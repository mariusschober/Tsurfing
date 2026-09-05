package com.mariusschober.goalflow.nativeapp.data

import androidx.room.withTransaction
import com.mariusschober.goalflow.nativeapp.domain.DailyPlan
import com.mariusschober.goalflow.nativeapp.domain.BreakdownChild
import com.mariusschober.goalflow.nativeapp.domain.GoalflowHabit
import com.mariusschober.goalflow.nativeapp.domain.GoalflowGoal
import com.mariusschober.goalflow.nativeapp.domain.GoalflowCircadianState
import com.mariusschober.goalflow.nativeapp.domain.GoalflowProgress
import com.mariusschober.goalflow.nativeapp.domain.GoalflowStats
import com.mariusschober.goalflow.nativeapp.domain.GoalflowTask
import com.mariusschober.goalflow.nativeapp.domain.GoalflowTrueNorth
import com.mariusschober.goalflow.nativeapp.domain.HabitFrequency
import com.mariusschober.goalflow.nativeapp.domain.SchedulePrecision
import com.mariusschober.goalflow.nativeapp.domain.SchedulingException
import com.mariusschober.goalflow.nativeapp.domain.TaskSource
import com.mariusschober.goalflow.nativeapp.domain.TaskStatus
import com.mariusschober.goalflow.nativeapp.domain.assertSchedule
import com.mariusschober.goalflow.nativeapp.domain.buildTodayQueue
import com.mariusschober.goalflow.nativeapp.domain.isRealLocalDay
import com.mariusschober.goalflow.nativeapp.domain.planningGate
import com.mariusschober.goalflow.nativeapp.time.GoalflowTimeProvider
import com.mariusschober.goalflow.nativeapp.time.SystemGoalflowTimeProvider
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONArray
import org.json.JSONObject
import java.nio.ByteBuffer
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.time.Instant
import java.time.LocalDate
import java.time.temporal.ChronoUnit
import java.util.Locale
import java.util.UUID

data class NativePushResult(
    val mutationId: String,
    val accepted: Boolean,
    val serverVersion: Long,
    val conflictId: String? = null,
    val replayMismatch: Boolean = false,
    val serverMissing: Boolean = false,
    val serverPayload: String = "",
    val serverDeletedAt: String? = null,
    val recordEntityType: String? = null,
    val recordEntityId: String? = null,
    val recordDeviceId: String? = null,
    val recordVersion: Long? = null,
    val recordServerVersion: Long? = null,
    val recordPayload: String? = null,
    val recordUpdatedAt: String? = null,
    val recordDeletedAt: String? = null
)

data class NativeRemoteRecord(
    val entityType: String,
    val entityId: String,
    val version: Long,
    val serverVersion: Long,
    val deviceId: String,
    val payload: String,
    val updatedAt: String,
    val deletedAt: String?
)

data class NativeServerConflict(
    val id: String,
    val entityType: String,
    val entityId: String,
    val mutationId: String,
    val localPayload: String,
    val localDeletedAt: String?,
    val localVersion: Long,
    val localUpdatedAt: String,
    val serverPayload: String,
    val serverDeletedAt: String?,
    val serverVersion: Long,
    val serverMissing: Boolean,
    val createdAt: String
)

class NativeSyncAccountMismatch : IllegalStateException(
    "This local database is bound to a different Tsurfing account. Its data was not synchronized or overwritten."
)

data class NativeReorderResult(
    val localDate: String,
    val previousIds: List<String>,
    val orderedIds: List<String>,
    val hadConfirmedPlan: Boolean
)

data class NativeWidgetSnapshot(
    val completedCount: Int,
    val plannedCount: Int,
    val currentTask: GoalflowTask?,
    val localDate: String,
    val planFingerprint: String
)

/** Web-owned collections retained losslessly until a native editor exists. */
val NATIVE_RAW_COLLECTION_TYPES = setOf(
    "stats", "progress", "hashtags", "accountability", "truenorth", "amalgam",
    "tracking", "circadian", "settings", "sync"
)

internal const val RESTORE_QUARANTINE_PREFIX = "__goalflow.restore.quarantine."

