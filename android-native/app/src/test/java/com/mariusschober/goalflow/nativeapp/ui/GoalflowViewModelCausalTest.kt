package com.mariusschober.goalflow.nativeapp.ui

import android.content.Context
import androidx.lifecycle.viewModelScope
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.mariusschober.goalflow.nativeapp.data.GoalflowDatabase
import com.mariusschober.goalflow.nativeapp.data.GoalflowRepository
import com.mariusschober.goalflow.nativeapp.data.NativeCausalJournal
import com.mariusschober.goalflow.nativeapp.data.NativeFocusSessionRecord
import com.mariusschober.goalflow.nativeapp.data.RawCollectionEntity
import com.mariusschober.goalflow.nativeapp.domain.GoalflowTask
import com.mariusschober.goalflow.nativeapp.domain.SchedulePrecision
import com.mariusschober.goalflow.nativeapp.sync.NativeSession
import com.mariusschober.goalflow.nativeapp.sync.NativeSessionProvider
import com.mariusschober.goalflow.nativeapp.sync.NativeSyncEngine
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.util.UUID
import java.util.concurrent.Executors

/** Normal-UI routing: causal admission when the private journal exists,
 * legacy paths otherwise. Failures surface as UI errors, never silent.
 *
 * Main is a real single thread, never a virtual-time test dispatcher: the
 * ViewModel owns an infinite ticker loop that would otherwise spin
 * runTest's advanceUntilIdle forever through TestMainDispatcher. */
@RunWith(RobolectricTestRunner::class)
class GoalflowViewModelCausalTest {
    private val main = Executors.newSingleThreadExecutor().asCoroutineDispatcher()
    private lateinit var database: GoalflowDatabase
    private lateinit var repository: GoalflowRepository
    private lateinit var viewModel: GoalflowViewModel
    private val owner = UUID.randomUUID().toString()
    private lateinit var taskId: String
    private lateinit var createdTask: GoalflowTask

    @Before fun setup() {
        Dispatchers.setMain(main)
        database = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext<Context>(), GoalflowDatabase::class.java)
            .allowMainThreadQueries().build()
        repository = GoalflowRepository(database, "fixture")
        runBlocking {
            repository.bindSyncAccount(owner)
            createdTask = repository.createTask("Synthetic UI routing", "notes", SchedulePrecision.DAY, "2026-09-08", null, false)
            taskId = createdTask.id
        }
        val session = NativeSession("synthetic-access", "synthetic-refresh", Long.MAX_VALUE, owner)
        viewModel = GoalflowViewModel(repository,
            NativeSyncEngine(repository, NativeSessionProvider { session }, cloudAvailable = { false }))
    }
    @After fun teardown() {
        viewModel.viewModelScope.cancel()
        (main.executor as java.util.concurrent.ExecutorService).shutdownNow()
        database.close()
        Dispatchers.resetMain()
    }
    /** Real threads only; poll bounded and let assertions report on expiry. */
    private fun <T> awaitState(flow: StateFlow<T>, predicate: (T) -> Boolean, timeoutMs: Long = 15_000): T {
        val end = System.currentTimeMillis() + timeoutMs
        var value = flow.value
        while (!predicate(value)) {
            check(System.currentTimeMillis() < end) { "Timed out waiting for UI state; last value: $value" }
            Thread.sleep(25)
        }
        return value
    }
    private fun fence() = runBlocking {
        val tracking = JSONObject().put("date", "2026-09-08").put("planViewCount", 27).put("dailyPostponeCount", 3)
            .put("unknown", "retained").put("focusSession", JSONObject.NULL)
        database.rawCollectionDao().insert(RawCollectionEntity("tracking", tracking.toString(), "2026-09-08T00:00:00.000Z", null))
        repository.prepareCausalAccount(owner)
    }
    private fun journal() = runBlocking { NativeCausalJournal.validate(database.causalAccountDao().get(owner)!!) }
    private fun awaitDone(done: () -> Boolean, action: () -> Unit) {
        viewModel.clearError()
        action()
        val end = System.currentTimeMillis() + 15_000
        while (!done() && viewModel.error.value == null && System.currentTimeMillis() < end) {
            Thread.sleep(25)
        }
    }

    @Test fun `start uses the legacy path without a journal`() {
        var started: NativeFocusSessionRecord? = null
        awaitDone({ started != null }) { viewModel.startFocus(createdTask) { started = it } }
        assertNotNull(started)
        assertNull(runBlocking { database.causalAccountDao().get(owner) })
        assertNull(viewModel.error.value)
    }

    @Test fun `start admits a causal command when the journal exists`() {
        fence()
        var started: NativeFocusSessionRecord? = null
        awaitDone({ started != null }) { viewModel.startFocus(createdTask) { started = it } }
        assertNotNull(started)
        assertEquals("ACTIVE", started!!.phase.name)
        val state = journal()
        assertEquals(1, state.getJSONObject("focusOutbox").length())
        assertEquals(started!!.sessionId, state.getJSONObject("tracking").getJSONObject("focusSession").getString("sessionId"))
        assertNull(viewModel.error.value)
    }

    @Test fun `pause and extend compose through the journal from rendered state`() {
        fence()
        awaitDone({ viewModel.focusSession.value?.phase?.name == "ACTIVE" }) { viewModel.startFocus(createdTask) {} }
        val active = viewModel.focusSession.value
        assertNotNull(active)
        awaitDone({ (viewModel.focusSession.value?.plannedDurationSeconds ?: 0) == active!!.plannedDurationSeconds + 300 }) {
            viewModel.extendFocus(300) {} }
        awaitDone({ viewModel.focusSession.value?.phase?.name == "PAUSED" }) { viewModel.pauseFocus() {} }
        val paused = viewModel.focusSession.value
        assertNotNull(paused)
        assertEquals(active!!.plannedDurationSeconds + 300, paused!!.plannedDurationSeconds)
        assertNull(viewModel.error.value)
    }

    @Test fun `completion without a ready session surfaces an error and keeps the task open`() {
        fence()
        var done = false
        awaitDone({ done || viewModel.error.value != null }) { viewModel.completeFocus(createdTask) { done = true } }
        assertFalse(done)
        assertNotNull(viewModel.error.value)
        assertEquals("OPEN", runBlocking { database.taskDao().get(taskId)!! }.status)
    }

    @Test fun `task completion admits causally when prepared and legacy otherwise`() {
        fence()
        var done = false
        awaitDone({ done || viewModel.error.value != null }) { viewModel.completeTask(createdTask) { done = true } }
        assertTrue(done)
        assertNull(viewModel.error.value)
        assertEquals("COMPLETED", runBlocking { database.taskDao().get(taskId)!! }.status)
        val journal = journal()
        assertEquals(1, journal.optJSONObject("taskCompletionAdmissions")?.length() ?: 0)
    }
}
