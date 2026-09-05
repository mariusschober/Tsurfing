package com.mariusschober.goalflow.nativeapp

import android.content.Intent
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeLeft
import androidx.compose.ui.test.swipeRight
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.runBlocking
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Device-side contract for the first frame: the native client must expose its
 * local Current surface and its capture action without waiting for cloud state.
 */
@RunWith(AndroidJUnit4::class)
class NativeAndroidSmokeTest {
    @get:Rule
    val composeRule = createAndroidComposeRule<MainActivity>()

    @Test
    fun current_surface_exposes_capture_action() {
        composeRule.waitForIdle()
        composeRule.onAllNodesWithText("Current").onFirst().assertIsDisplayed()
        composeRule
            .onNodeWithContentDescription("Capture a scheduled commitment")
            .assertIsDisplayed()
    }

    @Test
    fun activity_recreation_keeps_current_destination() {
        composeRule.activityRule.scenario.recreate()
        composeRule.waitForIdle()
        composeRule.onAllNodesWithText("Current").onFirst().assertIsDisplayed()
    }

    @Test
    fun capture_uses_clock_and_duration_controls_without_text_time_entry() {
        composeRule
            .onNodeWithContentDescription("Capture a scheduled commitment")
            .performClick()
        composeRule.waitForIdle()
        composeRule.onNodeWithText("Capture").assertIsDisplayed()
        composeRule.onNodeWithText("Time (optional)").assertIsDisplayed()
        composeRule.onNodeWithText("Choose time").performClick()
        composeRule.waitForIdle()
        composeRule.onNodeWithText("Set").assertIsDisplayed()
        composeRule.onNodeWithText("Cancel").performClick()
        composeRule.onNodeWithText("25 min").assertIsDisplayed()
    }

    @Test
    fun focus_session_is_full_screen_and_can_break_down_before_completion() {
        val application = composeRule.activity.application as GoalflowApplication
        val today = java.time.LocalDate.now().toString()
        application.focusSessionStore.clear()
        val task = runBlocking {
            application.database.taskDao().deleteAll()
            application.database.dailyPlanDao().deleteAll()
            application.repository.createTask(
                title = "Emulator focus commitment",
                notes = "",
                schedulePrecision = com.mariusschober.goalflow.nativeapp.domain.SchedulePrecision.DAY,
                scheduledFor = today,
                scheduledTime = null,
                isFrog = false,
                duration = 5
            ).also { created -> application.repository.confirmPlan(today, listOf(created.id)) }
        }
        composeRule.waitUntil(10_000) {
            composeRule.onAllNodesWithText("Start focus session").fetchSemanticsNodes().isNotEmpty()
        }
        composeRule.onNodeWithText("Start focus session").performClick()
        composeRule.waitForIdle()
        composeRule.onNodeWithText("FOCUS SESSION").assertIsDisplayed()
        check(composeRule.onAllNodesWithText("Planning").fetchSemanticsNodes().isEmpty())

        composeRule.activityRule.scenario.recreate()
        composeRule.waitUntil(10_000) {
            composeRule.onAllNodesWithText("FOCUS SESSION").fetchSemanticsNodes().isNotEmpty()
        }
        composeRule.onNodeWithText("FOCUS SESSION").assertIsDisplayed()
        composeRule.activity.onBackPressedDispatcher.onBackPressed()
        composeRule.waitForIdle()
        composeRule.onNodeWithText("FOCUS SESSION").assertIsDisplayed()

        composeRule.onNodeWithText("Stop and break down").performClick()
        composeRule.waitForIdle()
        composeRule.onNodeWithText("Break down commitment").assertIsDisplayed()
        composeRule.onNodeWithText("Next action 1").performTextInput("Open the first small step")
        composeRule.onNodeWithText("Add another action").performClick()
        composeRule.onNodeWithText("Next action 2").performTextInput("Finish the second small step")
        composeRule.onNodeWithText("Create next actions").performClick()
        composeRule.waitUntil(10_000) {
            runBlocking {
                val parent = application.database.taskDao().get(task.id)
                val children = application.database.taskDao().getAll().filter { it.parentTaskId == task.id }
                val plan = application.database.dailyPlanDao().get(today)
                val planIds = plan?.taskIds?.split(",")?.filter(String::isNotBlank).orEmpty()
                parent?.status == "BROKEN_DOWN" &&
                    parent.completedAt != null &&
                    children.size == 2 &&
                    children.all { it.status == "OPEN" && it.scheduledFor == today } &&
                    planIds == children.sortedBy { it.plannedOrder }.map { it.id }
            }
        }
        runBlocking {
            val parent = application.database.taskDao().get(task.id)
            val children = application.database.taskDao().getAll().filter { it.parentTaskId == task.id }
            val plan = application.database.dailyPlanDao().get(today)
            val planIds = plan?.taskIds?.split(",")?.filter(String::isNotBlank).orEmpty()
            check(parent?.status == "BROKEN_DOWN")
            check(parent?.completedAt != null)
            check(children.size == 2)
            check(children.all { it.status == "OPEN" && it.scheduledFor == today })
            check(planIds == children.sortedBy { it.plannedOrder }.map { it.id })
            application.database.taskDao().deleteAll()
            application.database.dailyPlanDao().deleteAll()
        }
    }

