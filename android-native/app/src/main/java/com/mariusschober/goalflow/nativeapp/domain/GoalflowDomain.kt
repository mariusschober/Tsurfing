package com.mariusschober.goalflow.nativeapp.domain

import java.time.LocalDate
import java.time.LocalTime
import java.time.YearMonth
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException

enum class SchedulePrecision { DAY, MONTH }

enum class TaskStatus { OPEN, COMPLETED, BROKEN_DOWN, DROPPED, ARCHIVED }

enum class TaskSource { MANUAL, HABIT, TELEGRAM, SHARE, AI, MIGRATION }

enum class HabitFrequency { DAILY, SPECIFIC_DAYS }

data class GoalflowTask(
    val id: String,
    val title: String,
    val notes: String = "",
    val schedulePrecision: SchedulePrecision,
    val scheduledFor: String,
    val scheduledTime: String? = null,
    val plannedOrder: Int = 0,
    val status: TaskStatus = TaskStatus.OPEN,
    val isFrog: Boolean = false,
    val beforeFrog: Boolean = false,
    val frogFailures: Int = 0,
    val source: TaskSource = TaskSource.MANUAL,
    val goalId: String? = null,
    val parentTaskId: String? = null,
    val habitId: String? = null,
    val createdAt: Long,
    val updatedAt: Long,
    val completedAt: Long? = null,
    val deletedAt: Long? = null,
    /** Optional ordering hint written by the web circadian planner. */
    val circadianRank: Int? = null,
    /** JSON for fields introduced by another Goalflow client. Never discard them on edit. */
    val extraJson: String = "{}"
)

data class GoalflowGoal(
    val id: String,
    val name: String,
    val description: String = "",
    val deadline: String? = null,
    val completedTasks: Int = 0,
    val color: String = "#315C4B",
    val createdAt: Long,
    val excitement: Int? = null,
    val roi: Int? = null,
    val extraJson: String = "{}"
)

data class GoalflowHabit(
    val id: String,
    val title: String,
    val frequency: HabitFrequency = HabitFrequency.DAILY,
    val specificDays: Set<Int> = emptySet(),
    val streak: Int = 0,
    val bestStreak: Int = 0,
    val lastCompletedDate: String? = null,
    val isHighPriority: Boolean = false,
    val beforeFrog: Boolean = false,
    val duration: Int? = null,
    val goalId: String? = null,
    val createdAt: Long,
    val extraJson: String = "{}"
)

/** The small typed projection used by the native Insights surface. The full
 * web-owned JSON remains preserved in the raw collection store. */
data class GoalflowStats(
    val tasksCompleted: Int = 0,
    val frogsEaten: Int = 0,
    val timeFocused: Int = 0,
    val totalBreakMinutes: Int = 0,
    val circadianScore: Int? = null
)

data class GoalflowProgress(
    val level: Int = 1,
    val xp: Int = 0,
    val xpToNextLevel: Int = 100
)

data class GoalflowCircadianState(
    val lastCheckIn: String = "",
    val score: Int = 0,
    val mode: String = "maintenance",
    val sunriseTime: String? = null,
    val sunsetTime: String? = null,
    val solarNoonTime: String? = null,
    val sunrise: Boolean = false,
    val sleepHours: Int = 8,
    val energy: Int = 5,
    val clarity: Int = 5,
    val interest: Int = 5,
    val wakeTime: String? = null,
    val eatingWindow: Int? = null,
    val firstMealTime: String? = null
)

data class GoalflowTrueNorth(
    val id: String,
    val vision: String,
    val isMoneyGoal: Boolean = false,
    val tangibleReality: String? = null,
    val sensoryDetails: String = "",
    val planB: String = "",
    val importance: Int = 5,
    val anchorHabit: String? = null,
    val anchorTask: String? = null,
    val anchorHabitDuration: Int? = null,
    val createdAt: Long,
    /** Preserve fields introduced by the web client or a later native client. */
    val extraJson: String = "{}"
)

data class DailyPlan(
    val localDate: String,
    val confirmedAt: Long,
    val taskIds: List<String>
)

data class BreakdownChild(
    val title: String,
    val notes: String = "",
    val schedulePrecision: SchedulePrecision = SchedulePrecision.DAY,
    val scheduledFor: String,
    val scheduledTime: String? = null,
    val duration: Int = 25
)

sealed interface PlanningGate {
    data object Empty : PlanningGate
    data class MonthlyPlanningRequired(val month: String, val taskIds: List<String>) : PlanningGate
    data class DailyPlanningRequired(
        val localDate: String,
        val overdueTaskIds: List<String>,
        val taskIds: List<String>
    ) : PlanningGate
    data class Ready(val queue: List<GoalflowTask>) : PlanningGate
}

