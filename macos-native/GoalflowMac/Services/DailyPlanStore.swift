import Foundation

final class DailyPlanStore: @unchecked Sendable {
    let fileURL: URL
    private let walKey: String
    private let defaults: UserDefaults
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder
    private let syncMetaStore: SyncMetaStore
    private let deviceIdStore: DeviceIdStore

    init(fileURL: URL? = nil, defaults: UserDefaults = .standard, walKey: String = "goalflow.daily_plans.v1", syncMetaStore: SyncMetaStore? = nil, deviceIdStore: DeviceIdStore? = nil) {
        if let u = fileURL { self.fileURL = u } else {
            let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first ?? FileManager.default.temporaryDirectory
            let dir = base.appendingPathComponent("com.mariusschober.GoalflowMac", isDirectory: true)
            self.fileURL = dir.appendingPathComponent("dailyPlans.json")
        }
        self.defaults = defaults; self.walKey = walKey
        encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        decoder = JSONDecoder()
        let dir = self.fileURL.deletingLastPathComponent()
        let syncURL = dir.appendingPathComponent("sync.json")
        self.syncMetaStore = syncMetaStore ?? SyncMetaStore(fileURL: syncURL, defaults: defaults)
        self.deviceIdStore = deviceIdStore ?? DeviceIdStore(defaults: defaults)
    }

    func loadAll() throws -> [DailyPlan] {
        try syncMetaStore.loadLocalValue(fileURL: fileURL, walKey: walKey) { data in
            try normalized(decoder.decode([DailyPlan].self, from: data))
        } ?? []
    }

    func load(for date: String) throws -> DailyPlan? { try loadAll().first { $0.localDate == date } }

    func saveAll(_ plans: [DailyPlan]) throws {
        let norm = try normalized(plans)
        let previous = try loadAll()
        let prevVal: Any? = previous.map { ["id": $0.localDate, "localDate": $0.localDate, "confirmedAt": $0.confirmedAt, "taskIds": $0.taskIds] as [String: Any] }
        let nextVal: Any? = norm.map { ["id": $0.localDate, "localDate": $0.localDate, "confirmedAt": $0.confirmedAt, "taskIds": $0.taskIds] as [String: Any] }
        let transaction = try buildStagedLocalTransaction(
            storeName: "daily_plans",
            userKey: "unbound-local-workspace",
            previousValue: prevVal,
            nextValue: nextVal,
            order: nextOrder(),
            now: ISO8601DateFormatter().string(from: Date()),
            randomUuid: { UUID().uuidString.lowercased() }
        )
        let currentMeta = try syncMetaStore.load()
        let nextMeta: SyncMeta
        if let transaction {
            nextMeta = try appendStagedTransactions(currentMeta, transactions: [transaction], deviceId: deviceIdStore.deviceId)
        } else { nextMeta = currentMeta }
        let data = try encoder.encode(norm)
        try syncMetaStore.commitLocalValue(fileURL: fileURL, walKey: walKey, data: data, nextMeta: nextMeta)
    }

    private static let orderLock = NSLock()
    private static var orderCounter = 0
    private func nextOrder() -> Int {
        Self.orderLock.lock(); defer { Self.orderLock.unlock() }
        Self.orderCounter = (Self.orderCounter + 1) % 1000
        return Int(Date().timeIntervalSince1970 * 1000) * 1000 + Self.orderCounter
    }

    func save(_ plan: DailyPlan) throws {
        var all = try loadAll().filter { $0.localDate != plan.localDate }
        all.append(plan)
        try saveAll(all)
    }

    func clearAll() throws {
        try saveAll([])
    }

    private func normalized(_ plans: [DailyPlan]) throws -> [DailyPlan] {
        guard Set(plans.map(\.localDate)).count == plans.count,
              plans.allSatisfy({
                  isRealDay($0.localDate)
                      && $0.localDate.count == 10
                      && !$0.taskIds.contains(where: { $0.isEmpty })
                      && Set($0.taskIds).count == $0.taskIds.count
              }) else {
            throw SyncError.validation("Daily plan storage is invalid. No plan was discarded or replaced.")
        }
        return plans.sorted { $0.localDate < $1.localDate }
    }
}
