package com.mariusschober.goalflow.nativeapp.sync

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.mariusschober.goalflow.nativeapp.data.*
import kotlinx.coroutines.test.runTest
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.io.IOException
import java.util.Base64
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
class NativeCausalEvidenceSyncTest {
    private val owner = "11111111-1111-4111-8111-111111111111"
    private val session = NativeSession("synthetic-access", "synthetic-refresh", Long.MAX_VALUE, owner)
    private fun database() = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext<Context>(), GoalflowDatabase::class.java)
        .allowMainThreadQueries().build()

    private inner class Backend(var loseResponse: Boolean = false, val legacy: JSONObject? = null) : NativeSyncTransport {
        var receipt: JSONObject? = null
        val attempts = mutableListOf<String>()
        val parts = sortedMapOf<Int, ByteArray>()
        var stageCount = 0
        override fun request(path: String, token: String, method: String, body: String?): NativeHttpResponse {
            assertEquals(session.accessToken, token)
            fun response(value: JSONObject) = NativeHttpResponse(200, value.toString())
            if (path == "/api/v1/sync/status") return response(JSONObject().put("userId", owner))
            if (path == "/api/v1/sync/causal-capability") {
                val epoch = receipt?.let { if (it.has("cutoverReceipt")) it.getJSONObject("cutoverReceipt").getString("epoch") else it.getString("epoch") }
                return response(JSONObject().put("schemaVersion", 2).put("accountId", owner).put("rolloutReady", false)
                    .put("enrolled", epoch != null).put("epoch", epoch ?: JSONObject.NULL).put("projectionRevision", if (epoch == null) JSONObject.NULL else 0))
            }
            if (path == "/api/v1/sync/conflicts/stage") {
                val chunk = JSONObject(body!!); stageCount++
                parts[chunk.getInt("chunkIndex")] = Base64.getDecoder().decode(chunk.getString("data"))
                return response(JSONObject(chunk.toString()).apply { remove("data"); put("staged", true) })
            }
            if (path.startsWith("/api/v1/sync/causal-initialize") || path.startsWith("/api/v1/sync/causal-cutover")) {
                assertEquals("POST", method)
                val saved = if (path.endsWith("-staged")) parts.values.flatMap { it.asIterable() }.toByteArray().toString(Charsets.UTF_8) else body!!
                attempts.add(saved)
                if (receipt == null) {
                    val operation = JSONObject(saved); val initialization = operation.has("initializationId")
                    val epoch = operation.getString(if (initialization) "initializationId" else "cutoverId")
                    val payload = if (initialization && legacy != null) legacy else operation.getJSONObject(if (initialization) "initialTracking" else "expectedTrackingPayload")
                    val version = if (initialization) (if (legacy == null) 1L else 7L) else operation.getLong("expectedTrackingServerVersion")
                    val cutover = if (!initialization) operation else JSONObject().put("schemaVersion", 2).put("accountId", owner).put("cutoverId", epoch)
                        .put("expectedTrackingPayload", payload).put("expectedTrackingServerVersion", version)
                    val record = JSONObject().put("user_id", owner).put("entity_type", "tracking").put("entity_id", "singleton")
                        .put("version", 1).put("server_version", version).put("device_id", if (initialization && legacy == null) "causal-initialization-v2" else "legacy-fixture")
                        .put("payload", payload).put("updated_at", "2026-09-08T00:00:00.000Z").put("deleted_at", JSONObject.NULL)
                    val proof = JSONObject().put("schemaVersion", 2).put("epoch", epoch).put("projectionRevision", 0).put("operation", cutover).put("record", record)
                        .put("baseline", JSONObject().put("schemaVersion", 1).put("baselineId", epoch).put("accountId", owner).put("day", payload.getString("date"))
                            .put("counts", JSONObject().put("planViewCount", payload.get("planViewCount")).put("dailyPostponeCount", payload.get("dailyPostponeCount")))
                            .put("evidenceIds", JSONArray().put(epoch)))
                    receipt = if (initialization) JSONObject().put("schemaVersion", 2).put("type", "initialization").put("operation", operation)
                        .put("created", legacy == null).put("cutoverReceipt", proof) else proof
                }
                if (loseResponse) { loseResponse = false; throw IOException("Synthetic response loss after server commit") }
                return response(receipt!!)
            }
            if (path.startsWith("/api/v1/sync/causal-history?")) {
                val proof = receipt!!.let { if (it.has("cutoverReceipt")) it.getJSONObject("cutoverReceipt") else it }
                val entry = JSONObject().put("schemaVersion", 2).put("accountId", owner).put("epoch", proof.getString("epoch")).put("revision", 0).put("receipt", proof)
                val bytes = entry.toString().toByteArray(Charsets.UTF_8); val offset = path.substringAfter("&offset=").toInt()
                val chunk = bytes.copyOfRange(offset, minOf(bytes.size, offset + NativeCausalHistoryProtocol.CHUNK_BYTES))
                return response(JSONObject().put("schemaVersion", 2).put("accountId", owner).put("epoch", proof.getString("epoch"))
                    .put("revision", 0).put("throughRevision", 0).put("offset", offset).put("totalBytes", bytes.size)
                    .put("sha256", NativeCausalHistoryProtocol.hash(bytes)).put("chunkSha256", NativeCausalHistoryProtocol.hash(chunk))
                    .put("data", Base64.getEncoder().encodeToString(chunk))
                    .put("nextOffset", (offset + chunk.size).takeIf { it < bytes.size } ?: JSONObject.NULL))
            }
            error("Unexpected synthetic request path")
        }
    }
    private fun engine(repository: GoalflowRepository, backend: NativeSyncTransport, provider: NativeSessionProvider = NativeSessionProvider { session }) =
        NativeSyncEngine(repository, provider, backend, { true }, NativeSyncRetryPolicy(maxAttempts = 1))

    @Test fun `lost initialization response retries exact durable bytes and downloads without clearing pending increments`() = runTest {
        val db = database()
        try {
            val repository = GoalflowRepository(db, "fixture"); repository.bindSyncAccount(owner); repository.prepareCausalAccount(owner)
            val state = NativeCausalJournal.validate(db.causalAccountDao().get(owner)!!)
            repository.admitCausalCounter(owner, NativeCounterIntent(UUID.randomUUID().toString(), state.getJSONObject("tracking").getString("date"), "UTC", "planViewCount", "2026-09-08T00:00:00.000Z"))
            val mirror = db.rawCollectionDao().get("tracking")
            val backend = Backend(loseResponse = true)
            assertTrue(runCatching { engine(repository, backend).synchronizeCausalEvidence() }.isFailure)
            val pending = NativeCausalJournal.validate(db.causalAccountDao().get(owner)!!)
            assertEquals(backend.attempts.single(), pending.getString("initializationRequest")); assertFalse(pending.has("initializationReceipt"))
            assertEquals(0, JSONObject(pending.getString("initializationRequest")).getJSONObject("initialTracking").getInt("planViewCount"))
            val result = engine(repository, backend).synchronizeCausalEvidence()
            assertEquals(0L, result.downloadedRevision); assertEquals(2, backend.attempts.size); assertEquals(backend.attempts[0], backend.attempts[1])
            val complete = NativeCausalJournal.validate(db.causalAccountDao().get(owner)!!)
            assertEquals(1, complete.getJSONObject("counterOutbox").length()); assertEquals(mirror, db.rawCollectionDao().get("tracking"))
            assertEquals(0, complete.getJSONObject("causalHistory").getInt("downloadedRevision"))
            val retained = db.causalAccountDao().get(owner)!!
            val changedEpoch = JSONObject(retained.payload)
            changedEpoch.getJSONObject("causalCapability").put("epoch", UUID.randomUUID().toString())
            assertTrue(runCatching { NativeCausalJournal.validate(retained.copy(payload = changedEpoch.toString())) }.isFailure)
            val changedReceipt = JSONObject(retained.payload)
            changedReceipt.getJSONObject("initializationReceipt").getJSONObject("cutoverReceipt").getJSONObject("record").put("version", 2)
            assertTrue(runCatching { NativeCausalJournal.validate(retained.copy(payload = changedReceipt.toString())) }.isFailure)
        } finally { db.close() }
    }

    @Test fun `large known cutover uses staging and preserves the original baseline`() = runTest {
        val db = database()
        try {
            val repository = GoalflowRepository(db, "fixture"); repository.bindSyncAccount(owner)
            val payload = JSONObject().put("date", "2026-09-08").put("planViewCount", 27).put("dailyPostponeCount", 3).put("unknown", "界".repeat(90_000))
            db.rawCollectionDao().insert(RawCollectionEntity("tracking", payload.toString(), "2026-09-08T00:00:00Z", null))
            db.syncMetaDao().insert(SyncMetaEntity("tracking:singleton", 7, 1, 7, null))
            repository.prepareCausalAccount(owner)
            val backend = Backend(); engine(repository, backend).synchronizeCausalEvidence()
            assertTrue(backend.stageCount > 1)
            val retained = NativeCausalJournal.validate(db.causalAccountDao().get(owner)!!)
            assertEquals(backend.attempts.single(), retained.getString("cutoverRequest"))
            assertEquals(ActionJson.canonical(payload), ActionJson.canonical(JSONObject(retained.getString("cutoverRequest")).getJSONObject("expectedTrackingPayload")))
            assertEquals(7L, db.syncMetaDao().get("tracking:singleton")!!.cursor)
            val entity = db.causalAccountDao().get(owner)!!; val damaged = JSONObject(entity.payload)
            val request = JSONObject(damaged.getString("cutoverRequest")).put("expectedTrackingServerVersion", 8)
            damaged.put("cutoverRequest", request.toString()).remove("cutoverReceipt")
            assertTrue(runCatching { NativeCausalJournal.validate(entity.copy(payload = damaged.toString())) }.isFailure)
        } finally { db.close() }
    }

    @Test fun `session replacement invalidates discovery before enrollment writes`() = runTest {
        val db = database()
        try {
            val repository = GoalflowRepository(db, "fixture"); repository.bindSyncAccount(owner); repository.prepareCausalAccount(owner)
            val before = db.causalAccountDao().get(owner); var active: NativeSession? = session
            val backend = Backend()
            val transport = NativeSyncTransport { path, token, method, body ->
                val response = backend.request(path, token, method, body)
                if (path.endsWith("causal-capability")) active = null
                response
            }
            assertTrue(runCatching { engine(repository, transport, NativeSessionProvider { active }).synchronizeCausalEvidence() }.isFailure)
            assertEquals(before, db.causalAccountDao().get(owner)); assertTrue(backend.attempts.isEmpty())
        } finally { db.close() }
    }

    @Test fun `fresh local initialization retains the selected existing server baseline`() = runTest {
        val db = database()
        try {
            val repository = GoalflowRepository(db, "fixture"); repository.bindSyncAccount(owner); repository.prepareCausalAccount(owner)
            val legacy = JSONObject().put("date", "2026-09-08").put("planViewCount", 27).put("dailyPostponeCount", 3).put("unknown", "retained")
            val mirror = db.rawCollectionDao().get("tracking")
            engine(repository, Backend(legacy = legacy)).synchronizeCausalEvidence()
            val state = NativeCausalJournal.validate(db.causalAccountDao().get(owner)!!)
            val receipt = state.getJSONObject("initializationReceipt")
            assertFalse(receipt.getBoolean("created"))
            assertEquals(0, JSONObject(state.getString("initializationRequest")).getJSONObject("initialTracking").getInt("planViewCount"))
            assertEquals(ActionJson.canonical(legacy), ActionJson.canonical(receipt.getJSONObject("cutoverReceipt").getJSONObject("record").getJSONObject("payload")))
            assertEquals(27, NativeCausalReplay.replay(owner, state.getJSONObject("causalHistory")).tracking.getInt("planViewCount"))
            assertEquals(mirror, db.rawCollectionDao().get("tracking"))
        } finally { db.close() }
    }
}
