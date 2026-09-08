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
class NativeCausalStoreTest {
    private lateinit var database: GoalflowDatabase
    private lateinit var repository: GoalflowRepository
    private val owner = UUID.randomUUID().toString()
    private val session = UUID.randomUUID().toString()
    private lateinit var task: String

    @Before fun setup() = runTest {
        database = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext<Context>(), GoalflowDatabase::class.java)
            .allowMainThreadQueries().build()
        repository = GoalflowRepository(database, "fixture")
        task = repository.createTask("Synthetic focus", "retained notes", SchedulePrecision.DAY, "2026-09-08", null, false).id
        repository.bindSyncAccount(owner)
        val focus = NativeFocusSessionRecord.start(task, 600, Instant.parse("2026-09-08T00:00:00Z"), session).toJson()
        val tracking = JSONObject().put("date", "2026-09-08").put("planViewCount", 27).put("dailyPostponeCount", 3)
            .put("unknown", "retained").put("focusSession", focus)
        database.rawCollectionDao().insert(RawCollectionEntity("tracking", tracking.toString(), "2026-09-08T00:00:00Z", null))
        repository.prepareCausalAccount(owner)
    }
    @After fun teardown() { database.close() }
    private fun intent(kind: String, duration: Long? = null) = NativeFocusIntent(UUID.randomUUID().toString(), kind,
        session, task, session, duration, "2026-09-08T00:00:10.000Z")
    private suspend fun state() = database.causalAccountDao().get(owner)!!
    private fun counter(kind: String) = NativeCounterIntent(UUID.randomUUID().toString(), "2026-09-08",
        "Atlantic/Canary", kind, "2026-09-08T00:00:10.000Z")

    @Test fun `distinct counter actions conserve both counts independently of focus and retries`() = runTest {
        val plans = counter("planViewCount"); val postpones = counter("dailyPostponeCount")
        repository.admitCausalCounter(owner, plans); repository.admitCausalCounter(owner, postpones)
        var tracking = NativeCausalJournal.validate(state()).getJSONObject("tracking")
        assertEquals(28, tracking.getInt("planViewCount")); assertEquals(4, tracking.getInt("dailyPostponeCount"))
        repository.admitCausalFocus(owner, intent("extend", 300))
        repository.admitCausalCounter(owner, counter("planViewCount"))
        repository.admitCausalCounter(owner, counter("dailyPostponeCount"))
        val before = state()
        assertTrue(repository.admitCausalCounter(owner, plans).duplicate)
        assertTrue(repository.admitCausalCounter(owner, postpones).duplicate)
        assertEquals(before, state())
        tracking = NativeCausalJournal.validate(state()).getJSONObject("tracking")
        assertEquals(29, tracking.getInt("planViewCount")); assertEquals(5, tracking.getInt("dailyPostponeCount"))
        assertEquals(900, tracking.getJSONObject("focusSession").getInt("plannedDurationSeconds"))
        assertEquals("retained", tracking.getString("unknown"))
        assertTrue(runCatching { repository.admitCausalCounter(owner, plans.copy(counter = "dailyPostponeCount")) }.isFailure)
        assertTrue(runCatching { repository.admitCausalFocus(owner, intent("pause").copy(actionId = plans.actionId)) }.isFailure)
        assertEquals(before, state())
    }

    @Test fun `counter transaction rollback and unknown day preserve original evidence`() = runTest {
        val before = state(); val mirror = database.rawCollectionDao().get("tracking")
        assertTrue(runCatching { repository.admitCausalCounter(owner, counter("planViewCount").copy(day = "2026-09-07")) }.isFailure)
        database.openHelper.writableDatabase.execSQL("CREATE TRIGGER fail_counter_mirror BEFORE INSERT ON raw_collections WHEN NEW.entityType='tracking' BEGIN SELECT RAISE(ABORT,'synthetic counter failure'); END")
        assertTrue(runCatching { repository.admitCausalCounter(owner, counter("planViewCount")) }.isFailure)
        assertEquals(before, state()); assertEquals(mirror, database.rawCollectionDao().get("tracking"))
    }

    @Test fun `unknown day retains captured increments without relabeling previous counts or focus`() = runTest {
        val mirror = database.rawCollectionDao().get("tracking")
        val selection = NativeCounterDayIntent(UUID.randomUUID().toString(), "select", "2026-09-09",
            "Europe/Berlin", "2026-09-08T23:00:00.000Z")
        assertTrue(JSONObject(repository.admitCausalCounterDay(owner, selection).outcome).getBoolean("baselinePending"))
        val event = counter("planViewCount").copy(day = "2026-09-09")
        assertTrue(JSONObject(repository.admitCausalCounter(owner, event).outcome).getBoolean("baselinePending"))
        val retained = state()
        val damaged = JSONObject(retained.payload)
        damaged.getJSONObject("counterAdmissions").remove(event.actionId)
        damaged.getJSONObject("counterOutbox").remove(event.actionId)
        assertTrue(runCatching { NativeCausalJournal.validate(retained.copy(payload = damaged.toString())) }.isFailure)
        assertEquals(JSONObject(mirror!!.payload).toString(), NativeCausalJournal.validate(retained).getJSONObject("tracking").toString())
        assertTrue(repository.admitCausalCounterDay(owner, selection).duplicate)
        assertTrue(repository.admitCausalCounter(owner, event).duplicate)
        assertEquals(retained, state())
        repository.admitCausalCounter(owner, counter("dailyPostponeCount"))
        val tracking = NativeCausalJournal.validate(state()).getJSONObject("tracking")
        assertEquals("2026-09-08", tracking.getString("date"))
        assertEquals(27, tracking.getInt("planViewCount")); assertEquals(4, tracking.getInt("dailyPostponeCount"))
        assertEquals(ActionJson.canonical(JSONObject(mirror.payload).getJSONObject("focusSession")),
            ActionJson.canonical(tracking.getJSONObject("focusSession")))
    }

    @Test fun `serial extensions use actual parents and retries reuse admission`() = runTest {
        val first = intent("extend", 300); val second = intent("extend", 120)
        repository.admitCausalFocus(owner, first); repository.admitCausalFocus(owner, second)
        val before = state(); val journal = NativeCausalJournal.validate(before)
        val admissions = journal.getJSONObject("focusAdmissions")
        assertEquals(session, admissions.getJSONObject(first.actionId).getJSONObject("command").getString("expectedRevision"))
        assertEquals(first.actionId, admissions.getJSONObject(second.actionId).getJSONObject("command").getString("expectedRevision"))
        assertEquals(1020L, journal.getJSONObject("tracking").getJSONObject("focusSession").getLong("plannedDurationSeconds"))
        assertEquals(27, journal.getJSONObject("tracking").getInt("planViewCount"))
        assertEquals(3, journal.getJSONObject("tracking").getInt("dailyPostponeCount"))
        assertTrue(repository.admitCausalFocus(owner, first).duplicate)
        assertEquals(before, state())
        assertTrue(runCatching { repository.admitCausalFocus(owner, first.copy(durationSeconds = 1)) }.isFailure)
        assertEquals(before, state())
    }

    @Test fun `mirror failure rolls back journal projection and enqueue`() = runTest {
        val before = state(); val mirror = database.rawCollectionDao().get("tracking")
        database.openHelper.writableDatabase.execSQL("CREATE TRIGGER fail_causal_mirror BEFORE INSERT ON raw_collections WHEN NEW.entityType='tracking' BEGIN SELECT RAISE(ABORT,'synthetic mirror failure'); END")
        assertTrue(runCatching { repository.admitCausalFocus(owner, intent("pause")) }.isFailure)
        assertEquals(before, state()); assertEquals(mirror, database.rawCollectionDao().get("tracking"))
    }

    @Test fun `legacy snapshot cannot bypass the command journal`() = runTest {
        val before = state(); val outbox = repository.pendingSyncMutations()
        assertTrue(runCatching { repository.transitionFocus(session, task) { it.pause(Instant.parse("2026-09-08T00:00:10Z")) } }.isFailure)
        assertEquals(before, state()); assertEquals(outbox, repository.pendingSyncMutations())
    }

    @Test fun `backup retains exact journal bytes and rejects a missing pending command`() = runTest {
        val action = intent("pause"); repository.admitCausalFocus(owner, action)
        val envelope = repository.exportBackup("fixture password retained")
        val document = GoalflowBackup.decryptDocument(envelope, "fixture password retained")
        assertEquals(6, document.schemaVersion)
        assertEquals(listOf(state()), document.payload.causalAccounts)
        val damaged = JSONObject(state().payload)
        damaged.getJSONObject("focusOutbox").remove(action.actionId)
        assertTrue(runCatching { GoalflowBackup.encrypt(document.payload.copy(
            causalAccounts = listOf(CausalAccountEntity(owner, damaged.toString()))), "fixture password retained") }.isFailure)
    }

    @Test fun `wrong account and changed mirror preserve the pending journal`() = runTest {
        val before = state()
        assertTrue(runCatching { repository.admitCausalFocus(UUID.randomUUID().toString(), intent("pause")) }.isFailure)
        val raw = database.rawCollectionDao().get("tracking")!!
        val changed = JSONObject(raw.payload).put("planViewCount", 28)
        database.rawCollectionDao().insert(raw.copy(payload = changed.toString()))
        assertTrue(runCatching { repository.admitCausalFocus(owner, intent("pause")) }.isFailure)
        assertEquals(before, state())
        assertEquals(28, JSONObject(database.rawCollectionDao().get("tracking")!!.payload).getInt("planViewCount"))
    }

    @Test fun `encrypted restore to a fresh bound database retains exact admissions and retry identity`() = runTest {
        val action = intent("extend", 300)
        repository.admitCausalFocus(owner, action)
        val increment = counter("planViewCount")
        repository.admitCausalCounter(owner, increment)
        val original = state()
        val envelope = repository.exportBackup("fixture password retained")
        val fresh = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext<Context>(), GoalflowDatabase::class.java)
            .allowMainThreadQueries().build()
        try {
            val restored = GoalflowRepository(fresh, "fixture")
            restored.bindSyncAccount(owner)
            restored.restoreBackup(envelope, "fixture password retained", BackupRestoreMode.REPLACE)
            assertEquals(original, fresh.causalAccountDao().get(owner))
            assertTrue(restored.admitCausalFocus(owner, action).duplicate)
            assertTrue(restored.admitCausalCounter(owner, increment).duplicate)
            assertEquals(original, fresh.causalAccountDao().get(owner))
        } finally { fresh.close() }
    }
}
