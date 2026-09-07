package com.mariusschober.goalflow.nativeapp.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class GoalflowDomainTest {
    private val today = "2026-08-26"

    private fun task(
        id: String,
        day: String = today,
        order: Int = 0,
        frog: Boolean = false,
        beforeFrog: Boolean = false,
        habitId: String? = null,
        status: TaskStatus = TaskStatus.OPEN,
        precision: SchedulePrecision = SchedulePrecision.DAY
    ) = GoalflowTask(
        id = id,
        title = id,
        schedulePrecision = precision,
        scheduledFor = day,
        plannedOrder = order,
        status = status,
        isFrog = frog,
        beforeFrog = beforeFrog,
        habitId = habitId,
        createdAt = id.hashCode().toLong(),
        updatedAt = id.hashCode().toLong()
    )

    @Test
    fun `queue excludes completed and preserves frog priority`() {
        val queue = buildTodayQueue(
            listOf(
                task("later", order = 0),
                task("frog", order = 9, frog = true),
                task("before", order = 10, beforeFrog = true, habitId = "anchor"),
                task("done", status = TaskStatus.COMPLETED),
                task("other-day", day = "2026-08-27")
            ),
            today
        )

        assertEquals(listOf("before", "frog", "later"), queue.map { it.id })
    }

    @Test
    fun `queue applies circadian rank after the explicit plan order`() {
        val laterRhythm = task("later-rhythm", order = 0).copy(circadianRank = 3)
        val earlierRhythm = task("earlier-rhythm", order = 0).copy(circadianRank = 1)

        assertEquals(
            listOf("earlier-rhythm", "later-rhythm"),
            buildTodayQueue(listOf(laterRhythm, earlierRhythm), today).map { it.id }
        )
    }

    @Test
    fun `planning gate keeps today confirmed when tasks arrive or reorder`() {
        val tasks = listOf(task("one", order = 0), task("two", order = 1))

        assertTrue(planningGate(tasks, today, null) is PlanningGate.DailyPlanningRequired)
        assertTrue(
            planningGate(
                tasks,
                today,
                DailyPlan(today, confirmedAt = 1L, taskIds = listOf("one", "two"))
            ) is PlanningGate.Ready
        )
        assertTrue(
            planningGate(
                tasks,
                today,
                DailyPlan(today, confirmedAt = 1L, taskIds = listOf("two"))
            ) is PlanningGate.Ready
        )
    }

    @Test
    fun `monthly commitments in current month block execution`() {
        val gate = planningGate(
            listOf(task("month", day = "2026-08", precision = SchedulePrecision.MONTH)),
            today,
            null
        )

        assertEquals(
            PlanningGate.MonthlyPlanningRequired("2026-08", listOf("month")),
            gate
        )
    }

    @Test
    fun `schedule validation rejects invalid dates and past months`() {
        assertEquals(false, isRealLocalDay("2026-02-29"))
        assertEquals(false, isRealLocalMonth("2026-13"))

        assertFailsWithScheduling { assertSchedule(SchedulePrecision.DAY, "2026-02-29", today, null) }
        assertFailsWithScheduling { assertSchedule(SchedulePrecision.MONTH, "2026-08", today, null) }
    }

    private fun assertFailsWithScheduling(block: () -> Unit) {
        try {
            block()
            throw AssertionError("Expected SchedulingException")
        } catch (_: SchedulingException) {
            // Expected.
        }
    }
}
