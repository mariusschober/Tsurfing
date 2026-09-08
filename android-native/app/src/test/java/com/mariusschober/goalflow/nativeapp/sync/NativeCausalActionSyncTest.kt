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

    private suspend fun complete(notes: String): NativeFocusIntent {
        val focusId = state().getJSONObject("focus").getString("currentSessionId")
        val command = NativeFocusIntent(UUID.randomUUID().toString(), "complete", focusId, "task-F", focusId, null, time)
        repository.admitCausalCompletion(owner, command, NativeCompletionDetails("2026-09-08", "UTC", 10, "flow", notes))
        return command
    }

    private suspend fun acknowledge(row: SyncOutboxEntity, version: Long) {
        val record = JSONObject().put("user_id", owner).put("entity_type", row.entityType).put("entity_id", row.entityId)
            .put("device_id", row.deviceId).put("version", row.version).put("server_version", version).put("payload", JSONObject(row.payload))
            .put("updated_at", row.updatedAt).put("deleted_at", JSONObject.NULL)
        val receipt = JSONObject().put("mutationId", row.mutationId).put("accepted", true).put("serverVersion", version).put("record", record)
        repository.commitPushResults(listOf(row), listOf(NativePushResult(row.mutationId, true, version,
            recordEntityType = row.entityType, recordEntityId = row.entityId, recordDeviceId = row.deviceId,
            recordVersion = row.version, recordServerVersion = version, recordPayload = row.payload,
            recordUpdatedAt = row.updatedAt, receiptJson = receipt.toString())))
    }

    @Test fun `completion sends staged exact bytes and retires after history without replaying local effects`() = runTest {
        val backend = Backend(history(2)); val engine = engine(backend); engine.synchronizeCausalActions()
        val command = complete("界".repeat(100_000))
        val rewards = database.rawCollectionDao().get("stats")
        val result = engine.synchronizeCausalActions()
        assertEquals(1, result.sent); assertFalse(result.moreReady); assertTrue(backend.chunks.isNotEmpty())
        assertEquals(backend.attempts.single(), state().getJSONObject("causalRequests").getString(command.actionId))
        assertFalse(state().getJSONObject("focusOutbox").has(command.actionId))
        assertEquals(rewards, database.rawCollectionDao().get("stats"))
        assertEquals("completed", state().getJSONObject("tracking").getJSONObject("focusSession").getString("phase"))
        assertEquals(0, engine.synchronizeCausalActions().sent)
    }

    @Test fun `lost completion response recovers from history and preserves a later task edit`() = runTest {
        val backend = Backend(history(2)); val engine = engine(backend); engine.synchronizeCausalActions()
        val command = complete("Final notes")
        repository.updateTask("task-F", "Later title", "Later notes", SchedulePrecision.DAY, "2026-09-08")
        val before = database.taskDao().get("task-F")
        val pending = database.syncOutboxDao().getForEntity("tasks", "task-F").single()
        assertNotNull(pending.dependsOnMutationId)
        backend.loseAfterCommit = true
        assertTrue(runCatching { engine.synchronizeCausalActions() }.isFailure)
        val bytes = state().getJSONObject("causalRequests").getString(command.actionId)
        assertEquals(0, engine.synchronizeCausalActions().sent)
        assertEquals(listOf(bytes), backend.attempts); assertEquals(before, database.taskDao().get("task-F"))
        val released = database.syncOutboxDao().get(pending.mutationId)!!
        assertNull(released.dependsOnMutationId); assertEquals(pending.payload, released.payload); assertNotNull(released.baseServerVersion)
        assertFalse(state().getJSONObject("focusOutbox").has(command.actionId))
        acknowledge(released, 600)
        assertEquals(0, engine.synchronizeCausalActions().sent)
        assertEquals(before, database.taskDao().get("task-F"))
    }

    @Test fun `bad completion chunk acknowledgment retains the complete request for retry`() = runTest {
        val backend = Backend(history(2)); val engine = engine(backend); engine.synchronizeCausalActions()
        val command = complete("界".repeat(100_000)); backend.badChunkAck = true
        assertTrue(runCatching { engine.synchronizeCausalActions() }.isFailure)
        assertTrue(backend.attempts.isEmpty()); assertTrue(state().getJSONObject("focusOutbox").has(command.actionId))
        val original = state().getJSONObject("causalRequests").getString(command.actionId)
        backend.badChunkAck = false
        assertEquals(1, engine.synchronizeCausalActions().sent)
        assertEquals(original, backend.attempts.single())
    }

    @Test fun `completion waits for both focus and ordinary predecessor receipts before freezing its base`() = runTest {
        val backend = Backend(history(2)); val engine = engine(backend); engine.synchronizeCausalActions()
        repository.updateTask("task-F", "Edited title", "Edited notes", SchedulePrecision.DAY, "2026-09-08")
        val predecessor = database.syncOutboxDao().getForEntity("tasks", "task-F").single()
        val focusId = state().getJSONObject("focus").getString("currentSessionId")
        repository.admitCausalFocus(owner, NativeFocusIntent(UUID.randomUUID().toString(), "pause", focusId, "task-F", focusId, null, time))
        val command = complete("Final notes")
        assertEquals(1, engine.synchronizeCausalActions().sent)
        assertFalse(state().getJSONObject("causalRequests").has(command.actionId))
        val record = JSONObject().put("user_id", owner).put("entity_type", predecessor.entityType).put("entity_id", predecessor.entityId)
            .put("device_id", predecessor.deviceId).put("version", predecessor.version).put("server_version", 100)
            .put("payload", JSONObject(predecessor.payload)).put("updated_at", predecessor.updatedAt).put("deleted_at", JSONObject.NULL)
        val receipt = JSONObject().put("mutationId", predecessor.mutationId).put("accepted", true).put("serverVersion", 100).put("record", record)
        repository.commitPushResults(listOf(predecessor), listOf(NativePushResult(predecessor.mutationId, true, 100,
            recordEntityType = predecessor.entityType, recordEntityId = predecessor.entityId, recordDeviceId = predecessor.deviceId,
            recordVersion = predecessor.version, recordServerVersion = 100, recordPayload = predecessor.payload,
            recordUpdatedAt = predecessor.updatedAt, receiptJson = receipt.toString())))
        assertEquals(1, engine.synchronizeCausalActions().sent)
        val bytes = state().getJSONObject("causalRequests").getString(command.actionId)
        val members = JSONObject(bytes).getJSONArray("changes")
        val member = (0 until members.length()).map { members.getJSONObject(it) }.single { it.getString("entityType") == "tasks" }
        assertEquals(100, member.getInt("baseServerVersion"))
        assertEquals(bytes, repository.causalRequestStore.prepare(owner, command.actionId))
        val damaged = JSONObject(state().toString())
        damaged.getJSONObject("completionAdmissions").getJSONObject(command.actionId).getJSONObject("dependencies")
            .getJSONObject(member.getString("mutationId")).getJSONObject("request").put("ignoredTransportField", true)
        assertTrue(runCatching { NativeCausalJournal.validate(CausalAccountEntity(owner, damaged.toString())) }.isFailure)
    }

    @Test fun `failed completion history application rolls back dependency release and recovers without a resend`() = runTest {
        val backend = Backend(history(2)); val engine = engine(backend); engine.synchronizeCausalActions()
        val command = complete("Final notes")
        repository.updateTask("task-F", "Later title", "Later notes", SchedulePrecision.DAY, "2026-09-08")
        val pending = database.syncOutboxDao().getForEntity("tasks", "task-F").single()
        val meta = database.syncMetaDao().getAll()
        backend.afterAction = {
            database.openHelper.writableDatabase.execSQL("CREATE TRIGGER fail_completion_tracking BEFORE INSERT ON raw_collections WHEN NEW.entityType='tracking' BEGIN SELECT RAISE(ABORT,'synthetic completion apply failure'); END")
            backend.afterAction = null
        }
        assertTrue(runCatching { engine.synchronizeCausalActions() }.isFailure)
        assertEquals(pending, database.syncOutboxDao().get(pending.mutationId)); assertEquals(meta, database.syncMetaDao().getAll())
        assertTrue(state().getJSONObject("focusOutbox").has(command.actionId))
        assertEquals(2L, NativeCausalRequestJournal.appliedRevision(state()))
        database.openHelper.writableDatabase.execSQL("DROP TRIGGER fail_completion_tracking")
        assertEquals(0, engine.synchronizeCausalActions().sent)
        assertEquals(1, backend.attempts.size); assertNull(database.syncOutboxDao().get(pending.mutationId)!!.dependsOnMutationId)
    }

    /** Synthetic server state, not PostgreSQL acceptance. The client under test
     * is the production engine, transport, durable stores and Room transaction. */
    private inner class Backend(val saved: JSONObject = history()) : NativeSyncTransport {
        val attempts = mutableListOf<String>()
        val chunks = mutableMapOf<Int, ByteArray>()
        var badChunkAck = false
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
            if (path == "/api/v1/sync/conflicts/stage") {
                val chunk = JSONObject(requireNotNull(body)); val index = chunk.getInt("chunkIndex")
                chunks[index] = Base64.getDecoder().decode(chunk.getString("data"))
                return response(JSONObject().put("staged", true).put("manifest", chunk.getJSONObject("manifest"))
                    .put("chunkIndex", index).put("chunkSha256", if (badChunkAck) "different" else chunk.getString("chunkSha256")))
            }
            require(path in setOf("/api/v1/sync/actions", "/api/v1/sync/complete-focus", "/api/v1/sync/complete-focus-staged")); assertEquals("POST", method)
            val requestBody = if (path == "/api/v1/sync/complete-focus-staged") {
                val manifest = JSONObject(requireNotNull(body))
                val all = (0 until manifest.getInt("chunkCount")).flatMap { chunks.getValue(it).asIterable() }.toByteArray()
                assertEquals(manifest.getString("sha256"), NativeCausalHistoryProtocol.hash(all)); String(all, Charsets.UTF_8)
            } else requireNotNull(body)
            attempts.add(requestBody)
            if (failBeforeCommit) { failBeforeCommit = false; throw IOException("Synthetic pre-commit failure") }
            val operation = NativeCausalRequestJournal.operation(owner, JSONObject(requestBody)); val command = operation.getJSONObject("command")
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
                "focus", "completion" -> {
                    val result = CausalFocus.apply(canonical.focus, command)
                    receipt.put("accepted", result.outcome.getBoolean("accepted")).put("outcome", result.outcome)
                    if (result.outcome.getBoolean("accepted")) payload.put("focusSession",
                        result.journal.getJSONObject("sessions").getJSONObject(result.journal.getString("currentSessionId")).getJSONObject("projection"))
                }
            }
            if (operation.opt("type") == "completion") {
                val changes = operation.getJSONArray("changes"); val results = JSONArray()
                if (receipt.getBoolean("accepted")) for (index in 0 until changes.length()) {
                    val member = changes.getJSONObject(index); val serverVersion = (revision + 2) * 100 + index + 1
                    results.put(JSONObject().put("mutationId", member.getString("mutationId")).put("accepted", true).put("serverVersion", serverVersion)
                        .put("record", JSONObject().put("user_id", owner).put("entity_type", member.getString("entityType"))
                            .put("entity_id", member.getString("entityId")).put("device_id", member.getString("deviceId"))
                            .put("version", member.getLong("version")).put("server_version", serverVersion).put("payload", member.getJSONObject("payload"))
                            .put("updated_at", member.getString("updatedAt")).put("deleted_at", JSONObject.NULL)))
                }
                receipt.put("changes", results)
            }
            receipt.put("record", JSONObject().put("user_id", owner).put("entity_type", "tracking").put("entity_id", "singleton")
                .put("device_id", "causal-action-v2").put("version", revision + 3).put("server_version", (revision + 2) * 100 + 10)
                .put("updated_at", time).put("deleted_at", JSONObject.NULL).put("payload", payload))
            NativeCausalRequestJournal.receipt(owner, operation, receipt)
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
