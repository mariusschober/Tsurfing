package com.mariusschober.goalflow.nativeapp.ui

import android.content.Intent
import android.net.Uri
import android.view.HapticFeedbackConstants
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.BackHandler
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedContent
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.ArrowForward
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.ArrowDownward
import androidx.compose.material.icons.rounded.ArrowUpward
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.DateRange
import androidx.compose.material.icons.rounded.Flag
import androidx.compose.material.icons.rounded.MoreHoriz
import androidx.compose.material.icons.rounded.Repeat
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.material.icons.rounded.TaskAlt
import androidx.compose.material.icons.rounded.Timeline
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.Slider
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.withFrameNanos
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.zIndex
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.viewmodel.compose.viewModel
import com.mariusschober.goalflow.nativeapp.GoalflowApplication
import com.mariusschober.goalflow.nativeapp.R
import com.mariusschober.goalflow.nativeapp.domain.GoalflowGoal
import com.mariusschober.goalflow.nativeapp.domain.GoalflowCircadianState
import com.mariusschober.goalflow.nativeapp.domain.GoalflowTask
import com.mariusschober.goalflow.nativeapp.domain.BreakdownChild
import com.mariusschober.goalflow.nativeapp.domain.PlanningGate
import com.mariusschober.goalflow.nativeapp.domain.SchedulePrecision
import com.mariusschober.goalflow.nativeapp.data.NATIVE_RAW_COLLECTION_TYPES
import com.mariusschober.goalflow.nativeapp.data.BackupRestoreMode
import com.mariusschober.goalflow.nativeapp.data.NativeBackupPreview
import com.mariusschober.goalflow.nativeapp.sync.NativeAuthClient
import com.mariusschober.goalflow.nativeapp.sync.NativeConfig
import com.mariusschober.goalflow.nativeapp.sync.NativeOAuthFlow
import com.mariusschober.goalflow.nativeapp.sync.NativeSyncScheduler
import com.mariusschober.goalflow.nativeapp.sync.NativeTelegramStatus
import com.mariusschober.goalflow.nativeapp.sync.PendingEmailOtpAttempt
import com.mariusschober.goalflow.nativeapp.time.datePickerMillisToLocalDate
import com.mariusschober.goalflow.nativeapp.time.localDateToDatePickerMillis
import java.time.LocalDate
import java.time.YearMonth
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale
import kotlin.math.ceil
import androidx.compose.foundation.layout.RowScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

private enum class RootDestination(val label: String) {
    CURRENT("Current"),
    PLANNING("Planning"),
    HABITS("Habits"),
    GOALS("Goals"),
    INSIGHTS("Insights"),
    SETTINGS("Settings")
}

private val primaryDestinations = listOf(
    RootDestination.CURRENT,
    RootDestination.PLANNING,
    RootDestination.HABITS,
    RootDestination.GOALS,
    RootDestination.SETTINGS
)