    @Test
    fun planning_duration_rail_and_swipe_actions_are_local() {
        val application = composeRule.activity.application as GoalflowApplication
        val today = java.time.LocalDate.now().toString()
        val (frogCandidate, breakdownCandidate) = runBlocking {
            application.database.taskDao().deleteAll()
            application.database.dailyPlanDao().deleteAll()
            val frog = application.repository.createTask(
                title = "Frog candidate",
                notes = "",
                schedulePrecision = com.mariusschober.goalflow.nativeapp.domain.SchedulePrecision.DAY,
                scheduledFor = today,
                scheduledTime = null,
                isFrog = false,
                duration = 15
            )
            val breakdown = application.repository.createTask(
                title = "Breakdown candidate",
                notes = "",
                schedulePrecision = com.mariusschober.goalflow.nativeapp.domain.SchedulePrecision.DAY,
                scheduledFor = today,
                scheduledTime = null,
                isFrog = false,
                duration = 45
            )
            frog to breakdown
        }
        composeRule.onAllNodesWithText("Planning").onFirst().performClick()
        composeRule.waitUntil(10_000) {
            composeRule.onAllNodesWithText("15 min").fetchSemanticsNodes().isNotEmpty()
        }
        composeRule.onNodeWithText("Frog candidate").performTouchInput { swipeRight() }
        composeRule.waitUntil(10_000) {
            runBlocking { application.database.taskDao().get(frogCandidate.id)?.isFrog == true }
        }
        composeRule.onNodeWithText("Breakdown candidate").performTouchInput { swipeLeft() }
        composeRule.waitUntil(10_000) {
            composeRule.onAllNodesWithText("Break down commitment").fetchSemanticsNodes().isNotEmpty()
        }
        composeRule.onNodeWithText("Cancel").performClick()
        runBlocking {
            application.database.taskDao().deleteAll()
            application.database.dailyPlanDao().deleteAll()
        }
    }

    @Test
    fun widget_complete_action_updates_room_in_background() {
        val application = composeRule.activity.application as GoalflowApplication
        val today = java.time.LocalDate.now().toString()
        val task = runBlocking {
            application.database.taskDao().deleteAll()
            application.database.dailyPlanDao().deleteAll()
            application.repository.createTask(
                title = "Widget completion commitment",
                notes = "",
                schedulePrecision = com.mariusschober.goalflow.nativeapp.domain.SchedulePrecision.DAY,
                scheduledFor = today,
                scheduledTime = null,
                isFrog = false,
                duration = 10
            ).also { created -> application.repository.confirmPlan(today, listOf(created.id)) }
        }
        val snapshot = runBlocking { application.repository.widgetSnapshot(today) }
        val visible = checkNotNull(snapshot.currentTask)
        application.sendBroadcast(
            Intent(application, com.mariusschober.goalflow.nativeapp.widget.GoalflowWidgetProvider::class.java)
                .setAction("com.mariusschober.tsurfing.WIDGET_ACTION")
                .putExtra("goalflow_widget_action", "complete")
                .putExtra("goalflow_widget_task_id", visible.id)
                .putExtra("goalflow_widget_expected_updated_at", visible.updatedAt)
                .putExtra("goalflow_widget_local_date", snapshot.localDate)
                .putExtra("goalflow_widget_plan_fingerprint", snapshot.planFingerprint)
        )
        composeRule.waitUntil(10_000) {
            runBlocking { application.database.taskDao().get(task.id)?.status == "COMPLETED" }
        }
        runBlocking {
            check(application.database.taskDao().get(task.id)?.status == "COMPLETED")
            application.database.taskDao().deleteAll()
            application.database.dailyPlanDao().deleteAll()
        }
    }
}
