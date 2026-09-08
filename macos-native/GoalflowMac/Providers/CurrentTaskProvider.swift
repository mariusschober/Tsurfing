import Foundation
protocol CurrentTaskProvider: Sendable {
    func fetchCurrent() throws -> GoalflowTask?
    func allDemoTasks(today: String) throws -> [GoalflowTask]
}
protocol TaskStore: Sendable {
    func loadAll() throws -> [GoalflowTask]; func saveAll(_ tasks: [GoalflowTask]) throws
    func completeTask(id: String, actualDurationMinutes: Int, flowState: FlowState?) throws -> GoalflowTask
    func updateTask(_ task: GoalflowTask) throws; func queueCount(today: String) throws -> Int; func completedCount(today: String) throws -> Int
}
final class LocalTaskStore: TaskStore, @unchecked Sendable {
    let fileURL: URL; private let walKey: String; let defaults: UserDefaults
    private let encoder: JSONEncoder; private let decoder: JSONDecoder
    private let syncMetaStore: SyncMetaStore
    private let deviceIdStore: DeviceIdStore
    init(fileURL: URL? = nil, defaults: UserDefaults = .standard, walKey: String = "goalflow.demo.tasks.v1", syncMetaStore: SyncMetaStore? = nil, deviceIdStore: DeviceIdStore? = nil) {
        if let u = fileURL { self.fileURL = u } else {
            let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first ?? FileManager.default.temporaryDirectory
            let dir = base.appendingPathComponent("com.mariusschober.GoalflowMac", isDirectory: true)
            self.fileURL = dir.appendingPathComponent("goalflow.tasks.json")
        }
        self.defaults = defaults; self.walKey = walKey
        self.encoder = JSONEncoder(); self.encoder.dateEncodingStrategy = .iso8601; self.encoder.outputFormatting = [.sortedKeys]
        self.decoder = JSONDecoder(); self.decoder.dateDecodingStrategy = .iso8601
        if let s = syncMetaStore { self.syncMetaStore = s }
        else {
            let dir = self.fileURL.deletingLastPathComponent()
            let syncURL = dir.appendingPathComponent("sync.json")
            self.syncMetaStore = SyncMetaStore(fileURL: syncURL, defaults: defaults)
        }
        self.deviceIdStore = deviceIdStore ?? DeviceIdStore(defaults: defaults)
    }
    func loadAll() throws -> [GoalflowTask] {
        let tasks = try syncMetaStore.loadLocalValue(fileURL: fileURL, walKey: walKey) { data in
            try decoder.decode([GoalflowTask].self, from: data)
        }
        let loaded = tasks ?? []
        guard Set(loaded.map(\.id)).count == loaded.count,
              loaded.allSatisfy({ !$0.id.isEmpty && !$0.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && $0.version > 0 }) else {
            throw SyncError.validation("Task storage contains invalid or duplicate durable identities. No task was discarded or replaced.")
        }
        return loaded.sorted(by: goalflowTaskComparator)
    }
    func saveAll(_ tasks: [GoalflowTask]) throws {
        let sorted = tasks.sorted(by: goalflowTaskComparator)
        let previous = try loadAll()
        let previousValue: Any? = try previous.map { try $0.toSyncDictionary() }
        let nextValue: Any? = try sorted.map { try $0.toSyncDictionary() }
        let transaction = try buildStagedLocalTransaction(
            storeName: "tasks",
            userKey: "unbound-local-workspace",
            previousValue: previousValue,
            nextValue: nextValue,
            order: nextOrder(),
            now: ISO8601DateFormatter().string(from: Date()),
            randomUuid: { UUID().uuidString.lowercased() }
        )
        let currentMeta = try syncMetaStore.load()
        let nextMeta: SyncMeta
        if let transaction {
            nextMeta = try appendStagedTransactions(currentMeta, transactions: [transaction], deviceId: deviceIdStore.deviceId)
        } else { nextMeta = currentMeta }
        let data = try encoder.encode(sorted)
        try syncMetaStore.commitLocalValue(fileURL: fileURL, walKey: walKey, data: data, nextMeta: nextMeta)
        NotificationCenter.default.post(name: .syncMutationCommitted, object: nil)
    }