@Composable
fun GoalflowRoot(
    externalCaptureText: String? = null,
    externalCaptureRequest: Int = 0,
    authSessionRevision: Int = 0,
    onExternalCaptureConsumed: () -> Unit = {}
) {
    val application = LocalContext.current.applicationContext as GoalflowApplication
    val context = LocalContext.current
    val localView = LocalView.current
    val scope = rememberCoroutineScope()
    val goalflowViewModel: GoalflowViewModel = viewModel(
        factory = GoalflowViewModelFactory(application.repository, application.syncEngine)
    )
    val tasks by goalflowViewModel.tasks.collectAsStateWithLifecycle()
    val goals by goalflowViewModel.goals.collectAsStateWithLifecycle()
    val habits by goalflowViewModel.habits.collectAsStateWithLifecycle()
    val habitGenerationFailures by goalflowViewModel.habitGenerationFailures.collectAsStateWithLifecycle()
    val stats by goalflowViewModel.stats.collectAsStateWithLifecycle()
    val progress by goalflowViewModel.progress.collectAsStateWithLifecycle()
    val circadian by goalflowViewModel.circadian.collectAsStateWithLifecycle()
    val trueNorth by goalflowViewModel.trueNorth.collectAsStateWithLifecycle()
    val amalgam by goalflowViewModel.amalgam.collectAsStateWithLifecycle()
    val today by goalflowViewModel.today.collectAsStateWithLifecycle()
    val gate by goalflowViewModel.planningGate.collectAsStateWithLifecycle()
    val currentTask by goalflowViewModel.currentTask.collectAsStateWithLifecycle()
    val notice by goalflowViewModel.notice.collectAsStateWithLifecycle()
    val error by goalflowViewModel.error.collectAsStateWithLifecycle()
    val conflicts by goalflowViewModel.conflicts.collectAsStateWithLifecycle()
    val undoTaskId by goalflowViewModel.undoTaskId.collectAsStateWithLifecycle()
    val reorderUndo by goalflowViewModel.reorderUndo.collectAsStateWithLifecycle()
    val capturePromptSeen by application.preferences.capturePromptSeen.collectAsStateWithLifecycle(
        initialValue = null
    )
    val sandboxAccessGranted by application.preferences.sandboxAccessGranted.collectAsStateWithLifecycle(
        initialValue = !NativeConfig.isSandboxBuild
    )

    if (NativeConfig.isSandboxBuild && !sandboxAccessGranted) {
        GoalflowTheme {
            GoalflowSandboxGate(
                onGranted = {
                    scope.launch { application.preferences.markSandboxAccessGranted() }
                }
            )
        }
        return
    }

    var destination by rememberSaveable { mutableStateOf(RootDestination.CURRENT) }
    var captureOpen by rememberSaveable { mutableStateOf(false) }
    var captureSeed by rememberSaveable { mutableStateOf("") }
    var captureFormKey by rememberSaveable { mutableStateOf(0) }
    var capturePromptLoaded by rememberSaveable { mutableStateOf(false) }
    var datePickerForTask by remember { mutableStateOf<GoalflowTask?>(null) }
    var editTask by remember { mutableStateOf<GoalflowTask?>(null) }
    var backupAction by rememberSaveable { mutableStateOf<String?>(null) }
    var backupError by rememberSaveable { mutableStateOf<String?>(null) }
    var authError by rememberSaveable { mutableStateOf<String?>(null) }
    var signInOpen by rememberSaveable { mutableStateOf(false) }
    var mfaOpen by rememberSaveable { mutableStateOf(false) }
    var circadianOpen by rememberSaveable { mutableStateOf(false) }
    var focusTask by remember { mutableStateOf<GoalflowTask?>(null) }
    var focusStartedAt by remember { mutableStateOf<Long?>(null) }
    fun readUsableStoredSession() = application.sessionStore.read()?.takeIf {
        application.sessionStore.getPendingEmailOtp() == null
            && application.sessionStore.getPendingOAuth()?.flow !in setOf(
                NativeOAuthFlow.TELEGRAM_SIGN_IN,
                NativeOAuthFlow.TELEGRAM_ACTIVATION
            )
    }
    var sessionActive by remember { mutableStateOf(readUsableStoredSession() != null) }
    var sessionAssuranceLevel by remember {
        mutableStateOf(application.sessionStore.read()?.assuranceLevel ?: "aal1")
    }
    var sessionStorageProblem by remember {
        mutableStateOf(application.sessionStore.readProblem())
    }
    var telegramStatus by remember { mutableStateOf<NativeTelegramStatus?>(null) }
    var telegramStatusMessage by rememberSaveable { mutableStateOf<String?>(null) }
    var telegramWorking by rememberSaveable { mutableStateOf(false) }
    var breakdownTask by remember { mutableStateOf<GoalflowTask?>(null) }
    var pendingExportPassword by remember { mutableStateOf<String?>(null) }
    var pendingImportUri by remember { mutableStateOf<Uri?>(null) }
    var pendingRestoreContents by remember { mutableStateOf<String?>(null) }
    var pendingRestorePassword by remember { mutableStateOf<String?>(null) }
    var restorePreview by remember { mutableStateOf<NativeBackupPreview?>(null) }
    var replaceRestoreConfirmation by remember { mutableStateOf(false) }
    var restoreInProgress by remember { mutableStateOf(false) }
    var restoreCheckpointAvailable by remember { mutableStateOf(false) }
    val snackbarHostState = remember { SnackbarHostState() }
    val lifecycleOwner = LocalLifecycleOwner.current

    LaunchedEffect(sessionStorageProblem) {
        sessionStorageProblem?.let { snackbarHostState.showSnackbar(it, duration = SnackbarDuration.Long) }
    }

    // Room is the source of truth for recovery. Query it directly before
    // observing the task stream so an initial empty StateFlow value cannot
    // erase a valid session during process recreation.
    LaunchedEffect(Unit) {
        val storedFocus = application.focusSessionStore.read() ?: return@LaunchedEffect
        val storedTask = application.repository.taskSnapshot(storedFocus.taskId)
        if (storedTask == null || storedTask.status.name != "OPEN" || storedTask.deletedAt != null) {
            application.focusSessionStore.clear()
        } else {
            focusStartedAt = storedFocus.startedAtMillis
            focusTask = storedTask
        }
    }

    LaunchedEffect(Unit) {
        restoreCheckpointAvailable = application.repository.hasRestoreCheckpoint()
    }

    LaunchedEffect(authSessionRevision) {
        val authClient = NativeAuthClient(application.sessionStore)
        val resumedEmail = if (application.sessionStore.getPendingEmailOtp() != null
            && application.sessionStore.read() != null
        ) {
            runCatching { authClient.resumePendingEmailActivation() }
                .onFailure { authError = it.message ?: "Account activation could not be completed." }
                .getOrNull()
        } else null
        val resumedTelegram = if (application.sessionStore.getPendingOAuth()?.flow in setOf(
                NativeOAuthFlow.TELEGRAM_SIGN_IN,
                NativeOAuthFlow.TELEGRAM_ACTIVATION,
                NativeOAuthFlow.TELEGRAM_LINK
            ) && application.sessionStore.read() != null
        ) {
            runCatching { authClient.resumePendingTelegramFlow() }
                .onFailure { authError = it.message ?: "Telegram verification could not be completed." }
                .getOrNull()
        } else null
        val currentSession = readUsableStoredSession()
        sessionActive = currentSession != null
        sessionAssuranceLevel = if (sessionActive) currentSession?.assuranceLevel ?: "aal1" else "aal1"
        sessionStorageProblem = application.sessionStore.readProblem()
        if (resumedEmail != null || resumedTelegram != null) {
            authError = null
            NativeSyncScheduler.schedule(context)
            snackbarHostState.showSnackbar(
                if (resumedTelegram != null) "Telegram verification completed after reconnecting."
                else "Email verification completed after reconnecting."
            )
        }
    }

    LaunchedEffect(sessionActive, sessionAssuranceLevel, authSessionRevision) {
        application.foregroundSyncCoordinator.sessionChanged()
        if (!sessionActive || !NativeConfig.canUseTelegram) {
            telegramStatus = null
            telegramStatusMessage = null
            telegramWorking = false
            return@LaunchedEffect
        }
        telegramWorking = true
        runCatching { NativeAuthClient(application.sessionStore).telegramStatus() }
            .onSuccess {
                telegramStatus = it
                telegramStatusMessage = null
            }
            .onFailure {
                telegramStatus = null
                telegramStatusMessage = it.message ?: "Telegram status could not be loaded."
            }
        telegramWorking = false
    }

    LaunchedEffect(tasks) {
        val storedFocus = application.focusSessionStore.read() ?: return@LaunchedEffect
        // The first StateFlow value can be an empty placeholder. Only update
        // recovery state once the task stream actually contains this task.
        val currentTask = tasks.firstOrNull { it.id == storedFocus.taskId } ?: return@LaunchedEffect
        if (currentTask.status.name != "OPEN" || currentTask.deletedAt != null) {
            application.focusSessionStore.clear()
            if (focusTask?.id == storedFocus.taskId) {
                focusTask = null
                focusStartedAt = null
            }
        } else if (focusTask?.id == storedFocus.taskId) {
            focusTask = currentTask
        } else if (focusTask == null) {
            focusStartedAt = storedFocus.startedAtMillis
            focusTask = currentTask
        }
    }

    fun closeCapture() {
        scope.launch { application.preferences.markCapturePromptSeen() }
        captureSeed = ""
        captureOpen = false
    }

    fun openCapture(initialTitle: String = "") {
        if (focusTask != null) return
        captureSeed = initialTitle
        captureFormKey += 1
        captureOpen = true
    }

    LaunchedEffect(externalCaptureRequest) {
        if (externalCaptureRequest > 0) {
            openCapture(externalCaptureText.orEmpty())
            onExternalCaptureConsumed()
        }
    }

    LaunchedEffect(capturePromptSeen) {
        if (!capturePromptLoaded && capturePromptSeen != null) {
            if (capturePromptSeen == false && externalCaptureRequest == 0) openCapture()
            capturePromptLoaded = true
        }
    }

    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) {
                application.foregroundSyncCoordinator.start()
                goalflowViewModel.refreshToday()
                scope.launch {
                    val authClient = NativeAuthClient(application.sessionStore)
                    if (application.sessionStore.getPendingEmailOtp() != null
                        && application.sessionStore.read() != null
                    ) {
                        runCatching { authClient.resumePendingEmailActivation() }
                            .onFailure { authError = it.message ?: "Account activation could not be completed." }
                    }
                    if (application.sessionStore.getPendingOAuth()?.flow in setOf(
                            NativeOAuthFlow.TELEGRAM_SIGN_IN,
                            NativeOAuthFlow.TELEGRAM_ACTIVATION,
                            NativeOAuthFlow.TELEGRAM_LINK
                        ) && application.sessionStore.read() != null
                    ) {
                        runCatching { authClient.resumePendingTelegramFlow() }
                            .onFailure { authError = it.message ?: "Telegram verification could not be completed." }
                    }
                    val currentSession = readUsableStoredSession()
                    sessionActive = currentSession != null
                    sessionAssuranceLevel = if (sessionActive) currentSession?.assuranceLevel ?: "aal1" else "aal1"
                    sessionStorageProblem = application.sessionStore.readProblem()
                    if (sessionActive) NativeSyncScheduler.schedule(context)
                }
            } else if (event == Lifecycle.Event.ON_PAUSE) {
                application.foregroundSyncCoordinator.stop()
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose {
            lifecycleOwner.lifecycle.removeObserver(observer)
            application.foregroundSyncCoordinator.stop()
        }
    }

    LaunchedEffect(Unit) {
        withFrameNanos { }
        application.foregroundSyncCoordinator.start()
        NativeSyncScheduler.schedule(context)
    }

    BackHandler(enabled = destination != RootDestination.CURRENT && !captureOpen && editTask == null &&
        datePickerForTask == null && breakdownTask == null && backupAction == null && restorePreview == null &&
        !replaceRestoreConfirmation && !signInOpen && !mfaOpen && focusTask == null) {
        destination = if (destination == RootDestination.INSIGHTS) RootDestination.GOALS else RootDestination.CURRENT
    }

    // A focus session is an intentional single-task room. Back never silently
    // abandons it; the only exits are completion or an explicit breakdown.
    BackHandler(enabled = focusTask != null) { }

    val exportLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.CreateDocument("application/json")
    ) { uri ->
        val password = pendingExportPassword
        pendingExportPassword = null
        if (uri != null && password != null) {
            scope.launch {
                try {
                    val backup = application.repository.exportBackup(password)
                    context.contentResolver.openOutputStream(uri)?.use { stream ->
                        stream.write(backup.toByteArray(Charsets.UTF_8))
                    } ?: throw IllegalStateException("The backup file could not be opened.")
                    snackbarHostState.showSnackbar("Encrypted backup exported")
                } catch (error: Exception) {
                    snackbarHostState.showSnackbar(error.message ?: "Backup export failed")
                }
            }
        }
    }

    val importLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenDocument()
    ) { uri ->
        if (uri != null) {
            pendingImportUri = uri
            backupError = null
            backupAction = "import"
        }
    }

    fun clearRestorePreview() {
        restorePreview = null
        pendingRestoreContents = null
        pendingRestorePassword = null
        backupError = null
        replaceRestoreConfirmation = false
        restoreInProgress = false
    }

    fun restoreWithMode(mode: BackupRestoreMode) {
        val contents = pendingRestoreContents ?: return
        val password = pendingRestorePassword ?: return
        restoreInProgress = true
        scope.launch {
            runCatching { application.repository.restoreBackup(contents, password, mode) }
                .onSuccess {
                    clearRestorePreview()
                    restoreCheckpointAvailable = true
                    snackbarHostState.showSnackbar(
                        if (mode == BackupRestoreMode.MERGE) "Backup merged safely" else "Backup replaced safely; checkpoint saved"
                    )
                }
                .onFailure { failure ->
                    restoreInProgress = false
                    backupError = failure.message ?: "Backup restore failed"
                }
        }
    }

    LaunchedEffect(notice) {
        notice?.let {
            snackbarHostState.showSnackbar(it)
            goalflowViewModel.clearNotice()
        }
    }

    // Operations from Current/Planning do not have an inline form error
    // surface. Keep failures visible without leaving a stale error in a
    // later capture or editor sheet.
    val errorSurfaceOpen = captureOpen || circadianOpen || editTask != null ||
        breakdownTask != null || backupAction != null || signInOpen || focusTask != null ||
        destination == RootDestination.HABITS || destination == RootDestination.GOALS
    LaunchedEffect(error, errorSurfaceOpen) {
        val message = error
        if (message != null && !errorSurfaceOpen) {
            snackbarHostState.showSnackbar(message)
            goalflowViewModel.clearError()
        }
    }

    LaunchedEffect(undoTaskId) {
        val taskId = undoTaskId ?: return@LaunchedEffect
        val result = snackbarHostState.showSnackbar(
            message = "Done. Keep going.",
            actionLabel = "Undo",
            withDismissAction = true,
            duration = SnackbarDuration.Short
        )
        if (result == SnackbarResult.ActionPerformed) goalflowViewModel.undoCompletion(taskId)
        goalflowViewModel.clearUndo()
    }

    LaunchedEffect(reorderUndo) {
        val change = reorderUndo ?: return@LaunchedEffect
        val result = snackbarHostState.showSnackbar(
            message = "Order updated locally",
            actionLabel = "Undo",
            withDismissAction = true,
            duration = SnackbarDuration.Short
        )
        if (result == SnackbarResult.ActionPerformed) goalflowViewModel.undoReorder(change)
        goalflowViewModel.clearReorderUndo()
    }

    GoalflowTheme {
        if (focusTask == null) {
            Scaffold(
            modifier = Modifier.fillMaxSize(),
            snackbarHost = { SnackbarHost(snackbarHostState) },
            bottomBar = {
                GoalflowNavigationBar(destination) { destination = it }
            }
        ) { innerPadding ->
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(innerPadding)
                    .safeDrawingPadding()
            ) {
                when (destination) {
                    RootDestination.CURRENT -> CurrentScreen(
                        today = today,
                        gate = gate,
                        currentTask = currentTask,
                        onCapture = { openCapture() },
                        onPlanning = { destination = RootDestination.PLANNING },
                        onFocus = {
                            localView.performHapticFeedback(HapticFeedbackConstants.CONTEXT_CLICK)
                            focusStartedAt = application.focusSessionStore.beginOrResume(it.id).startedAtMillis
                            focusTask = it
                        },
                        onComplete = { task ->
                            goalflowViewModel.completeTask(task) {
                                localView.performHapticFeedback(HapticFeedbackConstants.CONFIRM)
                                application.soundController.playCompletion(task.isFrog)
                            }
                        },
                        onBreakDown = { breakdownTask = it },
                        onEdit = { editTask = it },
                        onDrop = { task ->
                            localView.performHapticFeedback(HapticFeedbackConstants.CONFIRM)
                            goalflowViewModel.dropTask(task)
                        },
                        onSkip = { task ->
                            localView.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
                            goalflowViewModel.skipTask(task)
                        }
                    )
                    RootDestination.PLANNING -> PlanningScreen(
                        today = today,
                        gate = gate,
                        tasks = tasks,
                        circadian = circadian,
                        onCheckIn = { circadianOpen = true },
                        onCapture = { openCapture() },
                        onMove = { date, taskId, direction ->
                            localView.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
                            goalflowViewModel.moveTask(date, taskId, direction)
                        },
                        onConfirm = { date, ids ->
                            localView.performHapticFeedback(HapticFeedbackConstants.CONFIRM)
                            goalflowViewModel.confirmPlan(date, ids)
                        },
                        onScheduleMonthTask = { datePickerForTask = it },
                        onReschedule = { task, date -> goalflowViewModel.rescheduleTask(task, date) },
                        onComplete = { task ->
                            goalflowViewModel.completeTask(task) {
                                localView.performHapticFeedback(HapticFeedbackConstants.CONFIRM)
                                application.soundController.playCompletion(task.isFrog)
                            }
                        },
                        onBreakDown = { breakdownTask = it },
                        onPromoteFrog = { task ->
                            localView.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
                            goalflowViewModel.promoteTaskToFrog(task)
                        },
                        onDrop = { task -> goalflowViewModel.dropTask(task) },
                        onEdit = { editTask = it }
                    )
                    RootDestination.HABITS -> NativeHabitsScreen(
                        habits = habits,
                        goals = goals,
                        error = error,
                        generationFailures = habitGenerationFailures,
                        onCreate = { draft, onComplete ->
                            goalflowViewModel.createHabit(
                                draft.title,
                                draft.frequency,
                                draft.specificDays,
                                draft.isHighPriority,
                                draft.beforeFrog,
                                draft.duration,
                                draft.goalId,
                                onComplete
                            )
                        },
                        onUpdate = { habit, draft, onComplete ->
                            goalflowViewModel.updateHabit(
                                habit.copy(
                                    title = draft.title,
                                    frequency = draft.frequency,
                                    specificDays = draft.specificDays,
                                    isHighPriority = draft.isHighPriority,
                                    beforeFrog = draft.beforeFrog,
                                    duration = draft.duration,
                                    goalId = draft.goalId
                                ),
                                onComplete
                            )
                        },
                        onDelete = goalflowViewModel::deleteHabit,
                        onRetryGeneration = goalflowViewModel::retryHabitGeneration
                    )
                    RootDestination.GOALS -> NativeGoalsScreen(
                        today = today,
                        goals = goals,
                        trueNorth = trueNorth,
                        amalgam = amalgam,
                        error = error,
                        onCreateGoal = { draft, onComplete ->
                            goalflowViewModel.createGoal(
                                name = draft.name,
                                description = draft.description,
                                deadline = draft.deadline,
                                excitement = draft.excitement,
                                roi = draft.roi,
                                onComplete = onComplete
                            )
                        },
                        onUpdateGoal = { goal, draft, onComplete ->
                            goalflowViewModel.updateGoal(
                                goal.copy(
                                    name = draft.name,
                                    description = draft.description,
                                    deadline = draft.deadline,
                                    excitement = draft.excitement,
                                    roi = draft.roi
                                ),
                                onComplete
                            )
                        },
                        onDeleteGoal = goalflowViewModel::deleteGoal,
                        onCreateTrueNorth = { draft, onComplete ->
                            goalflowViewModel.createTrueNorth(
                                com.mariusschober.goalflow.nativeapp.domain.GoalflowTrueNorth(
                                    id = "",
                                    vision = draft.vision,
                                    isMoneyGoal = draft.isMoneyGoal,
                                    tangibleReality = draft.tangibleReality,
                                    sensoryDetails = draft.sensoryDetails,
                                    planB = draft.planB,
                                    importance = draft.importance,
                                    anchorHabit = draft.anchorHabit,
                                    anchorTask = draft.anchorTask,
                                    anchorHabitDuration = draft.anchorHabitDuration,
                                    createdAt = 0L
                                ),
                                onComplete
                            )
                        },
                        onUpdateTrueNorth = { goal, draft, onComplete ->
                            goalflowViewModel.updateTrueNorth(
                                goal.copy(
                                    vision = draft.vision,
                                    isMoneyGoal = draft.isMoneyGoal,
                                    tangibleReality = draft.tangibleReality,
                                    sensoryDetails = draft.sensoryDetails,
                                    planB = draft.planB,
                                    importance = draft.importance,
                                    anchorHabit = draft.anchorHabit,
                                    anchorTask = draft.anchorTask,
                                    anchorHabitDuration = draft.anchorHabitDuration
                                ),
                                onComplete
                            )
                        },
                        onDeleteTrueNorth = goalflowViewModel::deleteTrueNorth,
                        onUpdateAmalgam = { text, onComplete -> goalflowViewModel.updateAmalgam(text, onComplete) },
                        onOpenInsights = { destination = RootDestination.INSIGHTS }
                    )
                    RootDestination.INSIGHTS -> NativeInsightsScreen(
                        today = today,
                        tasks = tasks,
                        habits = habits,
                        stats = stats,
                        progress = progress,
                        onBack = { destination = RootDestination.GOALS }
                    )
                    RootDestination.SETTINGS -> SettingsScreen(
                        signedIn = sessionActive,
                        mfaVerified = sessionAssuranceLevel == "aal2",
                        cloudSessionProblem = sessionStorageProblem,
                        canUseAuthentication = NativeConfig.canUseAuthentication,
                        canUseCloud = NativeConfig.canUseCloud,
                        canUseTelegram = NativeConfig.canUseTelegram,
                        telegramStatus = telegramStatus,
                        telegramStatusMessage = telegramStatusMessage,
                        telegramWorking = telegramWorking,
                        onSignIn = { signInOpen = true },
                        onVerifyMfa = {
                            authError = null
                            mfaOpen = true
                        },
                        onSignOut = {
                            sessionActive = false
                            sessionAssuranceLevel = "aal1"
                            telegramStatus = null
                            telegramStatusMessage = null
                            scope.launch(start = CoroutineStart.UNDISPATCHED) {
                                runCatching { NativeAuthClient(application.sessionStore).signOut() }
                                    .onSuccess {
                                        snackbarHostState.showSnackbar("Signed out. Local commitments stay here.")
                                    }
                                    .onFailure { error ->
                                        val currentSession = application.sessionStore.read()
                                        sessionActive = currentSession != null
                                        sessionAssuranceLevel = currentSession?.assuranceLevel ?: "aal1"
                                        sessionStorageProblem = application.sessionStore.readProblem()
                                        snackbarHostState.showSnackbar(
                                            error.message ?: "Server sign-out could not be confirmed."
                                        )
                                }
                            }
                        },
                        onConnectTelegram = {
                            if (!telegramWorking) {
                                telegramWorking = true
                                scope.launch {
                                    try {
                                        val providerUri = NativeAuthClient(application.sessionStore).beginTelegramLink()
                                        if (providerUri == null) {
                                            telegramStatus = NativeAuthClient(application.sessionStore).telegramStatus()
                                            telegramStatusMessage = null
                                            snackbarHostState.showSnackbar("Telegram is connected.")
                                        } else {
                                            try {
                                                context.startActivity(
                                                    Intent(Intent.ACTION_VIEW, providerUri)
                                                        .addCategory(Intent.CATEGORY_BROWSABLE)
                                                )
                                                snackbarHostState.showSnackbar("Complete Telegram authorization in the browser.")
                                            } catch (error: Exception) {
                                                application.sessionStore.clearPendingState()
                                                throw error
                                            }
                                        }
                                    } catch (error: Exception) {
                                        telegramStatusMessage = error.message ?: "Telegram could not be connected."
                                        snackbarHostState.showSnackbar(telegramStatusMessage!!)
                                    } finally {
                                        telegramWorking = false
                                    }
                                }
                            }
                        },
                        onDisconnectTelegram = {
                            if (!telegramWorking) {
                                telegramWorking = true
                                scope.launch {
                                    try {
                                        telegramStatus = NativeAuthClient(application.sessionStore).unlinkTelegram()
                                        telegramStatusMessage = null
                                        snackbarHostState.showSnackbar("Telegram access was disconnected.")
                                    } catch (error: Exception) {
                                        telegramStatusMessage = error.message ?: "Telegram could not be disconnected."
                                        snackbarHostState.showSnackbar(telegramStatusMessage!!)
                                    } finally {
                                        telegramWorking = false
                                    }
                                }
                            }
                        },
                        onExport = {
                            backupError = null
                            backupAction = "export"
                        },
                        onImport = {
                            importLauncher.launch(arrayOf("application/json", "text/plain"))
                        },
                        restoreCheckpointAvailable = restoreCheckpointAvailable,
                        onRollback = {
                            backupError = null
                            backupAction = "rollback"
                        }
                    )
                }
            }
        }
        }
    }

    if (focusTask == null) {
        conflicts.firstOrNull { it.status !in setOf("resolved", "resolving_local") }?.let { conflict ->
        val supportedLocally = conflict.entityType in setOf("tasks", "goals", "habits", "daily_plans", "task_events") ||
            (conflict.entityType in NATIVE_RAW_COLLECTION_TYPES && conflict.localPayload.isNotBlank())
        AlertDialog(
            onDismissRequest = {},
            title = { Text("Sync conflict — both versions are safe") },
            text = {
                Text(if (supportedLocally) {
                    "This ${conflict.entityType.removeSuffix("s")} was changed in two places. " +
                        "Choose explicitly; Tsurfing will not overwrite either version silently."
                } else {
                    "A cloud ${conflict.entityType} change cannot be displayed by this app version. " +
                        "Its complete payload remains preserved until you explicitly keep the canonical cloud copy."
                })
            },
            confirmButton = {
                if (supportedLocally) {
                    Button(onClick = { goalflowViewModel.resolveConflict(conflict, keepLocal = true) }) {
                        Text("Keep this device")
                    }
                }
            },
            dismissButton = {
                TextButton(onClick = { goalflowViewModel.resolveConflict(conflict, keepLocal = false) }) {
                    Text(if (supportedLocally) "Use cloud version" else "Keep canonical cloud copy")
                }
            }
        )
    }
    }

    if (captureOpen) {
        CaptureSheet(
            formKey = captureFormKey,
            initialTitle = captureSeed,
            today = today,
            goals = goals,
            error = error,
            onDismiss = {
                goalflowViewModel.clearError()
                closeCapture()
            },
            onSave = { title, notes, precision, scheduledFor, scheduledTime, isFrog, goalId, duration ->
                goalflowViewModel.createTask(
                    title = title,
                    notes = notes,
                    precision = precision,
                    scheduledFor = scheduledFor,
                    scheduledTime = scheduledTime,
                    isFrog = isFrog,
                    goalId = goalId,
                    duration = duration,
                    onComplete = {
                        localView.performHapticFeedback(HapticFeedbackConstants.CONFIRM)
                        closeCapture()
                    }
                )
            }
        )
    }

    if (circadianOpen) {
        CircadianCheckInSheet(
            initial = circadian,
            today = today,
            error = error,
            onDismiss = {
                goalflowViewModel.clearError()
                circadianOpen = false
            },
            onSave = { state ->
                goalflowViewModel.updateCircadian(state) { circadianOpen = false }
            }
        )
    }

    focusTask?.let { task ->
        FocusTimerSheet(
            task = task,
            startedAtMillis = focusStartedAt
                ?: application.focusSessionStore.read()?.startedAtMillis
                ?: System.currentTimeMillis(),
            error = error,
            onBreakDown = { breakdownTask = it },
            onComplete = { actualDuration, flowState ->
                goalflowViewModel.completeTask(task, actualDuration, flowState) {
                    // Keep the timer anchor until the task transaction has
                    // succeeded. A storage failure must remain recoverable.
                    application.focusSessionStore.clear()
                    focusTask = null
                    focusStartedAt = null
                    localView.performHapticFeedback(HapticFeedbackConstants.CONFIRM)
                    application.soundController.playCompletion(task.isFrog)
                }
            }
        )
    }

    editTask?.let { task ->
        NativeTaskEditorSheet(
            task = task,
            goals = goals,
            error = error,
            onDismiss = {
                goalflowViewModel.clearError()
                editTask = null
            },
            onSave = { title, notes, precision, scheduledFor, scheduledTime, isFrog, goalId, duration ->
                goalflowViewModel.updateTask(
                    task = task,
                    title = title,
                    notes = notes,
                    precision = precision,
                    scheduledFor = scheduledFor,
                    scheduledTime = scheduledTime,
                    isFrog = isFrog,
                    goalId = goalId,
                    duration = duration
                ) { editTask = null }
            }
        )
    }

    datePickerForTask?.let { task ->
        GoalflowDatePickerDialog(
            initialDate = today,
            onDismiss = { datePickerForTask = null },
            onConfirm = { date ->
                goalflowViewModel.rescheduleTask(task, date)
                datePickerForTask = null
            }
        )
    }

    breakdownTask?.let { task ->
        BreakdownDialog(
            task = task,
            today = today,
            error = error,
            onDismiss = {
                goalflowViewModel.clearError()
                breakdownTask = null
            },
            onConfirm = { children ->
                val todayForChildren = today
                goalflowViewModel.breakDownTask(
                    task,
                    children.map { child -> child.copy(scheduledFor = todayForChildren) }
                ) {
                    breakdownTask = null
                    application.focusSessionStore.clear()
                    focusTask = null
                    focusStartedAt = null
                }
            }
        )
    }

    if (backupAction in setOf("export", "import", "rollback")) {
        BackupPasswordDialog(
            action = backupAction!!,
            error = backupError,
            onDismiss = {
                backupAction = null
                backupError = null
                pendingImportUri = null
            },
            onConfirm = { password ->
                if (password.length < 12) {
                    backupError = "Use at least 12 characters."
                } else if (backupAction == "export") {
                    backupAction = null
                    pendingExportPassword = password
                    exportLauncher.launch("Tsurfing-backup.tsurfing-backup")
                } else if (backupAction == "rollback") {
                    backupAction = null
                    scope.launch {
                        runCatching { application.repository.rollbackLastRestore(password) }
                            .onSuccess {
                                restoreCheckpointAvailable = true
                                snackbarHostState.showSnackbar("Last restore rolled back safely")
                            }
                            .onFailure {
                                backupError = it.message ?: "Rollback failed"
                                backupAction = "rollback"
                            }
                    }
                } else {
                    val uri = pendingImportUri
                    if (uri == null) {
                        backupError = "Choose a backup file first."
                    } else {
                        backupAction = null
                        backupAction = null
                        scope.launch {
                            runCatching {
                                val contents = context.contentResolver.openInputStream(uri)?.bufferedReader()?.use { it.readText() }
                                    ?: throw IllegalStateException("The backup file could not be opened.")
                                contents to application.repository.previewBackup(contents, password)
                            }.onSuccess { (contents, preview) ->
                                pendingImportUri = null
                                pendingRestoreContents = contents
                                pendingRestorePassword = password
                                restorePreview = preview
                            }.onFailure {
                                backupError = it.message ?: "Backup preview failed"
                                backupAction = "import"
                            }
                        }
                    }
                }
            }
        )
    }

    restorePreview?.let { preview ->
        RestorePreviewDialog(
            preview = preview,
            busy = restoreInProgress,
            error = backupError,
            onDismiss = ::clearRestorePreview,
            onMerge = { restoreWithMode(BackupRestoreMode.MERGE) },
            onReplace = { replaceRestoreConfirmation = true }
        )
    }

    if (replaceRestoreConfirmation) {
        restorePreview?.let { preview ->
            ReplaceRestoreDialog(
                preview = preview,
                busy = restoreInProgress,
                onDismiss = { replaceRestoreConfirmation = false },
                onConfirm = {
                    replaceRestoreConfirmation = false
                    restoreWithMode(BackupRestoreMode.REPLACE)
                }
            )
        }
    }

    if (signInOpen) {
        val pendingEmailOtp = remember(signInOpen, authSessionRevision) {
            application.sessionStore.getPendingEmailOtp()
                ?.takeIf { it.expiresAtMillis > System.currentTimeMillis() }
        }
        SignInDialog(
            error = authError,
            pendingAttempt = pendingEmailOtp,
            canUseTelegram = NativeConfig.canUseTelegram,
            loadCaptchaPolicy = { NativeAuthClient(application.sessionStore).emailCaptchaRequired() },
            onDismiss = {
                signInOpen = false
                authError = null
            },
            onRequest = { email, purpose, inviteCode, captchaToken, onComplete, onFailure ->
                scope.launch {
                    runCatching {
                        NativeAuthClient(application.sessionStore).requestEmailCode(
                            email = email,
                            purpose = purpose,
                            inviteCode = inviteCode,
                            captchaToken = captchaToken
                        )
                    }
                        .onSuccess { attempt ->
                            onComplete(attempt)
                            snackbarHostState.showSnackbar("If approved, a six-digit email code is on its way")
                        }
                        .onFailure {
                            onFailure()
                            authError = it.message ?: "Sign-in failed"
                        }
                }
            },
            onVerify = { email, code, onComplete, onFailure ->
                scope.launch {
                    runCatching { NativeAuthClient(application.sessionStore).verifyEmailCode(email, code) }
                        .onSuccess { verified ->
                            onComplete()
                            sessionActive = true
                            sessionAssuranceLevel = verified.assuranceLevel
                            sessionStorageProblem = application.sessionStore.readProblem()
                            authError = null
                            signInOpen = false
                            NativeSyncScheduler.schedule(context)
                            snackbarHostState.showSnackbar("Email verified. Cloud sync is connected.")
                        }
                        .onFailure { failure ->
                            onFailure()
                            authError = failure.message ?: "Email verification failed"
                        }
                }
            },
            onTelegram = { joiningBeta, inviteCode, captchaToken, onComplete, onFailure ->
                scope.launch {
                    runCatching {
                        val authClient = NativeAuthClient(application.sessionStore)
                        if (joiningBeta) authClient.beginTelegramActivation(inviteCode, captchaToken)
                        else authClient.beginTelegramSignIn()
                    }
                        .onSuccess { providerUri ->
                            onComplete()
                            runCatching {
                                context.startActivity(
                                    Intent(Intent.ACTION_VIEW, providerUri)
                                        .addCategory(Intent.CATEGORY_BROWSABLE)
                                )
                            }
                                .onSuccess {
                                    authError = null
                                    signInOpen = false
                                }
                                .onFailure { error ->
                                    application.sessionStore.clearPendingState()
                                    onFailure()
                                    authError = error.message ?: "A browser could not be opened for Telegram sign-in."
                                }
                        }
                        .onFailure { error ->
                            onFailure()
                            authError = error.message ?: "Telegram sign-in could not be started."
                        }
                }
            }
        )
    }

    if (mfaOpen) {
        MfaDialog(
            error = authError,
            onDismiss = {
                mfaOpen = false
                authError = null
            },
            onConfirm = { code, onComplete, onFailure ->
                scope.launch {
                    runCatching { NativeAuthClient(application.sessionStore).completeMfa(code) }
                        .onSuccess { elevated ->
                            onComplete()
                            sessionActive = true
                            sessionAssuranceLevel = elevated.assuranceLevel
                            sessionStorageProblem = application.sessionStore.readProblem()
                            authError = null
                            mfaOpen = false
                            NativeSyncScheduler.schedule(context)
                            snackbarHostState.showSnackbar("Owner session verified. Cloud sync can continue.")
                        }
                        .onFailure { error ->
                            onFailure()
                            val currentSession = application.sessionStore.read()
                            sessionActive = currentSession != null
                            sessionAssuranceLevel = currentSession?.assuranceLevel ?: "aal1"
                            sessionStorageProblem = application.sessionStore.readProblem()
                            authError = error.message ?: "Owner verification failed"
                        }
                }
            }
        )
    }
}

