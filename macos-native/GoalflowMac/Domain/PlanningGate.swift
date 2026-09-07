import Foundation

struct DailyPlan: Codable, Equatable, Sendable {
    var localDate: String // YYYY-MM-DD id == localDate
    var confirmedAt: String // ISO string
    var taskIds: [String]

    init(localDate: String, confirmedAt: String, taskIds: [String]) {
        self.localDate = localDate
        self.confirmedAt = confirmedAt
        self.taskIds = taskIds
    }

    private enum CodingKeys: String, CodingKey { case localDate, confirmedAt, taskIds }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        localDate = try container.decode(String.self, forKey: .localDate)
        taskIds = try container.decode([String].self, forKey: .taskIds)
        if let text = try? container.decode(String.self, forKey: .confirmedAt) {
            confirmedAt = text
        } else {
            // Web plans store Unix milliseconds; native plans historically used ISO.
            let milliseconds = try container.decode(Int64.self, forKey: .confirmedAt)
            guard milliseconds > 0 && milliseconds <= 8_640_000_000_000_000 else {
                throw DecodingError.dataCorruptedError(forKey: .confirmedAt, in: container, debugDescription: "Invalid plan confirmation timestamp")
            }
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            confirmedAt = formatter.string(from: Date(timeIntervalSince1970: Double(milliseconds) / 1000))
        }
    }
}

enum PlanningGate: Equatable, Sendable {
    case monthlyPlanningRequired(month: String, taskIds: [String])
    case dailyPlanningRequired(localDate: String, overdueTaskIds: [String], taskIds: [String])
    case ready(queue: [GoalflowTask])
    case empty
}

func getPlanningGate(tasks: [GoalflowTask], today: String, dailyPlan: DailyPlan?) -> PlanningGate {
    let currentMonth = monthOf(today)
    let monthTasks = tasks.filter { $0.isOpen && $0.schedulePrecision == .month && $0.scheduledFor <= currentMonth }
    if !monthTasks.isEmpty {
        return .monthlyPlanningRequired(month: currentMonth, taskIds: monthTasks.map(\.id))
    }
    let overdue = tasks.filter { $0.isOpen && $0.schedulePrecision == .day && $0.scheduledFor < today }
    let queue = buildTodayQueue(tasks: tasks, today: today)
    let plannedIds = queue.map(\.id)
    var planMatches = false
    if let plan = dailyPlan, plan.localDate == today {
        let filtered = plan.taskIds.filter { plannedIds.contains($0) }
        planMatches = filtered.count == plannedIds.count && filtered.enumerated().allSatisfy { idx, id in id == plannedIds[idx] }
    }
    if !overdue.isEmpty || (queue.count > 0 && !planMatches) {
        return .dailyPlanningRequired(localDate: today, overdueTaskIds: overdue.map(\.id), taskIds: plannedIds)
    }
    return queue.isEmpty ? .empty : .ready(queue: queue)
}