    private static let orderLock = NSLock()
    private static var orderCounter = 0
    private func nextOrder() -> Int {
        Self.orderLock.lock(); defer { Self.orderLock.unlock() }
        Self.orderCounter = (Self.orderCounter + 1) % 1000
        return Int(Date().timeIntervalSince1970 * 1000) * 1000 + Self.orderCounter
    }
    func completeTask(id: String, actualDurationMinutes: Int, flowState: FlowState?) throws -> GoalflowTask {
        var tasks = try loadAll(); guard let idx = tasks.firstIndex(where: { $0.id == id }) else { throw TaskStoreError.notFound }
        guard tasks[idx].isOpen else { throw TaskStoreError.notOpen }
        let completed = try tasks[idx].withCompleted(at: Date(), actualDurationMinutes: actualDurationMinutes, flowState: flowState)
        tasks[idx] = completed; try saveAll(tasks); return completed
    }
    func updateTask(_ task: GoalflowTask) throws {
        var tasks = try loadAll(); guard let idx = tasks.firstIndex(where: { $0.id == task.id }) else { throw TaskStoreError.notFound }
        tasks[idx] = task; try saveAll(tasks)
    }
    func queueCount(today: String) throws -> Int { try buildTodayQueue(tasks: loadAll(), today: today).count }
    func completedCount(today: String) throws -> Int { try loadAll().filter { $0.status == .completed && $0.scheduledFor == today }.count }
    func seedIfEmpty(today: String) throws {
        if try !loadAll().isEmpty { return }
        let nowISO = ISO8601DateFormatter().string(from: Date())
        let tasks = [
            GoalflowTask(id: "40a647cb-1f8b-4a23-8ceb-76a6c30b2d04", title: "Draft Q4 roadmap — outline three bets", notes: "", tags: ["focus"], schedulePrecision: .day, scheduledFor: today, plannedOrder: 0, status: .open, isFrog: false, beforeFrog: false, source: .manual, createdAt: nowISO, updatedAt: nowISO, version: 1, durationMinutes: 25),
            GoalflowTask(id: "5955a3ad-5b7f-4cf2-9a2f-a64119f370d7", title: "Review weekly goals and prune one", tags: [], schedulePrecision: .day, scheduledFor: today, plannedOrder: 1, status: .open, isFrog: false, createdAt: nowISO, updatedAt: nowISO, version: 1, durationMinutes: 15)
        ]
        try saveAll(tasks)
    }
    func clearAll() throws {
        try saveAll([])
    }
}
enum TaskStoreError: Error, LocalizedError {
    case notFound; case notOpen
    var errorDescription: String? {
        switch self { case .notFound: return "Task not found."; case .notOpen: return "Only an open task can be completed." }
    }
}
final class DemoCurrentTaskProvider: CurrentTaskProvider, @unchecked Sendable {
    let taskStore: any TaskStore
    private let defaults: UserDefaults
    init(taskStore: (any TaskStore)? = nil, defaults: UserDefaults = .standard) {
        let resolvedStore = taskStore ?? LocalTaskStore(defaults: defaults)
        self.taskStore = resolvedStore; self.defaults = defaults
    }
    func allDemoTasks(today: String) throws -> [GoalflowTask] {
        return try taskStore.loadAll().filter { $0.scheduledFor == today }.sorted(by: goalflowTaskComparator)
    }
    func allTasks() throws -> [GoalflowTask] { try taskStore.loadAll() }
    func fetchCurrent() throws -> GoalflowTask? {
        let today = todayString()
        let queue = try buildTodayQueue(tasks: taskStore.loadAll(), today: today)
        return queue.first
    }
    func queueCount(today: String) throws -> Int { try taskStore.queueCount(today: today) }
    func completedCount(today: String) throws -> Int { try taskStore.completedCount(today: today) }
    func completeCurrent(actualDurationMinutes: Int, flowState: FlowState?) throws -> GoalflowTask {
        guard let cur = try fetchCurrent() else { throw TaskStoreError.notFound }
        return try taskStore.completeTask(id: cur.id, actualDurationMinutes: actualDurationMinutes, flowState: flowState)
    }
    func completeTask(id: String, actualDurationMinutes: Int, flowState: FlowState?) throws -> GoalflowTask {
        try taskStore.completeTask(id: id, actualDurationMinutes: actualDurationMinutes, flowState: flowState)
    }
    func updateFlowState(taskId: String, flow: FlowState) throws {
        var tasks = try taskStore.loadAll()
        guard let idx = tasks.firstIndex(where: { $0.id == taskId }) else { throw TaskStoreError.notFound }
        tasks[idx] = try tasks[idx].withFlowState(flow)
        try taskStore.saveAll(tasks)
    }
    func resetDemo() throws {
        try (taskStore as? LocalTaskStore)?.clearAll()
        let today = todayString()
        try (taskStore as? LocalTaskStore)?.seedIfEmpty(today: today)
    }
    func setFrogDemo(isFrog: Bool) throws {
        var tasks = try taskStore.loadAll()
        let today = todayString()
        let queue = buildTodayQueue(tasks: tasks, today: today)
        guard let firstId = queue.first?.id, let idx = tasks.firstIndex(where: { $0.id == firstId }) else { return }
        tasks[idx].isFrog = isFrog
        tasks[idx].updatedAt = ISO8601DateFormatter().string(from: Date())
        tasks[idx].version += 1
        try taskStore.saveAll(tasks)
    }
    private func todayString() -> String {
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; f.timeZone = .current; f.locale = Locale(identifier: "en_US_POSIX")
        return f.string(from: Date())
    }
}
protocol SyncGateway: Sendable { func synchronize() async throws }
struct NoopSyncGateway: SyncGateway { func synchronize() async throws {} }
protocol AuthGateway: Sendable { var isAuthenticated: Bool { get } }
struct StubAuthGateway: AuthGateway { var isAuthenticated: Bool { false } }
protocol ActionGateway: Sendable { func start(taskId: String) async throws -> ExecutionState }
struct LocalActionGateway: ActionGateway { func start(taskId: String) async throws -> ExecutionState { throw TaskStoreError.notFound } }
struct BreakdownSuggestion: Codable, Equatable, Sendable { var title: String; var estimatedDuration: Int }
protocol BreakdownGateway: Sendable { func suggest(for task: GoalflowTask) async throws -> [BreakdownSuggestion] }
struct StubBreakdownGateway: BreakdownGateway { func suggest(for task: GoalflowTask) async throws -> [BreakdownSuggestion] { [] } }