@Composable
private fun GoalflowSandboxGate(onGranted: () -> Unit) {
    var code by rememberSaveable { mutableStateOf("") }
    var error by rememberSaveable { mutableStateOf<String?>(null) }
    var checking by rememberSaveable { mutableStateOf(false) }
    val focusRequester = remember { FocusRequester() }
    val keyboardController = LocalSoftwareKeyboardController.current

    LaunchedEffect(Unit) {
        var focused = false
        repeat(10) {
            if (!focused) {
                withFrameNanos { }
                focused = runCatching {
                    focusRequester.requestFocus()
                    true
                }.getOrDefault(false)
            }
            if (!focused) delay(40)
        }
        if (focused) keyboardController?.show()
    }

    fun submit() {
        if (checking) return
        checking = true
        if (code == NativeConfig.sandboxAccessCode) {
            onGranted()
        } else {
            checking = false
            error = "That test code is not valid."
        }
    }

    Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .safeDrawingPadding()
                .imePadding()
                .padding(28.dp),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Icon(
                Icons.Rounded.TaskAlt,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary,
                modifier = Modifier.size(58.dp)
            )
            Spacer(Modifier.height(20.dp))
            Text("Tsurfing Test", style = MaterialTheme.typography.headlineLarge, textAlign = TextAlign.Center)
            Spacer(Modifier.height(8.dp))
            Text(
                "This is the isolated native test build. Enter the test code to continue.",
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center
            )
            Spacer(Modifier.height(24.dp))
            OutlinedTextField(
                value = code,
                onValueChange = { code = it.filter(Char::isDigit).take(12); error = null },
                modifier = Modifier.fillMaxWidth().focusRequester(focusRequester),
                label = { Text("Test code") },
                singleLine = true,
                keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(
                    keyboardType = KeyboardType.Number,
                    imeAction = ImeAction.Done
                ),
                keyboardActions = androidx.compose.foundation.text.KeyboardActions(onDone = { submit() }),
                isError = error != null
            )
            error?.let {
                Spacer(Modifier.height(8.dp))
                Text(it, color = MaterialTheme.colorScheme.error)
            }
            Spacer(Modifier.height(16.dp))
            Button(
                onClick = ::submit,
                enabled = code.isNotBlank() && !checking,
                modifier = Modifier.fillMaxWidth().height(56.dp)
            ) { Text("Enter test app") }
        }
    }
}

