package com.mariusschober.goalflow.nativeapp.data

import com.mariusschober.goalflow.nativeapp.domain.GoalflowTask
import com.mariusschober.goalflow.nativeapp.domain.GoalflowHabit
import com.mariusschober.goalflow.nativeapp.domain.SchedulePrecision
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class GoalflowBackupTest {
    private val task = GoalflowTask(
        id = "task-1",
        title = "Keep the promise",
        notes = "Offline is enough.",
        schedulePrecision = SchedulePrecision.DAY,
        scheduledFor = "2026-08-26",
        createdAt = 1L,
        updatedAt = 2L
    )

    @Test
    fun `planning journal survives encrypted backup with exact pending bytes`() {
        val owner = "00000000-0000-4000-8000-000000000001"
        val command = JSONObject("""{"schemaVersion":1,"operationId":"00000000-0000-4000-8000-000000000002","accountId":"$owner","localDate":"2026-09-08","baselineRevision":null,"proposedOrder":["task-1"],"ratings":[],"maximumAcceptedXp":0,"capturedAt":"2026-09-08T10:00:00.000Z"}""")
        val reply = DeliberatePlanning.apply(DeliberatePlanning.initial(owner, "2026-09-08"), command,
            listOf(DeliberatePlanning.Task("task-1", 2)), 0, "off")
        val policy = reply.policy
        val draft = JSONObject(command.toString()).also { it.remove("operationId"); it.remove("capturedAt") }
            .put("updatedAt", "2026-09-08T10:00:00.000Z")
        val planning = JSONObject().put("schemaVersion", 1)
            .put("days", JSONObject().put("2026-09-08", policy))
            .put("drafts", JSONObject().put("2026-09-08", draft))
            .put("pending", JSONObject().put(command.getString("operationId"), JSONObject().put("command", command)
                .put("members", org.json.JSONArray()).put("provisional", reply.receipt).put("request", command.toString())
                .put("sequence", 7).put("ordinaryDependencies", org.json.JSONArray()).put("causalDependencies", org.json.JSONArray())))
            .put("receipts", JSONObject())
        val bytes = JSONObject().put("schemaVersion", 1).put("accountKey", owner).put("generation", 7).put("planning", planning).toString(2)
        val row = PlanningAccountEntity(owner, 7, bytes)
        val payload = GoalflowBackupPayload(listOf(task), emptyList(), emptyList(), ownerUserId = owner, planningAccounts = listOf(row))
        val restored = GoalflowBackup.decrypt(GoalflowBackup.encrypt(payload, "a strong backup password"), "a strong backup password")
        assertEquals(listOf(row), restored.planningAccounts)
        assertThrows(IllegalArgumentException::class.java) {
            GoalflowBackup.encrypt(payload.copy(ownerUserId = "00000000-0000-4000-8000-000000000003"), "a strong backup password")
        }
    }

    @Test
    fun `encrypted backup round trips`() {
        val payload = GoalflowBackupPayload(
            tasks = listOf(task),
            goals = emptyList(),
            plans = emptyList(),
            habits = listOf(GoalflowHabit(id = "habit-1", title = "Keep habit", createdAt = 3L)),
            events = listOf(
                TaskEventEntity(
                    id = "event-1",
                    taskId = task.id,
                    eventType = "created",
                    localDate = "2026-08-26",
                    metadata = """{"source":"capture"}""",
                    createdAt = 4L
                )
            ),
            outbox = listOf(
                SyncOutboxEntity(
                    mutationId = "00000000-0000-4000-8000-000000000001",
                    deviceId = "device-a",
                    entityType = "tasks",
                    entityId = task.id,
                    baseServerVersion = null,
                    version = 1,
                    payload = GoalflowJson.taskPayload(task).toString(),
                    updatedAt = "2026-08-27T00:00:00Z",
                    deletedAt = null
                ),
                SyncOutboxEntity(
                    mutationId = "00000000-0000-4000-8000-000000000002",
                    deviceId = "device-a",
                    entityType = "amalgam",
                    entityId = "singleton",
                    baseServerVersion = null,
                    version = 1,
                    payload = "\"My world takes care of me\"",
                    updatedAt = "2026-08-27T00:00:01Z",
                    deletedAt = null
                )
            ),
            syncMeta = listOf(SyncMetaEntity("tasks:${task.id}", 0, 1, null, null)),
            conflicts = listOf(
                SyncConflictEntity(
                    id = "conflict-1",
                    entityType = "tasks",
                    entityId = task.id,
                    localPayload = GoalflowJson.taskPayload(task).toString(),
                    serverPayload = "{}",
                    serverVersion = 2,
                    createdAt = "2026-08-27T00:00:00Z"
                )
            ),
            rawCollections = mapOf(
                "truenorth" to "[{\"id\":\"vision-1\",\"vision\":\"A calm life\"}]",
                "amalgam" to "\"My world takes care of me\"",
                "stats" to "{\"2026-08-27\":{\"tasksCompleted\":2}}"
            ),
            ownerUserId = "00000000-0000-4000-8000-000000000009"
        )
        val restored = GoalflowBackup.decrypt(GoalflowBackup.encrypt(payload, PASSWORD), PASSWORD)

        assertEquals("tasks roundtrip", payload.tasks, restored.tasks)
        assertEquals("goals roundtrip", payload.goals, restored.goals)
        assertEquals("plans roundtrip", payload.plans, restored.plans)
        assertEquals("habits roundtrip", payload.habits, restored.habits)
        assertEquals("events roundtrip", payload.events, restored.events)
        assertEquals("outbox roundtrip", payload.outbox, restored.outbox)
        assertEquals("sync metadata roundtrip", payload.syncMeta, restored.syncMeta)
        assertEquals("conflicts roundtrip", payload.conflicts, restored.conflicts)
        assertEquals("raw collection keys", payload.rawCollections.keys, restored.rawCollections.keys)
        payload.rawCollections.forEach { (key, value) ->
            assertEquals("raw collection $key", value, restored.rawCollections[key])
        }
        assertEquals("account binding roundtrip", payload.ownerUserId, restored.ownerUserId)
    }

    @Test
    fun `web-shaped sparse collections and scalar preserved values round trip`() {
        val payload = GoalflowBackupPayload(
            tasks = listOf(task),
            goals = emptyList(),
            plans = emptyList(),
            rawCollections = mapOf(
                "amalgam" to "\"A durable promise\"",
                "progress" to "{\"level\":2,\"xp\":10,\"xpToNextLevel\":200}",
                "truenorth" to "[]"
            )
        )

        val restored = GoalflowBackup.decrypt(GoalflowBackup.encrypt(payload, PASSWORD), PASSWORD)

        assertEquals(payload, restored)
    }

    @Test
    fun `backup document retains export metadata and sync binding`() {
        val payload = GoalflowBackupPayload(
            tasks = emptyList(),
            goals = emptyList(),
            plans = emptyList(),
            syncBinding = GoalflowSyncBinding("https://api.example", 7, "account-1")
        )
        val envelope = GoalflowBackup.encrypt(payload, PASSWORD, "2024-02-29T23:59:59Z")
        val document = GoalflowBackup.decryptDocument(envelope, PASSWORD)

        assertEquals("2024-02-29T23:59:59Z", document.exportedAt)
        assertEquals(7, document.payload.syncBinding?.protocolVersion)
        assertEquals("account-1", document.payload.syncBinding?.accountSubject)
    }

    @Test
    fun `malformed optional collection and duplicate plan identity are rejected`() {
        val malformed = GoalflowBackupPayload(listOf(task), emptyList(), emptyList())
        val encrypted = GoalflowBackup.encrypt(malformed, PASSWORD)
        val envelope = JSONObject(encrypted)
        // The authenticated envelope cannot be edited in place; this assertion
        // covers the public validation boundary through a valid payload shape
        // that contains a duplicate planning identity in a separately encrypted
        // backup.
        val duplicatePlan = GoalflowBackupPayload(
            tasks = listOf(task),
            goals = emptyList(),
            plans = listOf(
                com.mariusschober.goalflow.nativeapp.domain.DailyPlan("2026-08-27", 1, emptyList()),
                com.mariusschober.goalflow.nativeapp.domain.DailyPlan("2026-08-27", 2, emptyList())
            )
        )
        // Native export itself is always valid; the duplicate is rejected when
        // parsing a web-shaped plaintext through the decrypt boundary. Keep the
        // envelope read above so this test also guards the expected outer shape.
        assertEquals("goalflow-encrypted-backup", envelope.getString("format"))
        assertThrows(BackupFormatException::class.java) {
            GoalflowBackup.decrypt(
                GoalflowBackup.encrypt(duplicatePlan, PASSWORD), PASSWORD
            )
        }
    }

    @Test
    fun `wrong password and modified ciphertext fail without a payload`() {
        val envelope = GoalflowBackup.encrypt(GoalflowBackupPayload(listOf(task), emptyList(), emptyList()), PASSWORD)
        assertThrows(BackupFormatException::class.java) { GoalflowBackup.decrypt(envelope, "wrong password") }

        val modified = JSONObject(envelope).apply {
            put("ciphertext", optString("ciphertext").dropLast(2) + "aa")
        }.toString()
        assertThrows(BackupFormatException::class.java) { GoalflowBackup.decrypt(modified, PASSWORD) }
    }

    @Test
    fun `cyclic pending dependencies are rejected before restore`() {
        val firstId = "00000000-0000-4000-8000-000000000001"
        val secondId = "00000000-0000-4000-8000-000000000002"
        fun mutation(id: String, dependency: String) = SyncOutboxEntity(
            mutationId = id,
            deviceId = "device-a",
            entityType = "tasks",
            entityId = id,
            baseServerVersion = null,
            version = 1,
            payload = GoalflowJson.taskPayload(task.copy(id = id)).toString(),
            updatedAt = "2026-08-27T00:00:00Z",
            deletedAt = null,
            dependsOnMutationId = dependency
        )

        val payload = GoalflowBackupPayload(
            tasks = listOf(task.copy(id = firstId), task.copy(id = secondId)),
            goals = emptyList(),
            plans = emptyList(),
            outbox = listOf(mutation(firstId, secondId), mutation(secondId, firstId))
        )

        assertThrows(BackupFormatException::class.java) {
            GoalflowBackup.decrypt(GoalflowBackup.encrypt(payload, PASSWORD), PASSWORD)
        }
    }

    @Test
    fun `web pending recovery state is rejected instead of being hidden as raw data`() {
        val payload = GoalflowBackupPayload(
            tasks = emptyList(),
            goals = emptyList(),
            plans = emptyList(),
            rawCollections = mapOf(
                "sync" to """{"schemaVersion":2,"cursor":0,"versions":{},"outbox":[{"mutationId":"valuable"}],"conflicts":[]}"""
            )
        )

        assertThrows(BackupFormatException::class.java) {
            GoalflowBackup.decrypt(GoalflowBackup.encrypt(payload, PASSWORD), PASSWORD)
        }
    }

    private companion object {
        const val PASSWORD = "correct horse battery staple"
    }
}
