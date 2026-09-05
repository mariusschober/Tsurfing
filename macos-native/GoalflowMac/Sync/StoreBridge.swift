import Foundation

protocol SyncStoreBridge: Sendable {
    func loadValues() throws -> [String: Any]
    func preparedWrites(_ values: [String: Any], stores: Set<String>) throws -> [DurableLocalWrite]
    func saveValues(_ values: [String: Any]) throws
}

final class FileSyncStoreBridge: SyncStoreBridge, @unchecked Sendable {
    private let baseDir: URL
    private let defaults: UserDefaults
    private let syncMetaStore: SyncMetaStore
    init(baseDir: URL? = nil, defaults: UserDefaults = .standard) {
        if let d = baseDir { self.baseDir = d }
        else {
            let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first ?? FileManager.default.temporaryDirectory
            self.baseDir = base.appendingPathComponent("com.mariusschober.GoalflowMac", isDirectory: true)
        }
        self.defaults = defaults
        self.syncMetaStore = SyncMetaStore(fileURL: self.baseDir.appendingPathComponent("sync.json"), defaults: defaults)
    }

    func loadValues() throws -> [String: Any] {
        var dict: [String: Any] = [:]
        for mapping in Self.mappings {
            let url = baseDir.appendingPathComponent(mapping.file)
            if let value = try syncMetaStore.loadLocalValue(fileURL: url, walKey: mapping.walKey, decode: {
                try JSONSerialization.jsonObject(with: $0, options: [.fragmentsAllowed])
            }) {
                dict[mapping.store] = value
            }
        }
        return dict
    }

    func preparedWrites(_ values: [String: Any], stores: Set<String>) throws -> [DurableLocalWrite] {
        var writes: [DurableLocalWrite] = []
        for store in stores {
            guard let mapping = Self.mappings.first(where: { $0.store == store }) else {
                throw SyncError.validation("The server returned an unsupported local store. Nothing was applied.")
            }
            guard let value = values[store] else {
                writes.append(DurableLocalWrite(fileName: mapping.file, walKey: mapping.walKey, data: nil))
                continue
            }
            let data: Data
            if store == "tasks" {
                guard let records = value as? [[String: Any]] else {
                    throw SyncError.validation("The server returned malformed task data. Nothing was applied.")
                }
                let tasks = try records.map { try GoalflowTask(syncDictionary: $0) }
                    .sorted(by: goalflowTaskComparator)
                let encoder = JSONEncoder()
                encoder.outputFormatting = [.sortedKeys]
                data = try encoder.encode(tasks)
            } else {
                data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .fragmentsAllowed])
            }
            try validateDomainData(data, store: store)
            writes.append(DurableLocalWrite(fileName: mapping.file, walKey: mapping.walKey, data: data))
        }
        return writes.sorted { $0.fileName < $1.fileName }
    }

    func saveValues(_ values: [String: Any]) throws {
        let writes = try preparedWrites(values, stores: Set(values.keys))
        if writes.isEmpty { return }
        try syncMetaStore.commitLocalValues(writes, nextMeta: syncMetaStore.load())
    }

    private func validateDomainData(_ data: Data, store: String) throws {
        if RECORD_LEVEL_STORES.contains(store) {
            guard let records = try JSONSerialization.jsonObject(with: data) as? [[String: Any]],
                  records.allSatisfy({ ($0["id"] as? String)?.isEmpty == false }),
                  Set(records.compactMap { $0["id"] as? String }).count == records.count else {
                throw SyncError.validation("The server returned invalid or duplicate durable identities. Nothing was applied.")
            }
        }
        do {
            switch store {
            case "tasks":
                let tasks = try JSONDecoder().decode([GoalflowTask].self, from: data)
                guard tasks.allSatisfy({ !$0.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && $0.version > 0 }) else {
                    throw SyncError.validation("The server returned invalid task data. Nothing was applied.")
                }
            case "goals":
                let goals = try JSONDecoder().decode([Goal].self, from: data)
                guard goals.allSatisfy({ !$0.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) else {
                    throw SyncError.validation("The server returned invalid goal data. Nothing was applied.")
                }
            case "truenorth":
                let goals = try JSONDecoder().decode([TrueNorthGoal].self, from: data)
                guard goals.allSatisfy({ !$0.vision.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) else {
                    throw SyncError.validation("The server returned invalid True North data. Nothing was applied.")
                }
            case "daily_plans":
                let plans = try JSONDecoder().decode([DailyPlan].self, from: data)
                guard Set(plans.map(\.localDate)).count == plans.count,
                      plans.allSatisfy({ isRealDay($0.localDate) && Set($0.taskIds).count == $0.taskIds.count }) else {
                    throw SyncError.validation("The server returned invalid daily plan data. Nothing was applied.")
                }
            case "task_events":
                guard let events = try JSONSerialization.jsonObject(with: data) as? [[String: Any]],
                      events.allSatisfy({ event in
                          guard let id = event["id"] as? String, UUID(uuidString: id) != nil,
                                let taskId = (event["taskId"] ?? event["task_id"]) as? String, UUID(uuidString: taskId) != nil,
                                let eventType = (event["eventType"] ?? event["event_type"] ?? event["type"]) as? String,
                                ["created", "completed", "skipped", "rescheduled", "promoted_to_frog", "broken_down", "dropped", "restored"].contains(eventType),
                                let localDate = (event["localDate"] ?? event["local_date"]) as? String,
                                isRealDay(localDate) else { return false }
                          let createdAt = event["createdAt"] ?? event["created_at"]
                          if let text = createdAt as? String {
                              let fractional = ISO8601DateFormatter()
                              fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                              return fractional.date(from: text) != nil || ISO8601DateFormatter().date(from: text) != nil
                          }
                          if let number = createdAt as? NSNumber,
                             CFGetTypeID(number) != CFBooleanGetTypeID() {
                              return number.doubleValue.isFinite && number.doubleValue >= 0
                          }
                          return false
                      }) else {
                    throw SyncError.validation("The server returned invalid task event history. Nothing was applied.")
                }
            default:
                break
            }
        } catch let error as SyncError {
            throw error
        } catch {
            throw SyncError.validation("The server returned malformed \(store) data. Nothing was applied.")
        }
    }

    private static let mappings: [(file: String, store: String, walKey: String)] = [
        ("goalflow.tasks.json", "tasks", "goalflow.demo.tasks.v1"),
        ("dailyPlans.json", "daily_plans", "goalflow.daily_plans.v1"),
        ("goals.json", "goals", "goalflow.goals.v1"),
        ("habits.json", "habits", "goalflow.habits.v1"),
        ("truenorth.json", "truenorth", "goalflow.truenorth.v1"),
        ("stats.json", "stats", "goalflow.stats.v1"),
        ("progress.json", "progress", "goalflow.progress.v1"),
        ("hashtags.json", "hashtags", "goalflow.hashtags.v1"),
        ("accountability.json", "accountability", "goalflow.accountability.v1"),
        ("amalgam.json", "amalgam", "goalflow.amalgam.v1"),
        ("tracking.json", "tracking", "goalflow.tracking.v1"),
        ("circadian.json", "circadian", "goalflow.circadian.v1"),
        ("settings.json", "settings", "goalflow.settings.v1"),
        ("taskEvents.json", "task_events", "goalflow.task_events.v1")
    ]
}
