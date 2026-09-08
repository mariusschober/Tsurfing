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
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
class NativeLegacyReceiptEvidenceTest {
    private lateinit var database: GoalflowDatabase
    private lateinit var repository: GoalflowRepository
    private lateinit var sent: SyncOutboxEntity
    private val owner = UUID.randomUUID().toString()
    @Before fun setup() = runTest {
        database = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext<Context>(), GoalflowDatabase::class.java)
            .allowMainThreadQueries().build()
        repository = GoalflowRepository(database, "fixture"); repository.bindSyncAccount(owner); repository.prepareCausalAccount(owner)
        repository.createTask("Synthetic predecessor", "Original notes retained", SchedulePrecision.DAY, "2026-09-08", null, false)
        sent = database.syncOutboxDao().getAll().first { it.entityType == "tasks" }
    }
    @After fun teardown() { database.close() }
    private fun result(accountId: String = owner): NativePushResult {
        val raw = JSONObject().put("mutationId", sent.mutationId).put("accepted", true).put("serverVersion", 10)
            .put("unknownReceipt", "retained").put("record", JSONObject().put("user_id", accountId)
                .put("entity_type", sent.entityType).put("entity_id", sent.entityId).put("device_id", sent.deviceId)
                .put("version", sent.version).put("server_version", 10).put("payload", JSONObject(sent.payload))
                .put("updated_at", sent.updatedAt).put("deleted_at", JSONObject.NULL))
        return NativePushResult(sent.mutationId, true, 10, recordEntityType = sent.entityType, recordEntityId = sent.entityId,
            recordDeviceId = sent.deviceId, recordVersion = sent.version, recordServerVersion = 10, recordPayload = sent.payload,
            recordUpdatedAt = sent.updatedAt, receiptJson = raw.toString(2))
    }
    @Test fun `accepted predecessor retains exact payload and full receipt through backup and duplicate acknowledgment`() = runTest {
        val response = result(); repository.markSyncAttempted(listOf(sent.mutationId), "2026-09-08T00:00:00.000Z")
        repository.commitPushResults(listOf(sent), listOf(response))
        assertNull(database.syncOutboxDao().get(sent.mutationId))
        val retained = database.causalAccountDao().get(owner)!!
        val entry = NativeCausalJournal.validate(retained).getJSONObject("legacyPushReceipts").getJSONObject(sent.mutationId)
        assertEquals(sent.payload, entry.getJSONObject("request").getString("payload"))
        assertEquals(response.receiptJson, entry.getString("receipt"))
        repository.commitPushResults(listOf(sent), listOf(response)); assertEquals(retained, database.causalAccountDao().get(owner))
        val backup = GoalflowBackup.decryptDocument(repository.exportBackup("synthetic predecessor password"), "synthetic predecessor password")
        assertEquals(listOf(retained), backup.payload.causalAccounts)
        val damaged = JSONObject(retained.payload)
        val proof = damaged.getJSONObject("legacyPushReceipts").getJSONObject(sent.mutationId)
        val raw = JSONObject(proof.getString("receipt")); raw.getJSONObject("record").put("device_id", "different")
        proof.put("receipt", raw.toString())
        assertTrue(runCatching { NativeCausalJournal.validate(retained.copy(payload = damaged.toString())) }.isFailure)
    }
    @Test fun `cross-account and missing full receipts cannot retire a causal predecessor`() = runTest {
        val before = database.causalAccountDao().get(owner); val queue = database.syncOutboxDao().getAll()
        assertTrue(runCatching { repository.commitPushResults(listOf(sent), listOf(result(UUID.randomUUID().toString()))) }.isFailure)
        assertTrue(runCatching { repository.commitPushResults(listOf(sent), listOf(result().copy(receiptJson = null))) }.isFailure)
        val mismatched = result().let { it.copy(receiptJson = JSONObject(it.receiptJson!!).put("serverVersion", 11).toString()) }
        assertTrue(runCatching { repository.commitPushResults(listOf(sent), listOf(mismatched)) }.isFailure)
        assertEquals(before, database.causalAccountDao().get(owner)); assertEquals(queue, database.syncOutboxDao().getAll())
    }
    @Test fun `receipt persistence failure rolls back retirement and dependent rebasing`() = runTest {
        val before = database.causalAccountDao().get(owner); val queue = database.syncOutboxDao().getAll(); val meta = database.syncMetaDao().getAll()
        database.openHelper.writableDatabase.execSQL("CREATE TRIGGER fail_predecessor_receipt BEFORE UPDATE ON causal_accounts BEGIN SELECT RAISE(ABORT,'synthetic receipt rollback'); END")
        assertTrue(runCatching { repository.commitPushResults(listOf(sent), listOf(result())) }.isFailure)
        assertEquals(before, database.causalAccountDao().get(owner)); assertEquals(queue, database.syncOutboxDao().getAll())
        assertEquals(meta, database.syncMetaDao().getAll())
    }
    @Test fun `changed queued bytes cannot be retired using an older sent snapshot`() = runTest {
        val changed = sent.copy(payload = JSONObject(sent.payload).put("description", "Later preserved notes").toString())
        database.syncOutboxDao().insert(changed)
        assertTrue(runCatching { repository.commitPushResults(listOf(sent), listOf(result())) }.isFailure)
        assertEquals(changed, database.syncOutboxDao().get(sent.mutationId))
        assertFalse(NativeCausalJournal.validate(database.causalAccountDao().get(owner)!!).has("legacyPushReceipts"))
    }
}
