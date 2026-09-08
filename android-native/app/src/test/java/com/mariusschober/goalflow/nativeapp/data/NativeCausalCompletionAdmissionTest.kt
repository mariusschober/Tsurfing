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

@RunWith(RobolectricTestRunner::class)
class NativeCausalCompletionAdmissionTest {
    private lateinit var database: GoalflowDatabase
    private lateinit var repository: GoalflowRepository
    private lateinit var task: String
    private val owner = UUID.randomUUID().toString()
    private val session = UUID.randomUUID().toString()
    private val capturedAt = "2026-09-08T00:00:10.000Z"
    private val details = NativeCompletionDetails("2026-09-08", "UTC", 10, "flow", "  Final notes\nretained exactly  ")
    private fun intent() = NativeFocusIntent(UUID.randomUUID().toString(), "complete", session, task, session, null, capturedAt)
    private suspend fun state() = database.causalAccountDao().get(owner)!!
    @Before fun setup() = runTest {
        database = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext<Context>(), GoalflowDatabase::class.java)
            .allowMainThreadQueries().build()
        repository = GoalflowRepository(database, "fixture")
        repository.bindSyncAccount(owner)
        task = repository.createTask("Synthetic completion", "Original notes", SchedulePrecision.DAY, details.day, null, false).id
        val focus = NativeFocusSessionRecord.start(task, 600, Instant.parse("2026-09-08T00:00:00Z"), session).toJson()
        val tracking = JSONObject().put("date", details.day).put("planViewCount", 27).put("dailyPostponeCount", 3)
            .put("unknown", "retained").put("focusSession", focus)
        database.rawCollectionDao().insert(RawCollectionEntity("tracking", tracking.toString(), capturedAt, null))
        repository.prepareCausalAccount(owner)
        repository.causalEnrollmentStore.bind(owner, JSONObject().put("schemaVersion", 2).put("accountId", owner)
            .put("rolloutReady", false).put("enrolled", true).put("epoch", UUID.randomUUID().toString()).put("projectionRevision", 0))
    }
    @After fun teardown() { database.close() }

    @Test fun `completion preserves notes and reserves all effects once while retaining attempted predecessors`() = runTest {
        val command = intent()
        val predecessor = database.syncOutboxDao().getForEntity("tasks", task).single()
        repository.markSyncAttempted(listOf(predecessor.mutationId), capturedAt)
        val originalQueue = database.syncOutboxDao().getAll()
        val result = repository.admitCausalCompletion(owner, command, details)
        assertTrue(JSONObject(result.outcome).getBoolean("accepted"))
        val row = database.taskDao().get(task)!!
        assertEquals("COMPLETED", row.status); assertEquals(details.finalDescription, row.notes)
        assertEquals(Instant.parse(capturedAt).toEpochMilli(), row.completedAt)
        val saved = state(); val journal = NativeCausalJournal.validate(saved)
        val admission = journal.getJSONObject("completionAdmissions").getJSONObject(command.actionId)
        val members = admission.getJSONArray("members")
        assertEquals(setOf("tasks", "stats", "progress", "task_events"), (0 until members.length()).map { members.getJSONObject(it).getString("entityType") }.toSet())
        assertEquals(originalQueue, database.syncOutboxDao().getAll())
        val taskMember = (0 until members.length()).map { members.getJSONObject(it) }.single { it.getString("entityType") == "tasks" }
        assertEquals(NativeLegacyReceiptEvidence.queued(originalQueue.single { it.mutationId == predecessor.mutationId }).toString(),
            admission.getJSONObject("dependencies").getJSONObject(taskMember.getString("mutationId")).getJSONObject("request").toString())
        assertTrue(taskMember.isNull("baseServerVersion"))
        assertEquals("completed", journal.getJSONObject("tracking").getJSONObject("focusSession").getString("phase"))
        assertEquals(27, journal.getJSONObject("tracking").getInt("planViewCount")); assertEquals(3, journal.getJSONObject("tracking").getInt("dailyPostponeCount"))
        assertEquals(1, JSONObject(database.rawCollectionDao().get("stats")!!.payload).getJSONObject(details.day).getInt("tasksCompleted"))
        val raw = database.rawCollectionDao().getAll(); val events = database.taskEventDao().getAll()
        assertTrue(repository.admitCausalCompletion(owner, command, details).duplicate)
        assertEquals(saved, state()); assertEquals(raw, database.rawCollectionDao().getAll()); assertEquals(events, database.taskEventDao().getAll())
        assertTrue(runCatching { repository.admitCausalCompletion(owner, command, details.copy(finalDescription = "Changed retry")) }.isFailure)
        val duplicateTap = repository.admitCausalCompletion(owner, intent(), details)
        assertFalse(JSONObject(duplicateTap.outcome).getBoolean("accepted"))
        assertEquals(events, database.taskEventDao().getAll())
        assertEquals(raw, database.rawCollectionDao().getAll())
        val backup = GoalflowBackup.decryptDocument(repository.exportBackup("synthetic completion password"), "synthetic completion password")
        assertEquals(listOf(state()), backup.payload.causalAccounts)
    }

    @Test fun `journal commit failure rolls back final notes rewards events and queue reservations`() = runTest {
        val saved = state(); val beforeTask = database.taskDao().get(task); val raw = database.rawCollectionDao().getAll()
        val queue = database.syncOutboxDao().getAll(); val meta = database.syncMetaDao().getAll(); val events = database.taskEventDao().getAll()
        database.openHelper.writableDatabase.execSQL("CREATE TRIGGER fail_completion BEFORE UPDATE ON causal_accounts BEGIN SELECT RAISE(ABORT,'synthetic completion rollback'); END")
        assertTrue(runCatching { repository.admitCausalCompletion(owner, intent(), details) }.isFailure)
        assertEquals(saved, state()); assertEquals(beforeTask, database.taskDao().get(task)); assertEquals(raw, database.rawCollectionDao().getAll())
        assertEquals(queue, database.syncOutboxDao().getAll()); assertEquals(meta, database.syncMetaDao().getAll()); assertEquals(events, database.taskEventDao().getAll())
    }

    @Test fun `empty notes remain an intentional edit and later edits wait behind the reserved member`() = runTest {
        val command = intent(); repository.admitCausalCompletion(owner, command, details.copy(finalDescription = ""))
        assertEquals("", database.taskDao().get(task)!!.notes)
        val member = NativeCompletionAdmissionEvidence.reserved(NativeCausalJournal.validate(state()), "tasks", task)!!.second
        repository.updateTask(task, "Later title", "Later notes", SchedulePrecision.DAY, details.day)
        val later = database.syncOutboxDao().getForEntity("tasks", task).maxBy { it.version }
        assertEquals(member.getString("mutationId"), later.dependsOnMutationId)
        assertTrue(later.version > member.getLong("version"))
    }

    @Test fun `invalid effects and oversized notes cannot produce a partial completion`() = runTest {
        val saved = state(); val beforeTask = database.taskDao().get(task); val queue = database.syncOutboxDao().getAll()
        database.rawCollectionDao().insert(RawCollectionEntity("stats", "{\"2026-09-08\":{\"tasksCompleted\":-1}}", capturedAt, null))
        assertTrue(runCatching { repository.admitCausalCompletion(owner, intent(), details) }.isFailure)
        assertEquals(saved, state()); assertEquals(beforeTask, database.taskDao().get(task)); assertEquals(queue, database.syncOutboxDao().getAll())
        database.rawCollectionDao().insert(RawCollectionEntity("stats", "{}", capturedAt, null))
        assertTrue(runCatching { repository.admitCausalCompletion(owner, intent(), details.copy(finalDescription = "界".repeat(1_100_000))) }.isFailure)
        assertEquals(saved, state()); assertEquals(beforeTask, database.taskDao().get(task)); assertEquals(queue, database.syncOutboxDao().getAll())
    }

    @Test fun `linked goal and habit effects share the captured action and all six reservations`() = runTest {
        val goal = repository.createGoal("Synthetic goal", "Preserved goal description")
        val habit = repository.createHabit("Synthetic habit")
        database.taskDao().insert(database.taskDao().get(task)!!.copy(goalId = goal.id, habitId = habit.id))
        val original = database.syncOutboxDao().getAll()
        val command = intent(); repository.admitCausalCompletion(owner, command, details)
        assertEquals(1, database.goalDao().get(goal.id)!!.completedTasks)
        assertEquals(1, database.habitDao().get(habit.id)!!.streak)
        assertEquals(details.day, database.habitDao().get(habit.id)!!.lastCompletedDate)
        val saved = state(); val journal = NativeCausalJournal.validate(saved)
        val admission = journal.getJSONObject("completionAdmissions").getJSONObject(command.actionId)
        assertEquals(6, admission.getJSONArray("members").length())
        assertEquals(original, database.syncOutboxDao().getAll())
        val event = database.taskEventDao().getAll().single { it.eventType == "completed" }
        assertEquals(Instant.parse(capturedAt).toEpochMilli(), event.createdAt)
        assertEquals(command.actionId, JSONObject(event.metadata).getString("actionId"))
        assertEquals(details.timeZone, JSONObject(event.metadata).getString("timeZone"))
        val damaged = JSONObject(saved.payload)
        damaged.getJSONObject("completionAdmissions").getJSONObject(command.actionId).getJSONObject("details").put("finalDescription", "Different notes")
        assertTrue(runCatching { NativeCausalJournal.validate(saved.copy(payload = damaged.toString())) }.isFailure)
        val missing = JSONObject(saved.payload).apply { remove("completionAdmissions") }
        assertTrue(runCatching { NativeCausalJournal.validate(saved.copy(payload = missing.toString())) }.isFailure)
        val missingEffect = JSONObject(saved.payload)
        val altered = missingEffect.getJSONObject("completionAdmissions").getJSONObject(command.actionId)
        val changes = altered.getJSONArray("members")
        val statsIndex = (0 until changes.length()).single { changes.getJSONObject(it).getString("entityType") == "stats" }
        changes.remove(statsIndex); altered.getJSONObject("preimages").remove("stats:singleton")
        assertTrue(runCatching { NativeCausalJournal.validate(saved.copy(payload = missingEffect.toString())) }.isFailure)
    }

    @Test fun `serial offline completions retain a causal dependency between shared statistics effects`() = runTest {
        val first = intent(); repository.admitCausalCompletion(owner, first, details)
        val another = repository.createTask("Second synthetic task", "Second notes", SchedulePrecision.DAY, details.day, null, false)
        val nextSession = UUID.randomUUID().toString()
        val start = NativeFocusIntent(UUID.randomUUID().toString(), "start", nextSession, another.id, session, 600L, capturedAt)
        repository.admitCausalFocus(owner, start)
        val second = NativeFocusIntent(UUID.randomUUID().toString(), "complete", nextSession, another.id, nextSession, null, capturedAt)
        repository.admitCausalCompletion(owner, second, details)
        val journal = NativeCausalJournal.validate(state())
        val admission = journal.getJSONObject("completionAdmissions").getJSONObject(second.actionId)
        for (type in listOf("stats", "progress")) {
            val member = NativeCompletionAdmissionEvidence.reserved(journal, type, "singleton")!!.second
            val dependency = admission.getJSONObject("dependencies").getJSONObject(member.getString("mutationId"))
            assertEquals("completion", dependency.getString("kind")); assertEquals(first.actionId, dependency.getString("actionId"))
        }
        assertEquals(2, JSONObject(database.rawCollectionDao().get("stats")!!.payload).getJSONObject(details.day).getInt("tasksCompleted"))
    }

    @Test fun `ordinary remote snapshots cannot overwrite reserved completion effects or advance the cursor`() = runTest {
        repository.admitCausalCompletion(owner, intent(), details)
        val saved = state(); val raw = database.rawCollectionDao().getAll(); val meta = database.syncMetaDao().getAll()
        val remote = NativeRemoteRecord("stats", "singleton", 2, 200, "remote-fixture", "{}", capturedAt, null)
        assertTrue(runCatching { repository.applyRemotePage(listOf(remote), 200) }.isFailure)
        assertEquals(saved, state()); assertEquals(raw, database.rawCollectionDao().getAll()); assertEquals(meta, database.syncMetaDao().getAll())
    }
}
