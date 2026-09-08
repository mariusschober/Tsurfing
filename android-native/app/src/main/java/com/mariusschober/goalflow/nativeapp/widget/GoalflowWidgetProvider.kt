package com.mariusschober.goalflow.nativeapp.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.view.View
import android.widget.RemoteViews
import com.mariusschober.goalflow.nativeapp.GOALFLOW_CAPTURE_ACTION
import com.mariusschober.goalflow.nativeapp.GoalflowApplication
import com.mariusschober.goalflow.nativeapp.MainActivity
import com.mariusschober.goalflow.nativeapp.R
import com.mariusschober.goalflow.nativeapp.data.NativeWidgetAction
import com.mariusschober.goalflow.nativeapp.data.NativeWidgetSnapshot
import com.mariusschober.goalflow.nativeapp.data.NativeWidgetTarget
import androidx.lifecycle.ProcessLifecycleOwner
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

internal object GoalflowWidgetIntent {
    const val ACTION = "com.mariusschober.tsurfing.WIDGET_ACTION"
    const val EXTRA_ACTION = "goalflow_widget_action"
    const val EXTRA_TASK_ID = "goalflow_widget_task_id"
    const val EXTRA_EXPECTED_UPDATED_AT = "goalflow_widget_expected_updated_at"
    const val EXTRA_EXPECTED_PRIOR_UPDATED_AT = "goalflow_widget_expected_prior_updated_at"
    const val EXTRA_LOCAL_DATE = "goalflow_widget_local_date"
    const val EXTRA_PLAN_FINGERPRINT = "goalflow_widget_plan_fingerprint"
    const val ACTION_COMPLETE = "complete"
    const val ACTION_SKIP = "skip"
    const val ACTION_UNDO = "undo"
    const val ACTION_ADD = "add"
}

private data class WidgetUndoState(
    val taskId: String,
    val expectedUpdatedAt: Long,
    val localDate: String,
    val planFingerprint: String,
    val expectedPriorUpdatedAt: Long
)

private object GoalflowWidgetState {
    private const val PREFS = "goalflow-widget-state"
    private const val KEY_ERROR = "error"
    private const val KEY_UNDO_TASK_ID = "undoTaskId"
    private const val KEY_UNDO_UPDATED_AT = "undoUpdatedAt"
    private const val KEY_UNDO_LOCAL_DATE = "undoLocalDate"
    private const val KEY_UNDO_PLAN_FINGERPRINT = "undoPlanFingerprint"
    private const val KEY_UNDO_PRIOR_UPDATED_AT = "undoPriorUpdatedAt"

    private fun preferences(context: Context) =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun error(context: Context): String? = preferences(context).getString(KEY_ERROR, null)

    fun setError(context: Context, message: String) {
        preferences(context).edit().putString(KEY_ERROR, message).commit()
    }

    fun clearError(context: Context) {
        preferences(context).edit().remove(KEY_ERROR).commit()
    }

    fun setUndo(
        context: Context,
        taskId: String,
        expectedUpdatedAt: Long,
        localDate: String,
        planFingerprint: String,
        expectedPriorUpdatedAt: Long
    ) {
        preferences(context).edit()
            .putString(KEY_UNDO_TASK_ID, taskId)
            .putLong(KEY_UNDO_UPDATED_AT, expectedUpdatedAt)
            .putString(KEY_UNDO_LOCAL_DATE, localDate)
            .putString(KEY_UNDO_PLAN_FINGERPRINT, planFingerprint)
            .putLong(KEY_UNDO_PRIOR_UPDATED_AT, expectedPriorUpdatedAt)
            .commit()
    }

    fun undo(context: Context): WidgetUndoState? {
        val prefs = preferences(context)
        val taskId = prefs.getString(KEY_UNDO_TASK_ID, null)?.takeIf(String::isNotBlank) ?: return null
        if (!prefs.contains(KEY_UNDO_UPDATED_AT) || !prefs.contains(KEY_UNDO_LOCAL_DATE) ||
            !prefs.contains(KEY_UNDO_PLAN_FINGERPRINT) || !prefs.contains(KEY_UNDO_PRIOR_UPDATED_AT)
        ) return null
        val localDate = prefs.getString(KEY_UNDO_LOCAL_DATE, null)?.takeIf(String::isNotBlank) ?: return null
        val fingerprint = prefs.getString(KEY_UNDO_PLAN_FINGERPRINT, null)?.takeIf(String::isNotBlank) ?: return null
        return WidgetUndoState(
            taskId = taskId,
            expectedUpdatedAt = prefs.getLong(KEY_UNDO_UPDATED_AT, 0L),
            localDate = localDate,
            planFingerprint = fingerprint,
            expectedPriorUpdatedAt = prefs.getLong(KEY_UNDO_PRIOR_UPDATED_AT, Long.MIN_VALUE)
        )
    }