@Composable
internal fun GoalPicker(
    goals: List<GoalflowGoal>,
    selectedGoalId: String?,
    expanded: Boolean,
    onExpandedChange: (Boolean) -> Unit,
    onSelect: (String?) -> Unit
) {
    val selectedName = goals.firstOrNull { it.id == selectedGoalId }?.name ?: "No linked goal"
    Box {
        OutlinedButton(
            onClick = { onExpandedChange(true) },
            modifier = Modifier.fillMaxWidth().height(52.dp)
        ) {
            Column(modifier = Modifier.weight(1f), horizontalAlignment = Alignment.Start) {
                Text("Direction", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(selectedName, maxLines = 1)
            }
            Icon(Icons.Rounded.MoreHoriz, contentDescription = "Choose linked goal")
        }
        DropdownMenu(expanded = expanded, onDismissRequest = { onExpandedChange(false) }) {
            DropdownMenuItem(text = { Text("No linked goal") }, onClick = { onSelect(null) })
            goals.forEach { goal ->
                DropdownMenuItem(
                    text = { Text(goal.name, maxLines = 1) },
                    onClick = { onSelect(goal.id) }
                )
            }
        }
    }
}

@Composable
private fun GoalflowNavigationBar(
    selected: RootDestination,
    onSelect: (RootDestination) -> Unit
) {
    NavigationBar(containerColor = MaterialTheme.colorScheme.surface) {
        primaryDestinations.forEach { destination ->
            val icon = when (destination) {
                RootDestination.CURRENT -> Icons.Rounded.TaskAlt
                RootDestination.PLANNING -> Icons.Rounded.Timeline
                RootDestination.HABITS -> Icons.Rounded.Repeat
                RootDestination.GOALS -> Icons.Rounded.Flag
                RootDestination.SETTINGS -> Icons.Rounded.Settings
                RootDestination.INSIGHTS -> Icons.Rounded.Timeline
            }
            NavigationBarItem(
                selected = selected == destination || (selected == RootDestination.INSIGHTS && destination == RootDestination.GOALS),
                onClick = { onSelect(destination) },
                icon = { Icon(icon, contentDescription = destination.label) },
                label = { Text(destination.label) }
            )
        }
    }
}

@Composable
private fun CurrentScreen(
    today: String,
    gate: PlanningGate,
    currentTask: GoalflowTask?,
    onCapture: () -> Unit,
    onPlanning: () -> Unit,
    onFocus: (GoalflowTask) -> Unit,
    onComplete: (GoalflowTask) -> Unit,
    onBreakDown: (GoalflowTask) -> Unit,
    onEdit: (GoalflowTask) -> Unit,
    onDrop: (GoalflowTask) -> Unit,
    onSkip: (GoalflowTask) -> Unit
) {
    val listState = rememberSaveable(saver = LazyListState.Saver) { LazyListState() }
    LazyColumn(state = listState,
        modifier = Modifier.fillMaxSize(),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(24.dp),
        verticalArrangement = Arrangement.spacedBy(18.dp)
    ) {
        item {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("Current", style = MaterialTheme.typography.headlineLarge)
                Text(
                    formatDate(today),
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
        item {
            when (gate) {
                PlanningGate.Empty -> EmptyCurrent(onCapture)
                is PlanningGate.MonthlyPlanningRequired -> PlanningRequiredCard(
                    title = "A month needs a day",
                    body = "Turn each open monthly commitment into an exact day before executing it.",
                    onClick = onPlanning
                )
                is PlanningGate.DailyPlanningRequired -> PlanningRequiredCard(
                    title = if (gate.overdueTaskIds.isNotEmpty()) "Overdue commitments need attention" else "Plan today before executing",
                    body = if (gate.overdueTaskIds.isNotEmpty()) {
                        "Nothing disappears because it became inconvenient. Review the order and decide deliberately."
                    } else {
                        "Planning is where you decide. Current is where you do."
                    },
                    onClick = onPlanning
                )
                is PlanningGate.Ready -> AnimatedContent(
                    targetState = currentTask,
                    label = "current-commitment"
                ) { task ->
                    task?.let {
                        CurrentTaskCard(
                            task = it,
                            remaining = gate.queue.size,
                            onFocus = onFocus,
                            onComplete = onComplete,
                            onBreakDown = onBreakDown,
                            onEdit = onEdit,
                            onDrop = onDrop,
                            onSkip = onSkip
                        )
                    }
                }
            }
        }
        item {
            OutlinedButton(
                onClick = onCapture,
                modifier = Modifier
                    .fillMaxWidth()
                    .height(54.dp)
                    .semantics { contentDescription = "Capture a scheduled commitment" }
            ) {
                Icon(Icons.Rounded.Add, contentDescription = null)
                Spacer(Modifier.width(8.dp))
                Text("Capture commitment")
            }
        }
    }
}

@Composable
private fun CircadianStatusCard(
    today: String,
    state: GoalflowCircadianState,
    onCheckIn: () -> Unit,
    onReset: () -> Unit
) {
    val active = state.lastCheckIn == today
    Card(
        colors = CardDefaults.cardColors(
            containerColor = if (active) MaterialTheme.colorScheme.tertiaryContainer
            else MaterialTheme.colorScheme.surfaceVariant
        ),
        shape = RoundedCornerShape(22.dp)
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text(
                    if (active) "${state.mode.replaceFirstChar { it.uppercase(Locale.getDefault()) }} rhythm · ${state.score}%"
                    else "Daily rhythm",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold
                )
                Text(
                    if (active) "Your plan can follow the energy you checked in with."
                    else "A 30-second check-in can tune today's plan.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            if (active) {
                TextButton(onClick = onCheckIn) { Text("Update") }
                TextButton(onClick = onReset) { Text("Reset") }
            } else {
                Button(onClick = onCheckIn) { Text("Check in") }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun FocusTimerSheet(
    task: GoalflowTask,
    startedAtMillis: Long,
    error: String?,
    onBreakDown: (GoalflowTask) -> Unit,
    onComplete: (actualDurationMinutes: Int, flowState: String?) -> Unit
) {
    val startedAt = rememberSaveable(task.id, startedAtMillis) { startedAtMillis }
    var now by remember(task.id) { mutableStateOf(System.currentTimeMillis()) }
    var flowState by rememberSaveable(task.id) { mutableStateOf("") }
    var completing by rememberSaveable(task.id) { mutableStateOf(false) }
    val plannedMinutes = runCatching {
        org.json.JSONObject(task.extraJson).optInt("duration", 25)
    }.getOrDefault(25).coerceIn(1, 1_440)
    val elapsedSeconds = ((now - startedAt) / 1_000L).coerceAtLeast(0L)
    val plannedSeconds = plannedMinutes * 60L
    val progress = (elapsedSeconds.toFloat() / plannedSeconds.toFloat()).coerceIn(0f, 1f)
    val minutes = elapsedSeconds / 60L
    val seconds = elapsedSeconds % 60L

    LaunchedEffect(task.id, startedAt) {
        while (isActive) {
            now = System.currentTimeMillis()
            delay(1_000L)
        }
    }

    LaunchedEffect(error) {
        if (error != null) completing = false
    }

    Surface(
        modifier = Modifier.fillMaxSize().zIndex(10f),
        color = goalflowFocusSurface(),
        contentColor = goalflowFocusOnSurface()
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .safeDrawingPadding()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 24.dp, vertical = 24.dp)
                .navigationBarsPadding(),
            verticalArrangement = Arrangement.spacedBy(18.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Text("FOCUS SESSION", style = MaterialTheme.typography.labelLarge, color = goalflowFocusAccent())
            Text("One thing. Right now.", style = MaterialTheme.typography.headlineMedium, textAlign = TextAlign.Center)
            Text(
                if (task.isExplicitFrogName()) "🐸 ${task.title}" else task.title,
                style = MaterialTheme.typography.headlineLarge,
                fontWeight = FontWeight.SemiBold,
                textAlign = TextAlign.Center
            )
            Text(
                String.format(Locale.ROOT, "%02d:%02d", minutes, seconds),
                style = MaterialTheme.typography.displayLarge,
                color = goalflowFocusAccent(),
                modifier = Modifier.fillMaxWidth(),
                textAlign = TextAlign.Center
            )
            LinearProgressIndicator(
                progress = { progress },
                modifier = Modifier.fillMaxWidth().height(10.dp),
                color = goalflowFocusAccent(),
                trackColor = Color.White.copy(alpha = 0.28f)
            )
            Text(
                if (elapsedSeconds >= plannedSeconds) "Planned focus reached. Finish when the commitment is truly done."
                else "$plannedMinutes minute target · keep the next action small and visible.",
                color = goalflowFocusOnSurface(),
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth()
            )
            Text("How did the session feel?", style = MaterialTheme.typography.labelLarge, color = goalflowFocusOnSurface())
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.fillMaxWidth()) {
                listOf("distracted" to "Distracted", "good" to "Good", "flow" to "Flow").forEach { (value, label) ->
                    if (flowState == value) {
                        Button(onClick = { flowState = value }, modifier = Modifier.weight(1f)) { Text(label) }
                    } else {
                        OutlinedButton(onClick = { flowState = value }, modifier = Modifier.weight(1f)) { Text(label) }
                    }
                }
            }
            error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            Button(
                onClick = {
                    if (!completing) {
                        completing = true
                        onComplete(ceil(elapsedSeconds / 60.0).toInt().coerceAtLeast(1), flowState.takeIf(String::isNotBlank))
                    }
                },
                enabled = !completing,
                modifier = Modifier.fillMaxWidth().height(60.dp)
            ) {
                Icon(Icons.Rounded.Check, contentDescription = null)
                Spacer(Modifier.width(8.dp))
                Text(if (completing) "Saving…" else "Complete commitment")
            }
            OutlinedButton(
                onClick = { if (!completing) onBreakDown(task) },
                enabled = !completing,
                modifier = Modifier.fillMaxWidth().height(56.dp)
            ) {
                Text("Stop and break down")
            }
            Text(
                "This session stays open until you complete it or turn it into smaller actions.",
                style = MaterialTheme.typography.bodySmall,
                color = goalflowFocusOnSurface(),
                textAlign = TextAlign.Center
            )
        }
    }
}

@Composable
private fun EmptyCurrent(onCapture: () -> Unit) {
    Card(
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
        shape = RoundedCornerShape(28.dp)
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(28.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Icon(
                Icons.Rounded.CheckCircle,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary,
                modifier = Modifier.size(46.dp)
            )
            Text("Nothing is scheduled for now", style = MaterialTheme.typography.titleLarge, textAlign = TextAlign.Center)
            Text(
                "Capture one real commitment and give it a day. Then leave the app and do it.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center
            )
            Button(onClick = onCapture) { Text("Add the first one") }
        }
    }
}

@Composable
private fun PlanningRequiredCard(title: String, body: String, onClick: () -> Unit) {
    Card(
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer),
        shape = RoundedCornerShape(28.dp)
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp)
        ) {
            Text(title, style = MaterialTheme.typography.headlineMedium, color = MaterialTheme.colorScheme.onPrimaryContainer)
            Text(body, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onPrimaryContainer)
            Button(onClick = onClick) {
                Text("Open Planning")
                Spacer(Modifier.width(8.dp))
                Icon(Icons.AutoMirrored.Rounded.ArrowForward, contentDescription = null)
            }
        }
    }
}

@Composable
private fun CurrentTaskCard(
    task: GoalflowTask,
    remaining: Int,
    onFocus: (GoalflowTask) -> Unit,
    onComplete: (GoalflowTask) -> Unit,
    onBreakDown: (GoalflowTask) -> Unit,
    onEdit: (GoalflowTask) -> Unit,
    onDrop: (GoalflowTask) -> Unit,
    onSkip: (GoalflowTask) -> Unit
) {
    Card(
        colors = CardDefaults.cardColors(
            containerColor = when {
                task.isExplicitFrogName() -> MaterialTheme.colorScheme.primaryContainer
                task.isFrog -> MaterialTheme.colorScheme.secondaryContainer
                else -> MaterialTheme.colorScheme.surface
            }
        ),
        border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = 0.25f)),
        shape = RoundedCornerShape(30.dp)
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(26.dp),
            verticalArrangement = Arrangement.spacedBy(18.dp)
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (task.isFrog || task.isExplicitFrogName()) {
                    if (task.isExplicitFrogName()) {
                        Text("🐸", style = MaterialTheme.typography.titleLarge)
                    } else {
                        Icon(Icons.Rounded.Flag, contentDescription = "Frog", tint = MaterialTheme.colorScheme.secondary)
                    }
                    Text("FROG", style = MaterialTheme.typography.labelLarge, color = if (task.isExplicitFrogName()) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.secondary)
                } else {
                    Text("DO THIS NOW", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
                }
                Spacer(Modifier.weight(1f))
                Text("$remaining remaining", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Text(if (task.isExplicitFrogName()) "🐸 ${task.title}" else task.title, style = MaterialTheme.typography.headlineMedium)
            if (task.notes.isNotBlank()) {
                Text(task.notes, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Button(
                onClick = {
                    onComplete(task)
                },
                modifier = Modifier
                    .fillMaxWidth()
                    .height(58.dp)
                    .semantics { contentDescription = "Complete ${task.title}" },
                shape = RoundedCornerShape(18.dp)
            ) {
                Icon(Icons.Rounded.Check, contentDescription = null)
                Spacer(Modifier.width(8.dp))
                Text("Complete")
            }
            OutlinedButton(onClick = { onEdit(task) }, modifier = Modifier.fillMaxWidth().height(50.dp)) {
                Icon(Icons.Rounded.MoreHoriz, contentDescription = null)
                Spacer(Modifier.width(8.dp))
                Text("Adjust commitment")
            }
            OutlinedButton(onClick = { onFocus(task) }, modifier = Modifier.fillMaxWidth().height(50.dp)) {
                Icon(Icons.Rounded.Timeline, contentDescription = null)
                Spacer(Modifier.width(8.dp))
                Text("Start focus session")
            }
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
                if (!task.isFrog && !task.isExplicitFrogName()) {
                    TextButton(
                        onClick = { onSkip(task) },
                        modifier = Modifier.semantics { contentDescription = "Skip ${task.title} for now" }
                    ) { Text("Skip for now") }
                }
                TextButton(onClick = { onBreakDown(task) }) { Text("Break down") }
                TextButton(onClick = { onDrop(task) }) { Text("Drop") }
            }
        }
    }
}

@Composable
private fun PlanningScreen(
    today: String,
    gate: PlanningGate,
    tasks: List<GoalflowTask>,
    circadian: GoalflowCircadianState,
    onCheckIn: () -> Unit,
    onCapture: () -> Unit,
    onMove: (String, String, Int) -> Unit,
    onConfirm: (String, List<String>) -> Unit,
    onScheduleMonthTask: (GoalflowTask) -> Unit,
    onReschedule: (GoalflowTask, String) -> Unit,
    onComplete: (GoalflowTask) -> Unit,
    onBreakDown: (GoalflowTask) -> Unit,
    onPromoteFrog: (GoalflowTask) -> Unit,
    onEdit: (GoalflowTask) -> Unit,
    onDrop: (GoalflowTask) -> Unit
) {
    val listState = rememberSaveable(saver = LazyListState.Saver) { LazyListState() }
    var insertionTargetIndex by rememberSaveable { mutableStateOf<Int?>(null) }
    val queue = (gate as? PlanningGate.DailyPlanningRequired)?.taskIds
        ?.mapNotNull { id -> tasks.find { it.id == id } }
        ?: (gate as? PlanningGate.Ready)?.queue.orEmpty()
    val monthlyTasks = (gate as? PlanningGate.MonthlyPlanningRequired)?.taskIds
        ?.mapNotNull { id -> tasks.find { it.id == id } }
        .orEmpty()
    val overdueTasks = (gate as? PlanningGate.DailyPlanningRequired)?.overdueTaskIds
        ?.mapNotNull { id -> tasks.find { it.id == id } }
        .orEmpty()
    val timelineById = buildGoalflowTimeline(queue).associateBy { it.taskId }

    LazyColumn(
        state = listState,        modifier = Modifier.fillMaxSize(),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(24.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp)
    ) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("Planning", style = MaterialTheme.typography.headlineLarge)
                    Text(formatDate(today), style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                FloatingActionButton(onClick = onCapture, modifier = Modifier.size(52.dp)) {
                    Icon(Icons.Rounded.Add, contentDescription = "Capture commitment")
                }
            }
        }
        item {
            val rhythmLabel = if (circadian.lastCheckIn == today) {
                "${circadian.mode.replaceFirstChar { it.uppercase(Locale.getDefault()) }} ${circadian.score}%"
            } else {
                "Daily rhythm"
            }
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(50))
                    .background(MaterialTheme.colorScheme.tertiaryContainer)
                    .clickable(onClick = onCheckIn)
                    .padding(horizontal = 14.dp, vertical = 9.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                Box(Modifier.size(8.dp).clip(CircleShape).background(MaterialTheme.colorScheme.tertiary))
                Text(
                    rhythmLabel,
                    style = MaterialTheme.typography.labelLarge,
                    color = MaterialTheme.colorScheme.onTertiaryContainer
                )
                Spacer(Modifier.weight(1f))
                Text(
                    if (circadian.lastCheckIn == today) "Adjust" else "Set",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onTertiaryContainer
                )
            }
        }
        if (monthlyTasks.isNotEmpty()) {
            item {
                PlanningHeaderCard(
                    title = "Convert monthly commitments",
                    body = "A month is a direction, not a place to hide. Give each task an exact day."
                )
            }
            items(monthlyTasks, key = { it.id }) { task ->
                MonthTaskRow(task, onScheduleMonthTask)
            }
        } else {
            if (overdueTasks.isNotEmpty()) {
                item {
                    PlanningHeaderCard(
                        title = "Resolve overdue commitments",
                        body = "Nothing disappears because it became inconvenient. Move ordinary work to today, complete it, break it down, or drop it."
                    )
                }
                items(overdueTasks, key = { it.id }) { task ->
                    OverdueTaskRow(
                        task = task,
                        today = today,
                        onReschedule = onReschedule,
                        onComplete = onComplete,
                        onBreakDown = onBreakDown,
                        onDrop = onDrop
                    )
                }
            }
            if (queue.isNotEmpty()) {
                item {
                    PlanningHeaderCard(
                        title = if (gate is PlanningGate.Ready) "Today's order is confirmed" else "Decide the order",
                        body = if (gate is PlanningGate.Ready) "Current will show one task at a time, beginning with this order." else "Move the commitments into the order you are willing to execute."
                    )
                }
                items(queue, key = { it.id }) { task ->
                    val index = queue.indexOfFirst { it.id == task.id }
                    if (insertionTargetIndex == index) {
                        HorizontalDivider(
                            modifier = Modifier.padding(horizontal = 12.dp),
                            thickness = 3.dp,
                            color = MaterialTheme.colorScheme.primary
                        )
                    }
                    PlannedTaskRow(
                        task = task,
                        timeline = timelineById[task.id],
                        isFirst = queue.firstOrNull()?.id == task.id,
                        isLast = queue.lastOrNull()?.id == task.id,
                        onMove = { direction -> onMove(today, task.id, direction) },
                        onEdit = { onEdit(task) },
                        onPromoteFrog = { onPromoteFrog(task) },
                        onBreakDown = { onBreakDown(task) },
                        onDragDirection = { direction ->
                            insertionTargetIndex = (index + direction).coerceIn(0, queue.size)
                        },
                        onDragEnd = { insertionTargetIndex = null }
                    )
                }
                if (insertionTargetIndex == queue.size && queue.isNotEmpty()) {
                    item {
                        HorizontalDivider(
                            modifier = Modifier.padding(horizontal = 12.dp),
                            thickness = 3.dp,
                            color = MaterialTheme.colorScheme.primary
                        )
                    }
                }
                if (gate is PlanningGate.DailyPlanningRequired) {
                    item {
                        Button(
                            onClick = { onConfirm(today, queue.map { it.id }) },
                            modifier = Modifier
                                .fillMaxWidth()
                                .height(56.dp)
                        ) { Text("Confirm this order") }
                    }
                }
            } else if (overdueTasks.isEmpty()) {
                item { EmptyPlanning(onCapture) }
            }
        }
    }
}

