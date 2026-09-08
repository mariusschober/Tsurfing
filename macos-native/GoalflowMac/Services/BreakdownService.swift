import Foundation

final class ServerBreakdownGateway: BreakdownGateway, @unchecked Sendable {
    private let keychain: KeychainSessionStore
    private let configuration: MacCloudConfiguration
    private let urlSession: URLSession

    init(
        configuration: MacCloudConfiguration = .current,
        keychain: KeychainSessionStore = KeychainSessionStore(),
        urlSession: URLSession = URLSession.shared
    ) {
        self.configuration = configuration
        self.keychain = keychain
        self.urlSession = urlSession
    }

    func suggest(for task: GoalflowTask) async throws -> [BreakdownSuggestion] {
        guard configuration.isCloudConfigured,
              let apiOrigin = configuration.apiOrigin,
              let url = URL(string: "/api/v1/ai/breakdown", relativeTo: apiOrigin)?.absoluteURL else {
            throw BreakdownError.notConfigured
        }
        let session = try await keychain.currentSession(configuration: configuration, urlSession: urlSession)
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("Bearer \(session.accessToken)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        let body = ["taskTitle": task.title]
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, resp) = try await urlSession.data(for: req)
        guard let http = resp as? HTTPURLResponse else { throw BreakdownError.invalid }
        if http.statusCode == 429 { throw BreakdownError.quotaReached }
        if http.statusCode == 503 { throw BreakdownError.unavailable }
        if http.statusCode == 401 || http.statusCode == 403 { throw BreakdownError.authenticationRequired }
        guard (200..<300).contains(http.statusCode), data.count <= 64 * 1024 else { throw BreakdownError.invalid }
        struct Resp: Codable { var subtasks: [BreakdownSuggestion] }
        let decoded = try JSONDecoder().decode(Resp.self, from: data)
        // Validate 1..8 already, clamp durations
        return decoded.subtasks.map { BreakdownSuggestion(title: $0.title.trimmingCharacters(in: .whitespacesAndNewlines), estimatedDuration: max(1, min(1440, $0.estimatedDuration))) }.filter { !$0.title.isEmpty }
    }
}

enum BreakdownError: Error, LocalizedError {
    case quotaReached, unavailable, invalid, notConfigured, authenticationRequired
    var errorDescription: String? {
        switch self {
        case .quotaReached: return "AI quota reached — try manual breakdown."
        case .unavailable: return "AI unavailable now."
        case .invalid: return "Invalid breakdown"
        case .notConfigured: return "AI breakdown is not configured. Manual breakdown remains available."
        case .authenticationRequired: return "Verify the cloud session before using AI breakdown."
        }
    }
}

// MARK: - Local breakdown (persists parent broken_down + children)

struct BreakdownChildInput: Sendable { var title: String; var notes: String = ""; var durationMinutes: Int = 25 }

final class LocalBreakdownService: @unchecked Sendable {
    private let taskStore: any TaskStore
    private let clock: any Clock
    private let dailyPlanStore: DailyPlanStore

    init(taskStore: any TaskStore, clock: any Clock = SystemClock(), dailyPlanStore: DailyPlanStore = DailyPlanStore()) {
        self.taskStore = taskStore; self.clock = clock; self.dailyPlanStore = dailyPlanStore
    }

