package com.mariusschober.goalflow.nativeapp.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.mariusschober.goalflow.nativeapp.data.GoalflowRepository
import com.mariusschober.goalflow.nativeapp.data.HabitGenerationHealth
import com.mariusschober.goalflow.nativeapp.data.HabitGenerationStatus
import com.mariusschober.goalflow.nativeapp.data.NativeReorderResult
import com.mariusschober.goalflow.nativeapp.data.NativeFocusSessionRecord
import com.mariusschober.goalflow.nativeapp.data.NativeFocusSessionPhase
import com.mariusschober.goalflow.nativeapp.data.SyncConflictEntity
import com.mariusschober.goalflow.nativeapp.domain.BreakdownChild
import com.mariusschober.goalflow.nativeapp.domain.GoalflowHabit
import com.mariusschober.goalflow.nativeapp.domain.GoalflowGoal
import com.mariusschober.goalflow.nativeapp.domain.GoalflowCircadianState
import com.mariusschober.goalflow.nativeapp.domain.GoalflowProgress
import com.mariusschober.goalflow.nativeapp.domain.GoalflowStats
import com.mariusschober.goalflow.nativeapp.domain.GoalflowTask
import com.mariusschober.goalflow.nativeapp.domain.GoalflowTrueNorth
import com.mariusschober.goalflow.nativeapp.domain.PlanningGate
import com.mariusschober.goalflow.nativeapp.domain.SchedulePrecision
import com.mariusschober.goalflow.nativeapp.sync.NativeSyncEngine
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.time.Instant
import org.json.JSONObject