@Composable
private fun PlanningHeaderCard(title: String, body: String) {
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer), shape = RoundedCornerShape(24.dp)) {
        Column(modifier = Modifier.padding(22.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(title, style = MaterialTheme.typography.titleLarge, color = MaterialTheme.colorScheme.onPrimaryContainer)
            Text(body, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onPrimaryContainer)
        }
    }
}

@Composable
private fun OverdueTaskRow(
    task: GoalflowTask,
    today: String,
    onReschedule: (GoalflowTask, String) -> Unit,
    onComplete: (GoalflowTask) -> Unit,
    onBreakDown: (GoalflowTask) -> Unit,
    onDrop: (GoalflowTask) -> Unit
) {
    Card(
        colors = CardDefaults.cardColors(
            containerColor = if (task.isExplicitFrogName()) MaterialTheme.colorScheme.primaryContainer
            else MaterialTheme.colorScheme.surface
        ),
        shape = RoundedCornerShape(20.dp)
    ) {
        Column(
            modifier = Modifier.fillMaxWidth().padding(18.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (task.isFrog || task.isExplicitFrogName()) {
                    if (task.isExplicitFrogName()) {
                        Text("🐸", style = MaterialTheme.typography.titleMedium)
                    } else {
                        Icon(Icons.Rounded.Flag, contentDescription = "Frog", tint = MaterialTheme.colorScheme.secondary)
                    }
                    Text("FROG", style = MaterialTheme.typography.labelLarge, color = if (task.isExplicitFrogName()) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.secondary)
                } else {
                    Text("OVERDUE", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.error)
                }
                Spacer(Modifier.weight(1f))
                Text(task.scheduledFor, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Text(if (task.isExplicitFrogName()) "🐸 ${task.title}" else task.title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            if (task.isFrog || task.isExplicitFrogName()) {
                Text(
                    "This frog cannot be moved forward. Complete it, break it down, or drop it.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            } else {
                OutlinedButton(
                    onClick = { onReschedule(task, today) },
                    modifier = Modifier.fillMaxWidth().height(50.dp)
                ) { Text("Move to today") }
            }
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
                TextButton(onClick = { onComplete(task) }) { Text("Complete") }
                TextButton(onClick = { onBreakDown(task) }) { Text("Break down") }
                TextButton(onClick = { onDrop(task) }) { Text("Drop") }
            }
        }
    }
}

@Composable
private fun PlannedTaskRow(
    task: GoalflowTask,
    timeline: GoalflowTimelineBlock?,
    isFirst: Boolean,
    isLast: Boolean,
    onMove: (Int) -> Unit,
    onEdit: () -> Unit,
    onPromoteFrog: () -> Unit,
    onBreakDown: () -> Unit,
    onDragDirection: (Int) -> Unit,
    onDragEnd: () -> Unit
) {
    val localView = LocalView.current
    var dragging by remember(task.id) { mutableStateOf(false) }
    var dragDistance by remember(task.id) { mutableStateOf(0f) }
    var swipeHandled by remember(task.id) { mutableStateOf(false) }
    Card(
        modifier = Modifier
            .semantics {
                customActions = listOf(
                    CustomAccessibilityAction("Mark as frog") {
                        onPromoteFrog()
                        true
                    },
                    CustomAccessibilityAction("Break down") {
                        onBreakDown()
                        true
                    }
                )
            }
            .pointerInput("swipe-${task.id}") {
                var horizontalDistance = 0f
                detectHorizontalDragGestures(
                    onDragEnd = { horizontalDistance = 0f; swipeHandled = false },
                    onDragCancel = { horizontalDistance = 0f; swipeHandled = false },
                    onHorizontalDrag = { change, amount ->
                        change.consume()
                        horizontalDistance += amount
                        if (!swipeHandled && kotlin.math.abs(horizontalDistance) >= 80f) {
                            swipeHandled = true
                            localView.performHapticFeedback(HapticFeedbackConstants.CONFIRM)
                            if (horizontalDistance > 0f) onPromoteFrog() else onBreakDown()
                        }
                    }
                )
            }
            .pointerInput(task.id) {
            detectDragGesturesAfterLongPress(
                onDragStart = {
                    dragging = true
                    dragDistance = 0f
                    localView.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
                },
                onDragCancel = {
                    dragging = false
                    dragDistance = 0f
                    onDragEnd()
                },
                onDragEnd = {
                    dragging = false
                    dragDistance = 0f
                    onDragEnd()
                },
                onDrag = { change, dragAmount ->
                    change.consume()
                    dragDistance += dragAmount.y
                    when {
                        dragAmount.y > 0f -> onDragDirection(1)
                        dragAmount.y < 0f -> onDragDirection(-1)
                    }
                    while (dragDistance >= 48f) {
                        onMove(1)
                        dragDistance -= 48f
                    }
                    while (dragDistance <= -48f) {
                        onMove(-1)
                        dragDistance += 48f
                    }
                }
            )
        },
        border = if (dragging) androidx.compose.foundation.BorderStroke(2.dp, MaterialTheme.colorScheme.primary) else null,
        colors = CardDefaults.cardColors(
            containerColor = if (dragging) MaterialTheme.colorScheme.primaryContainer
            else if (task.isExplicitFrogName()) MaterialTheme.colorScheme.primaryContainer
            else if (task.isFrog) MaterialTheme.colorScheme.secondaryContainer
            else MaterialTheme.colorScheme.surface
        ),
        shape = RoundedCornerShape(20.dp)
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(start = 18.dp, top = 12.dp, bottom = 12.dp, end = 8.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text("${task.plannedOrder + 1}", style = MaterialTheme.typography.titleLarge, color = MaterialTheme.colorScheme.primary)
            Spacer(Modifier.width(16.dp))
            Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(
                    if (task.isExplicitFrogName()) "🐸 ${task.title}" else task.title,
                    style = MaterialTheme.typography.bodyLarge,
                    fontWeight = FontWeight.SemiBold
                )
                timeline?.let { block ->
                    Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            Text(formatTimelineTime(block.start), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
                            Box(
                                Modifier
                                    .padding(vertical = 2.dp)
                                    .width(3.dp)
                                    .height(block.durationMinutes.coerceIn(18, 72).dp)
                                    .clip(RoundedCornerShape(50))
                                    .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.45f))
                            )
                            Text(formatTimelineTime(block.end), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
                        }
                        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            Text(
                                formatDurationMinutes(block.durationMinutes),
                                style = MaterialTheme.typography.labelMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                            if (block.overlapsPrevious) {
                                Text("overlap", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error)
                            }
                        }
                    }
                }
                if (task.isFrog || task.isExplicitFrogName()) Text("🐸 Frog", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
            }
            IconButton(onClick = onEdit) { Icon(Icons.Rounded.MoreHoriz, contentDescription = "Edit ${task.title}") }
            IconButton(onClick = { onMove(-1) }, enabled = !isFirst, modifier = Modifier.semantics { contentDescription = "Move ${task.title} up" }) {
                Icon(Icons.Rounded.ArrowUpward, contentDescription = null)
            }
            IconButton(onClick = { onMove(1) }, enabled = !isLast, modifier = Modifier.semantics { contentDescription = "Move ${task.title} down" }) {
                Icon(Icons.Rounded.ArrowDownward, contentDescription = null)
            }
        }
    }
}

@Composable
private fun MonthTaskRow(task: GoalflowTask, onSchedule: (GoalflowTask) -> Unit) {
    Card(shape = RoundedCornerShape(20.dp)) {
        Row(modifier = Modifier.fillMaxWidth().padding(18.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Rounded.DateRange, contentDescription = null, tint = MaterialTheme.colorScheme.secondary)
            Spacer(Modifier.width(14.dp))
            Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(task.title, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold)
                Text(task.scheduledFor, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            TextButton(onClick = { onSchedule(task) }) { Text("Choose day") }
        }
    }
}

@Composable
private fun EmptyPlanning(onCapture: () -> Unit) {
    Column(modifier = Modifier.fillMaxWidth().padding(top = 80.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Icon(Icons.Rounded.Timeline, contentDescription = null, modifier = Modifier.size(48.dp), tint = MaterialTheme.colorScheme.primary)
        Text("Nothing needs planning", style = MaterialTheme.typography.titleLarge)
        Text("Capture a scheduled commitment to give today a deliberate shape.", textAlign = TextAlign.Center, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Button(onClick = onCapture) { Text("Capture commitment") }
    }
}

@Composable
private fun GoalsScreen(goals: List<GoalflowGoal>, onAdd: () -> Unit) {
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(24.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp)
    ) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("Goals", style = MaterialTheme.typography.headlineLarge)
                    Text("Direction that becomes action", style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                FloatingActionButton(onClick = onAdd, modifier = Modifier.size(52.dp)) { Icon(Icons.Rounded.Add, contentDescription = "Add goal") }
            }
        }
        if (goals.isEmpty()) {
            item {
                Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant), shape = RoundedCornerShape(26.dp)) {
                    Column(modifier = Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        Text("A goal should pull action forward", style = MaterialTheme.typography.titleLarge)
                        Text("Keep it concrete. Then put the next commitment on a day.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Button(onClick = onAdd) { Text("Add a goal") }
                    }
                }
            }
        } else {
            items(goals, key = { it.id }) { goal -> GoalRow(goal) }
        }
    }
}

