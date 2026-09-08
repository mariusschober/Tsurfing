import Foundation

final class GoalStore: @unchecked Sendable {
    let fileURL: URL
    private let walKey: String
    private let defaults: UserDefaults
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder
    private let syncMetaStore: SyncMetaStore
    private let deviceIdStore: DeviceIdStore
    private static let orderLock = NSLock()
    private static var orderCounter = 0
    init(fileURL: URL? = nil, defaults: UserDefaults = .standard, walKey: String = "goalflow.goals.v1", syncMetaStore: SyncMetaStore? = nil, deviceIdStore: DeviceIdStore? = nil) {
        if let u = fileURL { self.fileURL = u } else {
            let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first ?? FileManager.default.temporaryDirectory
            let dir = base.appendingPathComponent("com.mariusschober.GoalflowMac", isDirectory: true)
            self.fileURL = dir.appendingPathComponent("goals.json")
        }
        self.defaults = defaults; self.walKey = walKey
        encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        decoder = JSONDecoder()
        let dir = self.fileURL.deletingLastPathComponent()
        let syncURL = dir.appendingPathComponent("sync.json")
        self.syncMetaStore = syncMetaStore ?? SyncMetaStore(fileURL: syncURL, defaults: defaults)
        self.deviceIdStore = deviceIdStore ?? DeviceIdStore(defaults: defaults)
    }
    func loadAll() throws -> [Goal] {
        try syncMetaStore.loadLocalValue(fileURL: fileURL, walKey: walKey) { data in
            let goals = try decoder.decode([Goal].self, from: data)
            guard Set(goals.map(\.id)).count == goals.count,
                  goals.allSatisfy({ !$0.id.isEmpty && !$0.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) else {
                throw SyncError.validation("Goal storage is invalid. No goal was discarded or replaced.")
            }
            return goals
        } ?? []
    }
    func saveAll(_ goals: [Goal]) throws {
        guard Set(goals.map(\.id)).count == goals.count,
              goals.allSatisfy({ !$0.id.isEmpty && !$0.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) else {
            throw SyncError.validation("Goal storage is invalid. No goal was discarded or replaced.")
        }
        let previous = try loadAll()
        let prevVal: Any? = try JSONSerialization.jsonObject(with: encoder.encode(previous), options: [.fragmentsAllowed])
        let nextVal: Any? = try JSONSerialization.jsonObject(with: encoder.encode(goals), options: [.fragmentsAllowed])
        let transaction = try buildStagedLocalTransaction(storeName: "goals", userKey: "unbound-local-workspace", previousValue: prevVal, nextValue: nextVal, order: nextOrder(), now: ISO8601DateFormatter().string(from: Date()), randomUuid: { UUID().uuidString.lowercased() })
        let currentMeta = try syncMetaStore.load()
        let nextMeta: SyncMeta
        if let transaction {
            nextMeta = try appendStagedTransactions(currentMeta, transactions: [transaction], deviceId: deviceIdStore.deviceId)
        } else {
            nextMeta = currentMeta
        }
        let data = try encoder.encode(goals)
        try syncMetaStore.commitLocalValue(fileURL: fileURL, walKey: walKey, data: data, nextMeta: nextMeta)
    }
    private func nextOrder() -> Int {
        Self.orderLock.lock(); defer { Self.orderLock.unlock() }
        Self.orderCounter = (Self.orderCounter + 1) % 1000
        return Int(Date().timeIntervalSince1970 * 1000) * 1000 + Self.orderCounter
    }
}

final class TrueNorthStore: @unchecked Sendable {
    let fileURL: URL; private let walKey: String; private let defaults: UserDefaults
    private let encoder: JSONEncoder; private let decoder: JSONDecoder
    private let syncMetaStore: SyncMetaStore
    private let deviceIdStore: DeviceIdStore
    private static let orderLock = NSLock()
    private static var orderCounter = 0
    init(fileURL: URL? = nil, defaults: UserDefaults = .standard, walKey: String = "goalflow.truenorth.v1", syncMetaStore: SyncMetaStore? = nil, deviceIdStore: DeviceIdStore? = nil) {
        if let u = fileURL { self.fileURL = u } else {
            let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first ?? FileManager.default.temporaryDirectory
            let dir = base.appendingPathComponent("com.mariusschober.GoalflowMac", isDirectory: true)
            self.fileURL = dir.appendingPathComponent("truenorth.json")
        }
        self.defaults = defaults; self.walKey = walKey
        encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]; decoder = JSONDecoder()
        let dir = self.fileURL.deletingLastPathComponent()
        let syncURL = dir.appendingPathComponent("sync.json")
        self.syncMetaStore = syncMetaStore ?? SyncMetaStore(fileURL: syncURL, defaults: defaults)
        self.deviceIdStore = deviceIdStore ?? DeviceIdStore(defaults: defaults)
    }
    func loadAll() throws -> [TrueNorthGoal] {
        try syncMetaStore.loadLocalValue(fileURL: fileURL, walKey: walKey) { data in
            let goals = try decoder.decode([TrueNorthGoal].self, from: data)
            guard Set(goals.map(\.id)).count == goals.count,
                  goals.allSatisfy({ !$0.id.isEmpty && !$0.vision.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) else {
                throw SyncError.validation("True North storage is invalid. No goal was discarded or replaced.")
            }
            return goals
        } ?? []
    }
    func saveAll(_ goals: [TrueNorthGoal]) throws {
        guard Set(goals.map(\.id)).count == goals.count,
              goals.allSatisfy({ !$0.id.isEmpty && !$0.vision.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) else {
            throw SyncError.validation("True North storage is invalid. No goal was discarded or replaced.")
        }
        let previous = try loadAll()
        let prevVal: Any? = try JSONSerialization.jsonObject(with: encoder.encode(previous), options: [.fragmentsAllowed])
        let nextVal: Any? = try JSONSerialization.jsonObject(with: encoder.encode(goals), options: [.fragmentsAllowed])
        let transaction = try buildStagedLocalTransaction(storeName: "truenorth", userKey: "unbound-local-workspace", previousValue: prevVal, nextValue: nextVal, order: nextOrder(), now: ISO8601DateFormatter().string(from: Date()), randomUuid: { UUID().uuidString.lowercased() })
        let currentMeta = try syncMetaStore.load()
        let nextMeta: SyncMeta
        if let transaction {
            nextMeta = try appendStagedTransactions(currentMeta, transactions: [transaction], deviceId: deviceIdStore.deviceId)
        } else {
            nextMeta = currentMeta
        }
        let data = try encoder.encode(goals)
        try syncMetaStore.commitLocalValue(fileURL: fileURL, walKey: walKey, data: data, nextMeta: nextMeta)
    }
    private func nextOrder() -> Int {
        Self.orderLock.lock(); defer { Self.orderLock.unlock() }
        Self.orderCounter = (Self.orderCounter + 1) % 1000
        return Int(Date().timeIntervalSince1970 * 1000) * 1000 + Self.orderCounter
    }
}

final class AmalgamStore: @unchecked Sendable {
    let fileURL: URL; private let walKey: String; private let defaults: UserDefaults
    private let syncMetaStore: SyncMetaStore
    private let deviceIdStore: DeviceIdStore
    private static let orderLock = NSLock()
    private static var orderCounter = 0
    init(fileURL: URL? = nil, defaults: UserDefaults = .standard, walKey: String = "goalflow.amalgam.v1", syncMetaStore: SyncMetaStore? = nil, deviceIdStore: DeviceIdStore? = nil) {
        if let u = fileURL { self.fileURL = u } else {
            let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first ?? FileManager.default.temporaryDirectory
            let dir = base.appendingPathComponent("com.mariusschober.GoalflowMac", isDirectory: true)
            self.fileURL = dir.appendingPathComponent("amalgam.json")
        }
        self.defaults = defaults; self.walKey = walKey
        let dir = self.fileURL.deletingLastPathComponent()
        let syncURL = dir.appendingPathComponent("sync.json")
        self.syncMetaStore = syncMetaStore ?? SyncMetaStore(fileURL: syncURL, defaults: defaults)
        self.deviceIdStore = deviceIdStore ?? DeviceIdStore(defaults: defaults)
    }
    func load() throws -> String? {
        if let value = try syncMetaStore.loadLocalValue(fileURL: fileURL, walKey: walKey, decode: {
            try JSONDecoder().decode(String.self, from: $0)
        }) { return value }
        guard let legacy = defaults.string(forKey: walKey) else { return nil }
        try persist(legacy, previous: nil)
        return legacy
    }
    func save(_ value: String) throws {
        try persist(value, previous: load())
    }
    private func persist(_ value: String, previous: String?) throws {
        let transaction = try buildStagedLocalTransaction(storeName: "amalgam", userKey: "unbound-local-workspace", previousValue: previous, nextValue: value, order: nextOrder(), now: ISO8601DateFormatter().string(from: Date()), randomUuid: { UUID().uuidString.lowercased() })
        let currentMeta = try syncMetaStore.load()
        let nextMeta: SyncMeta
        if let transaction {
            nextMeta = try appendStagedTransactions(currentMeta, transactions: [transaction], deviceId: deviceIdStore.deviceId)
        } else {
            nextMeta = currentMeta
        }
        let data = try JSONEncoder().encode(value)
        try syncMetaStore.commitLocalValue(fileURL: fileURL, walKey: walKey, data: data, nextMeta: nextMeta)
    }
    private func nextOrder() -> Int {
        Self.orderLock.lock(); defer { Self.orderLock.unlock() }
        Self.orderCounter = (Self.orderCounter + 1) % 1000
        return Int(Date().timeIntervalSince1970 * 1000) * 1000 + Self.orderCounter
    }
}
