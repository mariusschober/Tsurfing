package com.mariusschober.goalflow.nativeapp.sync

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.mariusschober.goalflow.nativeapp.data.*
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
import java.io.IOException
import java.util.Base64
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
class NativeCausalActionSyncTest {
    private lateinit var database: GoalflowDatabase
    private lateinit var repository: GoalflowRepository
    private val owner = "11111111-1111-4111-8111-111111111111"
    private val session = NativeSession("synthetic-access", "synthetic-refresh", Long.MAX_VALUE, owner)
    private var currentSession: NativeSession? = session
    private val time = "2026-09-08T00:00:10.000Z"
    private fun history(through: Int = 0): JSONObject {
        val root = generateSequence(File(requireNotNull(System.getProperty("user.dir")))) { it.parentFile }
            .first { File(it, "tests/fixtures/s2/history-replay-v2.json").isFile }
        return JSONObject(File(root, "tests/fixtures/s2/history-replay-v2.json").readText()).getJSONObject("history").apply {
            val entries = getJSONObject("entries")
            for (key in entries.keys().asSequence().toList()) if (key.toInt() > through) entries.remove(key)
            put("throughRevision", through).put("downloadedRevision", through)
        }
    }
    @Before fun setup() = runTest {
        database = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext<Context>(), GoalflowDatabase::class.java)
            .allowMainThreadQueries().build()
        repository = GoalflowRepository(database, "fixture"); repository.bindSyncAccount(owner)
        database.rawCollectionDao().insert(RawCollectionEntity("tracking", NativeCausalReplay.replay(owner, history()).tracking.toString(), time, null))
        repository.prepareCausalAccount(owner)
        val task = repository.createTask("Synthetic focus", "retained notes", SchedulePrecision.DAY, "2026-09-08", null, false)
        database.taskDao().insert(database.taskDao().get(task.id)!!.copy(id = "task-F"))
    }
    @After fun teardown() { database.close() }
    private suspend fun state() = NativeCausalJournal.validate(database.causalAccountDao().get(owner)!!)
    private fun counter(kind: String = "planViewCount", day: String = "2026-09-08") = NativeCounterIntent(UUID.randomUUID().toString(), day, "UTC", kind, time)
    private fun engine(backend: Backend) = NativeSyncEngine(repository, NativeSessionProvider { currentSession }, backend,
        { true }, NativeSyncRetryPolicy(maxAttempts = 1))

    /** Synthetic server state, not PostgreSQL acceptance. The client under test
     * is the production engine, transport, durable stores and Room transaction. */
    private inner class Backend(val saved: JSONObject = history()) : NativeSyncTransport {
        val attempts = mutableListOf<String>()
        var failBeforeCommit = false
        var loseAfterCommit = false
        var afterAction: (() -> Unit)? = null
        override fun request(path: String, token: String, method: String, body: String?): NativeHttpResponse {
            assertEquals(session.accessToken, token)
            fun response(value: JSONObject) = NativeHttpResponse(200, value.toString())
            val epoch = saved.getString("epoch"); val revision = saved.getLong("downloadedRevision")
            if (path == "/api/v1/sync/status") return response(JSONObject().put("userId", owner))
            if (path == "/api/v1/sync/causal-capability") return response(JSONObject().put("schemaVersion", 2).put("accountId", owner)
                .put("rolloutReady", false).put("enrolled", true).put("epoch", epoch).put("projectionRevision", revision))
            if (path.startsWith("/api/v1/sync/causal-history?")) {
                val query = path.substringAfter('?').split('&').associate { it.substringBefore('=') to it.substringAfter('=') }
                val entryRevision = query.getValue("revision").toLong(); val offset = query.getValue("offset").toInt()
                val bytes = saved.getJSONObject("entries").getJSONObject(entryRevision.toString()).getString("body").toByteArray(Charsets.UTF_8)
                val chunk = bytes.copyOfRange(offset, minOf(bytes.size, offset + NativeCausalHistoryProtocol.CHUNK_BYTES))
                return response(JSONObject().put("schemaVersion", 2).put("accountId", owner).put("epoch", epoch)
                    .put("revision", entryRevision).put("throughRevision", query.getValue("throughRevision").toLong()).put("offset", offset)
                    .put("totalBytes", bytes.size).put("sha256", NativeCausalHistoryProtocol.hash(bytes))
                    .put("chunkSha256", NativeCausalHistoryProtocol.hash(chunk)).put("data", Base64.getEncoder().encodeToString(chunk))
                    .put("nextOffset", (offset + chunk.size).takeIf { it < bytes.size } ?: JSONObject.NULL))
            }
            assertEquals("/api/v1/sync/actions", path); assertEquals("POST", method)
            attempts.add(requireNotNull(body))
            if (failBeforeCommit) { failBeforeCommit = false; throw IOException("Synthetic pre-commit failure") }
            val operation = NativeCausalProtocol.operation(owner, JSONObject(body)); val command = operation.getJSONObject("command")
            val canonical = NativeCausalReplay.replay(owner, saved)
            canonical.receipts.optJSONObject(command.getString("actionId"))?.let {
                assertEquals(ActionJson.canonical(it.getJSONObject("operation")), ActionJson.canonical(operation)); return response(it)
            }
            val payload = JSONObject(canonical.tracking.toString())
            val receipt = JSONObject().put("schemaVersion", 2).put("epoch", epoch).put("operation", operation)
                .put("accepted", true).put("projectionRevision", revision + 1)
            when (operation.getString("type")) {
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
                "focus" -> {
                    val result = CausalFocus.apply(canonical.focus, command)
                    receipt.put("accepted", result.outcome.getBoolean("accepted")).put("outcome", result.outcome)
                    if (result.outcome.getBoolean("accepted")) payload.put("focusSession",
                        result.journal.getJSONObject("sessions").getJSONObject(result.journal.getString("currentSessionId")).getJSONObject("projection"))
                }
            }
            receipt.put("record", JSONObject().put("user_id", owner).put("entity_type", "tracking").put("entity_id", "singleton")
                .put("device_id", "causal-action-v2").put("version", revision + 3).put("server_version", (revision + 2) * 10)
                .put("updated_at", time).put("deleted_at", JSONObject.NULL).put("payload", payload))
            NativeCausalProtocol.receipt(owner, operation, receipt)
            val entry = JSONObject().put("schemaVersion", 2).put("accountId", owner).put("epoch", epoch).put("revision", revision + 1).put("receipt", receipt).toString()
            saved.getJSONObject("entries").put((revision + 1).toString(), JSONObject().put("body", entry).put("sha256", NativeCausalHistoryProtocol.hash(entry.toByteArray(Charsets.UTF_8))))
            saved.put("throughRevision", revision + 1).put("downloadedRevision", revision + 1)
            afterAction?.invoke()
            if (loseAfterCommit) { loseAfterCommit = false; throw IOException("Synthetic response lost after commit") }
            return response(receipt)
        }
    }

    @Test fun `bounded passes conserve both counters and preserve original admission order`() = runTest {
        val actions = listOf(counter(), counter("dailyPostponeCount"), counter())
        for (action in actions) repository.admitCausalCounter(owner, action)
        val ordinary = database.syncOutboxDao().getAll(); val meta = database.syncMetaDao().getAll()
        val backend = Backend(); val engine = engine(backend)
        val first = engine.synchronizeCausalActions(2)
        assertEquals(2, first.sent); assertTrue(first.moreReady)
        val second = engine.synchronizeCausalActions(2)
        assertEquals(1, second.sent); assertFalse(second.moreReady)
        assertEquals(actions.map { it.actionId }, backend.attempts.map { JSONObject(it).getJSONObject("command").getString("actionId") })
        val tracking = state().getJSONObject("tracking")
        assertEquals(29, tracking.getInt("planViewCount")); assertEquals(4, tracking.getInt("dailyPostponeCount"))
        assertEquals(0, state().getJSONObject("counterOutbox").length())
        assertEquals(0, engine.synchronizeCausalActions().sent)
        assertEquals(ordinary, database.syncOutboxDao().getAll()); assertEquals(meta, database.syncMetaDao().getAll())
    }

    @Test fun `pre-commit retry reuses exact bytes and a lost response recovers from history`() = runTest {
        val backend = Backend(); val engine = engine(backend)
        val first = counter(); repository.admitCausalCounter(owner, first); backend.failBeforeCommit = true
        assertTrue(runCatching { engine.synchronizeCausalActions() }.isFailure)
        val original = state().getJSONObject("causalRequests").getString(first.actionId)
        assertEquals(1, engine.synchronizeCausalActions().sent)
        assertEquals(listOf(original, original), backend.attempts)
        val second = counter(); repository.admitCausalCounter(owner, second); backend.loseAfterCommit = true
        assertTrue(runCatching { engine.synchronizeCausalActions() }.isFailure)
        assertTrue(state().getJSONObject("counterOutbox").has(second.actionId))
        val attemptCount = backend.attempts.size
        assertEquals(0, engine.synchronizeCausalActions().sent)
        assertEquals(attemptCount, backend.attempts.size)
        assertEquals(29, state().getJSONObject("tracking").getInt("planViewCount"))
        assertEquals(0, state().getJSONObject("counterOutbox").length())
    }

    @Test fun `day establishment precedes its retained counter without changing its original outcome`() = runTest {
        val day = NativeCounterDayIntent(UUID.randomUUID().toString(), "select", "2026-09-09", "UTC", time)
        repository.admitCausalCounterDay(owner, day)
        val action = counter(day = "2026-09-09"); val before = repository.admitCausalCounter(owner, action)
        val backend = Backend(); val result = engine(backend).synchronizeCausalActions()
        assertEquals(2, result.sent)
        assertEquals(listOf("counterDay", "counter"), backend.attempts.map { JSONObject(it).getString("type") })
        assertEquals("2026-09-09", state().getJSONObject("tracking").getString("date"))
        assertEquals(1, state().getJSONObject("tracking").getInt("planViewCount"))
        assertEquals(before.outcome, repository.admitCausalCounter(owner, action).outcome)
    }

    @Test fun `serial focus extensions retain their actual parents through transport and projection`() = runTest {
        val backend = Backend(history(2)); val engine = engine(backend); engine.synchronizeCausalActions()
        val ids = mutableListOf<String>()
        for (duration in listOf(300L, 120L)) {
            val action = NativeFocusIntent(UUID.randomUUID().toString(), "extend", "ffffffff-ffff-4fff-8fff-ffffffffffff", "task-F",
                "ffffffff-ffff-4fff-8fff-ffffffffffff", duration, time)
            ids.add(action.actionId); repository.admitCausalFocus(owner, action)
        }
        assertEquals(2, engine.synchronizeCausalActions().sent)
        assertEquals(ids[0], JSONObject(backend.attempts[1]).getJSONObject("command").getString("expectedRevision"))
        assertEquals(1020, state().getJSONObject("tracking").getJSONObject("focusSession").getInt("plannedDurationSeconds"))
        assertEquals(0, state().getJSONObject("focusOutbox").length())
    }

    @Test fun `session change rejects an in-flight reply and the next session recovers its exact history`() = runTest {
        val action = counter(); repository.admitCausalCounter(owner, action)
        val backend = Backend(); backend.afterAction = { currentSession = null }
        assertTrue(runCatching { engine(backend).synchronizeCausalActions() }.isFailure)
        assertTrue(state().getJSONObject("counterOutbox").has(action.actionId))
        assertFalse(state().optJSONObject("causalReceipts")?.has(action.actionId) == true)
        currentSession = session; backend.afterAction = null
        assertEquals(0, engine(backend).synchronizeCausalActions().sent)
        assertEquals(1, backend.attempts.size)
        assertEquals(0, state().getJSONObject("counterOutbox").length())
    }

    @Test fun `a rejected focus action stays auditable without blocking independent counters or resending forever`() = runTest {
        val backend = Backend(history(2)); val engine = engine(backend); engine.synchronizeCausalActions()
        val focusId = "ffffffff-ffff-4fff-8fff-ffffffffffff"
        val pause = NativeFocusIntent(UUID.randomUUID().toString(), "pause", focusId, "task-F", focusId, null, time)
        repository.admitCausalFocus(owner, pause)
        val canonical = NativeCausalReplay.replay(owner, backend.saved).focus.getJSONObject("sessions").getJSONObject(focusId)
        val peer = NativeFocusIntent(UUID.randomUUID().toString(), "extend", focusId, "task-F", focusId, 300, time)
            .json(owner, "peer").put("epoch", canonical.getString("epoch")).put("expectedRevision", canonical.getString("revision"))
        backend.request("/api/v1/sync/actions", session.accessToken, "POST", JSONObject().put("schemaVersion", 2)
            .put("epoch", backend.saved.getString("epoch")).put("type", "focus").put("command", peer).toString())
        repository.admitCausalCounter(owner, counter())
        val result = engine.synchronizeCausalActions()
        assertEquals(2, result.sent); assertFalse(result.moreReady)
        assertTrue(state().getJSONObject("focusOutbox").has(pause.actionId))
        assertFalse(state().getJSONObject("causalReceipts").getJSONObject(pause.actionId).getBoolean("accepted"))
        assertEquals(29, state().getJSONObject("tracking").getInt("planViewCount"))
        val count = backend.attempts.size
        assertEquals(0, engine.synchronizeCausalActions().sent); assertEquals(count, backend.attempts.size)
    }
}
