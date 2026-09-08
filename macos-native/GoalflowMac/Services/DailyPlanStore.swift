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
        try syncMetaStore.withLocalStateTransaction { try saveAllLocked(plans) }
    }

    func isOrderLocked(for day: String) throws -> Bool {
        try syncMetaStore.withLocalStateTransaction {
            let account = try syncMetaStore.load().accountUserId ?? "unbound-local-workspace"
            let legacy = try load(for: day)
            let policy = try DeliberatePlanningStore(metaStore: syncMetaStore).policy(accountID: account, day: day, legacy: legacy)
            return !(policy["revision"] is NSNull)
        }
    }

    private func saveAllLocked(_ plans: [DailyPlan]) throws {
        let norm = try normalized(plans)
        let previous = try loadAll()
        // Preserve confirmed policy before any legacy plan-clearing operation.
        for plan in previous { _ = try isOrderLocked(for: plan.localDate) }
        for plan in norm {
            if let before = previous.first(where: { $0.localDate == plan.localDate }),
               try isOrderLocked(for: plan.localDate), DeliberatePlanning.changed(before.taskIds, plan.taskIds) {
                throw SyncError.validation("Order is locked. Open Replan in today's plan to confirm a new order.")
            }
        }
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

/// Private daily decisions survive removal of the shared daily-plan projection.
/// Every read and write participates in the same recovery lock as task sync.
final class DeliberatePlanningStore: @unchecked Sendable {
    private let metaStore: SyncMetaStore
    private let fileURL: URL
    private let walKey = "goalflow.deliberate_planning.v1"

    init(metaStore: SyncMetaStore) {
        self.metaStore = metaStore
        self.fileURL = metaStore.fileURL.deletingLastPathComponent().appendingPathComponent("deliberatePlanning.json")
    }

    func load(accountID: String) throws -> [String: Any] {
        try metaStore.withLocalStateTransaction {
            let meta = try metaStore.load()
            guard (meta.accountUserId ?? "unbound-local-workspace") == accountID else { throw SyncError.accountMismatch }
            var value = try metaStore.loadLocalValue(fileURL: fileURL, walKey: walKey) { data in
                guard let value = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                      ActionJSON.integer(value["schemaVersion"]) == 1,
                      let savedAccount = value["accountId"] as? String,
                      let days = value["days"] as? [String: [String: Any]],
                      let drafts = value["drafts"] as? [String: [String: Any]],
                      value["pending"] is [String: [String: Any]],
                      value["receipts"] is [String: [String: Any]] else {
                    throw SyncError.corruptStorage("Daily planning state is invalid. Nothing was replaced.")
                }
                guard savedAccount == accountID || savedAccount == "unbound-local-workspace" else { throw SyncError.accountMismatch }
                for (day, policy) in days { try DeliberatePlanning.validatePolicy(policy, accountID: savedAccount, day: day) }
                for (day, draft) in drafts { try self.validateDraft(draft, accountID: savedAccount, day: day) }
                return value
            } ?? ["schemaVersion": 1, "accountId": accountID, "days": [String: Any](),
                  "drafts": [String: Any](), "pending": [String: Any](), "receipts": [String: Any]()]
            if value["accountId"] as? String != accountID {
                let days = value["days"] as! [String: [String: Any]]
                guard (value["pending"] as! [String: Any]).isEmpty,
                      (value["receipts"] as! [String: Any]).isEmpty,
                      days.values.allSatisfy({ ($0["history"] as? [Any])?.isEmpty == true }) else {
                    throw SyncError.validation("Unbound planning operations require recovery before account migration.")
                }
                // Only legacy locks and unsubmitted drafts may acquire their
                // first account. Attempted command identities are immutable.
                value["accountId"] = accountID
                for field in ["days", "drafts"] {
                    value[field] = (value[field] as! [String: [String: Any]]).mapValues { original in
                        var scoped = original; scoped["accountId"] = accountID; return scoped
                    }
                }
                try save(value)
            }
            return value
        }
    }

    func policy(accountID: String, day: String, legacy: DailyPlan? = nil) throws -> [String: Any] {
        try metaStore.withLocalStateTransaction {
            var state = try load(accountID: accountID)
            var days = state["days"] as! [String: [String: Any]]
            if let value = days[day] { return value }
            let legacyValue = legacy.map { ["confirmedAt": $0.confirmedAt, "taskIds": $0.taskIds] as [String: Any] }
            let value = try DeliberatePlanning.initial(accountID: accountID, day: day, legacy: legacyValue)
            if legacy != nil { days[day] = value; state["days"] = days; try save(state) }
            return value
        }
    }

    private func validateDraft(_ draft: [String: Any], accountID: String, day: String) throws {
        guard draft["accountId"] as? String == accountID, draft["localDate"] as? String == day,
              let updatedAt = draft["updatedAt"] else { throw SyncError.validation("Invalid planning draft scope.") }
        var command = draft
        command.removeValue(forKey: "updatedAt")
        command["capturedAt"] = updatedAt
        command["operationId"] = "00000000-0000-4000-8000-000000000001"
        try DeliberatePlanning.validate(command)
    }

    func saveDraft(_ draft: [String: Any], accountID: String, day: String) throws {
        try validateDraft(draft, accountID: accountID, day: day)
        try metaStore.withLocalStateTransaction {
            var state = try load(accountID: accountID)
            var drafts = state["drafts"] as! [String: [String: Any]]
            drafts[day] = draft; state["drafts"] = drafts
            try save(state)
        }
    }

    func discardDraft(accountID: String, day: String) throws {
        try metaStore.withLocalStateTransaction {
            var state = try load(accountID: accountID)
            var drafts = state["drafts"] as! [String: [String: Any]]
            drafts.removeValue(forKey: day); state["drafts"] = drafts
            try save(state)
        }
    }

    @discardableResult
    func commitDay(_ response: [String: Any], accountID: String, day: String) throws -> Bool {
        try DeliberatePlanning.validateDay(response, accountID: accountID, day: day)
        return try metaStore.withLocalStateTransaction {
            var state = try load(accountID: accountID)
            let pending = state["pending"] as! [String: [String: Any]]
            guard !pending.values.contains(where: { ($0["command"] as? [String: Any])?["localDate"] as? String == day }) else { return false }
            let cursor = try metaStore.load().cursor
            let records = response["records"] as? [[String: Any]] ?? []
            guard records.allSatisfy({ ActionJSON.integer($0["server_version"])! <= cursor }) else { return false }
            var days = state["days"] as! [String: [String: Any]]
            let incoming = response["policy"] as! [String: Any]
            let previousHistory = days[day]?["history"] as? [[String: Any]] ?? []
            let incomingHistory = incoming["history"] as! [[String: Any]]
            guard incomingHistory.count >= previousHistory.count,
                  previousHistory.enumerated().allSatisfy({ stableJson($0.element) == stableJson(incomingHistory[$0.offset]) }) else { return false }
            days[day] = incoming; state["days"] = days
            try save(state)
            return true
        }
    }

    private func save(_ state: [String: Any]) throws {
        let data = try JSONSerialization.data(withJSONObject: state, options: [.sortedKeys])
        try metaStore.commitLocalValue(fileURL: fileURL, walKey: walKey, data: data, nextMeta: metaStore.load())
    }
}