@Composable
private fun GoalRow(goal: GoalflowGoal) {
    Card(shape = RoundedCornerShape(22.dp)) {
        Column(modifier = Modifier.fillMaxWidth().padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Box(modifier = Modifier.size(12.dp).clip(CircleShape).background(MaterialTheme.colorScheme.primary))
                Text(goal.name, style = MaterialTheme.typography.titleLarge)
            }
            if (goal.description.isNotBlank()) Text(goal.description, color = MaterialTheme.colorScheme.onSurfaceVariant)
            goal.deadline?.let { Text("By $it", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.secondary) }
        }
    }
}

@Composable
private fun SettingsScreen(
    signedIn: Boolean,
    mfaVerified: Boolean,
    cloudSessionProblem: String?,
    canUseAuthentication: Boolean,
    canUseCloud: Boolean,
    canUseTelegram: Boolean,
    telegramStatus: NativeTelegramStatus?,
    telegramStatusMessage: String?,
    telegramWorking: Boolean,
    onSignIn: () -> Unit,
    onVerifyMfa: () -> Unit,
    onSignOut: () -> Unit,
    onConnectTelegram: () -> Unit,
    onDisconnectTelegram: () -> Unit,
    onExport: () -> Unit,
    onImport: () -> Unit,
    restoreCheckpointAvailable: Boolean,
    onRollback: () -> Unit
) {
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(24.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp)
    ) {
        item { Text("Settings", style = MaterialTheme.typography.headlineLarge) }
        item {
            SettingsCard(
                title = "Local-first",
                body = "Your commitments remain usable without Wi-Fi. Local actions never wait for a server."
            )
        }
        item {
            SettingsCard(
                title = "Cloud sync",
                body = when {
                    cloudSessionProblem != null -> cloudSessionProblem
                    signedIn && canUseCloud && mfaVerified -> "Signed in with owner verification. Local actions stay immediate; queued changes are complete only after server acknowledgment."
                    signedIn && canUseCloud -> "Signed in at basic assurance. Beta accounts can sync; owner accounts must verify an authenticator before cloud sync can continue."
                    canUseCloud -> "Optional. Sign in to sync across devices. Local execution never waits for it."
                    else -> "Not configured in this build. Local execution is complete without a backend."
                },
                actionLabel = when {
                    signedIn -> "Sign out"
                    canUseAuthentication -> "Sign in"
                    else -> null
                },
                onAction = if (signedIn) onSignOut else onSignIn
            )
            if (signedIn && canUseAuthentication && !mfaVerified) {
                Spacer(Modifier.height(8.dp))
                OutlinedButton(onClick = onVerifyMfa, modifier = Modifier.fillMaxWidth().height(52.dp)) {
                    Text("Verify owner session")
                }
            }
        }
        if (signedIn && canUseTelegram) {
            item {
                SettingsCard(
                    title = "Telegram",
                    body = when {
                        telegramStatusMessage != null -> telegramStatusMessage
                        telegramWorking -> "Checking the securely linked Telegram identity…"
                        telegramStatus?.enabled != true -> "Telegram is not enabled by the current Tsurfing server."
                        telegramStatus.linked -> telegramStatus.username
                            ?.takeIf(String::isNotBlank)
                            ?.let { "Connected as @$it. Bot access can be revoked here." }
                            ?: "Connected. Bot access can be revoked here."
                        else -> "Connect a Telegram identity explicitly. Tsurfing never merges accounts by email, username, phone, or profile metadata."
                    },
                    actionLabel = when {
                        telegramWorking || telegramStatus?.enabled != true -> null
                        telegramStatus.linked -> "Disconnect Telegram"
                        else -> "Connect Telegram"
                    },
                    onAction = if (telegramStatus?.linked == true) onDisconnectTelegram else onConnectTelegram
                )
            }
        }
        item {
            SettingsCard(
                title = "Backup and recovery",
                body = "Export an encrypted copy or restore one atomically. A wrong password or damaged file leaves current data untouched.",
                actionLabel = "Export backup",
                onAction = onExport
            )
            Spacer(Modifier.height(8.dp))
            OutlinedButton(onClick = onImport, modifier = Modifier.fillMaxWidth().height(52.dp)) {
                Text("Import backup")
            }
            if (restoreCheckpointAvailable) {
                Text(
                    "An encrypted checkpoint from the last restore is available.",
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                OutlinedButton(onClick = onRollback, modifier = Modifier.fillMaxWidth().height(52.dp)) {
                    Text("Rollback last restore")
                }
            }
        }
        item {
            SettingsCard(
                title = "Tsurfing native",
                body = "A focused Android client with the existing durable sync rules intact."
            )
        }
    }
}

@Composable
private fun SettingsCard(title: String, body: String, actionLabel: String? = null, onAction: (() -> Unit)? = null) {
    Card(shape = RoundedCornerShape(22.dp)) {
        Column(modifier = Modifier.fillMaxWidth().padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(title, style = MaterialTheme.typography.titleLarge)
            Text(body, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (actionLabel != null && onAction != null) {
                TextButton(onClick = onAction) { Text(actionLabel) }
            }
        }
    }
}

@Composable
private fun BackupPasswordDialog(
    action: String,
    error: String?,
    onDismiss: () -> Unit,
    onConfirm: (String) -> Unit
) {
    var password by rememberSaveable { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Text(
                when (action) {
                    "export" -> "Protect backup"
                    "rollback" -> "Unlock restore checkpoint"
                    else -> "Unlock backup"
                }
            )
        },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(
                    when (action) {
                        "export" -> "Use a password you can recover later. Tsurfing cannot reset it."
                        "rollback" -> "The checkpoint was encrypted before the last restore."
                        else -> "The backup is validated and previewed before it changes local data."
                    },
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                OutlinedTextField(
                    value = password,
                    onValueChange = { password = it },
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("Backup password") },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = KeyboardType.Password)
                )
                error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            }
        },
        confirmButton = {
            Button(onClick = { onConfirm(password) }, enabled = password.isNotBlank()) {
                Text(if (action == "export") "Continue" else if (action == "rollback") "Rollback" else "Preview restore")
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } }
    )
}

