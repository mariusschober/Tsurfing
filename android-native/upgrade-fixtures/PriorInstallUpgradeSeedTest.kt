package com.mariusschober.goalflow.nativeapp.data

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Copied into the preserved v2 test source tree by CI. This file is not part of
 * the current application APK. It seeds the prior installed application
 * through that version's own Room database before an in-place package upgrade.
 */
@RunWith(AndroidJUnit4::class)
class PriorInstallUpgradeSeedTest {
    @Test
    fun seedDurableVersionTwoState() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        context.deleteDatabase("goalflow-native.db")
        val room = GoalflowDatabase.create(context)
        val database = room.openHelper.writableDatabase
        database.beginTransaction()
        try {
            database.execSQL(
                """
                INSERT INTO tasks (
                  id,title,notes,schedulePrecision,scheduledFor,scheduledTime,plannedOrder,status,
                  isFrog,beforeFrog,frogFailures,source,goalId,parentTaskId,habitId,createdAt,updatedAt,
                  completedAt,deletedAt,extraJson
                ) VALUES (
                  '$ACTIVE_TASK_ID','Upgrade sentinel','created by preserved v2','DAY','2026-08-27',
                  '09:30',7,'OPEN',1,0,2,'MANUAL',NULL,NULL,NULL,1722470400000,1722470460000,
                  NULL,NULL,'{"duration":35}'
                )
                """.trimIndent()
            )
            database.execSQL(
                """
                INSERT INTO tasks (
                  id,title,notes,schedulePrecision,scheduledFor,scheduledTime,plannedOrder,status,
                  isFrog,beforeFrog,frogFailures,source,goalId,parentTaskId,habitId,createdAt,updatedAt,
                  completedAt,deletedAt,extraJson
                ) VALUES (
                  '$DELETED_TASK_ID','Deleted upgrade sentinel','','DAY','2026-08-28',NULL,8,'DROPPED',
                  0,0,0,'MANUAL',NULL,NULL,NULL,1722470500000,1722470560000,NULL,1722470600000,'{}'
                )
                """.trimIndent()
            )
            database.execSQL(
                """
                INSERT INTO sync_outbox (
                  mutationId,deviceId,entityType,entityId,baseServerVersion,version,payload,updatedAt,
                  deletedAt,dependsOnMutationId,resolvesConflictId,attemptedAt
                ) VALUES (
                  '$FIRST_MUTATION_ID','upgrade-device-v2','tasks','$ACTIVE_TASK_ID',NULL,1,
                  '{"title":"Upgrade sentinel v1"}','2026-08-27T00:00:00Z',NULL,NULL,NULL,NULL
                )
                """.trimIndent()
            )
            database.execSQL(
                """
                INSERT INTO sync_outbox (
                  mutationId,deviceId,entityType,entityId,baseServerVersion,version,payload,updatedAt,
                  deletedAt,dependsOnMutationId,resolvesConflictId,attemptedAt
                ) VALUES (
                  '$SECOND_MUTATION_ID','upgrade-device-v2','tasks','$ACTIVE_TASK_ID',NULL,2,
                  '{"title":"Upgrade sentinel"}','2026-08-27T00:01:00Z',NULL,
                  '$FIRST_MUTATION_ID',NULL,NULL
                )
                """.trimIndent()
            )
            database.execSQL(
                """
                INSERT INTO sync_outbox (
                  mutationId,deviceId,entityType,entityId,baseServerVersion,version,payload,updatedAt,
                  deletedAt,dependsOnMutationId,resolvesConflictId,attemptedAt
                ) VALUES (
                  '$DELETE_MUTATION_ID','upgrade-device-v2','tasks','$DELETED_TASK_ID',4,5,
                  '{"title":"Deleted upgrade sentinel"}','2026-08-28T00:00:00Z',
                  '2026-08-28T00:00:00Z',NULL,NULL,NULL
                )
                """.trimIndent()
            )
            database.execSQL(
                "INSERT INTO sync_meta (entityType,cursor,localVersion,serverVersion,lastSuccessfulSync) " +
                    "VALUES ('tasks:$ACTIVE_TASK_ID',17,2,16,'2026-08-26T23:59:00Z')"
            )
            database.execSQL(
                "INSERT INTO local_account (bindingKey,userId) VALUES ('owner','$ACCOUNT_ID')"
            )
            database.setTransactionSuccessful()
        } finally {
            database.endTransaction()
        }

        database.query("SELECT title,updatedAt FROM tasks WHERE id='$ACTIVE_TASK_ID'").use { cursor ->
            check(cursor.moveToFirst())
            assertEquals("Upgrade sentinel", cursor.getString(0))
            assertEquals(1722470460000L, cursor.getLong(1))
        }
        database.query("SELECT COUNT(*) FROM sync_outbox").use { cursor ->
            check(cursor.moveToFirst())
            assertEquals(3, cursor.getInt(0))
        }
        room.close()
    }

    private companion object {
        const val ACTIVE_TASK_ID = "11111111-1111-4111-8111-111111111111"
        const val DELETED_TASK_ID = "22222222-2222-4222-8222-222222222222"
        const val FIRST_MUTATION_ID = "33333333-3333-4333-8333-333333333333"
        const val SECOND_MUTATION_ID = "44444444-4444-4444-8444-444444444444"
        const val DELETE_MUTATION_ID = "55555555-5555-4555-8555-555555555555"
        const val ACCOUNT_ID = "66666666-6666-4666-8666-666666666666"
    }
}
