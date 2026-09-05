import Foundation

let SYNC_META_SCHEMA_VERSION = 3
let RECORD_LEVEL_STORES: Set<String> = ["tasks","goals","habits","truenorth","daily_plans","task_events"]
let LEGACY_MUTATION_NAMESPACE = "384d2580-c159-4f6a-97d4-f4e94809538b"

struct VersionPair: Codable, Equatable, Sendable { var local: Int; var server: Int? }

struct SyncMutation: Codable, Equatable, Sendable {
    var mutationId: String
    var deviceId: String
    var entityType: String
    var entityId: String
    var baseServerVersion: Int?
    var version: Int
    var payload: AnyCodable
    var updatedAt: String
    var deletedAt: String?
    var dependsOnMutationId: String?
    var resolvesConflictId: String?
    var attemptedAt: String?
}

struct LocalConflict: Codable, Equatable, Sendable {
    var id: String
    var entityType: String
    var entityId: String
    var mutationId: String
    var baseServerVersion: Int?
    var serverVersion: Int
    var localPayload: AnyCodable
    var localDeletedAt: String?
    var localHistory: [AnyCodable] // stored as array of history entries each with mutationId,payload,deletedAt,updatedAt,version
    var serverPayload: AnyCodable
    var serverMissing: Bool
    var serverDeletedAt: String?
    var status: String // unresolved, resolving-local, replay_mismatch, etc.
    var createdAt: String?
}

struct SyncMeta: Codable, Equatable, Sendable {
    var schemaVersion: Int = SYNC_META_SCHEMA_VERSION
    var accountUserId: String?
    var cursor: Int = 0
    var versions: [String: VersionPair] = [:]
    var outbox: [SyncMutation] = []
    var conflicts: [LocalConflict] = []
    var lastSuccessfulSync: String?
}

func syncEntityKey(_ entityType: String, _ entityId: String) -> String { "\(entityType):\(entityId)" }

func emptySyncMeta() -> SyncMeta {
    SyncMeta(
        schemaVersion: SYNC_META_SCHEMA_VERSION,
        accountUserId: nil,
        cursor: 0,
        versions: [:],
        outbox: [],
        conflicts: [],
        lastSuccessfulSync: nil
    )
}

// MARK: - AnyCodable

struct AnyCodable: Codable, Equatable, Sendable {
    var value: Any?

    init(_ value: Any?) { self.value = value }

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { value = nil; return }
        if let i = try? c.decode(Int.self) { value = i; return }
        if let d = try? c.decode(Double.self) { value = d; return }
        if let b = try? c.decode(Bool.self) { value = b; return }
        if let s = try? c.decode(String.self) { value = s; return }
        if let a = try? c.decode([AnyCodable].self) { value = a.map { $0.value ?? NSNull() }; return }
        if let d = try? c.decode([String: AnyCodable].self) { value = d.mapValues { $0.value ?? NSNull() }; return }
        throw DecodingError.dataCorruptedError(in: c, debugDescription: "AnyCodable cannot decode")
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        guard let v = value else { try c.encodeNil(); return }
        // On Darwin, `Any` values backed by NSNumber bridge across Bool and Int.
        // Match exact Swift types first, then inspect Foundation numbers by CF type.
        // A cast-only switch can encode integer 0/1 as false/true and corrupt an
        // outbox payload while it is written to disk.
        if type(of: v) == Bool.self, let b = v as? Bool {
            try c.encode(b)
        } else if type(of: v) == Int.self, let i = v as? Int {
            try c.encode(i)
        } else if type(of: v) == Int8.self, let i = v as? Int8 {
            try c.encode(i)
        } else if type(of: v) == Int16.self, let i = v as? Int16 {
            try c.encode(i)
        } else if type(of: v) == Int32.self, let i = v as? Int32 {
            try c.encode(i)
        } else if type(of: v) == Int64.self, let i = v as? Int64 {
            try c.encode(i)
        } else if type(of: v) == UInt.self, let i = v as? UInt {
            try c.encode(i)
        } else if type(of: v) == UInt8.self, let i = v as? UInt8 {
            try c.encode(i)
        } else if type(of: v) == UInt16.self, let i = v as? UInt16 {
            try c.encode(i)
        } else if type(of: v) == UInt32.self, let i = v as? UInt32 {
            try c.encode(i)
        } else if type(of: v) == UInt64.self, let i = v as? UInt64 {
            try c.encode(i)
        } else if type(of: v) == Double.self, let d = v as? Double {
            try c.encode(d)
        } else if type(of: v) == Float.self, let d = v as? Float {
            try c.encode(d)
        } else if let n = v as? NSNumber {
            if CFGetTypeID(n) == CFBooleanGetTypeID() {
                try c.encode(n.boolValue)
            } else if ["f", "d"].contains(String(cString: n.objCType)) {
                try c.encode(n.doubleValue)
            } else {
                try c.encode(n.int64Value)
            }
        } else if let s = v as? String {
            try c.encode(s)
        } else if v is NSNull {
            try c.encodeNil()
        } else if let a = v as? [Any] {
            try c.encode(a.map { AnyCodable($0) })
        } else if let d = v as? [String: Any] {
            try c.encode(d.mapValues { AnyCodable($0) })
        } else {
            throw EncodingError.invalidValue(
                v,
                EncodingError.Context(
                    codingPath: encoder.codingPath,
                    debugDescription: "AnyCodable refuses to silently replace an unsupported value with null"
                )
            )
        }
    }

    static func == (lhs: AnyCodable, rhs: AnyCodable) -> Bool {
        // Compare via stableJson
        return stableJson(lhs.value) == stableJson(rhs.value)
    }
}

// MARK: - Push/ Pull types

struct PushResult: Codable, Equatable, Sendable {
    var mutationId: String
    var accepted: Bool
    var serverVersion: Int
    var replayMismatch: Bool?
    var serverMissing: Bool?
    var conflictId: String?
    var record: RemoteRecord?
}

struct RemoteRecord: Codable, Equatable, Sendable {
    var entityType: String
    var entityId: String
    var version: Int
    var serverVersion: Int
    var deviceId: String?
    var payload: AnyCodable
    var updatedAt: String?
    var deletedAt: String?
}

struct StagedEntityChange: Sendable {
    var mutationId: String
    var entityType: String
    var entityId: String
    var payload: Any? // Any JSON value
    var updatedAt: String
    var deletedAt: String?
}

struct StagedLocalTransaction: Sendable {
    var id: String
    var userKey: String
    var storeName: String
    var storageKey: String
    var previousValue: Any?
    var hasPreviousValue: Bool
    var value: Any?
    var changes: [StagedEntityChange]
    var order: Int
    var createdAt: String
}
