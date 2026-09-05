package com.mariusschober.goalflow.nativeapp.data

import android.content.Context
import androidx.room.Room
import androidx.room.testing.MigrationTestHelper
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class GoalflowDatabaseMigrationInstrumentedTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context: Context = instrumentation.targetContext

    @get:Rule
    val migrationHelper = MigrationTestHelper(
        instrumentation,
        GoalflowDatabase::class.java
    )

    @Test
    fun migrateEverySupportedVersionWithoutDestructiveFallback() = runBlocking {
        for (startVersion in 1..7) {
            val databaseName = "goalflow-migration-$startVersion.db"
            val taskId = "task-$startVersion"
            val tombstoneTaskId = "deleted-task-$startVersion"
            val mutationId = stableUuid(startVersion)
            val dependencyMutationId = stableUuid(100 + startVersion)
            val ownerUserId = stableUuid(200 + startVersion)
            // Version 2 shipped a collection-snapshot protocol. Its durable entity ID was
            // "singleton" and its metadata key was the collection name. Version 3 introduced
            // per-entity conflicts and metadata keys. Model the contract that actually shipped
            // so this test detects identity changes instead of inventing a recoverable v2 ID.
            val entityId = if (startVersion == 2) "singleton" else taskId
            val syncMetaKey = if (startVersion == 2) "tasks" else "tasks:$taskId"
            val localPayload = if (startVersion == 2) {
                """[{"id":"$taskId","title":"Local snapshot"}]"""
            } else {
                """{"id":"$taskId","title":"Local entity"}"""
            }
            val serverPayload = if (startVersion == 2) {
                """[{"id":"$taskId","title":"Server snapshot"}]"""
            } else {
                """{"id":"$taskId","title":"Server entity"}"""
            }
            val updatedAt = "2026-08-27T00:00:00Z"
            val deletedAt = "2026-08-28T00:00:00Z"
            val attemptedAt = "2026-08-29T00:00:00Z"
            context.deleteDatabase(databaseName)
            migrationHelper.createDatabase(databaseName, startVersion).apply {
                execSQL(
                    "INSERT INTO tasks (id,title,notes,schedulePrecision,scheduledFor,scheduledTime,plannedOrder,status,isFrog,beforeFrog,frogFailures,source,goalId,parentTaskId,habitId,createdAt,updatedAt,completedAt,deletedAt" +
                        (if (startVersion >= 4) ",extraJson)" else ")") +
                        " VALUES ('$taskId','Keep this task','','DAY','2026-08-27',NULL,0,'OPEN',0,0,0,'MANUAL',NULL,NULL,NULL,1000,2000,NULL,NULL" +
                        (if (startVersion >= 4) ",'{}')" else ")")
                )
                execSQL(
                    "INSERT INTO tasks (id,title,notes,schedulePrecision,scheduledFor,scheduledTime,plannedOrder,status,isFrog,beforeFrog,frogFailures,source,goalId,parentTaskId,habitId,createdAt,updatedAt,completedAt,deletedAt" +
                        (if (startVersion >= 4) ",extraJson)" else ")") +
                        " VALUES ('$tombstoneTaskId','Preserve this tombstone','','DAY','2026-08-26',NULL,1,'DONE',0,0,0,'MANUAL',NULL,NULL,NULL,3000,4000,4500,5000" +
                        (if (startVersion >= 4) ",'{}')" else ")")
                )
                execSQL("INSERT INTO daily_plans (localDate,confirmedAt,taskIds) VALUES ('2026-08-27',6000,'$taskId')")
                if (startVersion >= 2) {
                    execSQL(
                        "INSERT INTO sync_outbox (mutationId,deviceId,entityType,entityId,baseServerVersion,version,payload,updatedAt,deletedAt" +
                            (if (startVersion >= 3) ",dependsOnMutationId,resolvesConflictId,attemptedAt)" else ")") +
                            " VALUES ('$mutationId','device-a','tasks','$entityId',41,42,'$localPayload','$updatedAt','$deletedAt'" +
                            (if (startVersion >= 3) ",'$dependencyMutationId','conflict-$startVersion','$attemptedAt')" else ")")
                    )
                    execSQL("INSERT INTO sync_meta (entityType,cursor,localVersion,serverVersion,lastSuccessfulSync) VALUES ('$syncMetaKey',17,42,41,'$updatedAt')")
                    execSQL(
                        "INSERT INTO sync_conflicts (id,entityType,localPayload,serverPayload,serverVersion,createdAt" +
                            (if (startVersion >= 3) ",entityId,mutationId,localDeletedAt,localHistory,serverDeletedAt,status)" else ")") +
                            " VALUES ('conflict-$startVersion','tasks','$localPayload','$serverPayload',43,'$updatedAt'" +
                            (if (startVersion >= 3) ",'$entityId','$mutationId','$deletedAt','[\"history\"]','$attemptedAt','unresolved')" else ")")
                    )
                }
                if (startVersion >= 5) {
                    execSQL("INSERT INTO raw_collections (entityType,payload,updatedAt,deletedAt) VALUES ('stats','{}','$updatedAt','$deletedAt')")
                }
                if (startVersion >= 6) {
                    execSQL("INSERT INTO task_events (id,taskId,eventType,localDate,metadata,createdAt) VALUES ('event-$startVersion','$taskId','completed','2026-08-27','{\"source\":\"migration\"}',7000)")
                }
                if (startVersion >= 7) {
                    execSQL("INSERT INTO local_account (bindingKey,userId) VALUES ('owner','$ownerUserId')")
                }
                version = startVersion
                close()
            }

            val migrated = Room.databaseBuilder(context, GoalflowDatabase::class.java, databaseName)
                .addMigrations(*GoalflowDatabase.migrations())
                .build()
            try {
                migrated.openHelper.writableDatabase
                // Valuable rows
                val task = migrated.taskDao().get(taskId)
                assertEquals(taskId, task?.id)
                assertEquals("Keep this task", task?.title)
                assertEquals(1000L, task?.createdAt)
                assertEquals(2000L, task?.updatedAt)
                assertNull(task?.deletedAt)
                val tombstone = migrated.taskDao().get(tombstoneTaskId)
                assertEquals(tombstoneTaskId, tombstone?.id)
                assertEquals(3000L, tombstone?.createdAt)
                assertEquals(4000L, tombstone?.updatedAt)
                assertEquals(4500L, tombstone?.completedAt)
                assertEquals(5000L, tombstone?.deletedAt)
                val dailyPlan = migrated.dailyPlanDao().get("2026-08-27")
                assertEquals(6000L, dailyPlan?.confirmedAt)
                assertEquals(taskId, dailyPlan?.taskIds)
                // Outbox
                if (startVersion >= 2) {
                    val outbox = migrated.syncOutboxDao().getAll()
                    assertEquals(1, outbox.size)
                    assertEquals(mutationId, outbox.single().mutationId)
                    assertEquals(mutationId, UUID.fromString(outbox.single().mutationId).toString())
                    assertEquals(entityId, outbox.single().entityId)
                    assertEquals(41L, outbox.single().baseServerVersion)
                    assertEquals(42L, outbox.single().version)
                    assertEquals(localPayload, outbox.single().payload)
                    assertEquals(updatedAt, outbox.single().updatedAt)
                    assertEquals(deletedAt, outbox.single().deletedAt)
                    if (startVersion >= 3) {
                        assertEquals(dependencyMutationId, outbox.single().dependsOnMutationId)
                        assertEquals("conflict-$startVersion", outbox.single().resolvesConflictId)
                        assertEquals(attemptedAt, outbox.single().attemptedAt)
                    } else {
                        assertNull(outbox.single().dependsOnMutationId)
                        assertNull(outbox.single().resolvesConflictId)
                        assertNull(outbox.single().attemptedAt)
                    }
                    val syncMeta = migrated.syncMetaDao().get(syncMetaKey)
                    assertEquals(17L, syncMeta?.cursor)
                    assertEquals(42L, syncMeta?.localVersion)
                    assertEquals(41L, syncMeta?.serverVersion)
                    assertEquals(updatedAt, syncMeta?.lastSuccessfulSync)
                } else {
                    assertEquals(0, migrated.syncOutboxDao().getAll().size)
                }
                // Conflicts
                if (startVersion >= 2) {
                    val conflicts = migrated.syncConflictDao().getAll()
                    assertEquals(1, conflicts.size)
                    assertEquals("conflict-$startVersion", conflicts.single().id)
                    assertEquals("tasks", conflicts.single().entityType)
                    assertEquals(entityId, conflicts.single().entityId)
                    assertEquals(localPayload, conflicts.single().localPayload)
                    assertEquals(serverPayload, conflicts.single().serverPayload)
                    assertEquals(43L, conflicts.single().serverVersion)
                    assertEquals("unresolved", conflicts.single().status)
                    assertEquals(updatedAt, conflicts.single().createdAt)
                    if (startVersion >= 3) {
                        assertEquals(mutationId, conflicts.single().mutationId)
                        assertEquals(deletedAt, conflicts.single().localDeletedAt)
                        assertEquals("[\"history\"]", conflicts.single().localHistory)
                        assertEquals(attemptedAt, conflicts.single().serverDeletedAt)
                    }
                } else {
                    assertEquals(0, migrated.syncConflictDao().getAll().size)
                }
                // Events
                if (startVersion >= 6) {
                    assertEquals(1, migrated.taskEventDao().getAll().size)
                    assertEquals("event-$startVersion", migrated.taskEventDao().getAll().single().id)
                    assertEquals(taskId, migrated.taskEventDao().getAll().single().taskId)
                    assertEquals(7000L, migrated.taskEventDao().getAll().single().createdAt)
                } else {
                    assertEquals(0, migrated.taskEventDao().getAll().size)
                    // Verify table is writable post-migration
                    migrated.taskEventDao().insert(
                        TaskEventEntity("event-$startVersion-new", taskId, "completed", "2026-08-27", "{}", 7000)
                    )
                    assertEquals(1, migrated.taskEventDao().getAll().size)
                }
                // Account binding
                if (startVersion >= 7) {
                    val account = migrated.localAccountDao().get()
                    assertNotNull(account)
                    assertEquals(ownerUserId, account!!.userId)
                    assertEquals(ownerUserId, UUID.fromString(account.userId).toString())
                } else {
                    assertNull(migrated.localAccountDao().get())
                    migrated.localAccountDao().insert(LocalAccountEntity(userId = "00000000-0000-4000-8000-000000000001"))
                    assertEquals("00000000-0000-4000-8000-000000000001", migrated.localAccountDao().get()?.userId)
                }
                if (startVersion >= 5) {
                    assertEquals("{}", migrated.rawCollectionDao().get("stats")?.payload)
                    assertEquals(updatedAt, migrated.rawCollectionDao().get("stats")?.updatedAt)
                    assertEquals(deletedAt, migrated.rawCollectionDao().get("stats")?.deletedAt)
                }
                // Verify 7->8 indices exist
                migrated.openHelper.readableDatabase.query("SELECT name FROM sqlite_master WHERE type='index' AND name='index_tasks_scheduledFor_schedulePrecision_status_deletedAt'").use { c ->
                    assertEquals(true, c.count > 0)
                }
            } finally {
                migrated.close()
                context.deleteDatabase(databaseName)
            }
        }
    }

    private fun stableUuid(value: Int): String =
        "00000000-0000-4000-8000-${value.toString().padStart(12, '0')}"
}