@Composable
private fun RestorePreviewDialog(
    preview: NativeBackupPreview,
    busy: Boolean,
    error: String?,
    onDismiss: () -> Unit,
    onMerge: () -> Unit,
    onReplace: () -> Unit
) {
    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text("Preview backup restore") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(7.dp)) {
                Text("Exported: ${preview.exportedAt ?: "unknown"}")
                Text(
                    "Incoming: ${preview.incomingTaskCount} tasks, ${preview.incomingGoalCount} goals, " +
                        "${preview.incomingHabitCount} habits, ${preview.incomingPlanCount} plans, " +
                        "${preview.incomingEventCount} events, ${preview.incomingRawCollectionCount} preserved collections."
                )
                Text(
                    "Merge: +${preview.tasksToAdd} tasks, ${preview.tasksToChange} changed, " +
                        "+${preview.goalsToAdd} goals, +${preview.habitsToAdd} habits."
                )
                Text(
                    "Explicit Replace would remove ${preview.tasksToRemoveOnReplace} tasks, " +
                        "${preview.goalsToRemoveOnReplace} goals, and ${preview.habitsToRemoveOnReplace} habits locally."
                )
                if (preview.syncStateWillBeQuarantined) {
                    Text(
                        "Sync metadata belongs to another backend, protocol, or account and will be quarantined locally.",
                        color = MaterialTheme.colorScheme.error
                    )
                }
                error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            }
        },
        confirmButton = {
            Button(onClick = onMerge, enabled = !busy) {
                Text(if (busy) "Restoring…" else "Merge safely")
            }
        },
        dismissButton = {
            Column(horizontalAlignment = Alignment.End) {
                TextButton(onClick = onReplace, enabled = !busy) { Text("Review explicit Replace") }
                TextButton(onClick = onDismiss, enabled = !busy) { Text("Cancel") }
            }
        }
    )
}

@Composable
private fun ReplaceRestoreDialog(
    preview: NativeBackupPreview,
    busy: Boolean,
    onDismiss: () -> Unit,
    onConfirm: () -> Unit
) {
    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text("Replace local data?") },
        text = {
            Text(
                "This explicit choice removes records missing from the backup, creates an encrypted rollback checkpoint first, " +
                    "and queues the resulting local changes for safe reconciliation."
            )
        },
        confirmButton = {
            Button(onClick = onConfirm, enabled = !busy) { Text(if (busy) "Replacing…" else "Replace and checkpoint") }
        },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !busy) { Text("Cancel") } }
    )
}

@Composable
private fun SignInDialog(
    error: String?,
    pendingAttempt: PendingEmailOtpAttempt?,
    canUseTelegram: Boolean,
    loadCaptchaPolicy: suspend () -> Boolean,
    onDismiss: () -> Unit,
    onRequest: (String, String, String, String, (PendingEmailOtpAttempt) -> Unit, () -> Unit) -> Unit,
    onVerify: (String, String, () -> Unit, () -> Unit) -> Unit,
    onTelegram: (Boolean, String, String, () -> Unit, () -> Unit) -> Unit
) {
    var email by rememberSaveable(pendingAttempt?.attemptToken) { mutableStateOf(pendingAttempt?.email ?: "") }
    var inviteCode by rememberSaveable { mutableStateOf("") }
    var emailCode by rememberSaveable { mutableStateOf("") }
    var joiningBeta by rememberSaveable(pendingAttempt?.attemptToken) {
        mutableStateOf(pendingAttempt?.purpose == "activation")
    }
    var codeRequested by rememberSaveable(pendingAttempt?.attemptToken) {
        mutableStateOf(pendingAttempt != null)
    }
    var working by rememberSaveable { mutableStateOf(false) }
    var captchaToken by rememberSaveable { mutableStateOf("") }
    var captchaRevision by rememberSaveable { mutableStateOf(0) }
    var captchaMessage by rememberSaveable { mutableStateOf("") }
    var captchaRequired by remember { mutableStateOf<Boolean?>(null) }
    var captchaPolicyError by remember { mutableStateOf<String?>(null) }
    var captchaPolicyRevision by remember { mutableStateOf(0) }
    val verificationReady = captchaRequired == false || (captchaRequired == true && captchaToken.isNotBlank())
    LaunchedEffect(captchaPolicyRevision) {
        captchaRequired = null
        captchaPolicyError = null
        runCatching { loadCaptchaPolicy() }
            .onSuccess { captchaRequired = it }
            .onFailure { captchaPolicyError = it.message ?: "Sign-in settings could not load." }
    }

    var resendAtMillis by rememberSaveable(pendingAttempt?.attemptToken) {
        mutableStateOf(pendingAttempt?.resendAtMillis ?: 0L)
    }
    var clockMillis by remember { mutableStateOf(System.currentTimeMillis()) }
    val resendSeconds = ceil(
        (resendAtMillis - clockMillis).coerceAtLeast(0L) / 1_000.0
    ).toInt()
    LaunchedEffect(error) {
        if (error != null) working = false
    }
    LaunchedEffect(codeRequested, resendAtMillis) {
        while (codeRequested && System.currentTimeMillis() < resendAtMillis) {
            clockMillis = System.currentTimeMillis()
            delay(1_000)
        }
        clockMillis = System.currentTimeMillis()
    }
    AlertDialog(
        onDismissRequest = { if (!working) onDismiss() },
        title = { Text("Sign in to sync") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                if (!codeRequested) {
                    Text(
                        "Tsurfing sends a typed email code. Your local commitments stay available either way.",
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    OutlinedTextField(
                        value = email,
                        onValueChange = { email = it },
                        modifier = Modifier.fillMaxWidth(),
                        label = { Text("Email") },
                        singleLine = true,
                        keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(
                            keyboardType = KeyboardType.Email,
                            imeAction = ImeAction.Next
                        )
                    )
                    if (joiningBeta) {
                        OutlinedTextField(
                            value = inviteCode,
                            onValueChange = { inviteCode = it.take(128) },
                            modifier = Modifier.fillMaxWidth(),
                            label = { Text("Beta invite code") },
                            singleLine = true
                        )
                    }
                    TextButton(onClick = { joiningBeta = !joiningBeta }, enabled = !working) {
                        Text(if (joiningBeta) "I already have an account" else "Join with a beta invite")
                    }
                    if (captchaRequired == null) {
                        Text(captchaPolicyError ?: "Loading sign-in settings…", color = MaterialTheme.colorScheme.onSurfaceVariant)
                        if (captchaPolicyError != null) {
                            TextButton(onClick = { captchaPolicyRevision += 1 }) { Text("Retry sign-in settings") }
                        }
                    }
                    if (captchaRequired == true) NativeCaptchaView(
                        revision = captchaRevision,
                        onToken = {
                            captchaToken = it
                            captchaMessage = "Human verification complete."
                        },
                        onError = { captchaMessage = it }
                    )
                    if (captchaMessage.isNotBlank()) {
                        Text(captchaMessage, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    if (canUseTelegram) {
                        OutlinedButton(
                            onClick = {
                                if (!working) {
                                    working = true
                                    onTelegram(
                                        joiningBeta,
                                        inviteCode,
                                        captchaToken,
                                        { working = false },
                                        { working = false }
                                    )
                                }
                            },
                            modifier = Modifier.fillMaxWidth().height(52.dp),
                            enabled = !working && (!joiningBeta || (
                                inviteCode.length >= 6 && verificationReady
                            ))
                        ) {
                            Text(if (joiningBeta) "Join beta with Telegram" else "Continue with Telegram")
                        }
                    }
                } else {
                    Text(
                        "Enter the six-digit code sent to ${email.trim().lowercase()}.",
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    OutlinedTextField(
                        value = emailCode,
                        onValueChange = { emailCode = it.filter(Char::isDigit).take(6) },
                        modifier = Modifier.fillMaxWidth(),
                        label = { Text("Email code") },
                        singleLine = true,
                        keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(
                            keyboardType = KeyboardType.NumberPassword,
                            imeAction = ImeAction.Done
                        )
                    )
                    TextButton(onClick = {
                        codeRequested = false
                        emailCode = ""
                        captchaToken = ""
                        captchaMessage = ""
                        captchaRevision += 1
                    }, enabled = !working && resendSeconds == 0) {
                        Text(if (resendSeconds > 0) "Request another code in ${resendSeconds}s" else "Request another code")
                    }
                }
                error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            }
        },
        confirmButton = {
            Button(
                onClick = {
                    if (!working) {
                        working = true
                        if (codeRequested) {
                            onVerify(
                                email,
                                emailCode,
                                { working = false },
                                { working = false }
                            )
                        } else {
                            onRequest(
                                email,
                                if (joiningBeta) "activation" else "sign_in",
                                if (joiningBeta) inviteCode else "",
                                captchaToken,
                                { attempt ->
                                    working = false
                                    email = attempt.email
                                    joiningBeta = attempt.purpose == "activation"
                                    codeRequested = true
                                    resendAtMillis = attempt.resendAtMillis
                                    clockMillis = System.currentTimeMillis()
                                    captchaToken = ""
                                },
                                { working = false }
                            )
                        }
                    }
                },
                enabled = !working && if (codeRequested) {
                    emailCode.length == 6
                } else {
                    email.isNotBlank() && verificationReady && (!joiningBeta || inviteCode.length >= 6)
                }
            ) { Text(if (working) "Working…" else if (codeRequested) "Verify code" else "Send email code") }
        },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !working) { Text("Cancel") } }
    )
}

@Composable
private fun MfaDialog(
    error: String?,
    onDismiss: () -> Unit,
    onConfirm: (String, () -> Unit, () -> Unit) -> Unit
) {
    var code by rememberSaveable { mutableStateOf("") }
    var verifying by rememberSaveable { mutableStateOf(false) }
    LaunchedEffect(error) {
        if (error != null) verifying = false
    }
    AlertDialog(
        onDismissRequest = { if (!verifying) onDismiss() },
        title = { Text("Verify owner session") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(
                    "Enter the six-digit code from the authenticator enrolled for the owner account.",
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                OutlinedTextField(
                    value = code,
                    onValueChange = { code = it.filter(Char::isDigit).take(6) },
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("Authenticator code") },
                    singleLine = true,
                    keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(
                        keyboardType = KeyboardType.NumberPassword,
                        imeAction = ImeAction.Done
                    ),
                    visualTransformation = PasswordVisualTransformation()
                )
                error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            }
        },
        confirmButton = {
            Button(
                onClick = {
                    if (!verifying) {
                        verifying = true
                        onConfirm(code, { verifying = false }, { verifying = false })
                    }
                },
                enabled = code.length == 6 && !verifying
            ) { Text(if (verifying) "Verifying…" else "Verify") }
        },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !verifying) { Text("Cancel") } }
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CaptureSheet(
    formKey: Int,
    initialTitle: String,
    today: String,
    goals: List<GoalflowGoal>,
    error: String?,
    onDismiss: () -> Unit,
    onSave: (String, String, SchedulePrecision, String, String?, Boolean, String?, Int) -> Unit
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var title by rememberSaveable(formKey) { mutableStateOf(initialTitle) }
    var notes by rememberSaveable(formKey) { mutableStateOf("") }
    var precision by rememberSaveable(formKey) { mutableStateOf(SchedulePrecision.DAY) }
    var selectedDate by rememberSaveable(formKey) { mutableStateOf(today) }
    var scheduledTime by rememberSaveable(formKey) { mutableStateOf<String?>(null) }
    var frog by rememberSaveable(formKey) { mutableStateOf(false) }
    var selectedGoalId by rememberSaveable(formKey) { mutableStateOf<String?>(null) }
    var duration by rememberSaveable(formKey) { mutableStateOf(25) }
    var showDatePicker by rememberSaveable(formKey) { mutableStateOf(false) }
    var goalMenuOpen by rememberSaveable(formKey) { mutableStateOf(false) }
    var saving by rememberSaveable(formKey) { mutableStateOf(false) }
    var localError by rememberSaveable(formKey) { mutableStateOf<String?>(null) }
    val focusManager = LocalFocusManager.current
    val focusRequester = remember { FocusRequester() }
    val keyboardController = LocalSoftwareKeyboardController.current

    LaunchedEffect(Unit) {
        var focused = false
        repeat(10) {
            if (!focused) {
                withFrameNanos { }
                focused = runCatching {
                    focusRequester.requestFocus()
                    true
                }.getOrDefault(false)
            }
            if (!focused) delay(40)
        }
        if (focused) keyboardController?.show()
    }
    LaunchedEffect(error) {
        if (error != null) saving = false
    }

    fun submit() {
        if (saving || title.isBlank()) return
        saving = true
        localError = null
        focusManager.clearFocus()
        onSave(
            title,
            notes,
            precision,
            if (precision == SchedulePrecision.DAY) selectedDate else selectedDate.substring(0, 7),
            scheduledTime?.takeIf { precision == SchedulePrecision.DAY && it.isNotBlank() },
            frog,
            selectedGoalId,
            duration
        )
    }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = goalflowCaptureSurface(),
        modifier = Modifier.imePadding()
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .navigationBarsPadding()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 24.dp)
                .padding(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp)
        ) {
            Text("Capture", style = MaterialTheme.typography.headlineMedium)
            Text("Give it a day. Keep moving.", color = MaterialTheme.colorScheme.onSurfaceVariant)
            OutlinedTextField(
                value = title,
                onValueChange = { title = it },
                modifier = Modifier
                    .fillMaxWidth()
                    .focusRequester(focusRequester),
                label = { Text("What needs to happen?") },
                singleLine = true,
                keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(imeAction = ImeAction.Done),
                keyboardActions = androidx.compose.foundation.text.KeyboardActions(onDone = {
                    submit()
                })
            )
            OutlinedTextField(
                value = notes,
                onValueChange = { notes = it },
                modifier = Modifier.fillMaxWidth(),
                label = { Text("Notes (optional)") },
                minLines = 2,
                maxLines = 4
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                PrecisionButton("Exact day", precision == SchedulePrecision.DAY) { precision = SchedulePrecision.DAY }
                PrecisionButton("Future month", precision == SchedulePrecision.MONTH) {
                    precision = SchedulePrecision.MONTH
                    val currentMonth = YearMonth.parse(today.substring(0, 7))
                    if (selectedDate.substring(0, 7) <= currentMonth.toString()) {
                        selectedDate = currentMonth.plusMonths(1).atDay(1).toString()
                    }
                }
            }
            OutlinedButton(onClick = { showDatePicker = true }, modifier = Modifier.fillMaxWidth().height(52.dp)) {
                Icon(Icons.Rounded.DateRange, contentDescription = null)
                Spacer(Modifier.width(8.dp))
                Text(if (precision == SchedulePrecision.DAY) formatDate(selectedDate) else formatMonth(selectedDate.substring(0, 7)))
            }
            if (precision == SchedulePrecision.DAY) {
                GoalflowTimeField(
                    value = scheduledTime,
                    onValueChange = { scheduledTime = it },
                    label = "Time (optional)",
                    optional = true
                )
            }
            GoalflowDurationField(
                value = duration,
                onValueChange = { duration = it ?: 25; localError = null },
                label = "Estimated time"
            )
            if (goals.isNotEmpty()) {
                GoalPicker(
                    goals = goals,
                    selectedGoalId = selectedGoalId,
                    expanded = goalMenuOpen,
                    onExpandedChange = { goalMenuOpen = it },
                    onSelect = { selectedGoalId = it; goalMenuOpen = false }
                )
            }
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                Checkbox(checked = frog, onCheckedChange = { frog = it })
                Column(modifier = Modifier.weight(1f)) {
                    Text("Mark as frog", fontWeight = FontWeight.SemiBold)
                    Text("A commitment you refuse to quietly avoid.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            (error ?: localError)?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium) }
            Button(
                onClick = {
                    submit()
                },
                enabled = title.isNotBlank() && !saving,
                modifier = Modifier.fillMaxWidth().height(56.dp)
            ) { Text(if (saving) "Saving…" else "Save commitment") }
        }
    }

    if (showDatePicker) {
        GoalflowDatePickerDialog(
            initialDate = selectedDate,
            onDismiss = { showDatePicker = false },
            onConfirm = { date -> selectedDate = date; showDatePicker = false }
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CircadianCheckInSheet(
    initial: GoalflowCircadianState,
    today: String,
    error: String?,
    onDismiss: () -> Unit,
    onSave: (GoalflowCircadianState) -> Unit
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var wakeTime by rememberSaveable { mutableStateOf<String?>(initial.wakeTime ?: "07:00") }
    var firstMealTime by rememberSaveable { mutableStateOf<String?>(initial.firstMealTime ?: "08:00") }
    var morningLight by rememberSaveable { mutableStateOf(initial.sunrise) }
    var eatingWindow by rememberSaveable { mutableStateOf((initial.eatingWindow ?: 10).toFloat()) }
    var sleepHours by rememberSaveable { mutableStateOf(initial.sleepHours.coerceIn(0, 24).toFloat()) }
    var currentState by rememberSaveable { mutableStateOf(initial.energy.coerceIn(1, 10).toFloat()) }
    var saving by rememberSaveable { mutableStateOf(false) }

    LaunchedEffect(error) {
        if (error != null) saving = false
    }

    fun score(): Int {
        val windowScore = when {
            eatingWindow <= 10f -> 30
            eatingWindow <= 12f -> 20
            else -> 10
        }
        return ((if (morningLight) 30 else 0) + windowScore + currentState.toInt() * 4).coerceIn(0, 100)
    }

    fun modeFor(score: Int): String = when {
        score < 50 -> "recovery"
        score >= 80 -> "apex"
        else -> "maintenance"
    }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = goalflowCaptureSurface(),
        modifier = Modifier.imePadding()
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .navigationBarsPadding()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 24.dp)
                .padding(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp)
        ) {
            Text("Daily rhythm", style = MaterialTheme.typography.headlineMedium)
            Text(
                "A quick check-in tunes the order around the person who has to do it. It is saved locally first.",
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            GoalflowTimeField(
                value = wakeTime,
                onValueChange = { wakeTime = it },
                label = "Wake time",
                optional = false
            )
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                Checkbox(checked = morningLight, onCheckedChange = { morningLight = it })
                Column(modifier = Modifier.weight(1f)) {
                    Text("Morning light", fontWeight = FontWeight.SemiBold)
                    Text(
                        "Bright light within two hours of waking",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
            Text("Eating window: ${eatingWindow.toInt()} hours", fontWeight = FontWeight.SemiBold)
            Slider(
                value = eatingWindow,
                onValueChange = { eatingWindow = it },
                valueRange = 6f..16f,
                steps = 9,
                modifier = Modifier.fillMaxWidth()
            )
            GoalflowTimeField(
                value = firstMealTime,
                onValueChange = { firstMealTime = it },
                label = "First meal",
                optional = false
            )
            Text("Sleep: ${sleepHours.toInt()} hours", fontWeight = FontWeight.SemiBold)
            Slider(
                value = sleepHours,
                onValueChange = { sleepHours = it },
                valueRange = 0f..12f,
                steps = 11,
                modifier = Modifier.fillMaxWidth()
            )
            Text("Current energy and clarity: ${currentState.toInt()}/10", fontWeight = FontWeight.SemiBold)
            Slider(
                value = currentState,
                onValueChange = { currentState = it },
                valueRange = 1f..10f,
                steps = 8,
                modifier = Modifier.fillMaxWidth()
            )
            val calculatedScore = score()
            Card(
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer),
                shape = RoundedCornerShape(18.dp)
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(16.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text("Today's mode", style = MaterialTheme.typography.labelLarge)
                        Text(
                            modeFor(calculatedScore).replaceFirstChar { it.titlecase(Locale.ROOT) },
                            style = MaterialTheme.typography.titleLarge,
                            fontWeight = FontWeight.Bold
                        )
                    }
                    Text("$calculatedScore%", style = MaterialTheme.typography.headlineMedium)
                }
            }
            error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            Button(
                onClick = {
                    if (!saving) {
                        saving = true
                        val calculatedScore = score()
                        onSave(
                            GoalflowCircadianState(
                                lastCheckIn = today,
                                score = calculatedScore,
                                mode = modeFor(calculatedScore),
                                sunriseTime = initial.sunriseTime,
                                sunsetTime = initial.sunsetTime,
                                solarNoonTime = initial.solarNoonTime,
                                sunrise = morningLight,
                                sleepHours = sleepHours.toInt(),
                                energy = currentState.toInt(),
                                clarity = currentState.toInt(),
                                interest = initial.interest.coerceIn(1, 10),
                                wakeTime = wakeTime?.trim(),
                                eatingWindow = eatingWindow.toInt(),
                                firstMealTime = firstMealTime?.trim()
                            )
                        )
                    }
                },
                enabled = !saving,
                modifier = Modifier.fillMaxWidth().height(56.dp)
            ) { Text(if (saving) "Saving…" else "Save today's rhythm") }
        }
    }
}

@Composable
private fun RowScope.PrecisionButton(label: String, selected: Boolean, onClick: () -> Unit) {
    if (selected) Button(onClick = onClick, modifier = Modifier.weight(1f)) { Text(label) }
    else OutlinedButton(onClick = onClick, modifier = Modifier.weight(1f)) { Text(label) }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun GoalSheet(error: String?, onDismiss: () -> Unit, onSave: (String, String) -> Unit) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var name by rememberSaveable { mutableStateOf("") }
    var description by rememberSaveable { mutableStateOf("") }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheetState, modifier = Modifier.imePadding()) {
        Column(
            modifier = Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 24.dp).padding(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp)
        ) {
            Text("New goal", style = MaterialTheme.typography.headlineMedium)
            OutlinedTextField(value = name, onValueChange = { name = it }, modifier = Modifier.fillMaxWidth(), label = { Text("Direction") }, singleLine = true)
            OutlinedTextField(value = description, onValueChange = { description = it }, modifier = Modifier.fillMaxWidth(), label = { Text("What would make it real?") }, minLines = 3, maxLines = 5)
            error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            Button(onClick = { onSave(name, description) }, enabled = name.isNotBlank(), modifier = Modifier.fillMaxWidth().height(56.dp)) { Text("Save goal") }
        }
    }
}

