package com.mariusschober.goalflow.nativeapp.data

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.test.runTest
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
class NativeCausalAccountDaoTest {
    @Test fun `journal DAO reads beyond the cursor window without splitting Unicode or losing bytes`() = runTest {
        val database = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext<Context>(), GoalflowDatabase::class.java)
            .allowMainThreadQueries().build()
        try {
            val dao = database.causalAccountDao()
            val payload = JSONObject().put("syntheticUnicode", "🧭界".repeat(400_000)).toString()
            assertTrue(payload.toByteArray(Charsets.UTF_8).size > 2 * 1024 * 1024)
            val row = CausalAccountEntity(UUID.randomUUID().toString(), payload)
            dao.insert(row)
            assertEquals(row, dao.get(row.accountId)); assertEquals(listOf(row), dao.getAll())
            val updated = row.copy(payload = JSONObject().put("replacement", "界🧭".repeat(410_000)).toString())
            assertEquals(1, dao.update(updated)); assertEquals(updated, dao.get(row.accountId))
            assertNull(dao.get(UUID.randomUUID().toString()))
        } finally { database.close() }
    }
}
