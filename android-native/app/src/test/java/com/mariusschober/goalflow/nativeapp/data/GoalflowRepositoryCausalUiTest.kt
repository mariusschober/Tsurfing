package com.mariusschober.goalflow.nativeapp.data

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.mariusschober.goalflow.nativeapp.domain.SchedulePrecision
import kotlinx.coroutines.test.runTest
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.time.Instant
import java.util.UUID

/** Normal-UI admission routing: causal intents when the private journal exists,
 * legacy behavior otherwise. Journals are never created implicitly here. */
@RunWith(RobolectricTestRunner::class)
class GoalflowRepositoryCausalUiTest {
    private lateinit var database: GoalflowDatabase
    private lateinit var repository: GoalflowRepository
    private val owner = UUID.randomUUID().toString()
    private lateinit var task: String
    private val time = Instant.parse("2026-09-08T00:00:10.123Z")

    @Before fun setup() = runTest {
        database = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext<Context>(), GoalflowDatabase::class.java)
            .allowMainThreadQueries().build()
        repository = GoalflowRepository(database, "fixture")
        repository.bindSyncAccount(owner)
        task = repository.createTask("Synthetic UI focus", "retained notes", SchedulePrecision.DAY, "2026-09-08", null, false).id
    }
    @After fun teardown() { database.close() }
    private suspend fun fence() {
        val tracking = JSONObject().put("date", "2026-09-08").put("planViewCount", 27).put("dailyPostponeCount", 3)
            .put("unknown", "retained").put("focusSession", JSONObject.NULL)
        database.rawCollectionDao().insert(RawCollectionEntity("tracking", tracking.toString(), "2026-09-08T00:00:00Z", null))
        repository.prepareCausalAccount(owner)
    }
    private suspend fun enroll() {
        repository.causalEnrollmentStore.bind(owner, JSONObject().put("schemaVersion", 2).put("accountId", owner)
            .put("rolloutReady", false).put("enrolled", true).put("epoch", UUID.randomUUID().toString()).put("projectionRevision", 0))
    }
    private fun newSession() = UUID.randomUUID().toString()
    private suspend fun journal() = NativeCausalJournal.validate(database.causalAccountDao().get(owner)!!)

    @Test fun `journal presence is false before preparation and true after`() = runTest {
        assertFalse(repository.hasCausalJournal())
        fence()
        assertTrue(repository.hasCausalJournal())
    }

    @Test fun `focus intents compose through the journal and reject stale targets`() = runTest {
        fence()
        val started = repository.admitFocusIntent("start", newSession(), task, null, 600L, time)
        assertFalse(started.duplicate)
        var tracking = JSONObject(started.tracking)
        val sessionId = tracking.getJSONObject("focusSession").getString("sessionId")
        assertEquals("active", tracking.getJSONObject("focusSession").getString("phase"))
        assertEquals(600, tracking.getJSONObject("focusSession").getInt("plannedDurationSeconds"))
        repository.admitFocusIntent("extend", sessionId, task, sessionId, 300L, time)
        repository.admitFocusIntent("pause", sessionId, task, sessionId, null, time)
        tracking = JSONObject(repository.admitFocusIntent("resume", sessionId, task, sessionId, null, time).tracking)
        assertEquals("active", tracking.getJSONObject("focusSession").getString("phase"))
        assertEquals(900, tracking.getJSONObject("focusSession").getInt("plannedDurationSeconds"))
        assertEquals("retained", tracking.getString("unknown"))
        assertEquals(27, tracking.getInt("planViewCount"))
        val stale = repository.admitFocusIntent("pause", sessionId, task, UUID.randomUUID().toString(), null, time)
        assertFalse(JSONObject(stale.outcome).getBoolean("accepted"))
        assertEquals(tracking.toString(), journal().getJSONObject("tracking").toString())
    }

    @Test fun `focus intents fail closed without a journal and legacy paths still work`() = runTest {
        assertTrue(runCatching {
            repository.admitFocusIntent("start", newSession(), task, null, 600L, time)
        }.isFailure)
        val legacySession = newSession()
        val started = repository.startFocus(task, legacySession, time)
        assertEquals(legacySession, started.sessionId)
        assertNull(database.causalAccountDao().get(owner))
    }

    @Test fun `completion intent requires enrollment and then awards effects once`() = runTest {
        fence()
        val started = repository.admitFocusIntent("start", newSession(), task, null, 600L, time)
        val session = JSONObject(started.tracking).getJSONObject("focusSession").getString("sessionId")
        assertTrue(runCatching {
            repository.admitCompletionIntent(task, session, time, 10, "flow", "Final notes")
        }.isFailure)
        assertEquals("OPEN", database.taskDao().get(task)!!.status)
        enroll()
        val completed = repository.admitCompletionIntent(task, session, time, 10, "flow", "Final notes")
        assertFalse(completed.duplicate)
        assertEquals("COMPLETED", database.taskDao().get(task)!!.status)
        assertEquals("Final notes", database.taskDao().get(task)!!.notes)
        assertEquals("completed", JSONObject(completed.tracking).getJSONObject("focusSession").getString("phase"))
        val repeated = repository.admitCompletionIntent(task, session, time, 10, "flow", "Final notes")
        assertFalse(JSONObject(repeated.outcome).getBoolean("accepted"))
        assertEquals("Final notes", database.taskDao().get(task)!!.notes)
    }

    @Test fun `task completion intents compose ordinary effects with idempotent retries`() = runTest {
        fence()
        val second = repository.createTask("Second synthetic", "notes", SchedulePrecision.DAY, "2026-09-08", null, false).id
        val first = repository.admitTaskCompletionIntent(task, time, 10, "flow", "First done")
        assertFalse(first.duplicate)
        val other = repository.admitTaskCompletionIntent(second, time, null, null, null)
        assertFalse(other.duplicate)
        assertEquals("COMPLETED", database.taskDao().get(task)!!.status)
        assertEquals("COMPLETED", database.taskDao().get(second)!!.status)
        assertEquals("First done", database.taskDao().get(task)!!.notes)
        val outbox = database.syncOutboxDao().getAll()
        assertTrue(outbox.map { it.mutationId }.containsAll(first.mutationIds + other.mutationIds))
        assertTrue(outbox.all { it.attemptedAt == null })
        val statsRows = outbox.filter { it.entityType == "stats" }
        assertEquals(2, statsRows.size)
        val roots = statsRows.filter { it.dependsOnMutationId == null }
        assertEquals(1, roots.size)
        val chained = statsRows.filter { it.dependsOnMutationId == roots.single().mutationId }
        assertEquals(1, chained.size)
        val retry = repository.admitTaskCompletionIntent(task, time, 10, "flow", "First done", first.actionId)
        assertTrue(retry.duplicate)
        assertEquals(retry.mutationIds.sorted(), first.mutationIds.sorted())
        assertEquals(outbox.map { it.mutationId }.toSet(), database.syncOutboxDao().getAll().map { it.mutationId }.toSet())
        assertTrue(runCatching {
            repository.admitTaskCompletionIntent(task, time, 10, "flow", "Changed retry", first.actionId)
        }.isFailure)
    }

    @Test fun `task completion fails closed without a journal or an open task`() = runTest {
        assertTrue(runCatching {
            repository.admitTaskCompletionIntent(task, time, null, null, null)
        }.isFailure)
        val legacy = repository.createTask("Legacy completion", "notes", SchedulePrecision.DAY, "2026-09-08", null, false).id
        repository.completeTask(legacy, null, null, null)
        assertEquals("COMPLETED", database.taskDao().get(legacy)!!.status)
        fence()
        assertTrue(runCatching {
            repository.admitTaskCompletionIntent("missing-task", time, null, null, null)
        }.isFailure)
        assertNull(database.causalAccountDao().get(owner)?.let { NativeCausalJournal.validate(it).optJSONObject("taskCompletionAdmissions") })
    }
}
