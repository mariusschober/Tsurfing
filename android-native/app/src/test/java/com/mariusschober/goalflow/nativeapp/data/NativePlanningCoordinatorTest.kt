package com.mariusschober.goalflow.nativeapp.data

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.test.runTest
import org.json.JSONArray
import org.json.JSONObject
import org.junit.*
import org.junit.Assert.*
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class NativePlanningCoordinatorTest {
    private lateinit var database: GoalflowDatabase
    private lateinit var repository: GoalflowRepository
    private val account = "11111111-1111-4111-8111-111111111111"
    private val day = "2026-09-08"
    @Before fun setup() {
        database = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext<Context>(), GoalflowDatabase::class.java).allowMainThreadQueries().build()
        repository = GoalflowRepository(database, deviceId = "test-device")
    }
    @After fun close() { database.close() }
    private fun response() = JSONObject().put("schemaVersion", 1).put("accountId", account).put("enforcementEnabled", true)
        .put("policy", DeliberatePlanning.initial(account, day))

    @Test fun `saved dates retain old drafts and pending confirmations without entering the new day`() = runTest {
        repository.bindSyncAccount(account)
        repository.beginReplan(day)
        val tomorrow = "2026-09-09"
        val current = repository.planningStore.read(tomorrow)
        assertEquals(listOf(day), current.otherDates)
        assertNull(current.draft)
        assertEquals(0, current.pending)
        assertFalse(current.locked)
        repository.confirmPlan(day, emptyList())
        val after = repository.planningStore.read(tomorrow)
        assertEquals(listOf(day), after.otherDates)
        assertNull(after.draft)
        assertEquals(0, after.pending)
        assertEquals(1, repository.planningStore.read(day).pending)
        val state = JSONObject(database.planningAccountDao().get(account)!!.payload)
        val pending = state.getJSONObject("planning").getJSONObject("pending")
        assertEquals(day, pending.getJSONObject(pending.keys().next()).getJSONObject("command").getString("localDate"))
    }

    @Test fun `policy waits for its business records to reach the local cursor`() = runTest {
        repository.bindSyncAccount(account)
        val record = JSONObject().put("user_id", account).put("entity_type", "progress").put("entity_id", "singleton")
            .put("server_version", 5).put("version", 1).put("device_id", "remote")
            .put("updated_at", "2026-09-08T10:00:00.000Z").put("deleted_at", JSONObject.NULL).put("payload", JSONObject().put("xp", 0))
        val snapshot = response().put("records", JSONArray().put(record))
        assertFalse(repository.planningStore.commitDay(account, day, snapshot))
        assertNull(database.planningAccountDao().get(account))
        database.syncMetaDao().insert(SyncMetaEntity("_cursor", 5, 0, null, null))
        assertTrue(repository.planningStore.commitDay(account, day, snapshot))
        assertNotNull(database.planningAccountDao().get(account))
    }
    @Test fun `remote refresh preserves offline confirmation byte for byte`() = runTest {
        repository.bindSyncAccount(account)
        repository.confirmPlan(day, emptyList())
        val before = database.planningAccountDao().get(account)!!
        assertFalse(repository.planningStore.commitDay(account, day, response()))
        assertEquals(before, database.planningAccountDao().get(account))
        assertEquals(1, repository.planningStore.read(day).pending)
    }
    @Test fun `delayed policy snapshot cannot roll back confirmed history`() = runTest {
        repository.bindSyncAccount(account)
        val old = response()
        val command = JSONObject().put("schemaVersion", 1).put("accountId", account).put("localDate", day)
            .put("operationId", "00000000-0000-4000-8000-000000000003").put("baselineRevision", JSONObject.NULL)
            .put("proposedOrder", JSONArray()).put("ratings", JSONArray()).put("maximumAcceptedXp", 0)
            .put("capturedAt", "2026-09-08T10:00:00.000Z")
        val confirmed = DeliberatePlanning.apply(old.getJSONObject("policy"), command, emptyList(), 10, "classic")
        assertTrue(repository.planningStore.commitDay(account, day, response().put("policy", confirmed.policy)))
        assertFalse(repository.planningStore.commitDay(account, day, old))
        assertEquals(ActionJson.canonical(confirmed.policy), ActionJson.canonical(repository.planningStore.read(day).policy))
    }

    @Test fun `stale draft review adopts current revision without confirming or charging`() = runTest {
        repository.bindSyncAccount(account)
        val draft = repository.planningStore.begin(day)
        val command = JSONObject().put("schemaVersion", 1).put("accountId", account).put("localDate", day)
            .put("operationId", "00000000-0000-4000-8000-000000000003").put("baselineRevision", JSONObject.NULL)
            .put("proposedOrder", JSONArray()).put("ratings", JSONArray()).put("maximumAcceptedXp", 0)
            .put("capturedAt", "2026-09-08T10:00:00.000Z")
        val confirmed = DeliberatePlanning.apply(DeliberatePlanning.initial(account, day), command, emptyList(), 10, "classic")
        assertTrue(repository.planningStore.commitDay(account, day, response().put("policy", confirmed.policy)))
        assertTrue(repository.planningStore.read(day).staleDraft)
        val reviewed = repository.planningStore.reviewDraft(day)
        assertEquals(confirmed.policy.get("revision"), reviewed.get("baselineRevision"))
        assertEquals(ActionJson.canonical(draft.getJSONArray("proposedOrder")), ActionJson.canonical(reviewed.getJSONArray("proposedOrder")))
        val after = repository.planningStore.read(day)
        assertFalse(after.staleDraft)
        assertEquals(0, after.pending)
        assertEquals(ActionJson.canonical(confirmed.policy), ActionJson.canonical(after.policy))
    }

    @Test fun `confirmation consent is zero for unchanged order or task additions alone`() {
        val policy = DeliberatePlanning.initial(account, day)
            .put("revision", "00000000-0000-4000-8000-000000000003")
            .put("confirmedOrder", JSONArray(listOf("a", "b"))).put("acceptedReplans", 3)
        val snapshot = NativePlanningSnapshot(policy, null, 0, 50)
        assertEquals(0, snapshot.confirmationCost(listOf("a", "b")))
        assertEquals(0, snapshot.confirmationCost(listOf("a", "new", "b")))
        assertEquals(0, snapshot.confirmationCost(listOf("b")))
        assertEquals(50, snapshot.confirmationCost(listOf("b", "a")))
    }

    @Test fun `rejected confirmation retains review and resolves without charging or confirming`() = runTest {
        repository.bindSyncAccount(account)
        repository.confirmPlan(day, emptyList())
        val earlier = database.syncOutboxDao().getAll()
        repository.planningStore.retainOrdinaryResults(earlier, earlier.mapIndexed { index, row -> NativePushResult(row.mutationId, true, index + 1L) })
        earlier.forEach { database.syncOutboxDao().delete(it.mutationId) }
        val command = JSONObject(repository.planningStore.prepare(account)!!)
        val state = JSONObject(database.planningAccountDao().get(account)!!.payload)
        val pending = state.getJSONObject("planning").getJSONObject("pending").getJSONObject(command.getString("operationId"))
        val receipt = JSONObject(pending.getJSONObject("provisional").toString()).put("code", "STALE_REVISION")
            .put("revision", JSONObject.NULL).put("order", JSONArray()).put("actualDebit", 0).put("acceptedReplans", 0)
        val policy = DeliberatePlanning.initial(account, day).put("history", JSONArray().put(receipt))
        val reply = JSONObject().put("schemaVersion", 1).put("accountId", account).put("receipt", receipt).put("policy", policy).put("records", JSONArray())
        assertFalse(repository.planningStore.commit(account, command, reply))
        assertNull(repository.planningStore.prepare(account))
        assertEquals(command.toString(), repository.planningStore.reviewRequest(account))
        val records = JSONArray()
        val members = pending.getJSONArray("members")
        for (i in 0 until members.length()) {
            val member = members.getJSONObject(i)
            records.put(JSONObject().put("user_id", account).put("entity_type", member.getString("entityType")).put("entity_id", member.getString("entityId"))
                .put("version", 1).put("server_version", i + 1).put("device_id", "remote").put("updated_at", command.getString("capturedAt"))
                .put("deleted_at", JSONObject.NULL).put("payload", member.getJSONObject("payload")))
        }
        val snapshot = JSONObject().put("schemaVersion", 1).put("accountId", account).put("operationId", command.getString("operationId"))
            .put("response", reply).put("policy", policy).put("records", records).put("missingTaskIds", JSONArray())
        repository.planningStore.retainReview(account, command, snapshot)
        assertNull(repository.planningStore.reviewRequest(account))
        assertNotNull(repository.planningStore.read(day).review)
        repository.planningStore.resolveReview(day, true)
        val after = repository.planningStore.read(day)
        assertNull(after.review); assertEquals(0, after.pending); assertNotNull(after.draft)
        assertFalse(after.locked); assertEquals(3, after.remaining)
        assertFalse(repository.planningStore.commit(account, command, reply))
        val row = database.planningAccountDao().get(account)!!
        val payload = GoalflowBackupPayload(emptyList(), emptyList(), emptyList(), ownerUserId = account, planningAccounts = listOf(row))
        assertEquals(listOf(row), GoalflowBackup.decrypt(GoalflowBackup.encrypt(payload, "a strong backup password"), "a strong backup password").planningAccounts)
        val altered = JSONObject(row.payload)
        altered.getJSONObject("planning").getJSONObject("resolutions").getJSONObject(command.getString("operationId")).put("choice", "automatic")
        assertTrue(runCatching { GoalflowBackup.encrypt(payload.copy(planningAccounts = listOf(row.copy(payload = altered.toString()))), "a strong backup password") }.isFailure)
        val saved = JSONObject(row.payload).getJSONObject("planning")
        assertEquals(command.toString(), saved.getJSONObject("resolutions").getJSONObject(command.getString("operationId")).getJSONObject("pending").getString("request"))
    }
}