class SchedulingException(message: String) : IllegalArgumentException(message)

private val dayFormatter = DateTimeFormatter.ISO_LOCAL_DATE
private val monthFormatter = DateTimeFormatter.ofPattern("yyyy-MM")
private val timeFormatter = DateTimeFormatter.ofPattern("HH:mm")

fun isRealLocalDay(value: String): Boolean = try {
    LocalDate.parse(value, dayFormatter)
    true
} catch (_: DateTimeParseException) {
    false
}

fun isRealLocalMonth(value: String): Boolean = try {
    YearMonth.parse(value, monthFormatter)
    true
} catch (_: DateTimeParseException) {
    false
}

fun assertSchedule(
    precision: SchedulePrecision,
    scheduledFor: String,
    today: String,
    scheduledTime: String?
) {
    if (!isRealLocalDay(today)) throw SchedulingException("The local day is invalid.")
    if (scheduledTime != null) {
        try {
            LocalTime.parse(scheduledTime, timeFormatter)
        } catch (_: DateTimeParseException) {
            throw SchedulingException("Time must use HH:mm.")
        }
    }
    when (precision) {
        SchedulePrecision.DAY -> if (!isRealLocalDay(scheduledFor)) {
            throw SchedulingException("Choose a valid calendar day.")
        }
        SchedulePrecision.MONTH -> {
            if (!isRealLocalMonth(scheduledFor)) throw SchedulingException("Choose a valid month.")
            if (scheduledFor <= today.substring(0, 7)) {
                throw SchedulingException("The current or a past month needs an exact day.")
            }
            if (scheduledTime != null) throw SchedulingException("A time needs an exact day.")
        }
    }
}

private fun groupRank(task: GoalflowTask): Int = when {
    task.beforeFrog && task.habitId != null -> 0
    task.isFrog -> 1
    else -> 2
}

private fun compareCreatedAt(left: Long, right: Long): Int = left.compareTo(right)

private fun optionalRank(value: Int?): Int = value ?: Int.MAX_VALUE

val goalflowTaskComparator = Comparator<GoalflowTask> { left, right ->
    val group = groupRank(left).compareTo(groupRank(right))
    if (group != 0) return@Comparator group
    val order = left.plannedOrder.compareTo(right.plannedOrder)
    if (order != 0) return@Comparator order
    val circadian = optionalRank(left.circadianRank).compareTo(optionalRank(right.circadianRank))
    if (circadian != 0) return@Comparator circadian
    val time = (left.scheduledTime ?: "99:99").compareTo(right.scheduledTime ?: "99:99")
    if (time != 0) return@Comparator time
    val created = compareCreatedAt(left.createdAt, right.createdAt)
    if (created != 0) return@Comparator created
    left.id.compareTo(right.id)
}

fun buildTodayQueue(tasks: List<GoalflowTask>, today: String): List<GoalflowTask> = tasks
    .filter {
        it.status == TaskStatus.OPEN &&
            it.deletedAt == null &&
            it.schedulePrecision == SchedulePrecision.DAY &&
            it.scheduledFor == today
    }
    .sortedWith(goalflowTaskComparator)

fun planningGate(
    tasks: List<GoalflowTask>,
    today: String,
    plan: DailyPlan?
): PlanningGate {
    val currentMonth = today.substring(0, 7)
    val monthly = tasks.filter {
        it.status == TaskStatus.OPEN &&
            it.deletedAt == null &&
            it.schedulePrecision == SchedulePrecision.MONTH &&
            it.scheduledFor <= currentMonth
    }
    if (monthly.isNotEmpty()) return PlanningGate.MonthlyPlanningRequired(
        month = currentMonth,
        taskIds = monthly.map { it.id }
    )

    val overdue = tasks.filter {
        it.status == TaskStatus.OPEN &&
            it.deletedAt == null &&
            it.schedulePrecision == SchedulePrecision.DAY &&
            it.scheduledFor < today
    }
    val queue = buildTodayQueue(tasks, today)
    val queueIds = queue.map { it.id }
    val matches = plan?.localDate == today
    if (overdue.isNotEmpty() || (queue.isNotEmpty() && !matches)) {
        return PlanningGate.DailyPlanningRequired(today, overdue.map { it.id }, queueIds)
    }
    return if (queue.isEmpty()) PlanningGate.Empty else PlanningGate.Ready(queue)
}
