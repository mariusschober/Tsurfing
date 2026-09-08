package com.mariusschober.goalflow.nativeapp.data

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.mariusschober.goalflow.nativeapp.domain.SchedulePrecision
import kotlinx.coroutines.test.runTest
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.io.File
import java.util.Base64
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
class NativeCausalProjectionStoreTest {
    private lateinit var database: GoalflowDatabase
    private lateinit var repository: GoalflowRepository
    private lateinit var history: JSONObject
    private val owner = "11111111-1111-4111-8111-111111111111"
    private val session = "ffffffff-ffff-4fff-8fff-ffffffffffff"
    private val time = "2026-09-08T00:00:10.000Z"
    private fun fixture(): JSONObject {
        val root = generateSequence(File(requireNotNull(System.getProperty("user.dir")))) { it.parentFile }
            .first { File(it, "tests/fixtures/s2/history-replay-v2.json").isFile }
        return JSONObject(File(root, "tests/fixtures/s2/history-replay-v2.json").readText())
    }
    private fun prefix(revision: Int): JSONObject = fixture().getJSONObject("history").apply {
        val entries = getJSONObject("entries")
        for (key in entries.keys().asSequence().toList()) if (key.toInt() > revision) entries.remove(key)
        put("downloadedRevision", revision).put("throughRevision", revision)
    }
    @Before fun setup() = runTest {
        database = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext<Context>(), GoalflowDatabase::class.java)
            .allowMainThreadQueries().build()
        repository = GoalflowRepository(database, "fixture")
        repository.bindSyncAccount(owner)
        val task = repository.createTask("Synthetic focus", "retained notes", SchedulePrecision.DAY, "2026-09-08", null, false)
        database.taskDao().insert(database.taskDao().get(task.id)!!.copy(id = "task-F"))
        history = prefix(0)
        val tracking = NativeCausalReplay.replay(owner, history).tracking
        database.rawCollectionDao().insert(RawCollectionEntity("tracking", tracking.toString(), time, null))
        repository.prepareCausalAccount(owner)
    }
    @After fun teardown() { database.close() }
    private suspend fun state() = database.causalAccountDao().get(owner)!!
    private fun counter(day: String = "2026-09-08", kind: String = "planViewCount") =
        NativeCounterIntent(UUID.randomUUID().toString(), day, "UTC", kind, time)
    private fun focus(kind: String, duration: Long? = null) =
        NativeFocusIntent(UUID.randomUUID().toString(), kind, session, "task-F", session, duration, time)
    private fun day(kind: String, day: String) = NativeCounterDayIntent(UUID.randomUUID().toString(), kind, day, "UTC", time)

    private suspend fun download(target: GoalflowDatabase = database) {
        val epoch = history.getString("epoch"); val revision = history.getLong("downloadedRevision")
        NativeCausalEnrollmentStore(target).bind(owner, JSONObject().put("schemaVersion", 2).put("accountId", owner)
            .put("rolloutReady", false).put("enrolled", true).put("epoch", epoch).put("projectionRevision", revision))
        val store = NativeCausalHistoryStore(target)
        store.begin(owner, epoch, revision)
        while (true) {
            val position = store.next(owner) ?: break
            val body = history.getJSONObject("entries").getJSONObject(position.revision.toString()).getString("body").toByteArray(Charsets.UTF_8)
            val chunk = body.copyOfRange(position.offset, minOf(body.size, position.offset + NativeCausalHistoryProtocol.CHUNK_BYTES))
            store.accept(owner, position, JSONObject().put("schemaVersion", 2).put("accountId", owner).put("epoch", epoch)
                .put("revision", position.revision).put("throughRevision", revision).put("offset", position.offset)
                .put("totalBytes", body.size).put("sha256", NativeCausalHistoryProtocol.hash(body))
                .put("chunkSha256", NativeCausalHistoryProtocol.hash(chunk)).put("data", Base64.getEncoder().encodeToString(chunk))
                .put("nextOffset", (position.offset + chunk.size).takeIf { it < body.size } ?: JSONObject.NULL))
        }
    }

    /** Synthetic server replies exercise the actual Room download/application
     * path. Fixed cutover and start entries come from the shared fixture. */
    private fun append(type: String, command: JSONObject) {
        val canonical = NativeCausalReplay.replay(owner, history)
        val revision = history.getLong("downloadedRevision") + 1
        val payload = JSONObject(canonical.tracking.toString())
        val operation = JSONObject().put("schemaVersion", 2).put("epoch", history.getString("epoch")).put("type", type).put("command", command)
        val receipt = JSONObject().put("schemaVersion", 2).put("operation", operation).put("epoch", history.getString("epoch"))
            .put("accepted", true).put("projectionRevision", revision)
        when (type) {
            "focus" -> {
                val result = CausalFocus.apply(canonical.focus, command)
                receipt.put("outcome", result.outcome).put("accepted", result.outcome.getBoolean("accepted"))
                if (result.outcome.getBoolean("accepted")) payload.put("focusSession", result.journal.getJSONObject("sessions").getJSONObject(result.journal.getString("currentSessionId")).getJSONObject("projection"))
            }
            "counter" -> {
                canonical.events.put(command.getString("actionId"), command)
                val counts = CounterLedger.project(canonical.baselines.getJSONObject(command.getString("day")),
                    JSONArray(canonical.events.keys().asSequence().map { canonical.events.getJSONObject(it) }.toList()))
                receipt.put("outcome", JSONObject().put("accepted", true).put("code", "APPLIED").put("day", command.getString("day")).put("counts", counts))
                if (payload.getString("date") == command.getString("day")) payload.put("planViewCount", counts.get("planViewCount")).put("dailyPostponeCount", counts.get("dailyPostponeCount"))
            }
            "counterDay" -> {
                val baseline = canonical.baselines.optJSONObject(command.getString("day")) ?: JSONObject().put("schemaVersion", 1)
                    .put("baselineId", UUID.randomUUID().toString()).put("accountId", owner).put("day", command.getString("day"))
                    .put("counts", JSONObject().put("planViewCount", 0).put("dailyPostponeCount", 0)).put("evidenceIds", JSONArray().put(command.getString("actionId")))
                val counts = CounterLedger.project(baseline, JSONArray(canonical.events.keys().asSequence().map { canonical.events.getJSONObject(it) }.toList()))
                receipt.put("baseline", baseline).put("counts", counts)
                if (command.getString("kind") == "select") payload.put("date", command.getString("day"))
                    .put("planViewCount", counts.get("planViewCount")).put("dailyPostponeCount", counts.get("dailyPostponeCount"))
            }
        }
        val record = JSONObject().put("user_id", owner).put("entity_type", "tracking").put("entity_id", "singleton")
            .put("version", revision + 2).put("server_version", (revision + 1) * 10).put("device_id", "causal-action-v2")
            .put("updated_at", time).put("deleted_at", JSONObject.NULL).put("payload", payload)
        receipt.put("record", record)
        val entry = JSONObject().put("schemaVersion", 2).put("accountId", owner).put("epoch", history.getString("epoch"))
            .put("revision", revision).put("receipt", receipt).toString()
        history.getJSONObject("entries").put(revision.toString(), JSONObject().put("body", entry).put("sha256", NativeCausalHistoryProtocol.hash(entry.toByteArray(Charsets.UTF_8))))
        history.put("downloadedRevision", revision).put("throughRevision", revision)
    }

    @Test fun `represented increments are counted once and independent pending increments remain visible`() = runTest {
        val first = counter(); val second = counter()
        repository.admitCausalCounter(owner, first); repository.admitCausalCounter(owner, second)
        val original = NativeCausalJournal.validate(state())
        append("counter", first.json(owner, "fixture")); download()
        assertFalse(repository.applyCausalHistory(owner).duplicate)
        var projected = NativeCausalJournal.validate(state())
        assertEquals(29, projected.getJSONObject("tracking").getInt("planViewCount"))
        assertEquals(ActionJson.canonical(original.getJSONObject("counterOutbox")), ActionJson.canonical(projected.getJSONObject("counterOutbox")))
        val before = state(); assertTrue(repository.applyCausalHistory(owner).duplicate); assertEquals(before, state())
        assertTrue(repository.admitCausalCounter(owner, first).duplicate)
        append("counter", counter(kind = "dailyPostponeCount").json(owner, "peer")); download(); repository.applyCausalHistory(owner)
        projected = NativeCausalJournal.validate(state())
        assertEquals(29, projected.getJSONObject("tracking").getInt("planViewCount"))
        assertEquals(4, projected.getJSONObject("tracking").getInt("dailyPostponeCount"))
    }

    @Test fun `later remote parents do not rewrite earlier accepted admissions`() = runTest {
        history = prefix(2); download(); repository.applyCausalHistory(owner)
        val first = focus("pause"); repository.admitCausalFocus(owner, first)
        val original = NativeCausalJournal.validate(state()).getJSONObject("focusAdmissions").getJSONObject(first.actionId).toString()
        val server = NativeCausalReplay.replay(owner, history).focus.getJSONObject("sessions").getJSONObject(session)
        val extension = focus("extend", 300).json(owner, "peer").put("epoch", server.getString("epoch")).put("expectedRevision", server.getString("revision"))
        append("focus", extension); download(); repository.applyCausalHistory(owner)
        var projected = NativeCausalJournal.validate(state())
        assertEquals("STALE_REVISION", projected.getJSONObject("causalProjectionReviews").getJSONObject(first.actionId).getString("code"))
        assertEquals("active", projected.getJSONObject("tracking").getJSONObject("focusSession").getString("phase"))
        assertEquals(original, projected.getJSONObject("focusAdmissions").getJSONObject(first.actionId).toString())
        val second = focus("pause"); repository.admitCausalFocus(owner, second)
        projected = NativeCausalJournal.validate(state())
        assertEquals(extension.getString("actionId"), projected.getJSONObject("focusAdmissions").getJSONObject(second.actionId).getJSONObject("command").getString("expectedRevision"))
        assertEquals("paused", projected.getJSONObject("tracking").getJSONObject("focusSession").getString("phase"))
        assertEquals(900, projected.getJSONObject("tracking").getJSONObject("focusSession").getInt("plannedDurationSeconds"))
        val saved = state(); assertTrue(repository.admitCausalFocus(owner, first).duplicate); assertEquals(saved, state())
        val envelope = repository.exportBackup("synthetic retained password")
        assertEquals(listOf(saved), GoalflowBackup.decryptDocument(envelope, "synthetic retained password").payload.causalAccounts)
        val damaged = JSONObject(saved.payload)
        damaged.getJSONObject("focusAdmissions").getJSONObject(first.actionId).getJSONObject("command").put("expectedRevision", extension.getString("actionId"))
        assertTrue(runCatching { NativeCausalJournal.validate(saved.copy(payload = damaged.toString())) }.isFailure)
    }

    @Test fun `failed mirror commit leaves the old projection basis and every queue intact`() = runTest {
        repository.admitCausalCounter(owner, counter()); history = prefix(2); download()
        val before = state(); val mirror = database.rawCollectionDao().get("tracking")
        val outbox = database.syncOutboxDao().getAll(); val meta = database.syncMetaDao().getAll()
        database.openHelper.writableDatabase.execSQL("CREATE TRIGGER fail_projection_mirror BEFORE INSERT ON raw_collections WHEN NEW.entityType='tracking' BEGIN SELECT RAISE(ABORT,'synthetic projection failure'); END")
        assertTrue(runCatching { repository.applyCausalHistory(owner) }.isFailure)
        assertEquals(before, state()); assertEquals(mirror, database.rawCollectionDao().get("tracking"))
        assertEquals(outbox, database.syncOutboxDao().getAll()); assertEquals(meta, database.syncMetaDao().getAll())
        database.openHelper.writableDatabase.execSQL("DROP TRIGGER fail_projection_mirror")
        repository.applyCausalHistory(owner)
        assertEquals(29, NativeCausalJournal.validate(state()).getJSONObject("tracking").getInt("planViewCount"))
        assertEquals(outbox, database.syncOutboxDao().getAll()); assertEquals(meta, database.syncMetaDao().getAll())
    }

    @Test fun `a downloaded completion cannot expose terminal focus before task members are applied`() = runTest {
        history = prefix(2); download(); repository.applyCausalHistory(owner)
        history = fixture().getJSONObject("history"); download()
        val before = state(); val mirror = database.rawCollectionDao().get("tracking"); val task = database.taskDao().get("task-F")
        val failure = runCatching { repository.applyCausalHistory(owner) }.exceptionOrNull()
        assertTrue(failure?.message?.contains("Atomic completion member") == true)
        assertEquals(before, state()); assertEquals(mirror, database.rawCollectionDao().get("tracking")); assertEquals(task, database.taskDao().get("task-F"))
    }

    @Test fun `newly established days project retained events without relabeling earlier admission outcomes`() = runTest {
        val selection = day("select", "2026-09-09"); val event = counter("2026-09-09")
        val admittedDay = repository.admitCausalCounterDay(owner, selection)
        val admittedEvent = repository.admitCausalCounter(owner, event)
        append("counterDay", day("establish", "2026-09-09").json(owner, "peer")); download(); repository.applyCausalHistory(owner)
        var tracking = NativeCausalJournal.validate(state()).getJSONObject("tracking")
        assertEquals("2026-09-09", tracking.getString("date")); assertEquals(1, tracking.getInt("planViewCount")); assertEquals(0, tracking.getInt("dailyPostponeCount"))
        assertEquals(admittedDay.outcome, repository.admitCausalCounterDay(owner, selection).outcome)
        assertEquals(admittedEvent.outcome, repository.admitCausalCounter(owner, event).outcome)
        repository.admitCausalCounter(owner, counter(kind = "dailyPostponeCount"))
        assertEquals(0, NativeCausalJournal.validate(state()).getJSONObject("tracking").getInt("dailyPostponeCount"))
        repository.admitCausalCounterDay(owner, day("select", "2026-09-08"))
        tracking = NativeCausalJournal.validate(state()).getJSONObject("tracking")
        assertEquals(27, tracking.getInt("planViewCount")); assertEquals(4, tracking.getInt("dailyPostponeCount"))
        assertEquals(ActionJson.canonical(tracking), ActionJson.canonical(JSONObject(database.rawCollectionDao().get("tracking")!!.payload)))
    }

    @Test fun `task deletion retains pending start as review and keeps unrelated tracking fields`() = runTest {
        val start = focus("start", 600).copy(expectedCurrentSessionId = null)
        repository.admitCausalFocus(owner, start)
        val task = database.taskDao().get("task-F")!!; database.taskDao().update(task.copy(deletedAt = 1000L))
        val preserved = NativeCausalJournal.validate(state()).getJSONObject("focusAdmissions").toString()
        download(); repository.applyCausalHistory(owner)
        val projected = NativeCausalJournal.validate(state())
        assertEquals("TASK_REVIEW_REQUIRED", projected.getJSONObject("causalProjectionReviews").getJSONObject(start.actionId).getString("code"))
        assertTrue(projected.getJSONObject("focus").isNull("currentSessionId"))
        assertFalse(projected.getJSONObject("tracking").has("focusSession"))
        assertTrue(projected.getJSONObject("tracking").getJSONObject("unknown").getBoolean("retained"))
        assertEquals(preserved, projected.getJSONObject("focusAdmissions").toString())
        assertTrue(projected.getJSONObject("focusOutbox").has(start.actionId))
        val beforeRequest = state()
        assertTrue(runCatching { NativeCausalRequestStore(database).prepare(owner, start.actionId) }.isFailure)
        assertEquals(beforeRequest, state())
    }

    @Test fun `receipt capture cannot retire a command before applied history and failed projection remains retryable`() = runTest {
        val action = counter(); repository.admitCausalCounter(owner, action)
        val requests = NativeCausalRequestStore(database)
        val beforeEnrollment = state()
        assertTrue(runCatching { requests.prepare(owner, action.actionId) }.isFailure)
        assertEquals(beforeEnrollment, state())
        download(); repository.applyCausalHistory(owner)
        val bytes = requests.prepare(owner, action.actionId)
        assertEquals(bytes, requests.prepare(owner, action.actionId))
        append("counter", action.json(owner, "fixture"))
        val receipt = JSONObject(history.getJSONObject("entries").getJSONObject("1").getString("body")).getJSONObject("receipt")
        assertFalse(requests.accept(owner, action.actionId, receipt).retired)
        assertTrue(NativeCausalJournal.validate(state()).getJSONObject("counterOutbox").has(action.actionId))
        download()
        val beforeApply = state(); val mirror = database.rawCollectionDao().get("tracking")
        database.openHelper.writableDatabase.execSQL("CREATE TRIGGER fail_receipt_projection BEFORE INSERT ON raw_collections WHEN NEW.entityType='tracking' BEGIN SELECT RAISE(ABORT,'synthetic receipt projection failure'); END")
        assertTrue(runCatching { repository.applyCausalHistory(owner) }.isFailure)
        assertEquals(beforeApply, state()); assertEquals(mirror, database.rawCollectionDao().get("tracking"))
        database.openHelper.writableDatabase.execSQL("DROP TRIGGER fail_receipt_projection")
        repository.applyCausalHistory(owner)
        val applied = NativeCausalJournal.validate(state())
        assertEquals(0, applied.getJSONObject("counterOutbox").length())
        assertEquals(28, applied.getJSONObject("tracking").getInt("planViewCount"))
        assertEquals(bytes, applied.getJSONObject("causalRequests").getString(action.actionId))
        assertEquals(ActionJson.canonical(receipt), ActionJson.canonical(applied.getJSONObject("causalReceipts").getJSONObject(action.actionId)))
        assertTrue(requests.accept(owner, action.actionId, receipt).duplicate)
        assertTrue(repository.admitCausalCounter(owner, action).duplicate)
        val preserved = state(); assertTrue(repository.applyCausalHistory(owner).duplicate); assertEquals(preserved, state())
        val damaged = JSONObject(preserved.payload); damaged.getJSONObject("causalRequests").remove(action.actionId)
        assertTrue(runCatching { NativeCausalJournal.validate(preserved.copy(payload = damaged.toString())) }.isFailure)
        val backup = GoalflowBackup.decryptDocument(repository.exportBackup("synthetic receipt password"), "synthetic receipt password")
        assertEquals(listOf(preserved), backup.payload.causalAccounts)
    }

    @Test fun `history recovers an exact lost action response without minting another request`() = runTest {
        val action = counter(); repository.admitCausalCounter(owner, action)
        download(); repository.applyCausalHistory(owner)
        val requests = NativeCausalRequestStore(database); val bytes = requests.prepare(owner, action.actionId)
        append("counter", JSONObject(bytes).getJSONObject("command")); download()
        assertNull(requests.receipt(owner, action.actionId))
        repository.applyCausalHistory(owner)
        assertNotNull(requests.receipt(owner, action.actionId))
        assertEquals(bytes, requests.prepare(owner, action.actionId))
        assertEquals(0, NativeCausalJournal.validate(state()).getJSONObject("counterOutbox").length())
    }

    @Test fun `rejected focus receipt stays pending and a changed receipt cannot overwrite its evidence`() = runTest {
        history = prefix(2); download(); repository.applyCausalHistory(owner)
        val pause = focus("pause"); repository.admitCausalFocus(owner, pause)
        val requests = NativeCausalRequestStore(database); val bytes = requests.prepare(owner, pause.actionId)
        val server = NativeCausalReplay.replay(owner, history).focus.getJSONObject("sessions").getJSONObject(session)
        append("focus", focus("extend", 300).json(owner, "peer").put("epoch", server.getString("epoch")).put("expectedRevision", server.getString("revision")))
        append("focus", JSONObject(bytes).getJSONObject("command"))
        val receipt = JSONObject(history.getJSONObject("entries").getJSONObject("4").getString("body")).getJSONObject("receipt")
        assertFalse(receipt.getBoolean("accepted")); assertFalse(requests.accept(owner, pause.actionId, receipt).retired)
        download(); repository.applyCausalHistory(owner)
        val saved = state(); val state = NativeCausalJournal.validate(saved)
        assertTrue(state.getJSONObject("focusOutbox").has(pause.actionId))
        assertEquals("STALE_REVISION", state.getJSONObject("causalProjectionReviews").getJSONObject(pause.actionId).getString("code"))
        val changed = JSONObject(receipt.toString()).put("projectionRevision", 5)
        assertTrue(runCatching { requests.accept(owner, pause.actionId, changed) }.isFailure)
        assertEquals(saved, this@NativeCausalProjectionStoreTest.state())
    }

    @Test fun `late request proof retires already represented intent without changing the projection generation`() = runTest {
        val action = counter(); repository.admitCausalCounter(owner, action)
        append("counter", action.json(owner, "fixture")); download(); repository.applyCausalHistory(owner)
        val generation = NativeCausalJournal.validate(state()).getLong("generation")
        val requests = NativeCausalRequestStore(database); requests.prepare(owner, action.actionId)
        assertFalse(repository.applyCausalHistory(owner).duplicate)
        val applied = NativeCausalJournal.validate(state())
        assertEquals(generation, applied.getLong("generation"))
        assertEquals(0, applied.getJSONObject("counterOutbox").length())
        assertTrue(repository.applyCausalHistory(owner).duplicate)
    }

    @Test fun `fresh local defaults bind to an existing server baseline without consuming pending increments`() = runTest {
        for (localDay in listOf("2026-09-08", "2026-09-09")) {
            val fresh = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext<Context>(), GoalflowDatabase::class.java)
                .allowMainThreadQueries().build()
            try {
                val repository = GoalflowRepository(fresh, "fixture"); repository.bindSyncAccount(owner)
                NativeCausalStore(fresh, "fixture").enable(owner, localDay)
                val action = counter(localDay); repository.admitCausalCounter(owner, action)
                download(fresh); repository.applyCausalHistory(owner)
                val state = NativeCausalJournal.validate(fresh.causalAccountDao().get(owner)!!)
                assertTrue(state.getJSONObject("cutover").isNull("tracking"))
                assertEquals(0, state.getJSONObject("localInitialization").getInt("planViewCount"))
                assertEquals(localDay, state.getJSONObject("localInitialization").getString("date"))
                assertEquals("2026-09-08", state.getJSONObject("tracking").getString("date"))
                assertEquals(if (localDay == "2026-09-08") 28 else 27, state.getJSONObject("tracking").getInt("planViewCount"))
                assertTrue(state.getJSONObject("counterOutbox").has(action.actionId))
                if (localDay == "2026-09-09") {
                    assertEquals("BASELINE_REQUIRED", state.getJSONObject("causalProjectionReviews").getJSONObject(action.actionId).getString("code"))
                    assertTrue(runCatching { NativeCausalRequestStore(fresh).prepare(owner, action.actionId) }.isFailure)
                }
            } finally { fresh.close() }
        }
    }
}