    func breakdown(taskId: String, children: [BreakdownChildInput]) throws -> (parent: GoalflowTask, children: [GoalflowTask]) {
        guard !children.isEmpty else { throw SchedulingError(code: .invalidTitle, message: "Add at least one scheduled next action.") }
        guard children.count <= 50 else { throw SchedulingError(code: .invalidTitle, message: "At most 50 actions.") }
        let today = makeTodayString(from: clock.now())
        var tasks = try taskStore.loadAll()
        guard let parentIdx = tasks.firstIndex(where: { $0.id == taskId }) else { throw TaskStoreError.notFound }
        guard tasks[parentIdx].isOpen else { throw TaskStoreError.notOpen }
        let parent = tasks[parentIdx]
        // Validate children titles
        for c in children {
            if c.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { throw SchedulingError(code: .invalidTitle, message: "A task needs an actionable title.") }
            if c.durationMinutes < 1 || c.durationMinutes > 1440 { throw SchedulingError(code: .invalidTitle, message: "Duration 1..1440") }
            try assertSchedule(precision: .day, scheduledFor: today, today: today, scheduledTime: nil)
        }
        // Order: tail per today scheduledFor
        // If we will preserve plan, we need parent order
        let parentOrder = parent.plannedOrder
        var created: [GoalflowTask] = []
        let nowISO = ISO8601DateFormatter().string(from: clock.now())
        for (idx, child) in children.enumerated() {
            // Use parent order + idx for today children to preserve comparator
            let order = parentOrder + idx
            // If we use max tail instead of parent order, we'd lose deterministic replacement; use parent order
            let t = GoalflowTask(
                id: UUID().uuidString,
                title: child.title,
                notes: child.notes,
                schedulePrecision: .day,
                scheduledFor: today,
                plannedOrder: order,
                status: .open,
                isFrog: false,
                beforeFrog: false,
                source: .manual,
                parentTaskId: parent.id,
                createdAt: nowISO,
                updatedAt: nowISO,
                version: 1,
                durationMinutes: child.durationMinutes,
                extraJson: "{}"
            )
            created.append(t)
        }
        // Close parent
        var closed = parent
        closed.status = .brokenDown
        closed.updatedAt = nowISO
        closed.version = parent.version + 1
        // Store extraJson completedAt like withCompleted but keep brokenDown
        var dict: [String: Any] = [:]
        if let data = closed.extraJson.data(using: .utf8), let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] { dict = obj }
        dict["completedAt"] = nowISO
        let extraData = try JSONSerialization.data(withJSONObject: dict, options: [.sortedKeys])
        guard let extraJSON = String(data: extraData, encoding: .utf8) else {
            throw SyncError.validation("The breakdown metadata could not be encoded. Nothing was applied.")
        }
        closed.extraJson = extraJSON

        // Plan preservation: check previous queue == plan taskIds
        let previousQueue = buildTodayQueue(tasks: tasks, today: today)
        let previousPlan = try dailyPlanStore.load(for: today)
        var newPlanIds: [String]? = nil
        if let plan = previousPlan {
            let plannedIds = previousQueue.map(\.id)
            let filtered = plan.taskIds.filter { plannedIds.contains($0) }
            let matches = filtered.count == plannedIds.count && filtered.enumerated().allSatisfy { $0.element == plannedIds[$0.offset] }
            if matches && previousQueue.contains(where: { $0.id == parent.id }) && created.count == children.count {
                // Replace parent with children in order
                var replacement = previousQueue.filter { $0.id != parent.id }.map(\.id)
                // Insert children ids at parent index
                if let parentIdxInQueue = previousQueue.firstIndex(where: { $0.id == parent.id }) {
                    for (i, c) in created.enumerated() { replacement.insert(c.id, at: parentIdxInQueue + i) }
                } else {
                    replacement.append(contentsOf: created.map(\.id))
                }
                // Need to reorder existing tasks to match comparator? For now keep plannedOrder as is
                newPlanIds = replacement
            }
        }

        // Build new tasks array: replace parent, append children, re-sort by comparator for today? Keep order as parent+index
        tasks[parentIdx] = closed
        tasks.append(contentsOf: created)
        // Re-sort is handled by saveAll sorting via goalflowTaskComparator, but we want children order parent+idx to be respected
        // Since saveAll sorts, the parent+idx order will be preserved if we set plannedOrder accordingly (already)
        try taskStore.saveAll(tasks)

        // Update or delete daily plan
        if let ids = newPlanIds {
            let newPlan = DailyPlan(localDate: today, confirmedAt: nowISO, taskIds: ids)
            try dailyPlanStore.save(newPlan)
        } else if try dailyPlanStore.load(for: today) != nil && getPlanningGate(tasks: tasks, today: today, dailyPlan: previousPlan) != .ready(queue: buildTodayQueue(tasks: tasks, today: today)) {
            // If previous plan existed but now not matching, delete (or keep? Android deletes)
            // For simplicity, if plan existed and we didn't preserve, clear it
            // Check if gate would be not ready, then clear
            // We clear by saving empty? Instead clear file entry
            let all = try dailyPlanStore.loadAll().filter { $0.localDate != today }
            try dailyPlanStore.saveAll(all)
        }

        return (closed, created)
    }
}
