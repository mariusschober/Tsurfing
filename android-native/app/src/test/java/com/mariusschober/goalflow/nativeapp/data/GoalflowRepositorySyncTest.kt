package com.mariusschober.goalflow.nativeapp.data

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.mariusschober.goalflow.nativeapp.domain.SchedulePrecision
import com.mariusschober.goalflow.nativeapp.domain.HabitFrequency
import com.mariusschober.goalflow.nativeapp.domain.GoalflowCircadianState
import com.mariusschober.goalflow.nativeapp.domain.TaskStatus
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.flow.first
import org.json.JSONArray
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.nio.ByteBuffer
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.time.Instant
import java.time.LocalDate
import java.time.Clock
import java.time.ZoneId
import java.util.UUID
import com.mariusschober.goalflow.nativeapp.time.FixedGoalflowTimeProvider

@RunWith(RobolectricTestRunner::class)
class GoalflowRepositorySyncTest {
    private lateinit var database: GoalflowDatabase
    private lateinit var repository: GoalflowRepository

    @Before
    fun setUp() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        database = Room.inMemoryDatabaseBuilder(context, GoalflowDatabase::class.java)
            .allowMainThreadQueries()
            .build()
        repository = GoalflowRepository(database, deviceId = "device-a")
    }

    @After
    fun tearDown() {
        database.close()
    }

    @Test
    fun `task write and outbox insertion share one transaction`() = runTest {
        val task = repository.createTask(
            title = "Never lose this",
            notes = "",
            schedulePrecision = SchedulePrecision.DAY,
            scheduledFor = LocalDate.now().toString(),
            scheduledTime = null,
            isFrog = false
        )

        assertNotNull(database.taskDao().get(task.id))
        val pending = repository.pendingSyncMutations().filter { it.entityType == "tasks" }
        assertEquals(1, pending.size)
        assertEquals(task.id, pending.single().entityId)
        assertEquals("Never lose this", org.json.JSONObject(pending.single().payload).getString("title"))
    }

    @Test
    fun `repository uses injected local zone for date-sensitive transitions`() = runTest {
        val provider = FixedGoalflowTimeProvider(
            Clock.fixed(Instant.parse("2024-02-29T23:59:59Z"), ZoneId.of("UTC")),
            ZoneId.of("Pacific/Kiritimati")
        )
        val clockedRepository = GoalflowRepository(database, deviceId = "clocked", timeProvider = provider)
        val today = provider.today().toString()
        val task = clockedRepository.createTask("Leap-day boundary", "", SchedulePrecision.DAY, today, null, false)
        clockedRepository.confirmPlan(today, listOf(task.id))
        clockedRepository.completeTask(task.id)

        assertEquals("2024-03-01", today)
        assertEquals("2024-03-01", database.taskEventDao().getAll().last().localDate)
        assertTrue(database.rawCollectionDao().get("stats")!!.payload.contains("2024-03-01"))
    }

    @Test
    fun `capture keeps duration and goal linkage in the local and sync records`() = runTest {
        val goal = repository.createGoal("A real direction", "")
        val task = repository.createTask(
            title = "Make the next move",
            notes = "",
            schedulePrecision = SchedulePrecision.DAY,
            scheduledFor = LocalDate.now().toString(),
            scheduledTime = null,
            isFrog = false,
            goalId = goal.id,
            duration = 45
        )

        assertEquals(goal.id, database.taskDao().get(task.id)?.goalId)
        assertEquals(45, org.json.JSONObject(database.taskDao().get(task.id)!!.extraJson).getInt("duration"))
        val payload = org.json.JSONObject(repository.pendingSyncMutations().first { it.entityId == task.id }.payload)
        assertEquals(goal.id, payload.getString("goalId"))
        assertEquals(45, payload.getInt("duration"))
    }

    @Test
    fun `goal creation keeps deadline and priority fields in local and sync records`() = runTest {
        val goal = repository.createGoal(
            name = "Ship the next chapter",
            description = "One clear direction.",
            deadline = "2026-09-15",
            excitement = 8,
            roi = 7
        )

        val stored = database.goalDao().get(goal.id)
        assertEquals("2026-09-15", stored?.deadline)
        assertEquals(8, stored?.excitement)
        assertEquals(7, stored?.roi)
        val payload = org.json.JSONObject(repository.pendingSyncMutations().single().payload)
        assertEquals("2026-09-15", payload.getString("deadline"))
        assertEquals(8, payload.getInt("excitement"))
        assertEquals(7, payload.getInt("roi"))
    }

    @Test
    fun `habit instances use shared weekday convention and deterministic identity`() = runTest {
        val habit = repository.createHabit(
            title = "Sunday reset",
            frequency = HabitFrequency.SPECIFIC_DAYS,
            specificDays = setOf(0)
        )

        val first = repository.generateHabitInstance(habit.id, "2026-08-23")
        val second = repository.generateHabitInstance(habit.id, "2026-08-23")

        assertEquals(uuidV5("${habit.id}:2026-08-23"), first?.id)
        assertEquals(first?.id, second?.id)
        assertEquals(1, database.taskDao().getAll().size)
        val pending = repository.pendingSyncMutations().filter { it.entityType != "task_events" }
        assertEquals(3, pending.size)
        assertEquals(
            mapOf("habits" to 1, "progress" to 1, "tasks" to 1),
            pending.groupingBy { it.entityType }.eachCount()
        )
        assertEquals(1, repository.pendingSyncMutations().count { it.entityType == "task_events" })
    }

    @Test
    fun `database rejects duplicate active habit days at the storage boundary`() = runTest {
        GoalflowDatabase.installActiveHabitDayUniqueness(database.openHelper.writableDatabase)
        val habit = repository.createHabit("Storage guarded habit")
        val today = LocalDate.now().toString()
        val first = repository.generateHabitInstance(habit.id, today)
            ?: error("A daily habit should generate an instance")
        val duplicate = database.taskDao().get(first.id)!!.copy(id = "duplicate-habit-instance")

        try {
            database.taskDao().insert(duplicate)
            fail("The database trigger must reject a duplicate active habit day")
        } catch (_: Exception) {
            // SQLite aborts the insert before a second active instance exists.
        }
        assertEquals(1, database.taskDao().getAll().count { it.habitId == habit.id && it.deletedAt == null })
    }

    @Test
    fun `habit generation failure is durable and retryable`() = runTest {
        val habit = repository.createHabit("Collision habit")
        val today = LocalDate.now().toString()
        database.taskDao().insert(
            TaskEntity(
                id = uuidV5("${habit.id}:$today"),
                title = "Different record",
                notes = "",
                schedulePrecision = SchedulePrecision.DAY.name,
                scheduledFor = today,
                scheduledTime = null,
                plannedOrder = 0,
                status = TaskStatus.OPEN.name,
                isFrog = false,
                beforeFrog = false,
                frogFailures = 0,
                source = "MANUAL",
                goalId = null,
                parentTaskId = null,
                habitId = "another-habit",
                createdAt = 1L,
                updatedAt = 1L,
                completedAt = null,
                deletedAt = null
            )
        )

        repeat(2) {
            try {
                repository.generateHabitInstance(habit.id, today)
                fail("Expected the deterministic identity collision to remain visible")
            } catch (expected: IllegalArgumentException) {
                assertTrue(expected.message.orEmpty().contains("already belongs"))
            }
        }

        val health = repository.habitGenerationHealthStream.first().single()
        assertEquals(HabitGenerationStatus.FAILED, health.status)
        assertEquals(2, health.attemptCount)
        assertTrue(health.errorMessage.orEmpty().contains("already belongs"))
    }

    @Test
    fun `completion updates linked goal and habit atomically`() = runTest {
        val goal = repository.createGoal("Ship the work", "One deliberate step.")
        val habit = repository.createHabit("Daily anchor", goalId = goal.id)
        val task = repository.generateHabitInstance(habit.id, LocalDate.now().toString())
            ?: error("A daily habit should generate an instance")

        repository.completeTask(task.id)

        assertEquals(1, database.goalDao().get(goal.id)?.completedTasks)
        assertEquals(1, database.habitDao().get(habit.id)?.streak)
        assertEquals(LocalDate.now().toString(), database.habitDao().get(habit.id)?.lastCompletedDate)
        assertEquals(11, repository.pendingSyncMutations().size)
        assertEquals(
            mapOf("goals" to 2, "habits" to 2, "tasks" to 2, "progress" to 2, "stats" to 1, "task_events" to 2),
            repository.pendingSyncMutations().groupingBy { it.entityType }.eachCount()
        )
        val stats = org.json.JSONObject(database.rawCollectionDao().get("stats")!!.payload)
            .getJSONObject(LocalDate.now().toString())
        assertEquals(1, stats.getInt("tasksCompleted"))
        assertEquals(25, stats.getInt("timeFocused"))
        val progress = org.json.JSONObject(database.rawCollectionDao().get("progress")!!.payload)
        assertEquals(2, progress.getInt("level"))
        assertEquals(27, progress.getInt("xp"))
    }

    @Test
    fun `blank completion note does not erase the existing task notes`() = runTest {
        val task = repository.createTask(
            title = "Keep the context",
            notes = "Important context",
            schedulePrecision = SchedulePrecision.DAY,
            scheduledFor = LocalDate.now().toString(),
            scheduledTime = null,
            isFrog = false
        )

        repository.completeTask(task.id, finalDescription = "   ")

        assertEquals("Important context", database.taskDao().get(task.id)?.notes)
    }

    @Test
    fun `malformed optional stats does not block local completion`() = runTest {
        val task = repository.createTask(
            title = "Complete despite old projection",
            notes = "",
            schedulePrecision = SchedulePrecision.DAY,
            scheduledFor = LocalDate.now().toString(),
            scheduledTime = null,
            isFrog = false
        )
        database.rawCollectionDao().insert(
            RawCollectionEntity(
                entityType = "stats",
                payload = "not-json",
                updatedAt = Instant.now().toString(),
                deletedAt = null
            )
        )

        repository.completeTask(task.id)

        assertEquals("COMPLETED", database.taskDao().get(task.id)?.status)
        assertEquals("not-json", database.rawCollectionDao().get("stats")?.payload)
        assertEquals(60, org.json.JSONObject(database.rawCollectionDao().get("progress")!!.payload).getInt("xp"))
    }

    @Test
    fun `completion undo restores task and linked projections atomically`() = runTest {
        val goal = repository.createGoal("Undoable direction", "")
        val habit = repository.createHabit("Undoable habit", goalId = goal.id)
        val task = repository.generateHabitInstance(habit.id, LocalDate.now().toString())
            ?: error("A daily habit should generate an instance")

        repository.completeTask(task.id, actualDuration = 12, flowState = "flow")
        repository.undoCompletion(task.id)

        assertEquals("OPEN", database.taskDao().get(task.id)?.status)
        assertEquals(null, database.taskDao().get(task.id)?.completedAt)
        assertEquals(0, database.goalDao().get(goal.id)?.completedTasks)
        assertEquals(0, database.habitDao().get(habit.id)?.streak)
        assertEquals(null, database.habitDao().get(habit.id)?.lastCompletedDate)
        assertEquals(null, database.rawCollectionDao().get("stats"))
        val progress = org.json.JSONObject(database.rawCollectionDao().get("progress")!!.payload)
        assertEquals(1, progress.getInt("level"))
        assertEquals(50, progress.getInt("xp"))
        assertTrue(!org.json.JSONObject(database.taskDao().get(task.id)!!.extraJson).has("__goalflowCompletionUndo"))
    }

    @Test
    fun `circadian check in preserves state and records today's stats atomically`() = runTest {
        repository.updateCircadian(
            GoalflowCircadianState(
                lastCheckIn = LocalDate.now().toString(),
                score = 90,
                mode = "apex",
                sunriseTime = "06:12",
                sunsetTime = "20:31",
                solarNoonTime = "13:21",
                sunrise = true,
                sleepHours = 8,
                energy = 9,
                clarity = 8,
                interest = 7,
                wakeTime = "07:00",
                eatingWindow = 10,
                firstMealTime = "08:00"
            )
        )

        val circadian = org.json.JSONObject(database.rawCollectionDao().get("circadian")!!.payload)
        assertEquals("apex", circadian.getString("mode"))
        assertEquals("07:00", circadian.getJSONObject("metrics").getString("wakeTime"))
        val stats = org.json.JSONObject(database.rawCollectionDao().get("stats")!!.payload)
            .getJSONObject(LocalDate.now().toString())
        assertEquals(90, stats.getInt("circadianScore"))
        assertEquals(true, stats.getJSONObject("bioLog").getBoolean("sunrise"))

        repository.resetCircadian()
        assertEquals("", org.json.JSONObject(database.rawCollectionDao().get("circadian")!!.payload).getString("lastCheckIn"))
    }

    @Test
    fun `invalid circadian input leaves the existing record untouched`() = runTest {
        val original = """
            {"lastCheckIn":"2026-08-28","score":70,"mode":"maintenance","metrics":{"energy":7,"custom":"keep"}}
        """.trimIndent()
        database.rawCollectionDao().insert(
            RawCollectionEntity(
                entityType = "circadian",
                payload = original,
                updatedAt = Instant.now().toString(),
                deletedAt = null
            )
        )

        try {
            repository.updateCircadian(
                GoalflowCircadianState(
                    lastCheckIn = LocalDate.now().toString(),
                    score = 70,
                    mode = "maintenance",
                    energy = 7,
                    clarity = 7,
                    interest = 7,
                    wakeTime = "25:90"
                )
            )
            fail("Invalid clock input must be rejected")
        } catch (_: IllegalArgumentException) {
            // The record remains authoritative.
        }

        assertEquals(original, database.rawCollectionDao().get("circadian")?.payload)
    }

    @Test
    fun `room-backed move uses the latest order and invalidates a confirmed plan`() = runTest {
        val today = LocalDate.now().toString()
        val first = repository.createTask("First", "", SchedulePrecision.DAY, today, null, false)
        val second = repository.createTask("Second", "", SchedulePrecision.DAY, today, null, false)
        repository.confirmPlan(today, listOf(first.id, second.id))

        val moved = repository.moveToday(today, second.id, -1)
        val movedAgain = repository.moveToday(today, second.id, 1)

        assertEquals(
            "first move previousIds=${moved?.previousIds}",
            listOf(first.id, second.id),
            moved?.previousIds
        )
        assertEquals(
            "first move orderedIds=${moved?.orderedIds}",
            listOf(second.id, first.id),
            moved?.orderedIds
        )
        assertTrue("first move hadConfirmedPlan=${moved?.hadConfirmedPlan}", moved?.hadConfirmedPlan == true)
        assertEquals(
            "second move previousIds=${movedAgain?.previousIds}",
            listOf(second.id, first.id),
            movedAgain?.previousIds
        )
        assertEquals("daily plan after move=${database.dailyPlanDao().get(today)}", null, database.dailyPlanDao().get(today))
        assertEquals(listOf(first.id, second.id), database.taskDao().getAll()
            .filter { it.scheduledFor == today }
            .sortedBy { it.plannedOrder }
            .map { it.id })
    }

    private fun uuidV5(name: String): String {
        val namespace = UUID.fromString("c3e4bcbb-9f56-4ff5-a3a8-9f7478284169")
        val namespaceBytes = ByteBuffer.allocate(16)
            .putLong(namespace.mostSignificantBits)
            .putLong(namespace.leastSignificantBits)
            .array()
        val digest = MessageDigest.getInstance("SHA-1")
            .digest(namespaceBytes + name.toByteArray(StandardCharsets.UTF_8))
        digest[6] = ((digest[6].toInt() and 0x0f) or 0x50).toByte()
        digest[8] = ((digest[8].toInt() and 0x3f) or 0x80).toByte()
        val bytes = ByteBuffer.wrap(digest)
        return UUID(bytes.long, bytes.long).toString()
    }

    @Test
    fun `accepted creation promotes completion and rejection preserves completion conflict`() = runTest {
        val task = repository.createTask(
            title = "Complete once",
            notes = "",
            schedulePrecision = SchedulePrecision.DAY,
            scheduledFor = LocalDate.now().toString(),
            scheduledTime = null,
            isFrog = false
        )
        repository.completeTask(task.id)
        val create = repository.readySyncMutations().single { it.entityType == "tasks" }
        repository.commitPushResults(
            listOf(create),
            listOf(accepted(create, 10))
        )

        val completion = repository.readySyncMutations().single { it.entityType == "tasks" }
        assertEquals(10L, completion.baseServerVersion)
        repository.commitPushResults(
            listOf(completion),
            listOf(
                NativePushResult(
                    completion.mutationId,
                    accepted = false,
                    serverVersion = 11,
                    conflictId = "conflict-1",
                    serverPayload = create.payload
                )
            )
        )

        assertTrue(repository.pendingSyncMutations().none { it.entityType == "tasks" && it.entityId == task.id })
        assertTrue(repository.pendingSyncMutations().any { it.entityType == "task_events" && it.entityId.isNotBlank() })
        val conflict = database.syncConflictDao().getAll().single()
        assertEquals(task.id, conflict.entityId)
        assertEquals(1, JSONArray(conflict.localHistory).length())
        assertTrue(org.json.JSONObject(conflict.localPayload).getBoolean("completed"))
    }

    @Test
    fun `scalar collection rejection is preserved as a recoverable conflict`() = runTest {
        repository.updateAmalgam("valuable local thought")
        val mutation = repository.readySyncMutations().single()

        repository.commitPushResults(
            listOf(mutation),
            listOf(NativePushResult(
                mutationId = mutation.mutationId,
                accepted = false,
                serverVersion = 4,
                conflictId = "scalar-conflict",
                serverPayload = "\"valuable cloud thought\""
            ))
        )

        assertTrue(repository.pendingSyncMutations().isEmpty())
        val conflict = database.syncConflictDao().get("scalar-conflict")
        assertEquals("\"valuable local thought\"", conflict?.localPayload)
        assertEquals("\"valuable cloud thought\"", conflict?.serverPayload)
        assertEquals(
            "valuable local thought",
            JSONArray(conflict?.localHistory).getJSONObject(0).getString("payload")
        )
    }

    @Test
    fun `later local edit keeps the server conflict mutation identity stable`() = runTest {
        val task = repository.createTask(
            title = "First local side",
            notes = "",
            schedulePrecision = SchedulePrecision.DAY,
            scheduledFor = LocalDate.now().toString(),
            scheduledTime = null,
            isFrog = false
        )
        val original = repository.readySyncMutations().single { it.entityId == task.id }
        val conflictId = "99999999-9999-4999-8999-999999999998"
        repository.commitPushResults(
            listOf(original),
            listOf(NativePushResult(
                mutationId = original.mutationId,
                accepted = false,
                serverVersion = 9,
                conflictId = conflictId,
                serverPayload = "{\"id\":\"${task.id}\",\"title\":\"Cloud side\"}"
            ))
        )

        repository.updateTask(
            id = task.id,
            title = "Second local side",
            notes = task.notes,
            schedulePrecision = task.schedulePrecision,
            scheduledFor = task.scheduledFor,
            scheduledTime = task.scheduledTime,
            isFrog = task.isFrog,
            goalId = task.goalId
        )

        val stored = database.syncConflictDao().get(conflictId)!!
        assertEquals(original.mutationId, stored.mutationId)
        assertEquals(2, JSONArray(stored.localHistory).length())
        assertEquals(0, repository.mergeServerConflicts(listOf(NativeServerConflict(
            id = conflictId,
            entityType = "tasks",
            entityId = task.id,
            mutationId = original.mutationId,
            localPayload = original.payload,
            localDeletedAt = original.deletedAt,
            localVersion = original.version,
            localUpdatedAt = original.updatedAt,
            serverPayload = "{\"id\":\"${task.id}\",\"title\":\"Cloud side\"}",
            serverDeletedAt = null,
            serverVersion = 9,
            serverMissing = false,
            createdAt = stored.createdAt
        ))))
    }

    @Test
    fun `pull conflict is stored before cursor advances`() = runTest {
        val local = repository.createTask(
            title = "Local version",
            notes = "",
            schedulePrecision = SchedulePrecision.DAY,
            scheduledFor = LocalDate.now().toString(),
            scheduledTime = null,
            isFrog = false
        )
        val remote = local.copy(title = "Remote version", updatedAt = local.updatedAt + 1)
        val conflicts = repository.applyRemotePage(
            listOf(
                NativeRemoteRecord(
                    entityType = "tasks",
                    entityId = local.id,
                    version = 2,
                    serverVersion = 20,
                    deviceId = "device-b",
                    payload = GoalflowJson.taskPayload(remote).toString(),
                    updatedAt = Instant.now().toString(),
                    deletedAt = null
                )
            ),
            nextCursor = 20
        )

        assertEquals(1, conflicts)
        assertTrue(repository.pendingSyncMutations().none { it.entityType == "tasks" && it.entityId == local.id })
        assertTrue(repository.pendingSyncMutations().any { it.entityType == "task_events" })
        assertEquals(20L, repository.syncMetadata("_cursor")?.cursor)
        val stored = database.syncConflictDao().getAll().single()
        assertEquals("Local version", org.json.JSONObject(stored.localPayload).getString("title"))
        assertEquals("Remote version", org.json.JSONObject(stored.serverPayload).getString("title"))
    }

    @Test
    fun `same-device pending mutation is preserved before pull cursor advances`() = runTest {
        val local = repository.createTask(
            title = "Pending on this installation",
            notes = "",
            schedulePrecision = SchedulePrecision.DAY,
            scheduledFor = LocalDate.now().toString(),
            scheduledTime = null,
            isFrog = false
        )
        val remote = local.copy(title = "Earlier server state", updatedAt = local.updatedAt + 1)

        repository.applyRemotePage(
            listOf(
                NativeRemoteRecord(
                    "tasks", local.id, 1, 22, "device-a",
                    GoalflowJson.taskPayload(remote).toString(), Instant.now().toString(), null
                )
            ),
            22
        )

        assertTrue(repository.pendingSyncMutations().none { it.entityType == "tasks" && it.entityId == local.id })
        assertTrue(repository.pendingSyncMutations().any { it.entityType == "task_events" })
        val conflict = database.syncConflictDao().getAll().single()
        assertEquals("Pending on this installation", org.json.JSONObject(conflict.localPayload).getString("title"))
        assertEquals("Earlier server state", org.json.JSONObject(conflict.serverPayload).getString("title"))
        assertEquals(22L, repository.syncMetadata("_cursor")?.cursor)
    }

    @Test
    fun `open conflict retains the newest remote side without replacing local data`() = runTest {
        val local = repository.createTask(
            title = "Local side",
            notes = "",
            schedulePrecision = SchedulePrecision.DAY,
            scheduledFor = LocalDate.now().toString(),
            scheduledTime = null,
            isFrog = false
        )
        fun remote(title: String, version: Long) = NativeRemoteRecord(
            "tasks", local.id, version, version, "device-b",
            GoalflowJson.taskPayload(local.copy(title = title, updatedAt = local.updatedAt + version)).toString(),
            Instant.now().toString(), null
        )

        repository.applyRemotePage(listOf(remote("Cloud one", 30)), 30)
        repository.applyRemotePage(listOf(remote("Cloud two", 31)), 31)

        assertEquals("Local side", database.taskDao().get(local.id)?.title)
        val conflict = database.syncConflictDao().getAll().single()
        assertEquals("Cloud two", org.json.JSONObject(conflict.serverPayload).getString("title"))
        assertEquals(31L, conflict.serverVersion)
        assertEquals(31L, repository.syncMetadata("_cursor")?.cursor)
    }

    @Test
    fun `stale pull page and invalid acceptance cannot consume durable state`() = runTest {
        val task = repository.createTask(
            title = "Still pending",
            notes = "",
            schedulePrecision = SchedulePrecision.DAY,
            scheduledFor = LocalDate.now().toString(),
            scheduledTime = null,
            isFrog = false
        )
        val mutation = repository.readySyncMutations().single { it.entityType == "tasks" }
        try {
            repository.commitPushResults(
                listOf(mutation),
                listOf(NativePushResult(mutation.mutationId, accepted = true, serverVersion = 0))
            )
            fail("An invalid acceptance must not be committed")
        } catch (_: IllegalArgumentException) {
            // Pending state remains authoritative.
        }
        assertEquals(
            mutation.mutationId,
            repository.pendingSyncMutations().single { it.entityType == "tasks" }.mutationId
        )
        try {
            repository.commitPushResults(
                listOf(mutation),
                listOf(accepted(mutation, 1).copy(recordDeviceId = "device-b"))
            )
            fail("An acceptance for another device must not be committed")
        } catch (_: IllegalArgumentException) {
            // The exact local mutation remains pending.
        }
        assertEquals(
            mutation.mutationId,
            repository.pendingSyncMutations().single { it.entityType == "tasks" }.mutationId
        )

        val remote = task.copy(title = "Remote", updatedAt = task.updatedAt + 1)
        repository.applyRemotePage(
            listOf(NativeRemoteRecord(
                "tasks", "another-task", 1, 40, "device-b",
                GoalflowJson.taskPayload(remote.copy(id = "another-task")).toString(), Instant.now().toString(), null
            )),
            40
        )
        try {
            repository.applyRemotePage(
                listOf(NativeRemoteRecord(
                    "tasks", "stale-task", 1, 40, "device-b",
                    GoalflowJson.taskPayload(remote.copy(id = "stale-task")).toString(), Instant.now().toString(), null
                )),
                40
            )
            fail("A stale remote page must not be applied")
        } catch (_: IllegalArgumentException) {
            // Cursor and canonical data remain unchanged.
        }
        assertEquals(40L, repository.syncMetadata("_cursor")?.cursor)
        assertEquals(null, database.taskDao().get("stale-task"))
    }

    @Test
    fun `different-task pull applies without disturbing local pending task`() = runTest {
        repository.createTask(
            title = "Offline A",
            notes = "",
            schedulePrecision = SchedulePrecision.DAY,
            scheduledFor = LocalDate.now().toString(),
            scheduledTime = null,
            isFrog = false
        )
        val remote = com.mariusschober.goalflow.nativeapp.domain.GoalflowTask(
            id = "00000000-0000-4000-8000-000000000002",
            title = "Device B",
            schedulePrecision = SchedulePrecision.DAY,
            scheduledFor = LocalDate.now().toString(),
            createdAt = 1,
            updatedAt = 2
        )

        val conflicts = repository.applyRemotePage(
            listOf(
                NativeRemoteRecord(
                    "tasks", remote.id, 1, 21, "device-b",
                    GoalflowJson.taskPayload(remote).toString(), Instant.now().toString(), null
                )
            ),
            21
        )

        assertEquals(0, conflicts)
        assertEquals(1, repository.pendingSyncMutations().count { it.entityType == "tasks" })
        assertEquals("Device B", database.taskDao().get(remote.id)?.title)
    }

    @Test
    fun `local Room data can never synchronize into a second account`() = runTest {
        val task = repository.createTask(
            title = "Account A data",
            notes = "",
            schedulePrecision = SchedulePrecision.DAY,
            scheduledFor = LocalDate.now().toString(),
            scheduledTime = null,
            isFrog = false
        )
        // A task creation durably enqueues both the task record and its creation event.
        // Both must remain pending and bound to the first account; the count distinguishes
        // a real data-ownership defect from an obsolete single-record expectation.
        val pendingBeforeBind = repository.pendingSyncMutations()
        assertEquals(2, pendingBeforeBind.size)
        assertEquals(1, pendingBeforeBind.count { it.entityType == "tasks" && it.entityId == task.id })
        assertEquals(1, pendingBeforeBind.count { it.entityType == "task_events" })
        repository.bindSyncAccount("00000000-0000-4000-8000-000000000001")

        try {
            repository.bindSyncAccount("00000000-0000-4000-8000-000000000002")
            fail("Cross-account synchronization must stop")
        } catch (_: NativeSyncAccountMismatch) {
            // Existing data and pending mutations remain untouched.
        }

        val pendingAfterFailedBind = repository.pendingSyncMutations()
        assertEquals(2, pendingAfterFailedBind.size)
        assertEquals(
            setOf("tasks" to task.id, "task_events" to pendingAfterFailedBind.first { it.entityType == "task_events" }.entityId),
            pendingAfterFailedBind.map { it.entityType to it.entityId }.toSet()
        )
        assertEquals(task.title, database.taskDao().get(task.id)?.title)
        assertEquals(
            "00000000-0000-4000-8000-000000000001",
            database.localAccountDao().get()?.userId
        )
    }

    @Test
    fun `server-only conflict hydration durably preserves both sides`() = runTest {
        val localPayload = "{\"id\":\"valuable-task\",\"title\":\"newer pre-restore version\"}"
        val serverPayload = "{\"id\":\"valuable-task\",\"title\":\"restored version\"}"
        val inserted = repository.mergeServerConflicts(listOf(NativeServerConflict(
            id = "99999999-9999-4999-8999-999999999999",
            entityType = "tasks",
            entityId = "valuable-task",
            mutationId = "88888888-8888-4888-8888-888888888888",
            localPayload = localPayload,
            localDeletedAt = null,
            localVersion = 7,
            localUpdatedAt = "2026-08-26T00:00:00Z",
            serverPayload = serverPayload,
            serverDeletedAt = null,
            serverVersion = 12,
            serverMissing = false,
            createdAt = "2026-08-27T00:00:00Z"
        )))

        assertEquals(1, inserted)
        val conflict = database.syncConflictDao().get("99999999-9999-4999-8999-999999999999")
        assertNotNull(conflict)
        assertEquals(localPayload, conflict?.localPayload)
        assertEquals(serverPayload, conflict?.serverPayload)
        assertTrue(conflict?.localHistory.orEmpty().contains("88888888-8888-4888-8888-888888888888"))
    }

    @Test
    fun `conflict id collision rolls back every acknowledgement`() = runTest {
        repeat(2) { index ->
            repository.createTask(
                title = "Collision $index",
                notes = "",
                schedulePrecision = SchedulePrecision.DAY,
                scheduledFor = LocalDate.now().toString(),
                scheduledTime = null,
                isFrog = false
            )
        }
        val batch = repository.readySyncMutations()

        try {
            repository.commitPushResults(
                batch,
                batch.mapIndexed { index, mutation ->
                    NativePushResult(
                        mutationId = mutation.mutationId,
                        accepted = false,
                        serverVersion = index + 1L,
                        conflictId = "same-conflict-id",
                        serverPayload = mutation.payload
                    )
                }
            )
            fail("Expected the conflict identity collision to abort")
        } catch (_: Exception) {
            // Room must roll the complete transaction back.
        }

        assertEquals(2, repository.pendingSyncMutations().count { it.entityType == "tasks" })
        assertTrue(database.syncConflictDao().getAll().isEmpty())
    }

    @Test
    fun `legacy snapshot outbox expands deterministically into record mutations`() = runTest {
        val legacyId = "5a09cfb8-d178-49ee-8aab-ed8e04c51527"
        database.syncOutboxDao().insert(
            SyncOutboxEntity(
                mutationId = legacyId,
                deviceId = "old-device",
                entityType = "tasks",
                entityId = "singleton",
                baseServerVersion = 3,
                version = 4,
                payload = """[{"id":"a","title":"A"},{"id":"b","title":"B"}]""",
                updatedAt = Instant.now().toString(),
                deletedAt = null
            )
        )

        val first = repository.readySyncMutations()
        val second = repository.readySyncMutations()
        assertEquals(listOf("a", "b"), first.map { it.entityId }.sorted())
        assertEquals(first.map { it.mutationId }.sorted(), second.map { it.mutationId }.sorted())
        assertTrue(first.all { it.baseServerVersion == null })
    }

    @Test
    fun `merge restore aborts instead of choosing between same-id task versions`() = runTest {
        val task = repository.createTask(
            title = "Local version",
            notes = "",
            schedulePrecision = SchedulePrecision.DAY,
            scheduledFor = LocalDate.now().toString(),
            scheduledTime = null,
            isFrog = false
        )
        val envelope = GoalflowBackup.encrypt(
            GoalflowBackupPayload(
                tasks = listOf(task.copy(title = "Backup version")),
                goals = emptyList(),
                plans = emptyList()
            ),
            "strong-password"
        )

        try {
            repository.restoreBackup(envelope, "strong-password", BackupRestoreMode.MERGE)
            fail("Expected a visible merge conflict")
        } catch (expected: BackupFormatException) {
            assertTrue(expected.message.orEmpty().contains("identity"))
        }
        assertEquals("Local version", database.taskDao().get(task.id)?.title)
    }

    @Test
    fun `restore from a different bound account leaves valid local data unchanged`() = runTest {
        val task = repository.createTask(
            title = "Keep account A data",
            notes = "",
            schedulePrecision = SchedulePrecision.DAY,
            scheduledFor = LocalDate.now().toString(),
            scheduledTime = null,
            isFrog = false
        )
        repository.bindSyncAccount("00000000-0000-4000-8000-000000000001")
        val envelope = GoalflowBackup.encrypt(
            GoalflowBackupPayload(
                tasks = emptyList(),
                goals = emptyList(),
                plans = emptyList(),
                ownerUserId = "00000000-0000-4000-8000-000000000002"
            ),
            "strong-password"
        )

        try {
            repository.restoreBackup(envelope, "strong-password")
            fail("A cross-account restore must stop before replacing data")
        } catch (_: NativeSyncAccountMismatch) {
            // The Room transaction does not begin destructive work.
        }

        assertEquals("Keep account A data", database.taskDao().get(task.id)?.title)
        assertTrue(repository.pendingSyncMutations().isNotEmpty())
    }

    @Test
    fun `restore preserves a future collection without inventing a native sync mutation`() = runTest {
        val envelope = GoalflowBackup.encrypt(
            GoalflowBackupPayload(
                tasks = emptyList(),
                goals = emptyList(),
                plans = emptyList(),
                rawCollections = mapOf("future_feature" to "{\"enabled\":true}")
            ),
            "strong-password"
        )

        repository.restoreBackup(envelope, "strong-password")

        assertEquals("{\"enabled\":true}", database.rawCollectionDao().get("future_feature")?.payload)
        assertTrue(repository.pendingSyncMutations().isEmpty())
    }

    @Test
    fun `restore defaults to merge and keeps local records`() = runTest {
        val today = LocalDate.now().toString()
        val local = repository.createTask("Keep local", "", SchedulePrecision.DAY, today, null, false)
        val incoming = local.copy(id = "incoming-task", title = "From backup")
        val envelope = GoalflowBackup.encrypt(
            GoalflowBackupPayload(listOf(incoming), emptyList(), emptyList()),
            "strong-password"
        )

        repository.restoreBackup(envelope, "strong-password")

        assertEquals("Keep local", database.taskDao().get(local.id)?.title)
        assertEquals("From backup", database.taskDao().get(incoming.id)?.title)
        assertTrue(repository.hasRestoreCheckpoint())
    }

    @Test
    fun `replace creates an encrypted checkpoint that can roll back`() = runTest {
        val today = LocalDate.now().toString()
        val local = repository.createTask("Original", "", SchedulePrecision.DAY, today, null, false)
        val incoming = local.copy(id = "replacement-task", title = "Replacement")
        val envelope = GoalflowBackup.encrypt(
            GoalflowBackupPayload(listOf(incoming), emptyList(), emptyList()),
            "strong-password"
        )

        repository.restoreBackup(envelope, "strong-password", BackupRestoreMode.REPLACE)
        assertEquals(null, database.taskDao().get(local.id))
        assertEquals("Replacement", database.taskDao().get(incoming.id)?.title)
        assertTrue(repository.hasRestoreCheckpoint())

        repository.rollbackLastRestore("strong-password")

        assertEquals("Original", database.taskDao().get(local.id)?.title)
        assertEquals(null, database.taskDao().get(incoming.id))
    }

    @Test
    fun `foreign sync binding is quarantined instead of merged`() = runTest {
        val envelope = GoalflowBackup.encrypt(
            GoalflowBackupPayload(
                tasks = emptyList(),
                goals = emptyList(),
                plans = emptyList(),
                syncMeta = listOf(SyncMetaEntity("tasks:foreign", 4, 2, 7, null)),
                syncBinding = GoalflowSyncBinding("https://other.example", 99, "other-account")
            ),
            "strong-password"
        )

        val preview = repository.restoreBackup(envelope, "strong-password")

        assertTrue(preview.syncStateWillBeQuarantined)
        assertTrue(database.syncMetaDao().getAll().isEmpty())
        assertTrue(database.rawCollectionDao().getAll().any { it.entityType.startsWith(RESTORE_QUARANTINE_PREFIX) })
    }

    @Test
    fun `preserved empty web sync metadata is never queued as a domain mutation`() = runTest {
        val envelope = GoalflowBackup.encrypt(
            GoalflowBackupPayload(
                tasks = emptyList(),
                goals = emptyList(),
                plans = emptyList(),
                rawCollections = mapOf(
                    "sync" to """{"schemaVersion":2,"cursor":0,"versions":{},"outbox":[],"conflicts":[]}"""
                )
            ),
            "strong-password"
        )

        repository.restoreBackup(envelope, "strong-password")

        assertTrue(repository.pendingSyncMutations().none { it.entityType == "sync" })
        assertTrue(database.rawCollectionDao().get("sync") != null)
    }

    @Test
    fun `widget action is rejected when the visible plan changed`() = runTest {
        val today = LocalDate.now().toString()
        val first = repository.createTask("First", "", SchedulePrecision.DAY, today, null, false)
        val second = repository.createTask("Second", "", SchedulePrecision.DAY, today, null, false)
        repository.confirmPlan(today, listOf(first.id, second.id))
        val snapshot = repository.widgetSnapshot(today)
        val visible = snapshot.currentTask ?: error("A confirmed plan should expose its first task")
        val target = NativeWidgetTarget(
            taskId = visible.id,
            expectedUpdatedAt = visible.updatedAt,
            localDate = snapshot.localDate,
            planFingerprint = snapshot.planFingerprint
        )

        repository.moveToday(today, second.id, -1)

        try {
            repository.executeWidgetAction(NativeWidgetAction.COMPLETE, target)
            fail("Expected the stale widget action to be rejected")
        } catch (expected: StaleWidgetActionException) {
            assertTrue(expected.message.orEmpty().contains("Refresh"))
        }
        assertEquals(TaskStatus.OPEN.name, database.taskDao().get(first.id)?.status)
        assertEquals(TaskStatus.OPEN.name, database.taskDao().get(second.id)?.status)
    }

    @Test
    fun `widget action is rejected when the exact task version changed`() = runTest {
        val today = LocalDate.now().toString()
        val task = repository.createTask("Stable target", "", SchedulePrecision.DAY, today, null, false)
        repository.confirmPlan(today, listOf(task.id))
        val snapshot = repository.widgetSnapshot(today)
        val visible = snapshot.currentTask ?: error("A confirmed plan should expose its first task")
        val target = NativeWidgetTarget(visible.id, visible.updatedAt, snapshot.localDate, snapshot.planFingerprint)

        repository.updateTask(task.id, "Changed elsewhere", "", SchedulePrecision.DAY, today)

        try {
            repository.executeWidgetAction(NativeWidgetAction.COMPLETE, target)
            fail("Expected the stale task version to be rejected")
        } catch (expected: StaleWidgetActionException) {
            assertTrue(expected.message.orEmpty().contains("changed"))
        }
        assertEquals(TaskStatus.OPEN.name, database.taskDao().get(task.id)?.status)
    }

    @Test
    fun `widget undo carries and verifies the original plan proof`() = runTest {
        val today = LocalDate.now().toString()
        val task = repository.createTask("Undo proof", "", SchedulePrecision.DAY, today, null, false)
        repository.confirmPlan(today, listOf(task.id))
        val snapshot = repository.widgetSnapshot(today)
        val original = snapshot.currentTask ?: error("A confirmed plan should expose its first task")
        val completionTarget = NativeWidgetTarget(
            taskId = original.id,
            expectedUpdatedAt = original.updatedAt,
            localDate = snapshot.localDate,
            planFingerprint = snapshot.planFingerprint
        )

        repository.executeWidgetAction(NativeWidgetAction.COMPLETE, completionTarget)
        val completed = repository.taskSnapshot(task.id) ?: error("Completed task should remain readable")
        val newPlanItem = repository.createTask("New plan item", "", SchedulePrecision.DAY, today, null, false)
        repository.confirmPlan(today, listOf(newPlanItem.id))

        try {
            repository.executeWidgetAction(
                NativeWidgetAction.UNDO,
                completionTarget.copy(
                    expectedUpdatedAt = completed.updatedAt,
                    expectedPriorUpdatedAt = completionTarget.expectedUpdatedAt
                )
            )
            fail("Expected Undo to reject a changed plan")
        } catch (expected: StaleWidgetActionException) {
            assertTrue(expected.message.orEmpty().contains("plan"))
        }
        assertEquals(TaskStatus.COMPLETED.name, database.taskDao().get(task.id)?.status)
    }

    private fun accepted(mutation: SyncOutboxEntity, serverVersion: Long): NativePushResult =
        NativePushResult(
            mutationId = mutation.mutationId,
            accepted = true,
            serverVersion = serverVersion,
            recordEntityType = mutation.entityType,
            recordEntityId = mutation.entityId,
            recordDeviceId = mutation.deviceId,
            recordVersion = mutation.version,
            recordServerVersion = serverVersion,
            recordPayload = mutation.payload,
            recordUpdatedAt = mutation.updatedAt,
            recordDeletedAt = mutation.deletedAt
        )
}