    fun clearUndo(context: Context) {
        preferences(context).edit()
            .remove(KEY_UNDO_TASK_ID)
            .remove(KEY_UNDO_UPDATED_AT)
            .remove(KEY_UNDO_LOCAL_DATE)
            .remove(KEY_UNDO_PLAN_FINGERPRINT)
            .remove(KEY_UNDO_PRIOR_UPDATED_AT)
            .commit()
    }
}

class GoalflowWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, appWidgetIds: IntArray) {
        GoalflowWidgetUpdater.refresh(context)
    }

    override fun onReceive(context: Context, intent: Intent?) {
        super.onReceive(context, intent)
        if (intent?.action != GoalflowWidgetIntent.ACTION) return
        val pendingResult = goAsync()
        val appContext = context.applicationContext
        widgetScope.launch {
            try {
                val application = appContext as? GoalflowApplication
                    ?: error("Tsurfing is not ready to handle a widget action.")
                when (intent.getStringExtra(GoalflowWidgetIntent.EXTRA_ACTION)) {
                    GoalflowWidgetIntent.ACTION_COMPLETE -> {
                        val target = readTarget(intent)
                        application.repository.executeWidgetAction(NativeWidgetAction.COMPLETE, target)
                        val completed = application.repository.taskSnapshot(target.taskId)
                            ?: error("The completed task could not be re-read safely.")
                        GoalflowWidgetState.setUndo(
                            context = appContext,
                            taskId = completed.id,
                            expectedUpdatedAt = completed.updatedAt,
                            localDate = target.localDate,
                            planFingerprint = target.planFingerprint,
                            expectedPriorUpdatedAt = target.expectedUpdatedAt
                        )
                        application.soundController.playCompletion(completed.isFrog)
                    }
                    GoalflowWidgetIntent.ACTION_SKIP -> {
                        application.repository.executeWidgetAction(NativeWidgetAction.SKIP, readTarget(intent))
                    }
                    GoalflowWidgetIntent.ACTION_UNDO -> {
                        application.repository.executeWidgetAction(NativeWidgetAction.UNDO, readTarget(intent))
                        GoalflowWidgetState.clearUndo(appContext)
                    }
                    else -> error("This widget action is no longer supported. Refresh the widget.")
                }
                GoalflowWidgetState.clearError(appContext)
            } catch (failure: Exception) {
                // A widget action is never reported as successful after a
                // stale or failed transaction. Keep the reason visible until
                // the next successful action or refresh.
                GoalflowWidgetState.setError(
                    appContext,
                    failure.message ?: "The widget action failed. Refresh and try again."
                )
            } finally {
                GoalflowWidgetUpdater.refresh(appContext)
                pendingResult.finish()
            }
        }
    }

    override fun onDisabled(context: Context) {
        super.onDisabled(context)
        // P1-5: cancel scope tied to ProcessLifecycleOwner when last widget removed
        try { widgetScope.cancel() } catch (_: Exception) {}
        try { GoalflowWidgetUpdater.cancel() } catch (_: Exception) {}
    }

    private fun readTarget(intent: Intent): NativeWidgetTarget {
        val taskId = intent.getStringExtra(GoalflowWidgetIntent.EXTRA_TASK_ID)
            ?.takeIf(String::isNotBlank)
            ?: error("The widget action has no task identity.")
        val localDate = intent.getStringExtra(GoalflowWidgetIntent.EXTRA_LOCAL_DATE)
            ?.takeIf(String::isNotBlank)
            ?: error("The widget action has no local date.")
        val fingerprint = intent.getStringExtra(GoalflowWidgetIntent.EXTRA_PLAN_FINGERPRINT)
            ?.takeIf(String::isNotBlank)
            ?: error("The widget action has no plan version.")
        if (!intent.hasExtra(GoalflowWidgetIntent.EXTRA_EXPECTED_UPDATED_AT)) {
            error("The widget action has no task version.")
        }
        val expectedPriorUpdatedAt = if (intent.hasExtra(GoalflowWidgetIntent.EXTRA_EXPECTED_PRIOR_UPDATED_AT)) {
            intent.getLongExtra(GoalflowWidgetIntent.EXTRA_EXPECTED_PRIOR_UPDATED_AT, Long.MIN_VALUE)
        } else null
        return NativeWidgetTarget(
            taskId = taskId,
            expectedUpdatedAt = intent.getLongExtra(
                GoalflowWidgetIntent.EXTRA_EXPECTED_UPDATED_AT,
                Long.MIN_VALUE
            ),
            localDate = localDate,
            planFingerprint = fingerprint,
            expectedPriorUpdatedAt = expectedPriorUpdatedAt
        )
    }

    companion object {
        internal fun actionPendingIntent(
            context: Context,
            action: String,
            snapshot: NativeWidgetSnapshot
        ): PendingIntent {
            val task = snapshot.currentTask
            val intent = Intent(context, GoalflowWidgetProvider::class.java)
                .setPackage(context.packageName)
                .setAction(GoalflowWidgetIntent.ACTION)
                .putExtra(GoalflowWidgetIntent.EXTRA_ACTION, action)
                .putExtra(GoalflowWidgetIntent.EXTRA_TASK_ID, task?.id.orEmpty())
                .putExtra(GoalflowWidgetIntent.EXTRA_EXPECTED_UPDATED_AT, task?.updatedAt ?: Long.MIN_VALUE)
                .putExtra(GoalflowWidgetIntent.EXTRA_LOCAL_DATE, snapshot.localDate)
                .putExtra(GoalflowWidgetIntent.EXTRA_PLAN_FINGERPRINT, snapshot.planFingerprint)
            // Use task.id + localDate + action to avoid hashCode collisions (FB/Ea)
            val requestCode = "${snapshot.localDate}|$action|${task?.id.orEmpty()}|${task?.updatedAt}".hashCode()
            return PendingIntent.getBroadcast(
                context,
                requestCode,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        }

        internal fun undoPendingIntent(
            context: Context,
            taskId: String,
            expectedUpdatedAt: Long,
            localDate: String,
            planFingerprint: String,
            expectedPriorUpdatedAt: Long
        ): PendingIntent {
            val intent = Intent(context, GoalflowWidgetProvider::class.java)
                .setPackage(context.packageName)
                .setAction(GoalflowWidgetIntent.ACTION)
                .putExtra(GoalflowWidgetIntent.EXTRA_ACTION, GoalflowWidgetIntent.ACTION_UNDO)
                .putExtra(GoalflowWidgetIntent.EXTRA_TASK_ID, taskId)
                .putExtra(GoalflowWidgetIntent.EXTRA_EXPECTED_UPDATED_AT, expectedUpdatedAt)
                .putExtra(GoalflowWidgetIntent.EXTRA_LOCAL_DATE, localDate)
                .putExtra(GoalflowWidgetIntent.EXTRA_PLAN_FINGERPRINT, planFingerprint)
                .putExtra(GoalflowWidgetIntent.EXTRA_EXPECTED_PRIOR_UPDATED_AT, expectedPriorUpdatedAt)
            return PendingIntent.getBroadcast(
                context,
                "undo|$taskId|$expectedUpdatedAt|$planFingerprint".hashCode(),
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        }

        internal fun addPendingIntent(context: Context): PendingIntent {
            val intent = Intent(context, MainActivity::class.java)
                .setAction(GOALFLOW_CAPTURE_ACTION)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            return PendingIntent.getActivity(
                context,
                GoalflowWidgetIntent.ACTION_ADD.hashCode(),
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        }
    }
}

object GoalflowWidgetUpdater {
    private val exceptionHandler = CoroutineExceptionHandler { _, t -> android.util.Log.e("GoalflowWidgetUpdater", "updater error", t) }
    private val scope: CoroutineScope
        get() = try { ProcessLifecycleOwner.get().lifecycleScope } catch (_: Exception) { CoroutineScope(SupervisorJob() + Dispatchers.IO + exceptionHandler) }
    private var debounceJob: Job? = null
    @Volatile private var lastFingerprint: String? = null

    fun cancel() { debounceJob?.cancel(); debounceJob = null }

    fun refresh(context: Context) {
        debounceJob?.cancel()
        debounceJob = scope.launch {
            delay(500)
            val appContext = context.applicationContext
            val manager = AppWidgetManager.getInstance(appContext)
            val component = ComponentName(appContext, GoalflowWidgetProvider::class.java)
            val ids = manager.getAppWidgetIds(component)
            if (ids.isEmpty()) return@launch
            val application = appContext as GoalflowApplication
            val snapshot = application.repository.widgetSnapshot()
            // distinctUntilChanged by planFingerprint
            if (snapshot.planFingerprint == lastFingerprint) return@launch
            lastFingerprint = snapshot.planFingerprint
            val undoState = GoalflowWidgetState.undo(appContext)
            val undoTask = undoState?.let { application.repository.taskSnapshot(it.taskId) }
                ?.takeIf { it.status.name == "COMPLETED" && it.updatedAt == undoState.expectedUpdatedAt }
            if (undoState != null && undoTask == null) GoalflowWidgetState.clearUndo(appContext)
            render(manager, ids, appContext, snapshot, undoTask, undoState, GoalflowWidgetState.error(appContext))
        }
    }

    private fun render(
        manager: AppWidgetManager,
        ids: IntArray,
        context: Context,
        snapshot: NativeWidgetSnapshot,
        undoTask: com.mariusschober.goalflow.nativeapp.domain.GoalflowTask?,
        undoState: WidgetUndoState?,
        error: String?
    ) {
        val views = RemoteViews(context.packageName, R.layout.widget_goalflow)
        val total = snapshot.plannedCount
        val completed = snapshot.completedCount.coerceIn(0, total.coerceAtLeast(1))
        val hasCurrentTask = snapshot.currentTask != null
        views.setTextViewText(R.id.widget_done_count, completed.toString())
        views.setTextViewText(R.id.widget_total_count, total.toString())
        views.setProgressBar(R.id.widget_progress, total.coerceAtLeast(1), completed, false)
        views.setTextViewText(
            R.id.widget_current_task,
            snapshot.currentTask?.title ?: "Nothing scheduled right now"
        )
        views.setContentDescription(
            R.id.widget_current_task,
            snapshot.currentTask?.title ?: "Nothing scheduled right now"
        )
        views.setViewVisibility(R.id.widget_complete, if (hasCurrentTask) View.VISIBLE else View.GONE)
        views.setViewVisibility(R.id.widget_skip, if (hasCurrentTask) View.VISIBLE else View.GONE)
        views.setOnClickPendingIntent(
            R.id.widget_complete,
            GoalflowWidgetProvider.actionPendingIntent(context, GoalflowWidgetIntent.ACTION_COMPLETE, snapshot)
        )
        views.setOnClickPendingIntent(
            R.id.widget_skip,
            GoalflowWidgetProvider.actionPendingIntent(context, GoalflowWidgetIntent.ACTION_SKIP, snapshot)
        )
        views.setViewVisibility(R.id.widget_undo, if (undoTask != null) View.VISIBLE else View.GONE)
        if (undoTask != null && undoState != null) {
                views.setOnClickPendingIntent(
                    R.id.widget_undo,
                    GoalflowWidgetProvider.undoPendingIntent(
                        context = context,
                        taskId = undoTask.id,
                        expectedUpdatedAt = undoState.expectedUpdatedAt,
                        localDate = undoState.localDate,
                        planFingerprint = undoState.planFingerprint,
                        expectedPriorUpdatedAt = undoState.expectedPriorUpdatedAt
                    )
                )
        }
        views.setOnClickPendingIntent(R.id.widget_add, GoalflowWidgetProvider.addPendingIntent(context))
        views.setViewVisibility(R.id.widget_status, if (error.isNullOrBlank()) View.GONE else View.VISIBLE)
        error?.let { views.setTextViewText(R.id.widget_status, it) }
        manager.updateAppWidget(ids, views)
    }
}

private val widgetExceptionHandler = CoroutineExceptionHandler { _, t -> android.util.Log.e("GoalflowWidget", "widget scope error", t) }
private val widgetScope: CoroutineScope
    get() = try {
        ProcessLifecycleOwner.get().lifecycleScope
    } catch (_: Exception) {
        CoroutineScope(SupervisorJob() + Dispatchers.IO + widgetExceptionHandler)
    }