@Composable
private fun BreakdownDialog(
    task: GoalflowTask,
    today: String,
    error: String?,
    onDismiss: () -> Unit,
    onConfirm: (List<BreakdownChild>) -> Unit
) {
    var titles by rememberSaveable(task.id) { mutableStateOf(listOf("")) }
    var durations by rememberSaveable(task.id) { mutableStateOf(listOf(25)) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Break down commitment") },
        text = {
            Column(
                modifier = Modifier.heightIn(max = 440.dp).verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                Text(
                    "Close “${task.title}” by naming the next executable actions. Each one is scheduled for today.",
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                titles.forEachIndexed { index, title ->
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            OutlinedTextField(
                                value = title,
                                onValueChange = { value ->
                                    titles = titles.toMutableList().also { it[index] = value }
                                },
                                modifier = Modifier.weight(1f),
                                label = { Text("Next action ${index + 1}") },
                                singleLine = true,
                                keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(imeAction = ImeAction.Next)
                            )
                            if (titles.size > 1) {
                                TextButton(onClick = {
                                    titles = titles.filterIndexed { itemIndex, _ -> itemIndex != index }
                                    durations = durations.filterIndexed { itemIndex, _ -> itemIndex != index }
                                }) { Text("Remove") }
                            }
                        }
                        GoalflowDurationField(
                            value = durations.getOrElse(index) { 25 },
                            onValueChange = { value ->
                                durations = durations.toMutableList().also { it[index] = value ?: 25 }
                            },
                            label = "Time for action ${index + 1}"
                        )
                    }
                }
                if (titles.size < 5) {
                    TextButton(onClick = {
                        titles = titles + ""
                        durations = durations + 25
                    }) { Text("Add another action") }
                }
                error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            }
        },
        confirmButton = {
            Button(
                onClick = {
                    onConfirm(
                        titles.mapIndexedNotNull { index, value ->
                            value.trim().takeIf(String::isNotBlank)?.let { cleanTitle ->
                                BreakdownChild(
                                    title = cleanTitle,
                                    scheduledFor = today,
                                    duration = durations.getOrElse(index) { 25 }
                                )
                            }
                        }
                    )
                },
                enabled = titles.any { it.isNotBlank() }
            ) { Text("Create next actions") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } }
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun GoalflowDatePickerDialog(initialDate: String, onDismiss: () -> Unit, onConfirm: (String) -> Unit) {
    val initialMillis = runCatching {
        localDateToDatePickerMillis(LocalDate.parse(initialDate.take(10)))
    }.getOrDefault(localDateToDatePickerMillis(LocalDate.ofEpochDay(0)))
    val state = rememberDatePickerState(initialSelectedDateMillis = initialMillis)
    DatePickerDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            TextButton(onClick = {
                val selected = state.selectedDateMillis ?: initialMillis
                onConfirm(datePickerMillisToLocalDate(selected).toString())
            }) { Text("Use date") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } }
    ) { DatePicker(state = state) }
}

private fun formatDate(value: String): String = runCatching {
    LocalDate.parse(value).format(DateTimeFormatter.ofLocalizedDate(FormatStyle.FULL).withLocale(Locale.getDefault()))
}.getOrDefault(value)

private fun formatMonth(value: String): String = runCatching {
    YearMonth.parse(value).format(DateTimeFormatter.ofPattern("LLLL yyyy", Locale.getDefault()))
}.getOrDefault(value)