@OptIn(ExperimentalCoroutinesApi::class)
class GoalflowViewModel(
    private val repository: GoalflowRepository,
    private val syncEngine: NativeSyncEngine
) : ViewModel() {
    private val _reorderUndo = MutableStateFlow<NativeReorderResult?>(null)
    val reorderUndo: StateFlow<NativeReorderResult?> = _reorderUndo.asStateFlow()

    private val _today = MutableStateFlow(repository.timeProvider.today().toString())
    val today: StateFlow<String> = _today.asStateFlow()

    val tasks: StateFlow<List<GoalflowTask>> = repository.taskStream.stateIn(
        viewModelScope,
        SharingStarted.Eagerly,
        emptyList()
    )

    val goals: StateFlow<List<GoalflowGoal>> = repository.goalStream.stateIn(
        viewModelScope,
        SharingStarted.Eagerly,
        emptyList()
    )

    val habits: StateFlow<List<GoalflowHabit>> = repository.habitStream.stateIn(
        viewModelScope,
        SharingStarted.Eagerly,
        emptyList()
    )

    val habitGenerationFailures: StateFlow<List<HabitGenerationHealth>> = repository.habitGenerationHealthStream
        .map { health -> health.filter { it.status != HabitGenerationStatus.GENERATED } }
        .stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

    val stats: StateFlow<GoalflowStats> = repository.statsStream.stateIn(
        viewModelScope,
        SharingStarted.Eagerly,
        GoalflowStats()
    )

    val progress: StateFlow<GoalflowProgress> = repository.progressStream.stateIn(
        viewModelScope,
        SharingStarted.Eagerly,
        GoalflowProgress()
    )

    val circadian: StateFlow<GoalflowCircadianState> = repository.circadianStream.stateIn(
        viewModelScope,
        SharingStarted.Eagerly,
        GoalflowCircadianState()
    )

    val trueNorth: StateFlow<List<GoalflowTrueNorth>> = repository.trueNorthStream.stateIn(
        viewModelScope,
        SharingStarted.Eagerly,
        emptyList()
    )

    val amalgam: StateFlow<String> = repository.amalgamStream.stateIn(
        viewModelScope,
        SharingStarted.Eagerly,
        "My world takes care of me"
    )

    val focusSession: StateFlow<NativeFocusSessionRecord?> = repository.trackingStream
        .map { payload ->
            runCatching { NativeFocusSessionRecord.fromTrackingPayload(payload) }.getOrNull()
        }
        .stateIn(viewModelScope, SharingStarted.Eagerly, null)

    val conflicts: StateFlow<List<SyncConflictEntity>> = repository.conflictStream.stateIn(
        viewModelScope,
        SharingStarted.Eagerly,
        emptyList()
    )

    val planningGate: StateFlow<PlanningGate> = today.flatMapLatest { date ->
        combine(tasks, repository.planStream(date)) { allTasks, plan ->
            com.mariusschober.goalflow.nativeapp.domain.planningGate(allTasks, date, plan)
        }
    }.stateIn(viewModelScope, SharingStarted.Eagerly, PlanningGate.Empty)

    val currentTask: StateFlow<GoalflowTask?> = planningGate.map { gate ->
        (gate as? PlanningGate.Ready)?.queue?.firstOrNull()
    }.stateIn(viewModelScope, SharingStarted.Eagerly, null)

    private val _notice = MutableStateFlow<String?>(null)
    val notice: StateFlow<String?> = _notice.asStateFlow()

    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

    private val _undoTaskId = MutableStateFlow<String?>(null)
    val undoTaskId: StateFlow<String?> = _undoTaskId.asStateFlow()

    private val completing = mutableSetOf<String>()

    init {
        viewModelScope.launch {
            while (isActive) {
                delay(60_000)
                _today.value = repository.timeProvider.today().toString()
            }
        }
        viewModelScope.launch {
            combine(habits, today) { currentHabits, date -> currentHabits to date }
                .collectLatest { (currentHabits, date) ->
                    if (currentHabits.isEmpty()) return@collectLatest
                    // P1-3: batch habitId IN query to avoid N×getAll
                    runCatching { repository.generateHabitInstances(currentHabits.map { it.id }, date) }
                        .onFailure { failure ->
                            _error.value = failure.message ?: "A habit could not be generated safely."
                            // fallback to per-habit to preserve single-habit error visibility
                            currentHabits.forEach { habit ->
                                runCatching { repository.generateHabitInstance(habit.id, date) }
                                    .onFailure { perFailure ->
                                        _error.value = perFailure.message ?: "A habit could not be generated safely."
                                    }
                            }
                        }
                }
            }
    }

    fun createTask(
        title: String,
        notes: String,
        precision: SchedulePrecision,
        scheduledFor: String,
        scheduledTime: String?,
        isFrog: Boolean,
        goalId: String? = null,
        duration: Int? = null,
        onComplete: () -> Unit
    ) {
        viewModelScope.launch {
            clearError()
            runCatching {
                repository.createTask(title, notes, precision, scheduledFor, scheduledTime, isFrog, goalId, duration)
            }.onSuccess {
                _notice.value = "Commitment captured locally"
                onComplete()
            }.onFailure { failure ->
                _error.value = failure.message ?: "The task could not be saved."
            }
        }
    }

    fun updateTask(
        task: GoalflowTask,
        title: String,
        notes: String,
        precision: SchedulePrecision,
        scheduledFor: String,
        scheduledTime: String?,
        isFrog: Boolean,
        goalId: String? = null,
        duration: Int? = null,
        onComplete: () -> Unit
    ) {
        viewModelScope.launch {
            clearError()
            runCatching {
                repository.updateTask(task.id, title, notes, precision, scheduledFor, scheduledTime, isFrog, goalId, duration)
            }.onSuccess {
                _notice.value = "Commitment updated locally"
                onComplete()
            }.onFailure { failure ->
                _error.value = failure.message ?: "The task could not be updated."
            }
        }
    }

    fun completeTask(
        task: GoalflowTask,
        actualDuration: Int? = null,
        flowState: String? = null,
        finalDescription: String? = null,
        onComplete: () -> Unit = {}
    ) {
        if (!completing.add(task.id)) return
        viewModelScope.launch {
            try {
                clearError()
                runCatching { repository.completeTask(task.id, actualDuration, flowState, finalDescription) }
                    .onSuccess {
                        _undoTaskId.value = task.id
                        onComplete()
                    }
                    .onFailure { failure -> _error.value = failure.message ?: "The task could not be completed." }
            } finally {
                completing.remove(task.id)
            }
        }
    }

    fun startFocus(task: GoalflowTask, onComplete: (NativeFocusSessionRecord) -> Unit = {}) {
        viewModelScope.launch {
            clearError()
            runCatching {
                val current = repository.trackingFocusSession()
                if (current?.phase == NativeFocusSessionPhase.ACTIVE || current?.phase == NativeFocusSessionPhase.PAUSED) {
                    if (current.taskId != task.id) throw IllegalStateException("Another focus session is already open.")
                    current
                } else {
                    val plannedDurationSeconds = JSONObject(task.extraJson)
                        .optInt("duration", 25)
                        .coerceIn(1, 1_440) * 60L
                    repository.saveFocusSession(NativeFocusSessionRecord.start(task.id, plannedDurationSeconds))
                    repository.trackingFocusSession()
                        ?: throw IllegalStateException("The focus session was not confirmed locally.")
                }
            }.onSuccess(onComplete)
                .onFailure { failure -> _error.value = failure.message ?: "The focus session could not start." }
        }
    }

    fun pauseFocus(onComplete: (NativeFocusSessionRecord) -> Unit = {}) = updateFocus(
        transform = { it.pause(Instant.now()) },
        onComplete = onComplete,
        failureMessage = "The focus session could not be paused."
    )

    fun resumeFocus(onComplete: (NativeFocusSessionRecord) -> Unit = {}) = updateFocus(
        transform = { it.resume(Instant.now()) },
        onComplete = onComplete,
        failureMessage = "The focus session could not be resumed."
    )

    fun stopFocus(onComplete: (NativeFocusSessionRecord) -> Unit = {}) = updateFocus(
        transform = { it.stop(Instant.now()) },
        onComplete = onComplete,
        failureMessage = "The focus session could not be stopped."
    )

    fun extendFocus(deltaSeconds: Long, onComplete: (NativeFocusSessionRecord) -> Unit = {}) = updateFocus(
        transform = { it.extend(deltaSeconds, Instant.now()) },
        onComplete = onComplete,
        failureMessage = "The focus session could not be extended."
    )

    fun completeFocus(
        task: GoalflowTask,
        actualDuration: Int? = null,
        flowState: String? = null,
        onComplete: () -> Unit = {}
    ) {
        viewModelScope.launch {
            clearError()
            runCatching {
                val current = repository.trackingFocusSession()
                if (current != null && current.taskId == task.id && current.phase != NativeFocusSessionPhase.COMPLETED) {
                    repository.saveFocusSession(current.complete(Instant.now()))
                }
                repository.completeTask(task.id, actualDuration, flowState)
            }.onSuccess { onComplete() }
                .onFailure { failure -> _error.value = failure.message ?: "The commitment could not be completed." }
        }
    }

    private fun updateFocus(
        transform: (NativeFocusSessionRecord) -> NativeFocusSessionRecord,
        onComplete: (NativeFocusSessionRecord) -> Unit,
        failureMessage: String
    ) {
        viewModelScope.launch {
            clearError()
            runCatching {
                val current = repository.trackingFocusSession()
                    ?: throw IllegalStateException("No shared focus session is open.")
                val next = transform(current)
                repository.saveFocusSession(next)
                next
            }.onSuccess(onComplete)
                .onFailure { failure -> _error.value = failure.message ?: failureMessage }
        }
    }

    fun undoCompletion(taskId: String) {
        viewModelScope.launch {
            clearError()
            runCatching { repository.undoCompletion(taskId) }
                .onSuccess {
                    _undoTaskId.value = null
                    _notice.value = "Completion undone locally"
                }
                .onFailure { failure -> _error.value = failure.message ?: "The completion could not be undone safely." }
        }
    }

    fun clearUndo() { _undoTaskId.value = null }

    /** Refreshes the injected local calendar after resume, midnight, or zone changes. */
    fun refreshToday() {
        _today.value = repository.timeProvider.today().toString()
    }

    fun skipTask(task: GoalflowTask) {
        viewModelScope.launch {
            clearError()
            runCatching { repository.skipTask(task.id) }
                .onSuccess { _notice.value = "Commitment moved to the end of today" }
                .onFailure { failure -> _error.value = failure.message ?: "The commitment could not be skipped." }
        }
    }

    fun dropTask(task: GoalflowTask) {
        viewModelScope.launch {
            clearError()
            runCatching { repository.dropTask(task.id) }
                .onSuccess { _notice.value = "Commitment dropped" }
                .onFailure { failure -> _error.value = failure.message ?: "The commitment could not be dropped." }
        }
    }

    fun promoteTaskToFrog(task: GoalflowTask) {
        viewModelScope.launch {
            clearError()
            runCatching { repository.promoteTaskToFrog(task.id) }
                .onSuccess { _notice.value = "Marked as a frog" }
                .onFailure { failure -> _error.value = failure.message ?: "The commitment could not become a frog." }
        }
    }

    fun breakDownTask(task: GoalflowTask, children: List<BreakdownChild>, onComplete: () -> Unit) {
        viewModelScope.launch {
            clearError()
            runCatching { repository.breakDownTask(task.id, children) }
                .onSuccess {
                    _notice.value = "Broken down into next actions"
                    onComplete()
                }
                .onFailure { failure -> _error.value = failure.message ?: "The commitment could not be broken down." }
        }
    }

    fun rescheduleTask(task: GoalflowTask, scheduledFor: String) {
        viewModelScope.launch {
            clearError()
            runCatching { repository.rescheduleTask(task.id, scheduledFor) }
                .onSuccess { _notice.value = "Day saved locally" }
                .onFailure { failure -> _error.value = failure.message ?: "The task could not be rescheduled." }
        }
    }

    fun moveTask(localDate: String, taskId: String, direction: Int) {
        viewModelScope.launch {
            clearError()
                runCatching { repository.moveToday(localDate, taskId, direction) }
                .onSuccess { result ->
                    if (result != null) {
                        // A long-press drag can emit several adjacent moves.
                        // Keep the first snapshot as the undo target while
                        // updating the final order shown by the snackbar.
                        val existing = _reorderUndo.value
                        _reorderUndo.value = if (
                            existing == null || existing.localDate != result.localDate
                        ) {
                            result
                        } else {
                            existing.copy(
                                orderedIds = result.orderedIds,
                                hadConfirmedPlan = existing.hadConfirmedPlan || result.hadConfirmedPlan
                            )
                        }
                    }
                }
                .onFailure { failure -> _error.value = failure.message ?: "The order could not be saved." }
        }
    }

    fun undoReorder(result: NativeReorderResult) {
        viewModelScope.launch {
            clearError()
            runCatching {
                repository.reorderToday(result.localDate, result.previousIds)
                if (result.hadConfirmedPlan) repository.confirmPlan(result.localDate, result.previousIds)
            }.onSuccess {
                _reorderUndo.value = null
                _notice.value = "Previous order restored"
            }.onFailure { failure -> _error.value = failure.message ?: "The previous order could not be restored safely." }
        }
    }

    fun clearReorderUndo() { _reorderUndo.value = null }

    fun confirmPlan(localDate: String, orderedIds: List<String>) {
        viewModelScope.launch {
            clearError()
            runCatching { repository.confirmPlan(localDate, orderedIds) }
                .onSuccess {
                    _reorderUndo.value = null
                    _notice.value = "Plan confirmed"
                }
                .onFailure { failure -> _error.value = failure.message ?: "The plan changed. Review it again." }
        }
    }

    fun createGoal(
        name: String,
        description: String,
        deadline: String? = null,
        excitement: Int? = null,
        roi: Int? = null,
        onComplete: () -> Unit
    ) {
        viewModelScope.launch {
            clearError()
            runCatching { repository.createGoal(name, description, deadline, excitement, roi) }
                .onSuccess {
                    _notice.value = "Direction saved locally"
                    onComplete()
                }
                .onFailure { failure -> _error.value = failure.message ?: "The goal could not be saved." }
        }
    }

    fun updateGoal(goal: GoalflowGoal, onComplete: () -> Unit = {}) {
        viewModelScope.launch {
            clearError()
            runCatching { repository.updateGoal(goal) }
                .onSuccess { _notice.value = "Direction updated locally"; onComplete() }
                .onFailure { failure -> _error.value = failure.message ?: "The goal could not be updated." }
        }
    }

    fun deleteGoal(goal: GoalflowGoal) {
        viewModelScope.launch {
            clearError()
            runCatching { repository.deleteGoal(goal.id) }
                .onSuccess { _notice.value = "Goal removed; linked commitments remain." }
                .onFailure { failure -> _error.value = failure.message ?: "The goal could not be removed." }
        }
    }

    fun createHabit(
        title: String,
        frequency: com.mariusschober.goalflow.nativeapp.domain.HabitFrequency,
        specificDays: Set<Int>,
        highPriority: Boolean,
        beforeFrog: Boolean,
        duration: Int?,
        goalId: String?,
        onComplete: () -> Unit
    ) {
        viewModelScope.launch {
            clearError()
            runCatching {
                repository.createHabit(title, frequency, specificDays, highPriority, beforeFrog, duration, goalId)
            }.onSuccess {
                _notice.value = "Habit added locally"
                onComplete()
            }.onFailure { failure -> _error.value = failure.message ?: "The habit could not be saved." }
        }
    }

    fun updateHabit(habit: GoalflowHabit, onComplete: () -> Unit = {}) {
        viewModelScope.launch {
            clearError()
            runCatching { repository.updateHabit(habit) }
                .onSuccess { _notice.value = "Habit updated locally"; onComplete() }
                .onFailure { failure -> _error.value = failure.message ?: "The habit could not be updated." }
        }
    }

    fun deleteHabit(habit: GoalflowHabit) {
        viewModelScope.launch {
            clearError()
            runCatching { repository.deleteHabit(habit.id) }
                .onSuccess { _notice.value = "Habit removed; history remains." }
                .onFailure { failure -> _error.value = failure.message ?: "The habit could not be removed." }
        }
    }

    fun retryHabitGeneration(health: HabitGenerationHealth) {
        viewModelScope.launch {
            clearError()
            runCatching { repository.generateHabitInstance(health.habitId, health.scheduledFor) }
                .onSuccess { _notice.value = "Habit generation retried locally" }
                .onFailure { failure ->
                    _error.value = failure.message ?: "The habit could not be generated safely."
                }
        }
    }

    fun createTrueNorth(goal: GoalflowTrueNorth, onComplete: () -> Unit) {
        viewModelScope.launch {
            clearError()
            runCatching { repository.createTrueNorthGoal(goal) }
                .onSuccess { _notice.value = "Vision anchored locally"; onComplete() }
                .onFailure { failure -> _error.value = failure.message ?: "The vision could not be saved." }
        }
    }

    fun updateTrueNorth(goal: GoalflowTrueNorth, onComplete: () -> Unit = {}) {
        viewModelScope.launch {
            clearError()
            runCatching { repository.updateTrueNorthGoal(goal) }
                .onSuccess { _notice.value = "Vision updated locally"; onComplete() }
                .onFailure { failure -> _error.value = failure.message ?: "The vision could not be updated." }
        }
    }

    fun deleteTrueNorth(goal: GoalflowTrueNorth) {
        viewModelScope.launch {
            clearError()
            runCatching { repository.deleteTrueNorthGoal(goal.id) }
                .onSuccess { _notice.value = "Vision removed; linked commitments remain." }
                .onFailure { failure -> _error.value = failure.message ?: "The vision could not be removed." }
        }
    }

    fun updateAmalgam(text: String, onComplete: () -> Unit = {}) {
        viewModelScope.launch {
            clearError()
            runCatching { repository.updateAmalgam(text) }
                .onSuccess {
                    _notice.value = "Background thought saved locally"
                    onComplete()
                }
                .onFailure { failure -> _error.value = failure.message ?: "The background thought could not be saved." }
        }
    }

    fun updateCircadian(state: GoalflowCircadianState, onComplete: () -> Unit = {}) {
        viewModelScope.launch {
            clearError()
            runCatching { repository.updateCircadian(state) }
                .onSuccess {
                    _notice.value = "Daily rhythm saved locally"
                    onComplete()
                }
                .onFailure { failure -> _error.value = failure.message ?: "The daily rhythm could not be saved." }
        }
    }

    fun resetCircadian() {
        viewModelScope.launch {
            clearError()
            runCatching { repository.resetCircadian() }
                .onSuccess { _notice.value = "Daily rhythm reset locally" }
                .onFailure { failure -> _error.value = failure.message ?: "The daily rhythm could not be reset." }
        }
    }

    fun resolveConflict(conflict: SyncConflictEntity, keepLocal: Boolean) {
        viewModelScope.launch {
            clearError()
            runCatching {
                if (keepLocal) repository.resolveConflictLocally(conflict.id)
                else syncEngine.resolveConflictWithCloud(conflict)
            }.onSuccess {
                _notice.value = if (keepLocal) {
                    "Local version queued for safe reconciliation"
                } else {
                    "Cloud version applied"
                }
            }.onFailure { failure ->
                _error.value = failure.message ?: "The conflict remains preserved."
            }
        }
    }

    fun clearNotice() { _notice.value = null }
    fun clearError() { _error.value = null }
}

class GoalflowViewModelFactory(
    private val repository: GoalflowRepository,
    private val syncEngine: NativeSyncEngine
) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T {
        require(modelClass.isAssignableFrom(GoalflowViewModel::class.java))
        return GoalflowViewModel(repository, syncEngine) as T
    }
}
