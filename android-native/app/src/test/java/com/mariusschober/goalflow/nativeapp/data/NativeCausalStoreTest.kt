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
        assertEquals(5, document.schemaVersion)
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
            assertEquals(original, fresh.causalAccountDao().get(owner))
        } finally { fresh.close() }
    }
}
