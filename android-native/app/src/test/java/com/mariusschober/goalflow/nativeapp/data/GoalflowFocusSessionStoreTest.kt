package com.mariusschober.goalflow.nativeapp.data

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.time.Instant

@RunWith(RobolectricTestRunner::class)
class GoalflowFocusSessionStoreTest {
    private lateinit var context: Context

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext<Context>()
        check(
            context.getSharedPreferences("goalflow-native-focus", Context.MODE_PRIVATE)
                .edit()
                .clear()
                .commit()
        )
    }

    @Test
    fun `focus anchor resumes for the same task and replaces a different task`() {
        val store = GoalflowFocusSessionStore(context)

        assertEquals(NativeFocusSession("task-a", 100L), store.beginOrResume("task-a", 100L))
        assertEquals(NativeFocusSession("task-a", 100L), store.beginOrResume("task-a", 200L))
        assertEquals(NativeFocusSession("task-b", 300L), store.beginOrResume("task-b", 300L))

        store.clear()
        assertNull(store.read())
    }

    @Test
    fun `shared record mirror preserves action fields and terminal phase`() {
        val store = GoalflowFocusSessionStore(context)
        val started = Instant.parse("2026-09-07T10:00:00Z")
        val active = NativeFocusSessionRecord.start(
            taskId = "task-a",
            plannedDurationSeconds = 1_500L,
            now = started,
            sessionId = "11111111-1111-4111-8111-111111111111"
        )
        val paused = active.pause(Instant.parse("2026-09-07T10:10:00Z"))
        store.saveRecord(paused)

        assertEquals(paused, store.readRecord())
        assertEquals(NativeFocusSession("task-a", started.toEpochMilli()), store.read())

        val completed = paused.complete(Instant.parse("2026-09-07T10:12:00Z"))
        store.saveRecord(completed)
        assertEquals(completed, store.readRecord())
        store.clear()
        assertNull(store.readRecord())
    }
}