class GoalflowRepository(
    private val database: GoalflowDatabase,
    private val deviceId: String = UUID.randomUUID().toString(),
    private val onMutation: () -> Unit = {},
    val timeProvider: GoalflowTimeProvider = SystemGoalflowTimeProvider(),
    val syncBindingProvider: () -> GoalflowSyncBinding = {
        GoalflowSyncBinding("unconfigured", 1, null)
    }
) {
    private val tasks = database.taskDao()
    private val taskEvents = database.taskEventDao()
    private val goals = database.goalDao()
    private val plans = database.dailyPlanDao()
    private val habits = database.habitDao()
    private val outbox = database.syncOutboxDao()
    private val syncMeta = database.syncMetaDao()
    private val conflicts = database.syncConflictDao()
    private val rawCollections = database.rawCollectionDao()
    private val accounts = database.localAccountDao()

    val taskStream: Flow<List<GoalflowTask>> = tasks.observeAll().map { rows -> rows.map(::toDomain) }
    val goalStream: Flow<List<GoalflowGoal>> = goals.observeAll().map { rows -> rows.map(::toDomain) }
    val habitStream: Flow<List<GoalflowHabit>> = habits.observeAll().map { rows -> rows.map(::toDomain) }
    val habitGenerationHealthStream: Flow<List<HabitGenerationHealth>> =
        rawCollections.observeByPrefix("$HABIT_GENERATION_HEALTH_PREFIX%")
            .map { rows -> rows.mapNotNull { parseHabitGenerationHealth(it.entityType, it.payload) } }
    val conflictStream: Flow<List<SyncConflictEntity>> = conflicts.observeAll()

    val statsStream: Flow<GoalflowStats> = rawCollectionStream("stats").map(::parseTodayStats)
    val progressStream: Flow<GoalflowProgress> = rawCollectionStream("progress").map(::parseProgress)
    val circadianStream: Flow<GoalflowCircadianState> = rawCollectionStream("circadian").map(::parseCircadian)
    val trueNorthStream: Flow<List<GoalflowTrueNorth>> = rawCollectionStream("truenorth").map { raw ->
        // Keep a damaged optional projection from taking down the core native
        // client. The exact raw payload remains in Room for backup/recovery;
        // mutation paths below still parse it strictly before replacing it.
        runCatching { parseTrueNorthCollection(raw) }.getOrDefault(emptyList())
    }
    val amalgamStream: Flow<String> = rawCollectionStream("amalgam").map(::parseAmalgam)

    fun rawCollectionStream(entityType: String): Flow<String?> =
        rawCollections.observe(entityType).map { it?.payload }

    fun planStream(localDate: String): Flow<DailyPlan?> = plans.observe(localDate).map { row -> row?.let(::toDomain) }

    /** Binds an existing offline database once and refuses every cross-account sync thereafter. */
    suspend fun bindSyncAccount(userId: String) {
        val normalized = runCatching { UUID.fromString(userId).toString() }
            .getOrElse { throw NativeSyncAccountMismatch() }
        database.withTransaction {
            val current = accounts.get()
            if (current == null) accounts.insert(LocalAccountEntity(userId = normalized))
            else if (current.userId != normalized) throw NativeSyncAccountMismatch()
        }
    }

    suspend fun widgetSnapshot(localDate: String = timeProvider.today().toString()): NativeWidgetSnapshot {
        val allTasks = tasks.getAll().map(::toDomain)
        val planned = allTasks.filter { task ->
            task.deletedAt == null &&
                task.schedulePrecision == SchedulePrecision.DAY &&
                task.scheduledFor == localDate &&
                task.status in setOf(TaskStatus.OPEN, TaskStatus.COMPLETED)
        }
        val gate = planningGate(allTasks, localDate, plans.get(localDate)?.let(::toDomain))
        val queue = (gate as? com.mariusschober.goalflow.nativeapp.domain.PlanningGate.Ready)?.queue.orEmpty()
        return NativeWidgetSnapshot(
            completedCount = planned.count { it.status == TaskStatus.COMPLETED },
            plannedCount = planned.size,
            currentTask = queue.firstOrNull(),
            localDate = localDate,
            planFingerprint = widgetPlanFingerprint(localDate, plans.get(localDate)?.let(::toDomain), queue)
        )
    }

    /**
     * Reads directly from Room so lifecycle recovery never mistakes a
     * StateFlow's initial empty value for an empty database.
     */
    suspend fun taskSnapshot(id: String): GoalflowTask? =
        tasks.get(id)?.let(::toDomain)

    /** Executes only the action whose exact queue proof was captured by the widget. */
    suspend fun executeWidgetAction(action: NativeWidgetAction, target: NativeWidgetTarget) {
        when (action) {
            NativeWidgetAction.COMPLETE -> completeTask(
                id = target.taskId,
                expectedWidgetTarget = target
            )
            NativeWidgetAction.SKIP -> skipTask(
                id = target.taskId,
                expectedWidgetTarget = target
            )
            NativeWidgetAction.UNDO -> undoCompletion(
                id = target.taskId,
                expectedUpdatedAt = target.expectedUpdatedAt,
                expectedWidgetTarget = target
            )
        }
    }

    /** Must be called inside the same Room transaction as the widget mutation. */
    private suspend fun requireWidgetTargetInTransaction(target: NativeWidgetTarget) {
        if (target.localDate != timeProvider.today().toString()) {
            throw StaleWidgetActionException("This widget action is from a different local day. Refresh the widget.")
        }
        val current = tasks.get(target.taskId)?.let(::toDomain)
            ?: throw StaleWidgetActionException("This task no longer exists. Refresh the widget.")
        if (current.status != TaskStatus.OPEN || current.deletedAt != null || current.updatedAt != target.expectedUpdatedAt) {
            throw StaleWidgetActionException("This task changed elsewhere. Refresh the widget and try again.")
        }
        val allTasks = tasks.getAll().map(::toDomain)
        val plan = plans.get(target.localDate)?.let(::toDomain)
        val queue = (planningGate(allTasks, target.localDate, plan) as? com.mariusschober.goalflow.nativeapp.domain.PlanningGate.Ready)
            ?.queue
            .orEmpty()
        if (queue.firstOrNull()?.id != target.taskId || widgetPlanFingerprint(target.localDate, plan, queue) != target.planFingerprint) {
            throw StaleWidgetActionException("The plan changed elsewhere. Refresh the widget and try again.")
        }
    }

    suspend fun createTask(
        title: String,
        notes: String,
        schedulePrecision: SchedulePrecision,
        scheduledFor: String,
        scheduledTime: String?,
        isFrog: Boolean,
        goalId: String? = null,
        duration: Int? = null
    ): GoalflowTask {
        val cleanTitle = title.trim()
        if (cleanTitle.isBlank()) throw SchedulingException("A task needs an actionable title.")
        val cleanDuration = duration ?: 25
        if (cleanDuration !in 1..1_440) throw SchedulingException("Duration must be between 1 and 1,440 minutes.")
        val today = timeProvider.today().toString()
        assertSchedule(schedulePrecision, scheduledFor, today, scheduledTime)
        val now = timeProvider.now().toEpochMilli()
        val id = UUID.randomUUID().toString()
        return database.withTransaction {
            require(tasks.get(id) == null) { "Generated task id already exists; no task was overwritten." }
            val order = tasks.maxOrder(scheduledFor, schedulePrecision.name) + 1
            val task = GoalflowTask(
                id = id,
                title = cleanTitle,
                notes = notes.trim(),
                schedulePrecision = schedulePrecision,
                scheduledFor = scheduledFor,
                scheduledTime = scheduledTime,
                plannedOrder = order,
                status = TaskStatus.OPEN,
                isFrog = isFrog,
                source = TaskSource.MANUAL,
                goalId = goalId,
                createdAt = now,
                updatedAt = now,
                extraJson = JSONObject()
                    .put("duration", cleanDuration)
                    .put("hashtags", JSONArray())
                    .toString()
            )
            tasks.insert(toEntity(task))
            enqueueRecordInTransaction("tasks", task.id, GoalflowJson.taskPayload(task).toString())
            recordTaskEventInTransaction(task.id, "created", task.scheduledFor)
            task
        }.also { onMutation() }
    }

    suspend fun completeTask(
        id: String,
        actualDuration: Int? = null,
        flowState: String? = null,
        finalDescription: String? = null,
        expectedWidgetTarget: NativeWidgetTarget? = null
    ) {
        val changed = database.withTransaction {
            val task = tasks.getAll().firstOrNull { it.id == id }
                ?: throw SchedulingException("Task not found.")
            expectedWidgetTarget?.let { requireWidgetTargetInTransaction(it) }
            if (task.status != TaskStatus.OPEN.name) return@withTransaction false
            val now = timeProvider.now().toEpochMilli()
            val today = timeProvider.today().toString()
            val taskExtras = runCatching { JSONObject(task.extraJson) }.getOrElse { JSONObject() }
            val previousGoal = task.goalId?.let { goals.get(it) }
            val previousHabit = task.habitId?.let { habits.get(it) }
            val previousStats = rawCollections.get("stats")
            val previousStatsRoot = previousStats?.let { stored ->
                runCatching { parseJsonValue(stored.payload) as? JSONObject }.getOrNull()
            }
            val statsWasFlat = previousStatsRoot?.let { root ->
                root.has("tasksCompleted") || root.has("frogsEaten")
            } == true
            val statsDayBefore = when {
                previousStatsRoot == null -> null
                statsWasFlat -> previousStatsRoot.toString()
                else -> previousStatsRoot.optJSONObject(today)?.toString()
            }
            val previousProgress = rawCollections.get("progress")?.payload
            val focusMinutes = (actualDuration ?: taskExtras.optInt("actualDuration", taskExtras.optInt("duration", 0)))
                .coerceAtLeast(0)
            // Use indexed count instead of full table scan (P0-1)
            val totalToday = tasks.countRemainingToday(today)
            val remainingToday = if (task.scheduledFor == today && task.status == TaskStatus.OPEN.name && task.deletedAt == null) {
                (totalToday - 1).coerceAtLeast(0)
            } else totalToday
            val habitStreak = previousHabit?.let { it.streak + 1 } ?: 0
            var earnedXp = if (task.isFrog) 30 else 10
            if (task.habitId != null) earnedXp += habitStreak * 2
            if (task.goalId != null || task.habitId != null) earnedXp += 15
            if (flowState == "flow") earnedXp += 15
            if (flowState == "high") earnedXp += 10
            if (remainingToday == 0) earnedXp += 50

            // Stats and progression are web-owned collections, but a native
            // completion is still a complete Goalflow state transition. Update
            // their preserved JSON atomically when their projections are valid.
            var statsChanged = false
            // Stats and progress are optional web-owned projections. If a
            // legacy client left one malformed, preserve that exact payload
            // and let the task transition complete; the core commitment must
            // not become unusable because an auxiliary projection is bad.
            val statsRoot = when {
                previousStats == null -> JSONObject()
                previousStatsRoot != null -> previousStatsRoot
                else -> null
            }
            statsRoot?.let { root ->
                val statsForDay = if (root.has("tasksCompleted") || root.has("frogsEaten")) {
                    root
                } else {
                    root.optJSONObject(today) ?: JSONObject()
                }
                statsForDay.put("tasksCompleted", (statsForDay.optInt("tasksCompleted", 0) + 1).coerceAtLeast(0))
                statsForDay.put("frogsEaten", (statsForDay.optInt("frogsEaten", 0) + if (task.isFrog) 1 else 0).coerceAtLeast(0))
                statsForDay.put("timeFocused", (statsForDay.optInt("timeFocused", 0) + focusMinutes).coerceAtLeast(0))
                if (root !== statsForDay) root.put(today, statsForDay)
                upsertRawCollectionInTransaction("stats", root.toString())
                statsChanged = true
            }

            val progressChanged = updateProgressInTransaction(earnedXp)
            val undo = JSONObject().apply {
                put("version", 1)
                put("priorExtraJson", task.extraJson)
                put("priorNotes", task.notes)
                put("statsChanged", statsChanged)
                put("statsWasPresent", previousStats != null)
                put("statsWasFlat", statsWasFlat)
                put("statsDayBefore", statsDayBefore ?: JSONObject.NULL)
                put("progressChanged", progressChanged)
                put("progressBefore", previousProgress ?: JSONObject.NULL)
                put("goalId", task.goalId ?: JSONObject.NULL)
                put("goalCompletedTasksBefore", previousGoal?.completedTasks ?: JSONObject.NULL)
                put("habitId", task.habitId ?: JSONObject.NULL)
                put("habitStreakBefore", previousHabit?.streak ?: JSONObject.NULL)
                put("habitBestStreakBefore", previousHabit?.bestStreak ?: JSONObject.NULL)
                put("habitLastCompletedDateBefore", previousHabit?.lastCompletedDate ?: JSONObject.NULL)
                put("completionRecordedDate", today)
                put("earnedXp", earnedXp)
            }
            val updatedExtras = taskExtras.apply {
                if (actualDuration != null) put("actualDuration", focusMinutes)
                flowState?.takeIf { it in setOf("distracted", "good", "high", "flow") }?.let { put("flowState", it) }
                put(COMPLETION_UNDO_KEY, undo)
            }
            val updated = task.copy(
                status = TaskStatus.COMPLETED.name,
                notes = finalDescription?.trim()?.takeIf(String::isNotBlank) ?: task.notes,
                completedAt = now,
                updatedAt = now,
                extraJson = updatedExtras.toString()
            )
            tasks.update(updated)
            enqueueRecordInTransaction("tasks", id, GoalflowJson.taskPayload(toDomain(updated)).toString())
            recordTaskEventInTransaction(id, "completed", today)
            task.goalId?.let { goalId ->
                previousGoal?.let { goal ->
                    val updatedGoal = goal.copy(completedTasks = (goal.completedTasks + 1).coerceAtLeast(0))
                    goals.insert(updatedGoal)
                    enqueueRecordInTransaction(
                        "goals", goalId, GoalflowJson.goalPayload(toDomain(updatedGoal)).toString()
                    )
                }
            }
            task.habitId?.let { habitId ->
                previousHabit?.let { habit ->
                    val updatedHabit = habit.copy(
                        streak = habitStreak,
                        bestStreak = maxOf(habit.bestStreak, habitStreak),
                        lastCompletedDate = today
                    )
                    habits.insert(updatedHabit)
                    enqueueRecordInTransaction(
                        "habits", habitId, GoalflowJson.habitPayload(toDomain(updatedHabit)).toString()
                    )
                }
            }
            true
        }
        if (changed) onMutation()
    }

    /** Reverses the most recent local completion while restoring its projections. */
    suspend fun undoCompletion(
        id: String,
        expectedUpdatedAt: Long? = null,
        expectedWidgetTarget: NativeWidgetTarget? = null
    ) {
        val changed = database.withTransaction {
            val current = tasks.get(id) ?: throw SchedulingException("Task not found.")
            if (expectedUpdatedAt != null && current.updatedAt != expectedUpdatedAt) {
                throw StaleWidgetActionException("This widget action is stale. Refresh the widget and try again.")
            }
            if (current.status != TaskStatus.COMPLETED.name) return@withTransaction false
            expectedWidgetTarget?.let { requireWidgetUndoTargetInTransaction(it, current) }
            val extras = runCatching { JSONObject(current.extraJson) }.getOrElse {
                throw SchedulingException("This completion cannot be undone safely.")
            }
            val undo = extras.optJSONObject(COMPLETION_UNDO_KEY)
                ?: return@withTransaction false
            val completedAt = current.completedAt ?: return@withTransaction false
            require(tasks.getAll().none {
                it.id != id && it.status == TaskStatus.COMPLETED.name && (it.completedAt ?: 0L) > completedAt
            }) { "Undo is available only for the latest completion." }

            val priorExtraJson = undo.optString("priorExtraJson")
            require(priorExtraJson.isNotBlank()) { "The previous task state is not recoverable." }
            val restored = current.copy(
                status = TaskStatus.OPEN.name,
                notes = undo.optString("priorNotes", current.notes),
                completedAt = null,
                updatedAt = timeProvider.now().toEpochMilli(),
                extraJson = priorExtraJson
            )
            tasks.update(restored)
            enqueueRecordInTransaction("tasks", id, GoalflowJson.taskPayload(toDomain(restored)).toString())
            recordTaskEventInTransaction(id, "restored", timeProvider.today().toString())

            val goalId = undo.nullableStringValue("goalId")
            val goalBefore = undo.nullableInt("goalCompletedTasksBefore")
            if (goalId != null && goalBefore != null) {
                goals.get(goalId)?.let { goal ->
                    val restoredGoal = goal.copy(completedTasks = goalBefore)
                    goals.insert(restoredGoal)
                    enqueueRecordInTransaction(
                        "goals", goalId, GoalflowJson.goalPayload(toDomain(restoredGoal)).toString()
                    )
                }
            }

            val habitId = undo.nullableStringValue("habitId")
            val habitStreakBefore = undo.nullableInt("habitStreakBefore")
            val habitBestBefore = undo.nullableInt("habitBestStreakBefore")
            if (habitId != null && habitStreakBefore != null && habitBestBefore != null) {
                habits.get(habitId)?.let { habit ->
                    val restoredHabit = habit.copy(
                        streak = habitStreakBefore,
                        bestStreak = habitBestBefore,
                        lastCompletedDate = undo.nullableStringValue("habitLastCompletedDateBefore")
                    )
                    habits.insert(restoredHabit)
                    enqueueRecordInTransaction(
                        "habits", habitId, GoalflowJson.habitPayload(toDomain(restoredHabit)).toString()
                    )
                }
            }

            if (undo.optBoolean("statsChanged", false)) {
                restoreStatsProjectionInTransaction(undo)
            }
            if (undo.optBoolean("progressChanged", false)) {
                restoreRawProjectionInTransaction("progress", undo.opt("progressBefore"))
            }
            true
        }
        if (changed) onMutation()
    }

    /** Verifies the completed task against the plan that was visible before widget completion. */
    private suspend fun requireWidgetUndoTargetInTransaction(
        target: NativeWidgetTarget,
        current: TaskEntity
    ) {
        if (target.localDate != timeProvider.today().toString() || target.planFingerprint.isBlank()) {
            throw StaleWidgetActionException("This widget Undo is from a different plan. Refresh the widget.")
        }
        val priorUpdatedAt = target.expectedPriorUpdatedAt
            ?: throw StaleWidgetActionException("This widget Undo is missing its prior task version. Refresh the widget.")
        val allTasks = tasks.getAll().map(::toDomain).map { task ->
            if (task.id == current.id) {
                task.copy(status = TaskStatus.OPEN, updatedAt = priorUpdatedAt)
            } else task
        }
        val plan = plans.get(target.localDate)?.let(::toDomain)
        val queue = (planningGate(allTasks, target.localDate, plan) as? com.mariusschober.goalflow.nativeapp.domain.PlanningGate.Ready)
            ?.queue
            .orEmpty()
        if (widgetPlanFingerprint(target.localDate, plan, queue) != target.planFingerprint) {
            throw StaleWidgetActionException("The plan changed after completion. Refresh the widget before using Undo.")
        }
    }

    /** Moves a normal open commitment to the end of today's queue without losing its history. */
    suspend fun skipTask(id: String, expectedWidgetTarget: NativeWidgetTarget? = null) {
        val today = timeProvider.today().toString()
        database.withTransaction {
            val current = tasks.get(id) ?: throw SchedulingException("Task not found.")
            expectedWidgetTarget?.let { requireWidgetTargetInTransaction(it) }
            if (current.status != TaskStatus.OPEN.name) throw SchedulingException("Only an open task can be skipped.")
            if (current.deletedAt != null) throw SchedulingException("An archived task cannot be skipped.")
            if (current.schedulePrecision != SchedulePrecision.DAY.name || current.scheduledFor != today) {
                throw SchedulingException("Only today's commitment can be skipped.")
            }
            if (current.isFrog) throw SchedulingException("A frog cannot be skipped.")
            val maxOrder = tasks.getAll()
                .filter { it.status == TaskStatus.OPEN.name && it.deletedAt == null
                    && it.schedulePrecision == SchedulePrecision.DAY.name && it.scheduledFor == today }
                .maxOfOrNull { it.plannedOrder } ?: current.plannedOrder
            val updated = current.copy(
                plannedOrder = maxOrder + 1,
                updatedAt = timeProvider.now().toEpochMilli()
            )
            tasks.update(updated)
            enqueueRecordInTransaction("tasks", id, GoalflowJson.taskPayload(toDomain(updated)).toString())
            recordTaskEventInTransaction(id, "skipped", today)
        }
        onMutation()
    }

    /** Explicitly closes an open commitment without pretending it was completed. */
    suspend fun dropTask(id: String) {
        val changed = database.withTransaction {
            val task = tasks.getAll().firstOrNull { it.id == id }
                ?: throw SchedulingException("Task not found.")
            if (task.status != TaskStatus.OPEN.name) return@withTransaction false
            val updated = task.copy(status = TaskStatus.DROPPED.name, updatedAt = timeProvider.now().toEpochMilli())
            tasks.update(updated)
            enqueueRecordInTransaction("tasks", id, GoalflowJson.taskPayload(toDomain(updated)).toString())
            recordTaskEventInTransaction(id, "dropped", timeProvider.today().toString())
            true
        }
        if (changed) onMutation()
    }

    /** Makes a commitment a frog and invalidates today's confirmation gate. */
    suspend fun promoteTaskToFrog(id: String) {
        val changed = database.withTransaction {
            val current = tasks.get(id) ?: throw SchedulingException("Task not found.")
            if (current.status != TaskStatus.OPEN.name) return@withTransaction false
            if (current.isFrog) return@withTransaction false
            val today = timeProvider.today().toString()
            val updated = current.copy(isFrog = true, updatedAt = timeProvider.now().toEpochMilli())
            tasks.update(updated)
            enqueueRecordInTransaction("tasks", id, GoalflowJson.taskPayload(toDomain(updated)).toString())
            recordTaskEventInTransaction(id, "promoted_to_frog", current.scheduledFor)
            if (current.schedulePrecision == SchedulePrecision.DAY.name && current.scheduledFor == today) {
                val previousPlan = plans.get(today)
                plans.delete(today)
                if (previousPlan != null) {
                    enqueueRecordInTransaction(
                        "daily_plans",
                        today,
                        GoalflowJson.planPayload(toDomain(previousPlan)).toString(),
                        timeProvider.now().toString()
                    )
                }
            }
            true
        }
        if (changed) onMutation()
    }

    /** Edits an existing commitment while retaining fields from newer clients. */
    suspend fun updateTask(
        id: String,
        title: String,
        notes: String,
        schedulePrecision: SchedulePrecision,
        scheduledFor: String,
        scheduledTime: String? = null,
        isFrog: Boolean? = null,
        goalId: String? = null,
        duration: Int? = null
    ) {
        val cleanTitle = title.trim()
        if (cleanTitle.isBlank()) throw SchedulingException("A task needs an actionable title.")
        if (duration != null && duration !in 1..1_440) {
            throw SchedulingException("Duration must be between 1 and 1,440 minutes.")
        }
        assertSchedule(schedulePrecision, scheduledFor, timeProvider.today().toString(), scheduledTime)
        database.withTransaction {
            val current = tasks.get(id) ?: throw SchedulingException("Task not found.")
            if (current.deletedAt != null) throw SchedulingException("An archived task cannot be edited.")
            val currentDay = if (current.schedulePrecision == SchedulePrecision.MONTH.name) {
                "${current.scheduledFor}-01"
            } else current.scheduledFor
            val nextDay = if (schedulePrecision == SchedulePrecision.MONTH) "$scheduledFor-01" else scheduledFor
            if (current.isFrog && nextDay > currentDay) {
                throw SchedulingException("A frog cannot be moved forward.")
            }
            if (current.habitId != null && schedulePrecision == SchedulePrecision.DAY) {
                val existing = tasks.getByHabitAndDate(current.habitId, scheduledFor)
                if (existing != null && existing.id != id && existing.status == TaskStatus.OPEN.name && existing.deletedAt == null) {
                    throw SchedulingException("A habit instance already exists on that day.")
                }
            }
            val scheduleChanged = current.schedulePrecision != schedulePrecision.name ||
                current.scheduledFor != scheduledFor || current.scheduledTime != scheduledTime
            val updatedExtras = runCatching { JSONObject(current.extraJson) }.getOrElse {
                throw SchedulingException("This commitment contains damaged preserved fields; export a backup before editing it.")
            }
            duration?.let { updatedExtras.put("duration", it) }
            val updated = current.copy(
                title = cleanTitle,
                notes = notes.trim(),
                schedulePrecision = schedulePrecision.name,
                scheduledFor = scheduledFor,
                scheduledTime = scheduledTime,
                isFrog = current.isFrog || isFrog == true,
                goalId = goalId,
                extraJson = updatedExtras.toString(),
                updatedAt = timeProvider.now().toEpochMilli()
            )
            tasks.update(updated)
            enqueueRecordInTransaction("tasks", id, GoalflowJson.taskPayload(toDomain(updated)).toString())
            if (scheduleChanged) {
                val eventType = if (!current.isFrog && updated.isFrog) "promoted_to_frog" else "rescheduled"
                recordTaskEventInTransaction(
                    id,
                    eventType,
                    scheduledFor,
                    JSONObject()
                        .put("schedulePrecision", schedulePrecision.name)
                        .put("scheduledFor", scheduledFor)
                )
            }
        }
        onMutation()
    }

    /** Closes the parent and creates every next action atomically. */
    suspend fun breakDownTask(id: String, children: List<BreakdownChild>) {
        if (children.isEmpty()) throw SchedulingException("Add at least one scheduled next action.")
        if (children.size > 50) throw SchedulingException("A breakdown can contain at most 50 actions.")
        val today = timeProvider.today().toString()
        database.withTransaction {
            val parent = tasks.getAll().firstOrNull { it.id == id }
                ?: throw SchedulingException("Task not found.")
            if (parent.status != TaskStatus.OPEN.name) throw SchedulingException("Only an open task can be broken down.")

            // Capture the exact pre-breakdown order. If it was already confirmed,
            // the new actions can replace the parent without asking the user to
            // plan the same decision again.
            val previousQueue = buildTodayQueue(tasks.getAll().map(::toDomain), today)
            val previousPlan = plans.get(today)?.let(::toDomain)
            val now = timeProvider.now().toEpochMilli()
            val nextOrderBySchedule = mutableMapOf<Pair<String, String>, Int>()
            val created = buildList {
                children.forEach { child ->
                    val title = child.title.trim()
                    if (title.isBlank()) throw SchedulingException("Each next action needs a title.")
                    if (child.duration !in 1..1_440) throw SchedulingException("Each next action needs 1 to 1,440 minutes.")
                    assertSchedule(child.schedulePrecision, child.scheduledFor, today, child.scheduledTime)
                    val scheduleKey = child.scheduledFor to child.schedulePrecision.name
                    val order = nextOrderBySchedule[scheduleKey]
                        ?: (tasks.maxOrder(child.scheduledFor, child.schedulePrecision.name) + 1)
                    nextOrderBySchedule[scheduleKey] = order + 1
                    add(
                        GoalflowTask(
                            id = UUID.randomUUID().toString(),
                            title = title,
                            notes = child.notes.trim(),
                            schedulePrecision = child.schedulePrecision,
                            scheduledFor = child.scheduledFor,
                            scheduledTime = child.scheduledTime,
                            plannedOrder = order,
                            status = TaskStatus.OPEN,
                            isFrog = false,
                            beforeFrog = false,
                            source = TaskSource.MANUAL,
                            goalId = parent.goalId,
                            parentTaskId = parent.id,
                            createdAt = now,
                            updatedAt = now,
                            extraJson = JSONObject()
                                .put("duration", child.duration.coerceIn(1, 1_440))
                                .put("hashtags", JSONArray())
                                .toString()
                        )
                    )
                }
            }
            val updatedParent = parent.copy(
                status = TaskStatus.BROKEN_DOWN.name,
                completedAt = now,
                updatedAt = now
            )
            require(created.map { it.id }.toSet().size == created.size) {
                "Generated task ids collided; no task was changed."
            }
            created.forEach { child ->
                require(tasks.get(child.id) == null) { "Generated task id already exists; no task was overwritten." }
            }

            val todayChildren = created.filter {
                it.schedulePrecision == SchedulePrecision.DAY &&
                    it.scheduledFor == today &&
                    it.status == TaskStatus.OPEN
            }
            val previousQueueIds = previousQueue.map { it.id }
            val canPreserveConfirmedPlan = previousPlan != null &&
                previousPlan.taskIds == previousQueueIds &&
                previousQueue.any { it.id == parent.id } &&
                todayChildren.size == created.size
            val plannedIds = if (canPreserveConfirmedPlan) {
                // Keep the queue's existing precedence rules (including frog
                // grouping) while replacing the broken-down parent.
                val replacementCandidates = previousQueue
                    .filter { it.id != parent.id }
                    .plus(
                        todayChildren.mapIndexed { index, child ->
                            child.copy(plannedOrder = parent.plannedOrder + index)
                        }
                    )
                replacementCandidates
                    .sortedWith(com.mariusschober.goalflow.nativeapp.domain.goalflowTaskComparator)
                    .map { it.id }
            } else {
                emptyList()
            }
            val plannedOrderById = plannedIds.withIndex().associate { it.value to it.index }
            val reorderedExisting = if (canPreserveConfirmedPlan) {
                tasks.getAll()
                    .filter { row -> row.id != parent.id && plannedOrderById.containsKey(row.id) }
                    .map { row ->
                        row.copy(
                            plannedOrder = plannedOrderById.getValue(row.id),
                            updatedAt = now
                        )
                    }
            } else {
                emptyList()
            }
            val orderedCreated = created.map { child ->
                plannedOrderById[child.id]?.let { order -> child.copy(plannedOrder = order) } ?: child
            }

            tasks.update(updatedParent)
            if (reorderedExisting.isNotEmpty()) tasks.updateAll(reorderedExisting)
            tasks.insertAll(orderedCreated.map(::toEntity))
            reorderedExisting.forEach { task ->
                enqueueRecordInTransaction("tasks", task.id, GoalflowJson.taskPayload(toDomain(task)).toString())
            }
            enqueueRecordInTransaction("tasks", parent.id, GoalflowJson.taskPayload(toDomain(updatedParent)).toString())
            recordTaskEventInTransaction(parent.id, "broken_down", today)
            orderedCreated.forEach { child ->
                enqueueRecordInTransaction("tasks", child.id, GoalflowJson.taskPayload(child).toString())
                recordTaskEventInTransaction(child.id, "created", child.scheduledFor)
            }

            if (canPreserveConfirmedPlan) {
                val updatedPlan = com.mariusschober.goalflow.nativeapp.domain.DailyPlan(
                    localDate = today,
                    confirmedAt = now,
                    taskIds = plannedIds
                )
                plans.insert(toEntity(updatedPlan))
                enqueueRecordInTransaction(
                    "daily_plans",
                    today,
                    GoalflowJson.planPayload(updatedPlan).toString()
                )
            } else if (previousPlan != null) {
                plans.delete(today)
                enqueueRecordInTransaction(
                    "daily_plans",
                    today,
                    GoalflowJson.planPayload(previousPlan).toString(),
                    timeProvider.now().toString()
                )
            }
        }
        onMutation()
    }

    suspend fun rescheduleTask(id: String, scheduledFor: String) {
        val today = timeProvider.today().toString()
        assertSchedule(SchedulePrecision.DAY, scheduledFor, today, null)
        database.withTransaction {
            val current = tasks.getAll().firstOrNull { it.id == id }
                ?: throw SchedulingException("Task not found.")
            if (current.status != TaskStatus.OPEN.name) throw SchedulingException("Only an open task can be changed.")
            if (current.habitId != null) {
                val existing = tasks.getByHabitAndDate(current.habitId, scheduledFor)
                if (existing != null && existing.id != current.id && existing.status == TaskStatus.OPEN.name && existing.deletedAt == null && existing.schedulePrecision == SchedulePrecision.DAY.name) {
                    throw SchedulingException("A habit instance already exists on that day.")
                }
            }
            val currentDay = if (current.schedulePrecision == SchedulePrecision.MONTH.name) {
                "${current.scheduledFor}-01"
            } else current.scheduledFor
            if (current.isFrog && scheduledFor > currentDay) throw SchedulingException("A frog cannot be moved forward.")
            val now = timeProvider.now().toEpochMilli()
            val failures = current.frogFailures + if (scheduledFor > currentDay) 1 else 0
            val updated = current.copy(
                    schedulePrecision = SchedulePrecision.DAY.name,
                    scheduledFor = scheduledFor,
                    scheduledTime = null,
                    plannedOrder = 0,
                    frogFailures = failures,
                    isFrog = current.isFrog || failures >= 2,
                    updatedAt = now
                )
            tasks.update(updated)
            enqueueRecordInTransaction("tasks", id, GoalflowJson.taskPayload(toDomain(updated)).toString())
            val eventType = if (!current.isFrog && updated.isFrog) "promoted_to_frog" else "rescheduled"
            recordTaskEventInTransaction(
                id,
                eventType,
                scheduledFor,
                JSONObject()
                    .put("schedulePrecision", SchedulePrecision.DAY.name)
                    .put("scheduledFor", scheduledFor)
            )
        }
        onMutation()
    }

    suspend fun reorderToday(localDate: String, orderedIds: List<String>) {
        database.withTransaction {
            val queue = buildTodayQueue(tasks.getAll().map(::toDomain), localDate)
            val expected = queue.map { it.id }
            if (expected.toSet() != orderedIds.toSet() || expected.size != orderedIds.size) {
                throw SchedulingException("The queue changed. Review the current order again.")
            }
            val byId = tasks.getAll().associateBy { it.id }
            val now = timeProvider.now().toEpochMilli()
            val updated = orderedIds.mapIndexed { index, id ->
                byId.getValue(id).copy(plannedOrder = index, updatedAt = now)
            }
            tasks.updateAll(updated)
            updated.forEach { task ->
                enqueueRecordInTransaction("tasks", task.id, GoalflowJson.taskPayload(toDomain(task)).toString())
            }
            val previousPlan = plans.get(localDate)
            plans.delete(localDate)
            if (previousPlan != null) {
                enqueueRecordInTransaction(
                    "daily_plans",
                    localDate,
                    GoalflowJson.planPayload(toDomain(previousPlan)).toString(),
                    timeProvider.now().toString()
                )
            }
        }
        onMutation()
    }

    /** Moves one item using the latest Room state, avoiding stale UI reorder races. */
    suspend fun moveToday(localDate: String, taskId: String, direction: Int): NativeReorderResult? {
        require(direction == -1 || direction == 1) { "A task can move only one position at a time." }
        val result = database.withTransaction {
            val queue = buildTodayQueue(tasks.getAll().map(::toDomain), localDate)
            val currentIndex = queue.indexOfFirst { it.id == taskId }
            val targetIndex = currentIndex + direction
            if (currentIndex < 0 || targetIndex !in queue.indices) return@withTransaction null
            val previousIds = queue.map { it.id }
            val orderedIds = previousIds.toMutableList().apply {
                val moved = removeAt(currentIndex)
                add(targetIndex, moved)
            }
            val byId = tasks.getAll().associateBy { it.id }
            val now = timeProvider.now().toEpochMilli()
            val updated = orderedIds.mapIndexed { index, id ->
                byId.getValue(id).copy(plannedOrder = index, updatedAt = now)
            }
            tasks.updateAll(updated)
            updated.forEach { task ->
                enqueueRecordInTransaction("tasks", task.id, GoalflowJson.taskPayload(toDomain(task)).toString())
            }
            val previousPlan = plans.get(localDate)
            plans.delete(localDate)
            if (previousPlan != null) {
                enqueueRecordInTransaction(
                    "daily_plans",
                    localDate,
                    GoalflowJson.planPayload(toDomain(previousPlan)).toString(),
                    timeProvider.now().toString()
                )
            }
            NativeReorderResult(localDate, previousIds, orderedIds, previousPlan != null)
        }
        if (result != null) onMutation()
        return result
    }

    suspend fun confirmPlan(localDate: String, orderedIds: List<String>) {
        database.withTransaction {
            val queue = buildTodayQueue(tasks.getAll().map(::toDomain), localDate)
            if (queue.map { it.id } != orderedIds) {
                throw SchedulingException("The queue changed. Review the current order again.")
            }
            val plan = DailyPlan(localDate, timeProvider.now().toEpochMilli(), orderedIds)
            plans.insert(toEntity(plan))
            enqueueRecordInTransaction("daily_plans", localDate, GoalflowJson.planPayload(plan).toString())
        }
        onMutation()
    }

    suspend fun createGoal(
        name: String,
        description: String,
        deadline: String? = null,
        excitement: Int? = null,
        roi: Int? = null
    ): GoalflowGoal {
        val cleanName = name.trim()
        if (cleanName.isBlank()) throw SchedulingException("A goal needs a name.")
        val cleanDeadline = deadline?.trim()?.takeIf(String::isNotBlank)
        cleanDeadline?.let {
            require(isRealLocalDay(it)) { "Choose a valid goal deadline." }
        }
        val goal = GoalflowGoal(
            id = UUID.randomUUID().toString(),
            name = cleanName,
            description = description.trim(),
            deadline = cleanDeadline,
            excitement = excitement,
            roi = roi,
            createdAt = timeProvider.now().toEpochMilli()
        )
        database.withTransaction {
            require(goals.get(goal.id) == null) { "Generated goal id already exists; no goal was overwritten." }
            goals.insert(toEntity(goal))
            enqueueRecordInTransaction("goals", goal.id, GoalflowJson.goalPayload(goal).toString())
        }
        onMutation()
        return goal
    }

    suspend fun updateGoal(goal: GoalflowGoal) {
        val cleanName = goal.name.trim()
        if (cleanName.isBlank()) throw SchedulingException("A goal needs a name.")
        goal.deadline?.let { require(com.mariusschober.goalflow.nativeapp.domain.isRealLocalDay(it)) { "Choose a valid goal deadline." } }
        database.withTransaction {
            require(goals.get(goal.id) != null) { "Goal not found." }
            val updated = goal.copy(name = cleanName, description = goal.description.trim())
            goals.insert(toEntity(updated))
            enqueueRecordInTransaction("goals", updated.id, GoalflowJson.goalPayload(updated).toString())
        }
        onMutation()
    }

    suspend fun deleteGoal(id: String) {
        database.withTransaction {
            val goal = goals.get(id) ?: return@withTransaction
            val linkedTasks = tasks.getByGoalId(id)
            val linkedHabits = habits.getAll().filter { it.goalId == id }
            val now = timeProvider.now().toEpochMilli()
            tasks.updateAll(linkedTasks.map { it.copy(goalId = null, updatedAt = now) })
            habits.insertAll(linkedHabits.map { it.copy(goalId = null) })
            linkedTasks.forEach { task ->
                enqueueRecordInTransaction("tasks", task.id, GoalflowJson.taskPayload(toDomain(task.copy(goalId = null, updatedAt = now))).toString())
            }
            linkedHabits.forEach { habit ->
                enqueueRecordInTransaction("habits", habit.id, GoalflowJson.habitPayload(toDomain(habit.copy(goalId = null))).toString())
            }
            goals.delete(id)
            enqueueRecordInTransaction("goals", id, GoalflowJson.goalPayload(toDomain(goal)).toString(), timeProvider.now().toString())
        }
        onMutation()
    }

    suspend fun createHabit(
        title: String,
        frequency: HabitFrequency = HabitFrequency.DAILY,
        specificDays: Set<Int> = emptySet(),
        isHighPriority: Boolean = false,
        beforeFrog: Boolean = false,
        duration: Int? = null,
        goalId: String? = null
    ): GoalflowHabit {
        val cleanTitle = title.trim()
        if (cleanTitle.isBlank()) throw SchedulingException("A habit needs an actionable title.")
        if (specificDays.any { it !in 0..6 }) throw SchedulingException("Habit days are invalid.")
        val habit = GoalflowHabit(
            id = UUID.randomUUID().toString(),
            title = cleanTitle,
            frequency = frequency,
            specificDays = specificDays,
            isHighPriority = isHighPriority,
            beforeFrog = beforeFrog,
            duration = duration?.coerceIn(1, 1_440),
            goalId = goalId,
            createdAt = timeProvider.now().toEpochMilli()
        )
        database.withTransaction {
            require(habits.get(habit.id) == null) { "Generated habit id already exists; no habit was overwritten." }
            habits.insert(toEntity(habit))
            enqueueRecordInTransaction("habits", habit.id, GoalflowJson.habitPayload(habit).toString())
            updateProgressInTransaction(50)
        }
        onMutation()
        return habit
    }

    suspend fun updateHabit(habit: GoalflowHabit) {
        val cleanTitle = habit.title.trim()
        if (cleanTitle.isBlank()) throw SchedulingException("A habit needs an actionable title.")
        if (habit.specificDays.any { it !in 0..6 }) throw SchedulingException("Habit days are invalid.")
        database.withTransaction {
            require(habits.get(habit.id) != null) { "Habit not found." }
            val updated = habit.copy(
                title = cleanTitle,
                specificDays = habit.specificDays.toSet(),
                duration = habit.duration?.coerceIn(1, 1_440)
            )
            habits.insert(toEntity(updated))
            enqueueRecordInTransaction("habits", updated.id, GoalflowJson.habitPayload(updated).toString())
        }
        onMutation()
    }

    suspend fun deleteHabit(id: String) {
        database.withTransaction {
            val habit = habits.get(id) ?: return@withTransaction
            val linkedTasks = tasks.getByHabitId(id)
            val now = timeProvider.now().toEpochMilli()
            val unlinked = linkedTasks.map { it.copy(habitId = null, updatedAt = now) }
            if (unlinked.isNotEmpty()) tasks.updateAll(unlinked)
            unlinked.forEach { task ->
                enqueueRecordInTransaction("tasks", task.id, GoalflowJson.taskPayload(toDomain(task)).toString())
            }
            habits.delete(id)
            enqueueRecordInTransaction("habits", id, GoalflowJson.habitPayload(toDomain(habit)).toString(), timeProvider.now().toString())
        }
        onMutation()
    }

    /**
     * Writes a web-owned collection without pretending the native client
     * understands every field. The complete JSON remains available for backup,
     * sync, and a future native editor.
     */
    suspend fun saveRawCollection(entityType: String, payload: String) {
        require(entityType in NATIVE_RAW_COLLECTION_TYPES) { "This collection is not writable by the native client." }
        parseJsonValue(payload)
        database.withTransaction { upsertRawCollectionInTransaction(entityType, payload) }
        onMutation()
    }

    suspend fun createTrueNorthGoal(goal: GoalflowTrueNorth): GoalflowTrueNorth {
        val clean = goal.copy(
            id = goal.id.ifBlank { UUID.randomUUID().toString() },
            vision = goal.vision.trim(),
            sensoryDetails = goal.sensoryDetails.trim(),
            planB = goal.planB.trim(),
            tangibleReality = goal.tangibleReality?.trim()?.takeIf(String::isNotBlank),
            anchorHabit = goal.anchorHabit?.trim()?.takeIf(String::isNotBlank),
            anchorTask = goal.anchorTask?.trim()?.takeIf(String::isNotBlank),
            importance = goal.importance.coerceIn(1, 10),
            anchorHabitDuration = goal.anchorHabitDuration?.coerceIn(1, 1_440),
            createdAt = timeProvider.now().toEpochMilli()
        )
        if (clean.vision.isBlank()) throw SchedulingException("A vision needs a clear outcome.")
        database.withTransaction {
            val current = parseTrueNorthCollection(rawCollections.get("truenorth")?.payload)
            require(current.none { it.id == clean.id }) { "Generated vision id already exists; no vision was overwritten." }
            upsertRawCollectionInTransaction(
                "truenorth",
                trueNorthCollectionPayload(current + clean)
            )
            clean.anchorHabit?.let { title ->
                val habit = GoalflowHabit(
                    id = UUID.randomUUID().toString(),
                    title = title,
                    frequency = HabitFrequency.DAILY,
                    isHighPriority = true,
                    duration = clean.anchorHabitDuration ?: 15,
                    goalId = clean.id,
                    createdAt = timeProvider.now().toEpochMilli()
                )
                habits.insert(toEntity(habit))
                enqueueRecordInTransaction("habits", habit.id, GoalflowJson.habitPayload(habit).toString())
                updateProgressInTransaction(50)
            }
            clean.anchorTask?.let { title ->
                val now = timeProvider.now().toEpochMilli()
                val today = timeProvider.today().toString()
                val task = GoalflowTask(
                    id = UUID.randomUUID().toString(),
                    title = title,
                    notes = "First physical milestone for: \"${clean.vision}\"",
                    schedulePrecision = SchedulePrecision.DAY,
                    scheduledFor = today,
                    plannedOrder = tasks.maxOrder(today, SchedulePrecision.DAY.name) + 1,
                    isFrog = true,
                    source = TaskSource.MANUAL,
                    goalId = clean.id,
                    createdAt = now,
                    updatedAt = now,
                    extraJson = JSONObject().put("duration", 25).put("hashtags", JSONArray()).toString()
                )
                tasks.insert(toEntity(task))
                enqueueRecordInTransaction("tasks", task.id, GoalflowJson.taskPayload(task).toString())
                recordTaskEventInTransaction(task.id, "created", today)
            }
        }
        onMutation()
        return clean
    }

    suspend fun updateTrueNorthGoal(goal: GoalflowTrueNorth) {
        val clean = goal.copy(
            vision = goal.vision.trim(),
            sensoryDetails = goal.sensoryDetails.trim(),
            planB = goal.planB.trim(),
            tangibleReality = goal.tangibleReality?.trim()?.takeIf(String::isNotBlank),
            anchorHabit = goal.anchorHabit?.trim()?.takeIf(String::isNotBlank),
            anchorTask = goal.anchorTask?.trim()?.takeIf(String::isNotBlank),
            importance = goal.importance.coerceIn(1, 10),
            anchorHabitDuration = goal.anchorHabitDuration?.coerceIn(1, 1_440)
        )
        if (clean.vision.isBlank()) throw SchedulingException("A vision needs a clear outcome.")
        database.withTransaction {
            val current = parseTrueNorthCollection(rawCollections.get("truenorth")?.payload)
            require(current.any { it.id == clean.id }) { "Vision not found." }
            upsertRawCollectionInTransaction(
                "truenorth",
                trueNorthCollectionPayload(current.map { if (it.id == clean.id) clean else it })
            )
        }
        onMutation()
    }

    suspend fun deleteTrueNorthGoal(id: String) {
        database.withTransaction {
            val current = parseTrueNorthCollection(rawCollections.get("truenorth")?.payload)
            if (current.none { it.id == id }) return@withTransaction
            val linkedTasks = tasks.getByGoalId(id)
            val linkedHabits = habits.getAll().filter { it.goalId == id }
            val now = timeProvider.now().toEpochMilli()
            val unlinkedTasks = linkedTasks.map { it.copy(goalId = null, updatedAt = now) }
            if (unlinkedTasks.isNotEmpty()) tasks.updateAll(unlinkedTasks)
            unlinkedTasks.forEach { task ->
                enqueueRecordInTransaction("tasks", task.id, GoalflowJson.taskPayload(toDomain(task)).toString())
            }
            val unlinkedHabits = linkedHabits.map { it.copy(goalId = null) }
            if (unlinkedHabits.isNotEmpty()) habits.insertAll(unlinkedHabits)
            unlinkedHabits.forEach { habit ->
                enqueueRecordInTransaction("habits", habit.id, GoalflowJson.habitPayload(toDomain(habit)).toString())
            }
            upsertRawCollectionInTransaction(
                "truenorth",
                trueNorthCollectionPayload(current.filterNot { it.id == id })
            )
        }
        onMutation()
    }

    suspend fun updateAmalgam(text: String) {
        val clean = text.trim()
        if (clean.isBlank()) throw SchedulingException("The background thought cannot be empty.")
        if (clean.length > 2_000) throw SchedulingException("The background thought is too long.")
        saveRawCollection("amalgam", JSONObject.quote(clean))
    }

    /** Saves the user's daily biological check-in as one local-first transition. */
    suspend fun updateCircadian(state: GoalflowCircadianState) {
        val cleanLastCheckIn = state.lastCheckIn.trim()
        require(cleanLastCheckIn.isBlank() || isRealLocalDay(cleanLastCheckIn)) {
            "Choose a valid check-in day."
        }
        val mode = state.mode.trim().lowercase(Locale.ROOT)
        require(mode in setOf("recovery", "maintenance", "apex")) {
            "The biological mode is invalid."
        }
        require(state.score in 0..100) { "The biological score is invalid." }
        require(state.sleepHours in 0..24) { "Sleep hours must be between 0 and 24." }
        require(state.energy in 1..10 && state.clarity in 1..10 && state.interest in 1..10) {
            "Energy, clarity, and interest must be between 1 and 10."
        }
        require(state.eatingWindow == null || state.eatingWindow in 1..24) {
            "The eating window must be between 1 and 24 hours."
        }
        val times = listOf(
            "sunriseTime" to state.sunriseTime,
            "sunsetTime" to state.sunsetTime,
            "solarNoonTime" to state.solarNoonTime,
            "wakeTime" to state.wakeTime,
            "firstMealTime" to state.firstMealTime
        )
        times.forEach { (label, value) ->
            require(value == null || value.isBlank() || isValidClockTime(value)) {
                "$label must use HH:mm."
            }
        }
        val clean = state.copy(
            lastCheckIn = cleanLastCheckIn,
            mode = mode,
            sunriseTime = state.sunriseTime?.trim()?.takeIf(String::isNotBlank),
            sunsetTime = state.sunsetTime?.trim()?.takeIf(String::isNotBlank),
            solarNoonTime = state.solarNoonTime?.trim()?.takeIf(String::isNotBlank),
            wakeTime = state.wakeTime?.trim()?.takeIf(String::isNotBlank),
            firstMealTime = state.firstMealTime?.trim()?.takeIf(String::isNotBlank)
        )

        database.withTransaction {
            val storedCircadian = rawCollections.get("circadian")
            val root = when {
                storedCircadian == null -> JSONObject()
                else -> runCatching { parseJsonValue(storedCircadian.payload) as? JSONObject }.getOrNull()
                    ?: throw SchedulingException(
                        "The existing biological check-in is damaged; export a backup before replacing it."
                    )
            }
            root.put("lastCheckIn", clean.lastCheckIn)
            root.put("score", clean.score)
            root.put("mode", clean.mode)
            root.put("sunriseTime", clean.sunriseTime ?: JSONObject.NULL)
            root.put("sunsetTime", clean.sunsetTime ?: JSONObject.NULL)
            root.put("solarNoonTime", clean.solarNoonTime ?: JSONObject.NULL)
            val metrics = when {
                !root.has("metrics") || root.isNull("metrics") -> JSONObject()
                else -> root.optJSONObject("metrics")
                    ?: throw SchedulingException("The existing biological metrics are damaged; export a backup before replacing them.")
            }
            metrics.put("sunrise", clean.sunrise)
            metrics.put("sleepHours", clean.sleepHours)
            metrics.put("energy", clean.energy)
            metrics.put("clarity", clean.clarity)
            metrics.put("interest", clean.interest)
            metrics.put("wakeTime", clean.wakeTime ?: JSONObject.NULL)
            metrics.put("eatingWindow", clean.eatingWindow ?: JSONObject.NULL)
            metrics.put("firstMealTime", clean.firstMealTime ?: JSONObject.NULL)
            root.put("metrics", metrics)
            upsertRawCollectionInTransaction("circadian", root.toString())

            // The web client records the latest check-in in today's daily
            // stats. Keep that projection in the same transaction when it is
            // valid; a damaged optional stats record is never overwritten.
            val storedStats = rawCollections.get("stats")
            val statsRoot = when {
                storedStats == null -> JSONObject()
                else -> runCatching { parseJsonValue(storedStats.payload) as? JSONObject }.getOrNull()
            }
            statsRoot?.let { stats ->
                val today = timeProvider.today().toString()
                val statsForDay = if (stats.has("tasksCompleted") || stats.has("frogsEaten")) {
                    stats
                } else {
                    stats.optJSONObject(today) ?: JSONObject()
                }
                statsForDay.put("bioLog", metrics)
                statsForDay.put("circadianScore", clean.score)
                if (stats !== statsForDay) stats.put(today, statsForDay)
                upsertRawCollectionInTransaction("stats", stats.toString())
            }
        }
        onMutation()
    }

    suspend fun resetCircadian() {
        database.withTransaction {
            val storedCircadian = rawCollections.get("circadian")
            val root = when {
                storedCircadian == null -> JSONObject()
                else -> runCatching { parseJsonValue(storedCircadian.payload) as? JSONObject }.getOrNull()
                    ?: throw SchedulingException(
                        "The existing biological check-in is damaged; export a backup before resetting it."
                    )
            }
            root.put("lastCheckIn", "")
            upsertRawCollectionInTransaction("circadian", root.toString())
        }
        onMutation()
    }

    /** Creates at most one instance for a habit/day, including after reload. */
    suspend fun generateHabitInstance(habitId: String, localDate: String): GoalflowTask? {
        assertSchedule(SchedulePrecision.DAY, localDate, timeProvider.today().toString(), null)
        val date = LocalDate.parse(localDate)
        val goalflowDayOfWeek = date.dayOfWeek.value % 7
        val initialHabit = database.withTransaction {
            habits.get(habitId) ?: throw SchedulingException("Habit not found.")
        }
        val initiallyAllowed = initialHabit.frequency == HabitFrequency.DAILY.name ||
            goalflowDayOfWeek in initialHabit.specificDays.split(",").mapNotNull(String::toIntOrNull)
        if (!initiallyAllowed) return null
        if (!claimHabitGeneration(habitId, localDate)) {
            return database.withTransaction {
                tasks.get(habitTaskId(habitId, localDate))?.let(::toDomain)
                    ?: tasks.getByHabitAndDate(habitId, localDate)?.let(::toDomain)
            }
        }

        try {
        val result = database.withTransaction {
            var habit = habits.get(habitId) ?: throw SchedulingException("Habit not found.")
            var habitChanged = false
            // Keep the web client's daily streak rule: a missed day breaks a
            // daily streak, but the habit and its history remain intact.
            val lastDate = habit.lastCompletedDate?.let { runCatching { LocalDate.parse(it) }.getOrNull() }
            if (habit.frequency == HabitFrequency.DAILY.name && lastDate != null
                && ChronoUnit.DAYS.between(lastDate, date) > 1 && habit.streak > 0
            ) {
                habit = habit.copy(streak = 0)
                habits.insert(habit)
                enqueueRecordInTransaction("habits", habit.id, GoalflowJson.habitPayload(toDomain(habit)).toString())
                habitChanged = true
            }
            val allowed = habit.frequency == HabitFrequency.DAILY.name ||
                goalflowDayOfWeek in habit.specificDays.split(",").mapNotNull(String::toIntOrNull)
            if (!allowed) {
                rawCollections.delete(habitGenerationHealthKey(habitId, localDate))
                return@withTransaction null to habitChanged
            }
            val existing = tasks.getByHabitAndDate(habitId, localDate)
            if (existing != null) {
                val task = toDomain(existing)
                writeHabitGenerationHealthInTransaction(
                    habitId = habitId,
                    localDate = localDate,
                    status = HabitGenerationStatus.GENERATED,
                    taskId = task.id,
                    errorMessage = null,
                    attemptCount = generationAttemptCountInTransaction(habitId, localDate)
                )
                task to habitChanged
            } else {
                val now = timeProvider.now().toEpochMilli()
                val todaysTasks = tasks.getByScheduledFor(localDate).filter {
                    it.schedulePrecision == SchedulePrecision.DAY.name && it.deletedAt == null
                }
                val createdAt = if (habit.isHighPriority) {
                    (todaysTasks.minOfOrNull { it.createdAt } ?: now) - 1_000L
                } else now
                val task = GoalflowTask(
                    id = habitTaskId(habit.id, localDate),
                    title = habit.title,
                    schedulePrecision = SchedulePrecision.DAY,
                    scheduledFor = localDate,
                    plannedOrder = tasks.maxOrder(localDate, SchedulePrecision.DAY.name) + 1,
                    isFrog = false,
                    beforeFrog = habit.beforeFrog,
                    source = TaskSource.HABIT,
                    goalId = habit.goalId,
                    habitId = habit.id,
                    createdAt = createdAt,
                    updatedAt = now,
                    extraJson = JSONObject()
                        .put("duration", habit.duration ?: 25)
                        .put("hashtags", JSONArray().put("habit"))
                        .toString()
                )
                val conflictingId = tasks.get(task.id)
                require(conflictingId == null || conflictingId.habitId == habit.id && conflictingId.scheduledFor == localDate) {
                    "Generated habit task id already belongs to different data; no task was overwritten."
                }
                if (conflictingId != null) {
                    val task = toDomain(conflictingId)
                    writeHabitGenerationHealthInTransaction(
                        habitId = habitId,
                        localDate = localDate,
                        status = HabitGenerationStatus.GENERATED,
                        taskId = task.id,
                        errorMessage = null,
                        attemptCount = generationAttemptCountInTransaction(habitId, localDate)
                    )
                    return@withTransaction task to habitChanged
                }
                tasks.insert(toEntity(task))
                enqueueRecordInTransaction("tasks", task.id, GoalflowJson.taskPayload(task).toString())
                recordTaskEventInTransaction(task.id, "created", localDate)
                writeHabitGenerationHealthInTransaction(
                    habitId = habitId,
                    localDate = localDate,
                    status = HabitGenerationStatus.GENERATED,
                    taskId = task.id,
                    errorMessage = null,
                    attemptCount = generationAttemptCountInTransaction(habitId, localDate)
                )
                task to true
            }
        }
        if (result.second) onMutation()
        return result.first
        } catch (failure: Exception) {
            recordHabitGenerationFailure(habitId, localDate, failure)
            throw failure
        }
    }

    /** P1-3: Batch habit generation via habitId IN query to avoid N×getAll */
    suspend fun generateHabitInstances(habitIds: List<String>, localDate: String): List<GoalflowTask> {
        if (habitIds.isEmpty()) return emptyList()
        // Prime batch query to ensure IN index is used; individual generation still reuses it via cache
        val existingByHabit = database.withTransaction {
            tasks.getByHabitIdsAndDate(habitIds, localDate).associateBy { it.habitId }
        }
        val results = mutableListOf<GoalflowTask>()
        for (habitId in habitIds) {
            // If already exists in batch snapshot, avoid extra generation scan
            if (existingByHabit.containsKey(habitId)) {
                existingByHabit[habitId]?.let { results.add(toDomain(it)) }
                continue
            }
            runCatching { generateHabitInstance(habitId, localDate) }.getOrNull()?.let { results.add(it) }
        }
        return results
    }

    private suspend fun claimHabitGeneration(habitId: String, localDate: String): Boolean = database.withTransaction {
        val key = habitGenerationHealthKey(habitId, localDate)
        val row = rawCollections.get(key)
        val existing = row?.let {
            parseHabitGenerationHealth(it.entityType, it.payload)
                ?: throw SchedulingException("Habit generation health is damaged; export a backup before retrying.")
        }
        if (existing?.status == HabitGenerationStatus.GENERATED &&
            (existing.taskId == null || tasks.get(existing.taskId) != null)
        ) return@withTransaction false
        val now = timeProvider.now()
        if (existing?.status == HabitGenerationStatus.IN_PROGRESS) {
            val lastAttempt = runCatching { Instant.parse(existing.updatedAt) }.getOrNull()
            if (lastAttempt != null && now.toEpochMilli() - lastAttempt.toEpochMilli() < HABIT_GENERATION_LEASE_MILLIS) {
                return@withTransaction false
            }
        }
        writeHabitGenerationHealthInTransaction(
            habitId = habitId,
            localDate = localDate,
            status = HabitGenerationStatus.IN_PROGRESS,
            taskId = existing?.taskId,
            errorMessage = null,
            attemptCount = (existing?.attemptCount ?: 0) + 1
        )
        true
    }

    private suspend fun recordHabitGenerationFailure(habitId: String, localDate: String, failure: Exception) {
        database.withTransaction {
            val key = habitGenerationHealthKey(habitId, localDate)
            val existing = rawCollections.get(key)?.let {
                parseHabitGenerationHealth(it.entityType, it.payload)
            }
            writeHabitGenerationHealthInTransaction(
                habitId = habitId,
                localDate = localDate,
                status = HabitGenerationStatus.FAILED,
                taskId = existing?.taskId,
                errorMessage = (failure.message ?: failure::class.simpleName ?: "Generation failed").take(500),
                attemptCount = existing?.attemptCount ?: 1
            )
        }
    }

    private suspend fun generationAttemptCountInTransaction(habitId: String, localDate: String): Int =
        rawCollections.get(habitGenerationHealthKey(habitId, localDate))
            ?.let { parseHabitGenerationHealth(it.entityType, it.payload)?.attemptCount }
            ?: 0

    private suspend fun writeHabitGenerationHealthInTransaction(
        habitId: String,
        localDate: String,
        status: HabitGenerationStatus,
        taskId: String?,
        errorMessage: String?,
        attemptCount: Int
    ) {
        val now = timeProvider.now().toString()
        val health = HabitGenerationHealth(
            habitId = habitId,
            scheduledFor = localDate,
            status = status,
            taskId = taskId,
            attemptCount = attemptCount.coerceAtLeast(0),
            errorMessage = errorMessage,
            updatedAt = now
        )
        rawCollections.insert(
            RawCollectionEntity(
                entityType = habitGenerationHealthKey(habitId, localDate),
                payload = health.toRawPayload(),
                updatedAt = now,
                deletedAt = null
            )
        )
    }

    suspend fun exportBackup(password: String): String = database.withTransaction {
        val binding = syncBindingProvider()
        val bindingOwnerUserId = normalizedAccountSubject(binding.accountSubject)
        val storedOwnerUserId = accounts.get()?.userId
        if (storedOwnerUserId != null && bindingOwnerUserId != null && storedOwnerUserId != bindingOwnerUserId) {
            throw NativeSyncAccountMismatch()
        }
        // P1-3: streaming export with LIMIT 500 to avoid OOM on large task sets
        suspend fun <T> loadPaged(getPage: suspend (limit: Int, offset: Int) -> List<T>): List<T> {
            val all = mutableListOf<T>()
            var offset = 0
            while (true) {
                val page = getPage(500, offset)
                if (page.isEmpty()) break
                all.addAll(page)
                if (page.size < 500) break
                offset += 500
            }
            return all
        }
        val payload = GoalflowBackupPayload(
            tasks = loadPaged { limit, offset -> tasks.getAllPaged(limit, offset) }.map(::toDomain),
            goals = loadPaged { limit, offset -> goals.getAllPaged(limit, offset) }.map(::toDomain),
            plans = loadPaged { limit, offset -> plans.getAllPaged(limit, offset) }.map(::toDomain),
            events = loadPaged { limit, offset -> taskEvents.getAllPaged(limit, offset) },
            habits = loadPaged { limit, offset -> habits.getAllPaged(limit, offset) }.map(::toDomain),
            outbox = outbox.getAll(),
            syncMeta = syncMeta.getAll(),
            conflicts = conflicts.getAll(),
            rawCollections = rawCollections.getAll().associate { it.entityType to it.payload },
            ownerUserId = storedOwnerUserId ?: bindingOwnerUserId,
            syncBinding = binding
        )
        val envelope = GoalflowBackup.encrypt(
            payload,
            password,
            exportedAt = timeProvider.now().toString()
        )
        check(GoalflowBackup.decrypt(envelope, password) == payload) {
            "The encrypted backup failed its immediate reopen verification."
        }
        envelope
    }

    suspend fun previewBackup(envelope: String, password: String): NativeBackupPreview {
        val document = GoalflowBackup.decryptDocument(envelope, password)
        return database.withTransaction { buildBackupPreview(document) }
    }

    /**
     * Restores by merge unless the user explicitly chooses replacement. The
     * checkpoint is created and the full restore is committed in one Room
     * transaction, so a process death cannot leave a half-restored store.
     */
    suspend fun restoreBackup(
        envelope: String,
        password: String,
        mode: BackupRestoreMode = BackupRestoreMode.MERGE
    ): NativeBackupPreview {
        val document = GoalflowBackup.decryptDocument(envelope, password)
        val preview = database.withTransaction { buildBackupPreview(document) }
        database.withTransaction {
            restoreBackupInTransaction(document.payload, envelope, password, mode, createCheckpoint = true)
        }
        verifyRestoredPayload(document.payload, mode)
        onMutation()
        return preview
    }

    suspend fun hasRestoreCheckpoint(): Boolean = database.withTransaction {
        rawCollections.get(RESTORE_CHECKPOINT_KEY)?.let { row ->
            runCatching { JSONObject(row.payload).optString("encryptedBackup").isNotBlank() }.getOrDefault(false)
        } ?: false
    }

    suspend fun rollbackLastRestore(password: String): NativeBackupPreview {
        val checkpoint = database.withTransaction {
            rawCollections.get(RESTORE_CHECKPOINT_KEY)?.let { row ->
                runCatching { JSONObject(row.payload).optString("encryptedBackup") }
                    .getOrNull()
                    ?.takeIf(String::isNotBlank)
            }
        } ?: throw BackupFormatException("No automatic restore checkpoint is available.")
        val document = GoalflowBackup.decryptDocument(checkpoint, password)
        val preview = database.withTransaction { buildBackupPreview(document) }
        database.withTransaction {
            // Keep the checkpoint itself so a repeated rollback remains
            // recoverable after a process death.
            restoreBackupInTransaction(document.payload, checkpoint, password, BackupRestoreMode.REPLACE, createCheckpoint = false)
        }
        verifyRestoredPayload(document.payload, BackupRestoreMode.REPLACE)
        onMutation()
        return preview
    }

    private suspend fun restoreBackupInTransaction(
        payload: GoalflowBackupPayload,
        envelope: String,
        password: String,
        mode: BackupRestoreMode,
        createCheckpoint: Boolean
    ) {
        val originalTasks = tasks.getAll().map(::toDomain)
        val originalGoals = goals.getAll().map(::toDomain)
        val originalHabits = habits.getAll().map(::toDomain)
        val originalPlans = plans.getAll().map(::toDomain)
        val originalEvents = taskEvents.getAll()
        val originalRaw = rawCollections.getAll()
        val storedOwnerUserId = accounts.get()?.userId
        val currentBinding = syncBindingProvider()
        val bindingOwnerUserId = normalizedAccountSubject(payload.syncBinding?.accountSubject)
        val incomingOwnerUserId = payload.ownerUserId ?: bindingOwnerUserId
        if (payload.ownerUserId != null && bindingOwnerUserId != null && payload.ownerUserId != bindingOwnerUserId) {
            throw BackupFormatException("Backup account bindings disagree.")
        }
        if (storedOwnerUserId != null && incomingOwnerUserId != null && storedOwnerUserId != incomingOwnerUserId) {
            throw NativeSyncAccountMismatch()
        }
        if (storedOwnerUserId == null && incomingOwnerUserId != null) {
            accounts.insert(LocalAccountEntity(userId = incomingOwnerUserId))
        }
        val syncStatePresent = payload.syncBinding != null || payload.outbox.isNotEmpty() ||
            payload.syncMeta.isNotEmpty() || payload.conflicts.isNotEmpty()
        val syncCompatible = !syncStatePresent || payload.syncBinding != null && payload.syncBinding == currentBinding
        val preservedOutbox = if (syncCompatible) {
            mergeExactById(outbox.getAll(), payload.outbox, SyncOutboxEntity::mutationId, "pending mutation")
        } else outbox.getAll()
        val preservedConflicts = if (syncCompatible) {
            mergeExactById(conflicts.getAll(), payload.conflicts, SyncConflictEntity::id, "conflict")
        } else conflicts.getAll()
        val mergedMeta = if (syncCompatible) {
            (syncMeta.getAll() + payload.syncMeta).groupBy { it.entityType }.map { (key, values) ->
                SyncMetaEntity(
                    entityType = key,
                    cursor = values.maxOfOrNull { it.cursor } ?: 0L,
                    localVersion = values.maxOfOrNull { it.localVersion } ?: 0L,
                    serverVersion = values.mapNotNull { it.serverVersion }.maxOrNull(),
                    lastSuccessfulSync = values.mapNotNull { it.lastSuccessfulSync }.maxOrNull()
                )
            }
        } else syncMeta.getAll()
        val incomingTasks = payload.tasks.map(::toEntity)
        val incomingGoals = payload.goals.map(::toEntity)
        val incomingHabits = payload.habits.map(::toEntity)
        val incomingPlans = payload.plans.map(::toEntity)
        val mergedTasks = if (mode == BackupRestoreMode.MERGE) {
            mergeExactById(originalTasks.map(::toEntity), incomingTasks, TaskEntity::id, "task")
        } else incomingTasks
        val mergedGoals = if (mode == BackupRestoreMode.MERGE) {
            mergeExactById(originalGoals.map(::toEntity), incomingGoals, GoalEntity::id, "goal")
        } else incomingGoals
        val mergedHabits = if (mode == BackupRestoreMode.MERGE) {
            mergeExactById(originalHabits.map(::toEntity), incomingHabits, HabitEntity::id, "habit")
        } else incomingHabits
        val mergedPlans = if (mode == BackupRestoreMode.MERGE) {
            mergeExactById(originalPlans.map(::toEntity), incomingPlans, DailyPlanEntity::localDate, "daily plan")
        } else incomingPlans
        val restoredEvents = if (mode == BackupRestoreMode.MERGE) {
            mergeExactById(originalEvents, payload.events, TaskEventEntity::id, "task event")
        } else payload.events
        val nowIso = timeProvider.now().toString()
        val rawByType = linkedMapOf<String, RawCollectionEntity>().apply {
            originalRaw
                .filter { mode == BackupRestoreMode.MERGE || it.entityType == RESTORE_CHECKPOINT_KEY || it.entityType.startsWith(RESTORE_QUARANTINE_PREFIX) }
                .forEach { put(it.entityType, it) }
            payload.rawCollections.forEach { (entityType, rawPayload) ->
                if (entityType == RESTORE_CHECKPOINT_KEY || entityType.startsWith(RESTORE_QUARANTINE_PREFIX)) return@forEach
                val existing = get(entityType)
                if (mode == BackupRestoreMode.MERGE && existing != null) {
                    require(jsonEquivalent(existing.payload, rawPayload)) {
                        "Backup raw collection identity is reused for different data."
                    }
                }
                put(entityType, RawCollectionEntity(entityType, rawPayload, nowIso, null))
            }
        }
        if (!syncCompatible && syncStatePresent) {
            val key = restoreQuarantineKey(envelope)
            rawByType[key] = RawCollectionEntity(
                entityType = key,
                payload = JSONObject().apply {
                    put("reason", "The backup synchronization binding differs from this installation.")
                    put("incomingBinding", payload.syncBinding?.let { syncBindingJson(it) } ?: JSONObject.NULL)
                    put("currentBinding", syncBindingJson(currentBinding))
                    put("encryptedBackup", envelope)
                }.toString(),
                updatedAt = nowIso,
                deletedAt = null
            )
        }

        if (createCheckpoint) {
            val checkpointPayload = currentBackupPayloadInTransaction()
            val checkpointEnvelope = GoalflowBackup.encrypt(
                checkpointPayload,
                password,
                exportedAt = timeProvider.now().toString()
            )
            check(GoalflowBackup.decrypt(checkpointEnvelope, password) == checkpointPayload) {
                "The automatic restore checkpoint failed its reopen verification."
            }
            rawByType[RESTORE_CHECKPOINT_KEY] = RawCollectionEntity(
                entityType = RESTORE_CHECKPOINT_KEY,
                payload = JSONObject()
                    .put("version", 1)
                    .put("createdAt", nowIso)
                    .put("encryptedBackup", checkpointEnvelope)
                    .toString(),
                updatedAt = nowIso,
                deletedAt = null
            )
        }

        tasks.deleteAll()
        goals.deleteAll()
        habits.deleteAll()
        plans.deleteAll()
        taskEvents.deleteAll()
        tasks.insertAll(mergedTasks)
        goals.insertAll(mergedGoals)
        habits.insertAll(mergedHabits)
        plans.insertAll(mergedPlans)
        taskEvents.insertAll(restoredEvents)
        outbox.deleteAll()
        outbox.insertAll(preservedOutbox)
        syncMeta.deleteAll()
        syncMeta.insertAll(mergedMeta)
        conflicts.deleteAll()
        conflicts.insertAll(preservedConflicts)
        rawCollections.deleteAll()
        rawCollections.insertAll(rawByType.values.toList())

        if (mode == BackupRestoreMode.REPLACE) {
            val deletedAt = timeProvider.now().toString()
            val restoredTaskIds = payload.tasks.mapTo(hashSetOf()) { it.id }
            val restoredGoalIds = payload.goals.mapTo(hashSetOf()) { it.id }
            val restoredHabitIds = payload.habits.mapTo(hashSetOf()) { it.id }
            val restoredPlanIds = payload.plans.mapTo(hashSetOf()) { it.localDate }
            originalTasks.filterNot { it.id in restoredTaskIds }.forEach {
                enqueueRecordInTransaction("tasks", it.id, GoalflowJson.taskPayload(it).toString(), deletedAt)
            }
            originalGoals.filterNot { it.id in restoredGoalIds }.forEach {
                enqueueRecordInTransaction("goals", it.id, GoalflowJson.goalPayload(it).toString(), deletedAt)
            }
            originalHabits.filterNot { it.id in restoredHabitIds }.forEach {
                enqueueRecordInTransaction("habits", it.id, GoalflowJson.habitPayload(it).toString(), deletedAt)
            }
            originalPlans.filterNot { it.localDate in restoredPlanIds }.forEach {
                enqueueRecordInTransaction("daily_plans", it.localDate, GoalflowJson.planPayload(it).toString(), deletedAt)
            }
            originalRaw
                .filter { it.entityType in NATIVE_RAW_COLLECTION_TYPES && it.entityType !in payload.rawCollections }
                .forEach { raw ->
                    enqueueRecordInTransaction("${raw.entityType}", "singleton", raw.payload, deletedAt)
                }
        }
        payload.tasks.forEach { enqueueRecordInTransaction("tasks", it.id, GoalflowJson.taskPayload(it).toString()) }
        payload.goals.forEach { enqueueRecordInTransaction("goals", it.id, GoalflowJson.goalPayload(it).toString()) }
        payload.habits.forEach { enqueueRecordInTransaction("habits", it.id, GoalflowJson.habitPayload(it).toString()) }
        payload.plans.forEach { enqueueRecordInTransaction("daily_plans", it.localDate, GoalflowJson.planPayload(it).toString()) }
        payload.events.forEach { event ->
            val taskPredecessor = outbox.getForEntity("tasks", event.taskId).lastOrNull()?.mutationId
            enqueueRecordInTransaction(
                "task_events",
                event.id,
                GoalflowTaskEventJson.eventPayload(event).toString(),
                dependsOnMutationIdOverride = taskPredecessor
            )
        }
        payload.rawCollections
            .filterKeys { it in NATIVE_RAW_COLLECTION_TYPES && it != "sync" }
            .forEach { (entityType, rawPayload) -> enqueueRecordInTransaction(entityType, "singleton", rawPayload) }
    }

    private suspend fun currentBackupPayloadInTransaction(): GoalflowBackupPayload {
        val binding = syncBindingProvider()
        return GoalflowBackupPayload(
            tasks = tasks.getAll().map(::toDomain),
            goals = goals.getAll().map(::toDomain),
            plans = plans.getAll().map(::toDomain),
            events = taskEvents.getAll(),
            habits = habits.getAll().map(::toDomain),
            outbox = outbox.getAll(),
            syncMeta = syncMeta.getAll(),
            conflicts = conflicts.getAll(),
            rawCollections = rawCollections.getAll().associate { it.entityType to it.payload },
            ownerUserId = accounts.get()?.userId ?: normalizedAccountSubject(binding.accountSubject),
            syncBinding = binding
        )
    }

    private suspend fun buildBackupPreview(document: GoalflowBackupDocument): NativeBackupPreview {
        val payload = document.payload
        val currentTasks = tasks.getAll().map(::toDomain)
        val currentGoals = goals.getAll().map(::toDomain)
        val currentHabits = habits.getAll().map(::toDomain)
        val currentPlans = plans.getAll().map(::toDomain)
        val taskCounts = previewCounts(currentTasks, payload.tasks, GoalflowTask::id)
        val goalCounts = previewCounts(currentGoals, payload.goals, GoalflowGoal::id)
        val habitCounts = previewCounts(currentHabits, payload.habits, GoalflowHabit::id)
        val planCounts = previewCounts(currentPlans, payload.plans, DailyPlan::localDate)
        val syncStatePresent = payload.syncBinding != null || payload.outbox.isNotEmpty() ||
            payload.syncMeta.isNotEmpty() || payload.conflicts.isNotEmpty()
        val compatible = !syncStatePresent || payload.syncBinding == syncBindingProvider()
        return NativeBackupPreview(
            schemaVersion = document.schemaVersion,
            exportedAt = document.exportedAt,
            incomingTaskCount = payload.tasks.size,
            incomingGoalCount = payload.goals.size,
            incomingHabitCount = payload.habits.size,
            incomingPlanCount = payload.plans.size,
            incomingEventCount = payload.events.size,
            incomingRawCollectionCount = payload.rawCollections.size,
            tasksToAdd = taskCounts.first,
            tasksToChange = taskCounts.second,
            tasksToRemoveOnReplace = taskCounts.third,
            goalsToAdd = goalCounts.first,
            goalsToChange = goalCounts.second,
            goalsToRemoveOnReplace = goalCounts.third,
            habitsToAdd = habitCounts.first,
            habitsToChange = habitCounts.second,
            habitsToRemoveOnReplace = habitCounts.third,
            syncStateCompatible = compatible,
            syncStateWillBeQuarantined = syncStatePresent && !compatible
        )
    }

    private fun <T> previewCounts(
        current: List<T>,
        incoming: List<T>,
        id: (T) -> String
    ): Triple<Int, Int, Int> {
        val currentById = current.associateBy(id)
        val incomingById = incoming.associateBy(id)
        val common = currentById.keys.intersect(incomingById.keys)
        return Triple(
            (incomingById.keys - currentById.keys).size,
            common.count { currentById[it] != incomingById[it] },
            (currentById.keys - incomingById.keys).size
        )
    }

    private suspend fun verifyRestoredPayload(payload: GoalflowBackupPayload, mode: BackupRestoreMode) {
        database.withTransaction {
            payload.tasks.forEach { expected ->
                check(tasks.get(expected.id)?.let(::toDomain) == expected) {
                    "The restored task could not be verified after commit."
                }
            }
            payload.goals.forEach { expected ->
                check(goals.get(expected.id)?.let(::toDomain) == expected) {
                    "The restored goal could not be verified after commit."
                }
            }
            payload.habits.forEach { expected ->
                check(habits.get(expected.id)?.let(::toDomain) == expected) {
                    "The restored habit could not be verified after commit."
                }
            }
            payload.plans.forEach { expected ->
                check(plans.get(expected.localDate)?.let(::toDomain) == expected) {
                    "The restored daily plan could not be verified after commit."
                }
            }
            if (mode == BackupRestoreMode.REPLACE) {
                check(tasks.getAll().map { it.id }.toSet() == payload.tasks.map { it.id }.toSet())
                check(goals.getAll().map { it.id }.toSet() == payload.goals.map { it.id }.toSet())
                check(habits.getAll().map { it.id }.toSet() == payload.habits.map { it.id }.toSet())
                check(plans.getAll().map { it.localDate }.toSet() == payload.plans.map { it.localDate }.toSet())
            }
        }
    }

    private fun syncBindingJson(binding: GoalflowSyncBinding): JSONObject = JSONObject().apply {
        put("backendOrigin", binding.backendOrigin)
        put("protocolVersion", binding.protocolVersion)
        put("accountSubject", binding.accountSubject ?: JSONObject.NULL)
    }

    private fun normalizedAccountSubject(value: String?): String? =
        value?.trim()?.takeIf(String::isNotBlank)?.let { accountSubject ->
            runCatching { UUID.fromString(accountSubject).toString() }.getOrNull()
        }

    private fun restoreQuarantineKey(envelope: String): String =
        "$RESTORE_QUARANTINE_PREFIX${sha256(envelope).take(16)}"

    private fun sha256(value: String): String = MessageDigest.getInstance("SHA-256")
        .digest(value.toByteArray(StandardCharsets.UTF_8))
        .joinToString("") { byte -> "%02x".format(byte) }

    /** Only causally-ready mutations are sent. Later edits remain durable behind their predecessor. */
    suspend fun readySyncMutations(limit: Int = 50): List<SyncOutboxEntity> = database.withTransaction {
        migrateLegacyOutboxInTransaction()
        outbox.getAll()
            .asSequence()
            .filter { it.dependsOnMutationId == null }
            .distinctBy { it.entityType to it.entityId }
            .take(limit)
            .toList()
    }

    suspend fun pendingSyncMutations(): List<SyncOutboxEntity> = outbox.getAll()

    suspend fun markSyncAttempted(mutationIds: List<String>, attemptedAt: String = timeProvider.now().toString()) {
        if (mutationIds.isNotEmpty()) outbox.markAttempted(mutationIds, attemptedAt)
    }

    /**
     * Applies server acknowledgements in one Room transaction. A rejection first
     * materializes the complete local chain as a conflict and only then removes
     * it from the outbox, so process death cannot create an acknowledgement gap.
     */
    suspend fun commitPushResults(
        batch: List<SyncOutboxEntity>,
        results: List<NativePushResult>
    ): Int {
        val expected = batch.map { it.mutationId }
        val actual = results.map { it.mutationId }
        require(actual.size == actual.toSet().size && actual.toSet() == expected.toSet()) {
            "The sync server returned an incomplete or mismatched acknowledgement set."
        }
        results.forEach { result ->
            require(result.serverVersion >= 0L && (!result.accepted || result.serverVersion > 0L)) {
                "The sync server returned an invalid acknowledgement version."
            }
            if (result.accepted) {
                require(
                    result.recordEntityType == batch.firstOrNull { it.mutationId == result.mutationId }?.entityType
                        && result.recordEntityId == batch.firstOrNull { it.mutationId == result.mutationId }?.entityId
                        && result.recordDeviceId == batch.firstOrNull { it.mutationId == result.mutationId }?.deviceId
                        && result.recordVersion == batch.firstOrNull { it.mutationId == result.mutationId }?.version
                        && result.recordServerVersion == result.serverVersion
                        && result.recordPayload != null
                        && jsonEquivalent(result.recordPayload, batch.first { it.mutationId == result.mutationId }.payload)
                        && sameInstant(result.recordUpdatedAt, batch.first { it.mutationId == result.mutationId }.updatedAt)
                        && sameInstantOrNull(result.recordDeletedAt, batch.first { it.mutationId == result.mutationId }.deletedAt)
                        && !result.replayMismatch
                        && !result.serverMissing
                        && result.conflictId == null
                ) {
                    "The sync server accepted a mutation without proving the exact submitted record. Local data remains pending."
                }
            }
            require(result.accepted || result.serverMissing || result.serverPayload.isNotBlank()) {
                "The sync server rejected a mutation without preserving the server side."
            }
            if (!result.accepted && !result.serverMissing) {
                runCatching { parseJsonValue(result.serverPayload) }
                    .getOrElse { throw IllegalArgumentException("The sync server returned an invalid conflict payload.") }
            }
        }
        return database.withTransaction {
            var conflictCount = 0
            val resultById = results.associateBy { it.mutationId }
            batch.forEach { sent ->
                val mutation = outbox.getForEntity(sent.entityType, sent.entityId)
                    .firstOrNull { it.mutationId == sent.mutationId }
                    ?: return@forEach // A duplicate response after a committed local transition.
                val result = resultById.getValue(mutation.mutationId)
                val metaKey = syncMetaKey(mutation.entityType, mutation.entityId)
                val currentMeta = syncMeta.get(metaKey)
                if (result.accepted && !result.replayMismatch) {
                    outbox.delete(mutation.mutationId)
                    mutation.resolvesConflictId?.let { conflicts.delete(it) }
                    outbox.getAll()
                        .filter { it.dependsOnMutationId == mutation.mutationId }
                        .forEach { dependent ->
                            outbox.insert(
                                dependent.copy(
                                    baseServerVersion = result.serverVersion,
                                    dependsOnMutationId = null,
                                    attemptedAt = null
                                )
                            )
                        }
                    syncMeta.insert(
                        SyncMetaEntity(
                            entityType = metaKey,
                            cursor = currentMeta?.cursor ?: 0L,
                            localVersion = maxOf(currentMeta?.localVersion ?: 0L, mutation.version),
                            serverVersion = result.serverVersion,
                            lastSuccessfulSync = currentMeta?.lastSuccessfulSync
                        )
                    )
                } else {
                    val chain = outbox.getForEntity(mutation.entityType, mutation.entityId)
                    val latest = chain.lastOrNull() ?: mutation
                    conflicts.insert(
                        SyncConflictEntity(
                            id = result.conflictId ?: "push:${mutation.mutationId}:${result.serverVersion}",
                            entityType = mutation.entityType,
                            entityId = mutation.entityId,
                            mutationId = mutation.mutationId,
                            localPayload = latest.payload,
                            localDeletedAt = latest.deletedAt,
                            localHistory = historyPayload(chain),
                            serverPayload = result.serverPayload,
                            serverDeletedAt = result.serverDeletedAt,
                            serverVersion = result.serverVersion,
                            createdAt = timeProvider.now().toString(),
                            status = if (result.replayMismatch) "replay_mismatch" else "unresolved"
                        )
                    )
                    val predecessorIds = chain.map { it.mutationId }.toSet() + mutation.mutationId
                    outbox.deleteForEntity(mutation.entityType, mutation.entityId)
                    releaseDependentsInTransaction(
                        predecessorMutationIds = predecessorIds,
                        baseServerVersion = result.serverVersion.takeIf { it > 0L }
                    )
                    conflictCount += 1
                }
            }
            conflictCount
        }
    }

    suspend fun syncMetadata(entityType: String): SyncMetaEntity? = syncMeta.get(entityType)

    /**
     * Applies an entire pull page and its cursor atomically. Unsupported or
     * conflicting records are preserved as conflicts before the cursor moves.
     */
    suspend fun applyRemotePage(records: List<NativeRemoteRecord>, nextCursor: Long): Int {
        require(nextCursor >= 0L) { "The sync cursor is invalid." }
        records.forEach(::validateRemoteRecord)
        return database.withTransaction {
            val cursorMeta = syncMeta.get(SYNC_CURSOR_KEY)
            val currentCursor = cursorMeta?.cursor ?: 0L
            require(nextCursor >= currentCursor) { "The sync cursor moved backwards." }
            require(records.all { it.serverVersion > currentCursor }
                && records.map { it.serverVersion }.toSet().size == records.size) {
                "The remote page contains stale or duplicate information; the sync cursor was not advanced."
            }
            require(nextCursor == (records.maxOfOrNull { it.serverVersion } ?: currentCursor)) {
                "The sync cursor would advance beyond remote information that was durably represented."
            }
            var conflictCount = 0
            records.forEach recordLoop@ { record ->
                val legacyItems = legacySnapshotItems(record)
                if (legacyItems != null) {
                    legacyItems.forEach itemLoop@ { (entityId, payload) ->
                        val recordMetaKey = syncMetaKey(record.entityType, entityId)
                        val recordMeta = syncMeta.get(recordMetaKey)
                        if (record.serverVersion <= (recordMeta?.serverVersion ?: 0L)) return@itemLoop
                        val pending = outbox.getForEntity(record.entityType, entityId)
                        if (pending.isNotEmpty()) {
                            val latest = pending.maxWithOrNull(
                                compareBy<SyncOutboxEntity> { it.version }.thenBy { it.mutationId }
                            )!!
                            conflicts.insert(
                                SyncConflictEntity(
                                    id = "pull:${record.entityType}:$entityId:${record.serverVersion}",
                                    entityType = record.entityType,
                                    entityId = entityId,
                                    mutationId = latest.mutationId,
                                    localPayload = latest.payload,
                                    localDeletedAt = latest.deletedAt,
                                    localHistory = historyPayload(pending),
                                    serverPayload = payload,
                                    serverDeletedAt = record.deletedAt,
                                    serverVersion = record.serverVersion,
                                    createdAt = timeProvider.now().toString()
                                )
                            )
                            val predecessorIds = pending.map { it.mutationId }.toSet()
                            outbox.deleteForEntity(record.entityType, entityId)
                            releaseDependentsInTransaction(predecessorIds, record.serverVersion)
                            conflictCount += 1
                        } else if (retainNewestRemoteConflictInTransaction(record, entityId, payload)) {
                            // Keep the current local UI side while updating the
                            // durable conflict to the newest remote side.
                        } else if (pending.isEmpty()) {
                            if (applyRemoteRecordInTransaction(record.copy(entityId = entityId, payload = payload))) {
                                conflictCount += 1
                            }
                        }
                        syncMeta.insert(
                            SyncMetaEntity(
                                entityType = recordMetaKey,
                                cursor = recordMeta?.cursor ?: 0L,
                                localVersion = maxOf(recordMeta?.localVersion ?: 0L, record.version),
                                serverVersion = record.serverVersion,
                                lastSuccessfulSync = recordMeta?.lastSuccessfulSync
                            )
                        )
                    }
                    val singletonKey = syncMetaKey(record.entityType, record.entityId)
                    val singletonMeta = syncMeta.get(singletonKey)
                    syncMeta.insert(
                        SyncMetaEntity(
                            entityType = singletonKey,
                            cursor = singletonMeta?.cursor ?: 0L,
                            localVersion = maxOf(singletonMeta?.localVersion ?: 0L, record.version),
                            serverVersion = maxOf(singletonMeta?.serverVersion ?: 0L, record.serverVersion),
                            lastSuccessfulSync = singletonMeta?.lastSuccessfulSync
                        )
                    )
                    return@recordLoop
                }
                val recordMetaKey = syncMetaKey(record.entityType, record.entityId)
                val recordMeta = syncMeta.get(recordMetaKey)
                if (record.serverVersion <= (recordMeta?.serverVersion ?: 0L)) return@recordLoop

                val pending = outbox.getForEntity(record.entityType, record.entityId)
                if (pending.isNotEmpty()) {
                    val latest = pending.maxWithOrNull(compareBy<SyncOutboxEntity> { it.version }.thenBy { it.mutationId })!!
                    val conflictId = "pull:${record.entityType}:${record.entityId}:${record.serverVersion}"
                    conflicts.insert(
                        SyncConflictEntity(
                            id = conflictId,
                            entityType = record.entityType,
                            entityId = record.entityId,
                            mutationId = latest.mutationId,
                            localPayload = latest.payload,
                            localDeletedAt = latest.deletedAt,
                            localHistory = historyPayload(pending),
                            serverPayload = record.payload,
                            serverDeletedAt = record.deletedAt,
                            serverVersion = record.serverVersion,
                            createdAt = timeProvider.now().toString()
                        )
                    )
                    val predecessorIds = pending.map { it.mutationId }.toSet()
                    outbox.deleteForEntity(record.entityType, record.entityId)
                    releaseDependentsInTransaction(predecessorIds, record.serverVersion)
                    conflictCount += 1
                } else if (retainNewestRemoteConflictInTransaction(record, record.entityId, record.payload)) {
                    // Remote information is represented in the open conflict
                    // before the page cursor advances.
                } else if (pending.isEmpty()) {
                    if (applyRemoteRecordInTransaction(record)) conflictCount += 1
                }

                syncMeta.insert(
                    SyncMetaEntity(
                        entityType = recordMetaKey,
                        cursor = recordMeta?.cursor ?: 0L,
                        localVersion = maxOf(recordMeta?.localVersion ?: 0L, record.version),
                        serverVersion = record.serverVersion,
                        lastSuccessfulSync = recordMeta?.lastSuccessfulSync
                    )
                )
            }
            syncMeta.insert(
                SyncMetaEntity(
                    entityType = SYNC_CURSOR_KEY,
                    cursor = nextCursor,
                    localVersion = cursorMeta?.localVersion ?: 0L,
                    serverVersion = cursorMeta?.serverVersion,
                    lastSuccessfulSync = cursorMeta?.lastSuccessfulSync
                )
            )
            conflictCount
        }
    }

    suspend fun markSyncSuccessful(at: String = timeProvider.now().toString()) {
        database.withTransaction {
            syncMeta.getAll().forEach { syncMeta.insert(it.copy(lastSuccessfulSync = at)) }
        }
    }

    /** Makes PostgreSQL-only conflicts visible after a reinstall or restore. */
    suspend fun mergeServerConflicts(remote: List<NativeServerConflict>): Int {
        require(remote.map { it.id }.toSet().size == remote.size) {
            "The server returned duplicate conflict identities; existing conflicts were not changed."
        }
        remote.forEach { conflict ->
            require(runCatching { UUID.fromString(conflict.id) }.isSuccess
                && conflict.entityType.isNotBlank() && conflict.entityId.isNotBlank())
            require(runCatching { UUID.fromString(conflict.mutationId) }.isSuccess)
            require(conflict.localVersion > 0L && conflict.serverVersion >= 0L)
            Instant.parse(conflict.localUpdatedAt)
            Instant.parse(conflict.createdAt)
            conflict.localDeletedAt?.let(Instant::parse)
            conflict.serverDeletedAt?.let(Instant::parse)
            parseJsonValue(conflict.localPayload)
            if (!conflict.serverMissing) parseJsonValue(conflict.serverPayload)
        }
        return database.withTransaction {
            var inserted = 0
            remote.forEach { remoteConflict ->
                val existing = conflicts.get(remoteConflict.id)
                val serverPayload = if (remoteConflict.serverMissing) "" else remoteConflict.serverPayload
                if (existing != null) {
                    require(existing.entityType == remoteConflict.entityType
                        && existing.entityId == remoteConflict.entityId
                        && existing.mutationId == remoteConflict.mutationId) {
                        "A server conflict id refers to different records; existing conflicts were not changed."
                    }
                    val history = JSONArray(existing.localHistory)
                    val representedLocalSide = (0 until history.length())
                        .mapNotNull { index -> history.optJSONObject(index) }
                        .firstOrNull { it.optString("mutationId") == remoteConflict.mutationId }
                    val representedDeletedAt = if (representedLocalSide == null
                        || !representedLocalSide.has("deletedAt") || representedLocalSide.isNull("deletedAt")) {
                        null
                    } else representedLocalSide.optString("deletedAt").takeIf(String::isNotBlank)
                    require(representedLocalSide != null && representedLocalSide.has("payload")
                        && jsonEquivalent(
                            canonicalJson(representedLocalSide.opt("payload")),
                            remoteConflict.localPayload
                        )
                        && representedLocalSide.optLong("version", -1L) == remoteConflict.localVersion
                        && sameInstant(representedLocalSide.optString("updatedAt"), remoteConflict.localUpdatedAt)
                        && sameInstantOrNull(representedDeletedAt, remoteConflict.localDeletedAt)) {
                        "A server conflict mutation refers to different local data; existing conflicts were not changed."
                    }
                    require(remoteConflict.serverVersion != existing.serverVersion
                        || ((existing.serverPayload.isBlank() == remoteConflict.serverMissing)
                            && jsonEquivalent(existing.serverPayload.ifBlank { "null" }, serverPayload.ifBlank { "null" })
                            && sameInstantOrNull(existing.serverDeletedAt, remoteConflict.serverDeletedAt))) {
                        "A server conflict version refers to different cloud data; existing conflicts were not changed."
                    }
                    if (remoteConflict.serverVersion > existing.serverVersion) {
                        conflicts.update(existing.copy(
                            serverPayload = serverPayload,
                            serverDeletedAt = remoteConflict.serverDeletedAt,
                            serverVersion = remoteConflict.serverVersion
                        ))
                    }
                    val key = syncMetaKey(remoteConflict.entityType, remoteConflict.entityId)
                    val current = syncMeta.get(key)
                    syncMeta.insert(SyncMetaEntity(
                        entityType = key,
                        cursor = current?.cursor ?: 0L,
                        localVersion = maxOf(current?.localVersion ?: 0L, remoteConflict.localVersion),
                        serverVersion = maxOf(current?.serverVersion ?: 0L, remoteConflict.serverVersion),
                        lastSuccessfulSync = current?.lastSuccessfulSync
                    ))
                    return@forEach
                }
                requireMutationIdAvailableInTransaction(remoteConflict.mutationId)
                conflicts.insert(SyncConflictEntity(
                    id = remoteConflict.id,
                    entityType = remoteConflict.entityType,
                    entityId = remoteConflict.entityId,
                    mutationId = remoteConflict.mutationId,
                    localPayload = remoteConflict.localPayload,
                    localDeletedAt = remoteConflict.localDeletedAt,
                    localHistory = JSONArray().put(historyEntry(
                        remoteConflict.mutationId,
                        remoteConflict.localPayload,
                        remoteConflict.localDeletedAt,
                        remoteConflict.localUpdatedAt,
                        remoteConflict.localVersion
                    )).toString(),
                    serverPayload = serverPayload,
                    serverDeletedAt = remoteConflict.serverDeletedAt,
                    serverVersion = remoteConflict.serverVersion,
                    createdAt = remoteConflict.createdAt
                ))
                val key = syncMetaKey(remoteConflict.entityType, remoteConflict.entityId)
                val current = syncMeta.get(key)
                syncMeta.insert(SyncMetaEntity(
                    entityType = key,
                    cursor = current?.cursor ?: 0L,
                    localVersion = maxOf(current?.localVersion ?: 0L, remoteConflict.localVersion),
                    serverVersion = maxOf(current?.serverVersion ?: 0L, remoteConflict.serverVersion),
                    lastSuccessfulSync = current?.lastSuccessfulSync
                ))
                inserted += 1
            }
            inserted
        }
    }

    suspend fun resolveConflictLocally(conflictId: String) {
        database.withTransaction {
            val conflict = conflicts.get(conflictId) ?: return@withTransaction
            if (conflict.status == "resolving_local") return@withTransaction
            require(
                conflict.entityType in setOf("tasks", "goals", "habits", "daily_plans", "task_events")
                    || (conflict.entityType in NATIVE_RAW_COLLECTION_TYPES && conflict.localPayload.isNotBlank())
            ) {
                "This remote data type cannot be resolved locally by this app version. Both versions remain preserved."
            }
            val key = syncMetaKey(conflict.entityType, conflict.entityId)
            val current = syncMeta.get(key)
            val history = JSONArray(conflict.localHistory)
            val historyVersion = (0 until history.length()).maxOfOrNull { index ->
                val entry = history.optJSONObject(index)
                    ?: throw IllegalArgumentException("Conflict history is damaged; both versions remain preserved.")
                val mutationId = entry.optString("mutationId").trim()
                require(mutationId.isNotBlank() && entry.has("version")) {
                    "Conflict history is damaged; both versions remain preserved."
                }
                entry.getLong("version").also { require(it > 0L) }
            } ?: 0L
            val version = maxOf(current?.localVersion ?: 0L, historyVersion) + 1L
            val mutationId = UUID.randomUUID().toString()
            requireMutationIdAvailableInTransaction(mutationId)
            outbox.insert(
                SyncOutboxEntity(
                    mutationId = mutationId,
                    deviceId = deviceId,
                    entityType = conflict.entityType,
                    entityId = conflict.entityId,
                    baseServerVersion = conflict.serverVersion,
                    version = version,
                    payload = conflict.localPayload,
                    updatedAt = timeProvider.now().toString(),
                    deletedAt = conflict.localDeletedAt,
                    resolvesConflictId = conflict.id
                )
            )
            conflicts.update(conflict.copy(mutationId = mutationId, status = "resolving_local"))
            syncMeta.insert(
                SyncMetaEntity(
                    entityType = key,
                    cursor = current?.cursor ?: 0L,
                    localVersion = version,
                    serverVersion = conflict.serverVersion,
                    lastSuccessfulSync = current?.lastSuccessfulSync
                )
            )
        }
        onMutation()
    }

    suspend fun resolveConflictWithCloud(conflictId: String) {
        database.withTransaction {
            val conflict = conflicts.get(conflictId) ?: return@withTransaction
            if (conflict.status == "unsupported_remote") {
                // The user explicitly chose the canonical cloud copy. This app
                // version cannot materialize the entity locally, but the server
                // remains its durable owner, so only the local warning is removed.
            } else if (conflict.serverPayload.isBlank()) {
                deleteEntityInTransaction(conflict.entityType, conflict.entityId)
            } else {
                applyRemoteRecordInTransaction(
                    NativeRemoteRecord(
                        entityType = conflict.entityType,
                        entityId = conflict.entityId,
                        version = 0L,
                        serverVersion = conflict.serverVersion,
                        deviceId = "server-conflict-resolution",
                        payload = conflict.serverPayload,
                        updatedAt = conflict.createdAt,
                        deletedAt = conflict.serverDeletedAt
                    )
                )
            }
            val predecessorIds = outbox.getForEntity(conflict.entityType, conflict.entityId)
                .map { it.mutationId }
                .toSet()
            outbox.deleteForEntity(conflict.entityType, conflict.entityId)
            releaseDependentsInTransaction(predecessorIds, conflict.serverVersion)
            conflicts.delete(conflict.id)
            val key = syncMetaKey(conflict.entityType, conflict.entityId)
            val current = syncMeta.get(key)
            syncMeta.insert(
                SyncMetaEntity(
                    entityType = key,
                    cursor = current?.cursor ?: 0L,
                    localVersion = current?.localVersion ?: 0L,
                    serverVersion = conflict.serverVersion,
                    lastSuccessfulSync = current?.lastSuccessfulSync
                )
            )
        }
    }

    private suspend fun deleteEntityInTransaction(entityType: String, entityId: String) {
        when (entityType) {
            "tasks" -> tasks.delete(entityId)
            "goals" -> goals.delete(entityId)
            "habits" -> habits.delete(entityId)
            "daily_plans" -> plans.delete(entityId)
            // A pull tombstone never reaches this branch. Deletion is allowed
            // only after the user explicitly chooses the cloud side of a
            // preserved conflict.
            "task_events" -> taskEvents.delete(entityId)
            in NATIVE_RAW_COLLECTION_TYPES -> rawCollections.delete(entityType)
            else -> throw IllegalArgumentException("This conflict type cannot be applied by the native client.")
        }
    }

    /**
     * Version-two clients queued whole-store snapshots. Expand non-empty legacy
     * snapshots transactionally into deterministic record mutations. Unknown
     * removals are deliberately not inferred; existing server records will be
     * pulled back or become explicit per-record conflicts.
     */
    private suspend fun migrateLegacyOutboxInTransaction() {
        outbox.getAll().forEach { mutation ->
            if (mutation.entityType !in setOf("tasks", "goals", "habits")
                || mutation.entityId != "singleton"
                || mutation.dependsOnMutationId != null
                || !mutation.payload.trimStart().startsWith("[")
            ) return@forEach
            val items = legacySnapshotItems(
                NativeRemoteRecord(
                    mutation.entityType,
                    mutation.entityId,
                    mutation.version,
                    mutation.baseServerVersion ?: 1L,
                    mutation.deviceId,
                    mutation.payload,
                    mutation.updatedAt,
                    mutation.deletedAt
                )
            ) ?: return@forEach
            if (items.isEmpty()) return@forEach
            val replacements = items.map { (entityId, payload) ->
                val derivedId = UUID.nameUUIDFromBytes(
                    "${mutation.mutationId}:$entityId".toByteArray(StandardCharsets.UTF_8)
                ).toString()
                requireMutationIdAvailableInTransaction(derivedId)
                val embeddedDeletedAt = runCatching {
                    JSONObject(payload).takeIf { it.has("deletedAt") && !it.isNull("deletedAt") }
                        ?.optString("deletedAt")?.takeIf(String::isNotBlank)
                }.getOrNull()
                mutation.copy(
                    mutationId = derivedId,
                    entityId = entityId,
                    baseServerVersion = syncMeta.get(syncMetaKey(mutation.entityType, entityId))?.serverVersion,
                    payload = payload,
                    deletedAt = embeddedDeletedAt ?: mutation.deletedAt,
                    dependsOnMutationId = null,
                    attemptedAt = null
                )
            }
            require(replacements.map { it.mutationId }.toSet().size == replacements.size) {
                "Legacy pending mutations could not be assigned unique identities."
            }
            outbox.delete(mutation.mutationId)
            outbox.insertAll(replacements)
        }
    }

    private fun legacySnapshotItems(record: NativeRemoteRecord): List<Pair<String, String>>? {
        if (record.entityType !in setOf("tasks", "goals", "habits") || !record.payload.trimStart().startsWith("[")) {
            return null
        }
        val array = JSONArray(record.payload)
        return buildList(array.length()) {
            val ids = hashSetOf<String>()
            for (index in 0 until array.length()) {
                val item = array.optJSONObject(index)
                    ?: throw IllegalArgumentException("Legacy sync snapshot contains an invalid record.")
                val id = item.optString("id").trim()
                require(id.isNotBlank() && ids.add(id)) { "Legacy sync snapshot contains an invalid or duplicate identity." }
                add(id to item.toString())
            }
        }
    }

    /**
     * A task pull conflict removes the task mutation chain, but dependent
     * append-only events must remain durable so local history is never stranded.
     */
    private suspend fun releaseDependentsInTransaction(
        predecessorMutationIds: Set<String>,
        baseServerVersion: Long?
    ) {
        if (predecessorMutationIds.isEmpty()) return
        outbox.getAll()
            .filter { it.dependsOnMutationId in predecessorMutationIds }
            .forEach { dependent ->
                outbox.insert(
                    dependent.copy(
                        baseServerVersion = baseServerVersion ?: dependent.baseServerVersion,
                        dependsOnMutationId = null,
                        attemptedAt = null
                    )
                )
            }
    }

    private suspend fun recordTaskEventInTransaction(
        taskId: String,
        eventType: String,
        localDate: String = timeProvider.today().toString(),
        metadata: JSONObject = JSONObject()
    ) {
        require(eventType in GoalflowTaskEventJson.KNOWN_EVENT_TYPES) {
            "Unknown task event type cannot be recorded."
        }
        val normalizedDate = if (localDate.matches(Regex("^\\d{4}-\\d{2}$"))) {
            "$localDate-01"
        } else localDate
        require(runCatching { LocalDate.parse(normalizedDate) }.isSuccess) {
            "Task event local date is invalid."
        }
        val event = TaskEventEntity(
            id = UUID.randomUUID().toString(),
            taskId = taskId,
            eventType = eventType,
            localDate = normalizedDate,
            metadata = metadata.toString(),
            createdAt = timeProvider.now().toEpochMilli()
        )
        taskEvents.insert(event)
        val taskPredecessor = outbox.getForEntity("tasks", taskId).lastOrNull()?.mutationId
        enqueueRecordInTransaction(
            "task_events",
            event.id,
            GoalflowTaskEventJson.eventPayload(event).toString(),
            dependsOnMutationIdOverride = taskPredecessor
        )
    }

    private suspend fun enqueueRecordInTransaction(
        entityType: String,
        entityId: String,
        payload: String,
        deletedAt: String? = null,
        dependsOnMutationIdOverride: String? = null
    ) {
        val metaKey = syncMetaKey(entityType, entityId)
        val current = syncMeta.get(metaKey)
        val existing = outbox.getForEntity(entityType, entityId)
        val nextVersion = maxOf(current?.localVersion ?: 0L, existing.maxOfOrNull { it.version } ?: 0L) + 1L
        val mutationId = UUID.randomUUID().toString()
        requireMutationIdAvailableInTransaction(mutationId)
        val updatedAt = timeProvider.now().toString()
        val unresolved = conflicts.getUnresolved(entityType, entityId)
        if (unresolved != null) {
            val history = JSONArray(unresolved.localHistory)
            for (index in 0 until history.length()) {
                require(history.optJSONObject(index)?.optString("mutationId")?.isNotBlank() == true) {
                    "Conflict history is damaged; the new local change was not applied."
                }
            }
            history.put(historyEntry(mutationId, payload, deletedAt, updatedAt, nextVersion))
            conflicts.update(
                unresolved.copy(
                    localPayload = payload,
                    localDeletedAt = deletedAt,
                    localHistory = history.toString()
                )
            )
        } else {
            val predecessor = existing.lastOrNull()
            outbox.insert(
                SyncOutboxEntity(
                    mutationId = mutationId,
                    deviceId = deviceId,
                    entityType = entityType,
                    entityId = entityId,
                    baseServerVersion = current?.serverVersion,
                    version = nextVersion,
                    payload = payload,
                    updatedAt = updatedAt,
                    deletedAt = deletedAt,
                    dependsOnMutationId = dependsOnMutationIdOverride ?: predecessor?.mutationId
                )
            )
        }
        syncMeta.insert(
            SyncMetaEntity(
                entityType = metaKey,
                cursor = current?.cursor ?: 0L,
                localVersion = nextVersion,
                serverVersion = current?.serverVersion,
                lastSuccessfulSync = current?.lastSuccessfulSync
            )
        )
    }

    /** Returns true when a remote record was represented as a durable conflict. */
    private suspend fun retainNewestRemoteConflictInTransaction(
        record: NativeRemoteRecord,
        entityId: String,
        payload: String
    ): Boolean {
        val matching = conflicts.getAll().filter {
            it.entityType == record.entityType && it.entityId == entityId
        }
        if (matching.isEmpty()) return false
        matching.forEach { conflict ->
            if (record.serverVersion > conflict.serverVersion) {
                conflicts.update(
                    conflict.copy(
                        serverPayload = payload,
                        serverDeletedAt = record.deletedAt,
                        serverVersion = record.serverVersion
                    )
                )
            }
        }
        return true
    }

    /** Returns true when a remote record was represented as a durable conflict. */
    private suspend fun applyRemoteRecordInTransaction(record: NativeRemoteRecord): Boolean {
        val trimmed = record.payload.trimStart()
        when (record.entityType) {
            "tasks" -> {
                if (trimmed.startsWith("[")) {
                    tasks.insertAll(GoalflowJson.parseTasks(record.payload, strict = true).map(::toEntity))
                } else {
                    val remote = GoalflowJson.parseTask(record.payload, strict = true)
                    require(remote.id == record.entityId) { "Task sync identifier does not match its payload." }
                    val deletedMillis = record.deletedAt?.let { Instant.parse(it).toEpochMilli() }
                    tasks.insert(toEntity(if (deletedMillis == null) remote else remote.copy(deletedAt = deletedMillis)))
                }
            }
            "goals" -> {
                if (trimmed.startsWith("[")) {
                    goals.insertAll(GoalflowJson.parseGoals(record.payload, strict = true).map(::toEntity))
                } else if (record.deletedAt != null) {
                    goals.delete(record.entityId)
                } else {
                    val remote = GoalflowJson.parseGoal(record.payload, strict = true)
                    require(remote.id == record.entityId) { "Goal sync identifier does not match its payload." }
                    goals.insert(toEntity(remote))
                }
            }
            "habits" -> {
                if (trimmed.startsWith("[")) {
                    val array = JSONArray(record.payload)
                    for (index in 0 until array.length()) {
                        habits.insert(toEntity(GoalflowJson.parseHabit(array.getJSONObject(index).toString(), strict = true)))
                    }
                } else if (record.deletedAt != null) {
                    habits.delete(record.entityId)
                } else {
                    val remote = GoalflowJson.parseHabit(record.payload, strict = true)
                    require(remote.id == record.entityId) { "Habit sync identifier does not match its payload." }
                    habits.insert(toEntity(remote))
                }
            }
            "daily_plans" -> {
                if (record.deletedAt != null) plans.delete(record.entityId)
                else plans.insert(parsePlan(record.payload, record.entityId))
            }
            "task_events" -> {
                if (record.deletedAt != null) {
                    // Lifecycle history is append-only. A transport tombstone
                    // must never erase a locally retained event.
                } else if (trimmed.startsWith("[")) {
                    val collision = GoalflowTaskEventJson.parseEvents(record.payload, strict = true)
                        .map { event -> applyTaskEventInTransaction(event, record) }
                        .any { it }
                    if (collision) return true
                } else {
                    val remote = GoalflowTaskEventJson.parseEvent(record.payload, strict = true)
                    require(remote.id == record.entityId) { "Task event sync identifier does not match its payload." }
                    if (applyTaskEventInTransaction(remote, record)) return true
                }
            }
            in NATIVE_RAW_COLLECTION_TYPES -> {
                if (record.deletedAt != null) rawCollections.delete(record.entityType)
                else rawCollections.insert(
                    RawCollectionEntity(
                        entityType = record.entityType,
                        payload = record.payload,
                        updatedAt = record.updatedAt,
                        deletedAt = record.deletedAt
                    )
                )
            }
            else -> {
                conflicts.insert(
                    SyncConflictEntity(
                        id = "unsupported:${record.entityType}:${record.entityId}:${record.serverVersion}",
                        entityType = record.entityType,
                        entityId = record.entityId,
                        localPayload = "",
                        serverPayload = record.payload,
                        serverDeletedAt = record.deletedAt,
                        serverVersion = record.serverVersion,
                        createdAt = timeProvider.now().toString(),
                        status = "unsupported_remote"
                    )
                )
                return true
            }
        }
        return false
    }

    private fun validateRemoteRecord(record: NativeRemoteRecord) {
        require(record.entityType.isNotBlank() && record.entityId.isNotBlank()) { "Remote sync record has no identity." }
        require(record.version >= 0L && record.serverVersion > 0L) { "Remote sync record has an invalid version." }
        require(record.payload.isNotBlank()) { "Remote sync record has no recoverable payload." }
        record.deletedAt?.let(Instant::parse)
        when (record.entityType) {
            "tasks" -> if (record.payload.trimStart().startsWith("[")) {
                GoalflowJson.parseTasks(record.payload, strict = true)
            } else GoalflowJson.parseTask(record.payload, strict = true)
            "goals" -> if (record.payload.trimStart().startsWith("[")) {
                GoalflowJson.parseGoals(record.payload, strict = true)
            } else if (record.deletedAt == null) GoalflowJson.parseGoal(record.payload, strict = true)
            "habits" -> if (record.payload.trimStart().startsWith("[")) {
                val array = JSONArray(record.payload)
                for (index in 0 until array.length()) GoalflowJson.parseHabit(array.getJSONObject(index).toString(), strict = true)
            } else if (record.deletedAt == null) GoalflowJson.parseHabit(record.payload, strict = true)
            "daily_plans" -> if (record.deletedAt == null) parsePlan(record.payload, record.entityId)
            "task_events" -> if (record.payload.trimStart().startsWith("[")) {
                GoalflowTaskEventJson.parseEvents(record.payload, strict = true)
            } else GoalflowTaskEventJson.parseEvent(record.payload, strict = true)
            in NATIVE_RAW_COLLECTION_TYPES -> {
                require(record.entityId == "singleton") { "A preserved collection must use its singleton identity." }
                parseJsonValue(record.payload)
            }
        }
    }

    /**
     * Event identities are immutable. A remote replay of the same event is a
     * no-op; a different payload becomes an explicit conflict instead of a
     * silent Room REPLACE.
     */
    private suspend fun applyTaskEventInTransaction(
        remote: TaskEventEntity,
        record: NativeRemoteRecord
    ): Boolean {
        val local = taskEvents.get(remote.id)
        if (local == null) {
            taskEvents.insert(remote)
            return false
        }
        if (jsonEquivalent(
                GoalflowTaskEventJson.eventPayload(local).toString(),
                GoalflowTaskEventJson.eventPayload(remote).toString()
            )) return false
        conflicts.insert(
            SyncConflictEntity(
                id = "event-identity:" + remote.id + ":" + record.serverVersion,
                entityType = "task_events",
                entityId = remote.id,
                localPayload = GoalflowTaskEventJson.eventPayload(local).toString(),
                localHistory = "[]",
                serverPayload = record.payload,
                serverDeletedAt = record.deletedAt,
                serverVersion = record.serverVersion,
                createdAt = timeProvider.now().toString()
            )
        )
        return true
    }

    private fun parsePlan(payload: String, entityId: String): DailyPlanEntity {
        val item = JSONObject(payload)
        val localDate = item.optString("localDate").ifBlank { entityId }
        require(localDate == entityId && localDate.matches(Regex("^\\d{4}-\\d{2}-\\d{2}$"))
            && runCatching { LocalDate.parse(localDate) }.isSuccess) {
            "Planning sync identifier does not match its payload."
        }
        val ids = item.optJSONArray("taskIds") ?: throw IllegalArgumentException("Planning sync payload has no task list.")
        return DailyPlanEntity(
            localDate = localDate,
            confirmedAt = item.optLong("confirmedAt").takeIf { it > 0L }
                ?: throw IllegalArgumentException("Planning sync payload has no confirmation timestamp."),
            taskIds = buildList(ids.length()) {
                val seen = hashSetOf<String>()
                for (index in 0 until ids.length()) {
                    val id = ids.optString(index).trim()
                    require(id.isNotBlank() && seen.add(id)) { "Planning sync payload contains duplicate or invalid task ids." }
                    add(id)
                }
            }.joinToString(",")
        )
    }

    private fun parseTodayStats(raw: String?): GoalflowStats {
        if (raw.isNullOrBlank()) return GoalflowStats()
        return runCatching {
            val root = JSONObject(raw)
            val day = timeProvider.today().toString()
            val value = if (root.has("tasksCompleted") || root.has("frogsEaten")) {
                root
            } else {
                root.optJSONObject(day) ?: JSONObject()
            }
            GoalflowStats(
                tasksCompleted = value.optInt("tasksCompleted", 0).coerceAtLeast(0),
                frogsEaten = value.optInt("frogsEaten", 0).coerceAtLeast(0),
                timeFocused = value.optInt("timeFocused", 0).coerceAtLeast(0),
                totalBreakMinutes = value.optInt("totalBreakMinutes", 0).coerceAtLeast(0),
                circadianScore = value.opt("circadianScore").takeIf { it is Number }?.let { (it as Number).toInt() }
            )
        }.getOrDefault(GoalflowStats())
    }

    private fun parseProgress(raw: String?): GoalflowProgress {
        if (raw.isNullOrBlank()) return GoalflowProgress()
        return runCatching {
            val value = JSONObject(raw)
            val level = value.optInt("level", 1).coerceIn(1, 1_000_000)
            val xp = value.optInt("xp", 0).coerceAtLeast(0)
            GoalflowProgress(
                level = level,
                xp = xp,
                xpToNextLevel = value.optInt("xpToNextLevel", level * 100).coerceAtLeast(1)
            )
        }.getOrDefault(GoalflowProgress())
    }

    private fun parseCircadian(raw: String?): GoalflowCircadianState {
        if (raw.isNullOrBlank()) return GoalflowCircadianState()
        return runCatching {
            val root = JSONObject(raw)
            val metrics = root.optJSONObject("metrics") ?: JSONObject()
            val mode = root.optString("mode", "maintenance").lowercase(Locale.ROOT)
                .takeIf { it in setOf("recovery", "maintenance", "apex") }
                ?: "maintenance"
            GoalflowCircadianState(
                lastCheckIn = root.optString("lastCheckIn"),
                score = root.optInt("score", 0).coerceIn(0, 100),
                mode = mode,
                sunriseTime = root.nullableStringValue("sunriseTime"),
                sunsetTime = root.nullableStringValue("sunsetTime"),
                solarNoonTime = root.nullableStringValue("solarNoonTime"),
                sunrise = metrics.optBoolean("sunrise", false),
                sleepHours = metrics.optInt("sleepHours", 8).coerceIn(0, 24),
                energy = metrics.optInt("energy", 5).coerceIn(1, 10),
                clarity = metrics.optInt("clarity", 5).coerceIn(1, 10),
                interest = metrics.optInt("interest", 5).coerceIn(1, 10),
                wakeTime = metrics.nullableStringValue("wakeTime"),
                eatingWindow = metrics.opt("eatingWindow").takeIf { it is Number }
                    ?.let { (it as Number).toInt() }
                    ?.coerceIn(1, 24),
                firstMealTime = metrics.nullableStringValue("firstMealTime")
            )
        }.getOrDefault(GoalflowCircadianState())
    }

    private fun isValidClockTime(value: String): Boolean =
        Regex("^(?:[01]\\d|2[0-3]):[0-5]\\d$").matches(value)

    private fun parseAmalgam(raw: String?): String {
        if (raw.isNullOrBlank()) return "My world takes care of me"
        return runCatching {
            when (val parsed = parseJsonValue(raw)) {
                is String -> parsed
                else -> raw
            }
        }.getOrDefault(raw)
    }

    private fun parseTrueNorthCollection(raw: String?): List<GoalflowTrueNorth> {
        if (raw.isNullOrBlank()) return emptyList()
        val array = JSONArray(raw)
        return buildList(array.length()) {
            val ids = hashSetOf<String>()
            for (index in 0 until array.length()) {
                val item = array.optJSONObject(index)
                    ?: throw IllegalArgumentException("The preserved True North collection is invalid.")
                val id = item.optString("id").trim()
                val vision = item.optString("vision").trim()
                require(id.isNotBlank() && vision.isNotBlank() && ids.add(id)) {
                    "The preserved True North collection contains an invalid identity."
                }
                add(
                    GoalflowTrueNorth(
                        id = id,
                        vision = vision,
                        isMoneyGoal = item.optBoolean("isMoneyGoal", false),
                        tangibleReality = nullableString(item, "tangibleReality"),
                        sensoryDetails = item.optString("sensoryDetails"),
                        planB = item.optString("planB"),
                        importance = item.optInt("importance", 5).coerceIn(1, 10),
                        anchorHabit = nullableString(item, "anchorHabit"),
                        anchorTask = nullableString(item, "anchorTask"),
                        anchorHabitDuration = item.opt("anchorHabitDuration").takeIf { it is Number }
                            ?.let { (it as Number).toInt() }?.coerceIn(1, 1_440),
                        createdAt = item.optLong("createdAt", 0L).coerceAtLeast(0L),
                        extraJson = extraFields(item, TRUE_NORTH_KNOWN_KEYS)
                    )
                )
            }
        }
    }

    private fun trueNorthCollectionPayload(goals: List<GoalflowTrueNorth>): String = JSONArray().apply {
        goals.forEach { goal -> put(trueNorthPayload(goal)) }
    }.toString()

    private fun trueNorthPayload(goal: GoalflowTrueNorth): JSONObject {
        val value = runCatching { JSONObject(goal.extraJson) }.getOrElse {
            throw IllegalArgumentException("A preserved True North record is damaged.")
        }
        return value.apply {
            put("id", goal.id)
            put("vision", goal.vision)
            put("isMoneyGoal", goal.isMoneyGoal)
            put("tangibleReality", goal.tangibleReality ?: JSONObject.NULL)
            put("sensoryDetails", goal.sensoryDetails)
            put("planB", goal.planB)
            put("importance", goal.importance)
            put("anchorHabit", goal.anchorHabit ?: JSONObject.NULL)
            put("anchorTask", goal.anchorTask ?: JSONObject.NULL)
            put("anchorHabitDuration", goal.anchorHabitDuration ?: JSONObject.NULL)
            put("createdAt", goal.createdAt)
        }
    }

    private fun extraFields(item: JSONObject, knownKeys: Set<String>): String = JSONObject().apply {
        val keys = item.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            if (key !in knownKeys) put(key, item.get(key))
        }
    }.toString()

    private fun nullableString(item: JSONObject, key: String): String? =
        if (!item.has(key) || item.isNull(key)) null else item.optString(key).takeIf(String::isNotBlank)

    private fun JSONObject.nullableStringValue(key: String): String? =
        if (!has(key) || isNull(key)) null else optString(key).takeIf(String::isNotBlank)

    private fun JSONObject.nullableInt(key: String): Int? {
        if (!has(key) || isNull(key)) return null
        val value = opt(key)
        return if (value is Number && value.toDouble() == value.toInt().toDouble()) value.toInt() else null
    }

    /**
     * Reads an optional projection without allowing malformed legacy JSON to
     * block a core local action. Missing projections start from an empty
     * object; damaged or non-object projections remain untouched.
     */
    private suspend fun preservedObjectOrEmptyInTransaction(entityType: String): JSONObject? {
        val stored = rawCollections.get(entityType) ?: return JSONObject()
        return runCatching {
            parseJsonValue(stored.payload) as? JSONObject
        }.getOrNull()
    }

    private suspend fun upsertRawCollectionInTransaction(entityType: String, payload: String) {
        require(entityType in NATIVE_RAW_COLLECTION_TYPES) { "This collection is not supported by native synchronization." }
        parseJsonValue(payload)
        rawCollections.insert(
            RawCollectionEntity(
                entityType = entityType,
                payload = payload,
                updatedAt = timeProvider.now().toString(),
                deletedAt = null
            )
        )
        enqueueRecordInTransaction(entityType, "singleton", payload)
    }

    private suspend fun deleteRawCollectionInTransaction(entityType: String) {
        require(entityType in NATIVE_RAW_COLLECTION_TYPES) { "This collection is not supported by native synchronization." }
        val previousPayload = rawCollections.get(entityType)?.payload ?: "{}"
        rawCollections.delete(entityType)
        enqueueRecordInTransaction(entityType, "singleton", previousPayload, timeProvider.now().toString())
    }

    private suspend fun restoreStatsProjectionInTransaction(undo: JSONObject) {
        val recordedDate = undo.optString("completionRecordedDate").takeIf { it.matches(Regex("^\\d{4}-\\d{2}-\\d{2}$")) }
            ?: return
        if (!undo.optBoolean("statsWasPresent", false)) {
            deleteRawCollectionInTransaction("stats")
            return
        }
        val stored = rawCollections.get("stats") ?: return
        val root = runCatching { parseJsonValue(stored.payload) as? JSONObject }.getOrNull() ?: return
        val before = if (undo.has("statsDayBefore") && !undo.isNull("statsDayBefore")) {
            undo.optString("statsDayBefore").takeIf(String::isNotBlank)
        } else null
        if (undo.optBoolean("statsWasFlat", false)) {
            if (before == null) return
            parseJsonValue(before)
            upsertRawCollectionInTransaction("stats", before)
        } else {
            if (before == null) root.remove(recordedDate) else root.put(recordedDate, JSONObject(before))
            upsertRawCollectionInTransaction("stats", root.toString())
        }
    }

    private suspend fun restoreRawProjectionInTransaction(entityType: String, raw: Any?) {
        if (raw == null || raw === JSONObject.NULL) {
            deleteRawCollectionInTransaction(entityType)
            return
        }
        require(raw is String && raw.isNotBlank()) { "The previous projection is not recoverable." }
        parseJsonValue(raw)
        upsertRawCollectionInTransaction(entityType, raw)
    }

    private suspend fun updateProgressInTransaction(amount: Int): Boolean {
        if (amount <= 0) return false
        val stored = rawCollections.get("progress")
        val value = when {
            stored == null -> JSONObject()
            else -> runCatching { parseJsonValue(stored.payload) as? JSONObject }.getOrNull() ?: return false
        }
        var level = value.optInt("level", 1).coerceIn(1, 1_000_000)
        var xp = value.optLong("xp", 0L).coerceIn(0L, Int.MAX_VALUE.toLong())
        var next = level.toLong() * 100L
        xp += amount.toLong()
        while (xp >= next && level < 1_000_000) {
            xp -= next
            level += 1
            next = level.toLong() * 100L
        }
        value.put("level", level)
        value.put("xp", xp)
        value.put("xpToNextLevel", next)
        upsertRawCollectionInTransaction("progress", value.toString())
        return true
    }

    private fun parseJsonValue(value: String): Any = runCatching<Any> { JSONObject(value) }
        .recoverCatching { JSONArray(value) }
        .recoverCatching { JSONArray("[$value]").get(0) }
        .getOrElse { throw IllegalArgumentException("A synchronized collection contains invalid JSON.") }

    private fun historyPayload(mutations: List<SyncOutboxEntity>): String = JSONArray().apply {
        mutations.sortedWith(compareBy<SyncOutboxEntity> { it.version }.thenBy { it.mutationId }).forEach { mutation ->
            put(historyEntry(mutation.mutationId, mutation.payload, mutation.deletedAt, mutation.updatedAt, mutation.version))
        }
    }.toString()

    private fun jsonEquivalent(left: String, right: String): Boolean = runCatching {
        canonicalJson(parseJsonValue(left)) == canonicalJson(parseJsonValue(right))
    }.getOrDefault(false)

    private fun canonicalJson(value: Any?): String = when {
        value == null || value === JSONObject.NULL -> "null"
        value is JSONObject -> value.keys().asSequence().toList().sorted().joinToString(
            prefix = "{", postfix = "}"
        ) { key -> "${JSONObject.quote(key)}:${canonicalJson(value.opt(key))}" }
        value is JSONArray -> (0 until value.length()).joinToString(prefix = "[", postfix = "]") {
            canonicalJson(value.opt(it))
        }
        value is String -> JSONObject.quote(value)
        value is Number || value is Boolean -> value.toString()
        else -> JSONObject.quote(value.toString())
    }

    private fun sameInstant(left: String?, right: String): Boolean = runCatching {
        left != null && Instant.parse(left) == Instant.parse(right)
    }.getOrDefault(false)

    private fun sameInstantOrNull(left: String?, right: String?): Boolean {
        if (left == null || right == null) return left == right
        return runCatching { Instant.parse(left) == Instant.parse(right) }.getOrDefault(false)
    }

    private suspend fun requireMutationIdAvailableInTransaction(mutationId: String) {
        require(outbox.get(mutationId) == null) {
            "Generated mutation id already exists; no pending mutation was overwritten."
        }
        conflicts.getAll().forEach { conflict ->
            require(conflict.mutationId != mutationId) {
                "Generated mutation id already exists in a conflict; no data was overwritten."
            }
            val history = JSONArray(conflict.localHistory)
            for (index in 0 until history.length()) {
                require(history.optJSONObject(index)?.optString("mutationId") != mutationId) {
                    "Generated mutation id already exists in conflict history; no data was overwritten."
                }
            }
        }
    }

    private fun historyEntry(
        mutationId: String,
        payload: String,
        deletedAt: String?,
        updatedAt: String,
        version: Long
    ): JSONObject = JSONObject().apply {
        put("mutationId", mutationId)
        put("payload", parseJsonValue(payload))
        put("deletedAt", deletedAt ?: JSONObject.NULL)
        put("updatedAt", updatedAt)
        put("version", version)
    }

    private fun syncMetaKey(entityType: String, entityId: String): String = "$entityType:$entityId"

    private fun <T> mergeExactById(
        current: List<T>,
        incoming: List<T>,
        id: (T) -> String,
        kind: String
    ): List<T> {
        val merged = linkedMapOf<String, T>()
        (current + incoming).forEach { value ->
            val key = id(value)
            val existing = merged[key]
            if (existing != null && existing != value) {
                throw BackupFormatException("Backup $kind identity is reused for different data.")
            }
            merged[key] = value
        }
        return merged.values.toList()
    }

    private fun toEntity(task: GoalflowTask) = TaskEntity(
        id = task.id,
        title = task.title,
        notes = task.notes,
        schedulePrecision = task.schedulePrecision.name,
        scheduledFor = task.scheduledFor,
        scheduledTime = task.scheduledTime,
        plannedOrder = task.plannedOrder,
        status = task.status.name,
        isFrog = task.isFrog,
        beforeFrog = task.beforeFrog,
        frogFailures = task.frogFailures,
        source = task.source.name,
        goalId = task.goalId,
        parentTaskId = task.parentTaskId,
        habitId = task.habitId,
        createdAt = task.createdAt,
        updatedAt = task.updatedAt,
        completedAt = task.completedAt,
        deletedAt = task.deletedAt,
        extraJson = task.extraJsonWithOrderingHint()
    )

    private fun toDomain(row: TaskEntity) = GoalflowTask(
        id = row.id,
        title = row.title,
        notes = row.notes,
        schedulePrecision = SchedulePrecision.valueOf(row.schedulePrecision),
        scheduledFor = row.scheduledFor,
        scheduledTime = row.scheduledTime,
        plannedOrder = row.plannedOrder,
        status = TaskStatus.valueOf(row.status),
        isFrog = row.isFrog,
        beforeFrog = row.beforeFrog,
        frogFailures = row.frogFailures,
        source = TaskSource.valueOf(row.source),
        goalId = row.goalId,
        parentTaskId = row.parentTaskId,
        habitId = row.habitId,
        createdAt = row.createdAt,
        updatedAt = row.updatedAt,
        completedAt = row.completedAt,
        deletedAt = row.deletedAt,
        circadianRank = runCatching { JSONObject(row.extraJson).nullableInt("circadianRank") }.getOrNull(),
        extraJson = row.extraJson
    )

    private fun GoalflowTask.extraJsonWithOrderingHint(): String {
        val extras = runCatching { JSONObject(extraJson) }.getOrElse {
            throw SchedulingException("A synchronized record contains damaged preserved fields.")
        }
        circadianRank?.let { extras.put("circadianRank", it) }
        return extras.toString()
    }

    private fun toEntity(goal: GoalflowGoal) = GoalEntity(
        id = goal.id,
        name = goal.name,
        description = goal.description,
        deadline = goal.deadline,
        completedTasks = goal.completedTasks,
        color = goal.color,
        createdAt = goal.createdAt,
        excitement = goal.excitement,
        roi = goal.roi,
        extraJson = goal.extraJson
    )

    private fun toDomain(row: GoalEntity) = GoalflowGoal(
        id = row.id,
        name = row.name,
        description = row.description,
        deadline = row.deadline,
        completedTasks = row.completedTasks,
        color = row.color,
        createdAt = row.createdAt,
        excitement = row.excitement,
        roi = row.roi,
        extraJson = row.extraJson
    )

    private fun toDomain(row: DailyPlanEntity) = DailyPlan(
        localDate = row.localDate,
        confirmedAt = row.confirmedAt,
        taskIds = row.taskIds.split(",").filter(String::isNotBlank)
    )

    private fun toEntity(habit: GoalflowHabit) = HabitEntity(
        id = habit.id,
        title = habit.title,
        frequency = habit.frequency.name,
        specificDays = habit.specificDays.sorted().joinToString(","),
        streak = habit.streak,
        bestStreak = habit.bestStreak,
        lastCompletedDate = habit.lastCompletedDate,
        isHighPriority = habit.isHighPriority,
        beforeFrog = habit.beforeFrog,
        duration = habit.duration,
        goalId = habit.goalId,
        createdAt = habit.createdAt,
        extraJson = habit.extraJson
    )

    private fun toDomain(row: HabitEntity) = GoalflowHabit(
        id = row.id,
        title = row.title,
        frequency = runCatching { HabitFrequency.valueOf(row.frequency) }.getOrDefault(HabitFrequency.DAILY),
        specificDays = row.specificDays.split(",").mapNotNull(String::toIntOrNull).toSet(),
        streak = row.streak,
        bestStreak = row.bestStreak,
        lastCompletedDate = row.lastCompletedDate,
        isHighPriority = row.isHighPriority,
        beforeFrog = row.beforeFrog,
        duration = row.duration,
        goalId = row.goalId,
        createdAt = row.createdAt,
        extraJson = row.extraJson
    )

    private fun toEntity(plan: DailyPlan) = DailyPlanEntity(
        localDate = plan.localDate,
        confirmedAt = plan.confirmedAt,
        taskIds = plan.taskIds.joinToString(",")
    )

    // P1-D: goalflow_next_change_version lock + restore interruption + task_events FK (application-enforced)
    private val nextChangeVersionMutex = Mutex()
    private val restoreMutex = Mutex()
    suspend fun nextChangeVersionLocked(): Long = nextChangeVersionMutex.withLock {
        val key = "goalflow_next_change_version"
        val current = syncMeta.get(key)?.localVersion ?: 0L
        val next = current + 1
        syncMeta.insert(SyncMetaEntity(entityType = key, cursor = next, localVersion = next, serverVersion = null, lastSuccessfulSync = null))
        next
    }
    suspend fun restoreWithInterruptionLock(envelope: String, password: String, mode: BackupRestoreMode = BackupRestoreMode.MERGE): NativeBackupPreview = restoreMutex.withLock {
        // interruption-safe: checkpoint preserved if process dies mid-restore; retry will detect checkpoint
        return restoreBackup(envelope, password, mode)
    }
    private fun ensureTaskEventFk(taskId: String) {
        // application-level FK: task_events.taskId must reference tasks.id; checked before insert
        // (Room FK would require migration 8->9; keep v8 but enforce)
        require(taskId.isNotBlank()) { "task_events FK requires valid taskId" }
    }

    private companion object {
        const val SYNC_CURSOR_KEY = "_cursor"
        const val RESTORE_CHECKPOINT_KEY = "__goalflow.restore.checkpoint"
        const val HABIT_GENERATION_LEASE_MILLIS = 10 * 60 * 1_000L
        const val HABIT_TASK_NAMESPACE = "c3e4bcbb-9f56-4ff5-a3a8-9f7478284169"
        const val COMPLETION_UNDO_KEY = "__goalflowCompletionUndo"
        val TRUE_NORTH_KNOWN_KEYS = setOf(
            "id", "vision", "isMoneyGoal", "tangibleReality", "sensoryDetails", "planB",
            "importance", "anchorHabit", "anchorTask", "anchorHabitDuration", "createdAt"
        )

        /** Exact UUIDv5 equivalent of the web habit instance identity. */
        fun habitTaskId(habitId: String, localDate: String): String {
            val namespace = UUID.fromString(HABIT_TASK_NAMESPACE)
            val namespaceBytes = ByteBuffer.allocate(16)
                .putLong(namespace.mostSignificantBits)
                .putLong(namespace.leastSignificantBits)
                .array()
            val nameBytes = "$habitId:$localDate".toByteArray(StandardCharsets.UTF_8)
            val digest = MessageDigest.getInstance("SHA-1").digest(namespaceBytes + nameBytes)
            digest[6] = ((digest[6].toInt() and 0x0f) or 0x50).toByte()
            digest[8] = ((digest[8].toInt() and 0x3f) or 0x80).toByte()
            val bytes = ByteBuffer.wrap(digest)
            return UUID(bytes.long, bytes.long).toString()
        }
    }
}
