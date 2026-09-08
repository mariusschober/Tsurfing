import Foundation
import CryptoKit

/// Private causal journal for one account. Mirrors the Android native journal
/// (`NativeCausalJournal.validate`, `NativeCausalStore.enable`) and the Web
/// fenced tracking authority: the original tracking payload is preserved
/// verbatim as cutover evidence, admissions are never inferred, and
/// validation fails closed without deleting anything.
struct CausalJournalState: Codable, Equatable, Sendable {
    var schemaVersion: Int
    var accountId: String
    var generation: Int
    var trackingPresent: Bool
    var trackingValue: AnyCodable?
    var cutoverTracking: AnyCodable?
    var focus: [String: AnyCodable]
    var focusAdmissions: [String: AnyCodable]
    var focusOutbox: [String: AnyCodable]
    var counterAdmissions: [String: AnyCodable]
    var counterOutbox: [String: AnyCodable]
    var counterDayAdmissions: [String: AnyCodable]
    var counterDayOutbox: [String: AnyCodable]
    var counterBaselines: [String: AnyCodable]
    var taskCompletionAdmissions: [String: AnyCodable]
}

/// File + UserDefaults replicas with canonical-JSON drift repair, mirroring
/// `SyncMetaStore`. Replicas never delete each other; damage throws.
final class CausalJournalStore: @unchecked Sendable {
    private static let persistenceLock = NSRecursiveLock()
    let accountId: String
    let fileURL: URL
    private let mirrorKey: String
    private let defaults: UserDefaults
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder

    init(
        accountId: String,
        directory: URL? = nil,
        defaults: UserDefaults = .standard
    ) throws {
        guard UUID(uuidString: accountId) != nil else {
            throw SyncError.validation("The causal account identity is invalid. Nothing was prepared.")
        }
        self.accountId = accountId.lowercased()
        let base = directory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        let dir = base.appendingPathComponent("com.mariusschober.GoalflowMac", isDirectory: true)
        self.fileURL = dir.appendingPathComponent("causal-\(self.accountId).json")
        self.mirrorKey = "goalflow.causal.\(self.accountId)"
        self.defaults = defaults
        encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]; encoder.dateEncodingStrategy = .iso8601
        decoder = JSONDecoder(); decoder.dateDecodingStrategy = .iso8601
    }

    /// Validates identity, schema, generation, cutover preservation and the
    /// focus journal shape. Timeline replay validation arrives with admission.
    static func validate(_ state: CausalJournalState) throws {
        guard state.schemaVersion == 1,
              UUID(uuidString: state.accountId) != nil,
              state.generation >= 0 else {
            throw SyncError.corruptStorage("The causal journal identity is damaged. Nothing was discarded; recovery requires operator review.")
        }
        if !state.trackingPresent {
            guard state.trackingValue?.value == nil else {
                throw SyncError.corruptStorage("Recorded tracking absence carries a value. Nothing was discarded; recovery requires operator review.")
            }
        } else {
            guard let tracking = state.trackingValue?.value as? [String: Any] else {
                throw SyncError.corruptStorage("Retained causal tracking is missing. Nothing was discarded; recovery requires operator review.")
            }
            _ = try initialFocusJournal(accountId: state.accountId, baseline: tracking["focusSession"])
        }
        let focus = Dictionary(uniqueKeysWithValues: state.focus.map { ($0.key, $0.value.value ?? NSNull()) })
        guard focus["schemaVersion"] as? Int == 1,
              focus["accountId"] as? String == state.accountId,
              focus["sessions"] is [String: Any], focus["operations"] is [String: Any] else {
            throw SyncError.corruptStorage("The causal focus journal is damaged. Nothing was discarded; recovery requires operator review.")
        }
        let expected = try initialFocusJournal(accountId: state.accountId,
            baseline: (state.trackingValue?.value as? [String: Any])?["focusSession"])
        guard stableJson(focus) == stableJson(expected) else {
            throw SyncError.corruptStorage("The causal focus journal differs from its admissions. Nothing was discarded; recovery requires operator review.")
        }
        let hasAdmissions = !state.focusAdmissions.isEmpty || !state.focusOutbox.isEmpty
            || !state.counterAdmissions.isEmpty || !state.counterOutbox.isEmpty
            || !state.counterDayAdmissions.isEmpty || !state.counterDayOutbox.isEmpty
            || !state.taskCompletionAdmissions.isEmpty
        if !hasAdmissions {
            // Before any admission, the projection is exactly the preserved
            // cutover. Counter-level replay validation arrives with admission.
            guard stableJson(state.trackingValue?.value) == stableJson(state.cutoverTracking?.value) else {
                throw SyncError.corruptStorage("Retained causal tracking differs from its cutover evidence. Nothing was discarded; recovery requires operator review.")
            }
        }
    }

    static func initialFocusJournal(accountId: String, baseline: Any?) throws -> [String: Any] {
        if baseline == nil || baseline is NSNull { return try CausalFocus.initial(accountID: accountId, baseline: nil) }
        guard let session = baseline as? [String: Any] else {
            throw SyncError.corruptStorage("The retained focus baseline is damaged. Nothing was discarded; recovery requires operator review.")
        }
        return try CausalFocus.initial(accountID: accountId, baseline: session)
    }

    /// Prepares the journal, preserving the current tracking payload verbatim
    /// as cutover evidence (or recording its absence). Idempotent: an existing
    /// valid journal is returned unchanged, never rebound or rewritten.
    func prepare(tracking: [String: Any]?) throws -> CausalJournalState {
        try Self.withLock {
            if let existing = try loadWithoutValidation() {
                try Self.validate(existing)
                return existing
            }
            let focus = try Self.initialFocusJournal(accountId: accountId, baseline: tracking?["focusSession"])
            let state = CausalJournalState(
                schemaVersion: 1, accountId: accountId, generation: 0,
                trackingPresent: tracking != nil,
                trackingValue: tracking.map(AnyCodable.init),
                cutoverTracking: tracking.map(AnyCodable.init),
                focus: Dictionary(uniqueKeysWithValues: focus.map { ($0.key, AnyCodable($0.value)) }),
                focusAdmissions: [:], focusOutbox: [:],
                counterAdmissions: [:], counterOutbox: [:],
                counterDayAdmissions: [:], counterDayOutbox: [:],
                counterBaselines: [:], taskCompletionAdmissions: [:]
            )
            try save(state)
            return state
        }
    }

    func load() throws -> CausalJournalState? {
        try Self.withLock {
            guard let state = try loadWithoutValidation() else { return nil }
            try Self.validate(state)
            return state
        }
    }

    func save(_ state: CausalJournalState) throws {
        try Self.validate(state)
        guard state.accountId == accountId else {
            throw SyncError.validation("The causal journal belongs to another account. Nothing was saved.")
        }
        try Self.withLock {
            let data = try encoder.encode(state)
            try ensureDirectory()
            do { try data.write(to: fileURL, options: [.atomic]) }
            catch { throw SyncError.writeFailed("the causal journal could not be written") }
            guard (try? Data(contentsOf: fileURL)) == data else { throw SyncError.readBackMismatch }
            defaults.set(data, forKey: mirrorKey)
            guard defaults.synchronize(), defaults.data(forKey: mirrorKey) == data else {
                throw SyncError.writeFailed("the causal journal mirror did not become durable")
            }
        }
    }

    private func loadWithoutValidation() throws -> CausalJournalState? {
        let fileExists = FileManager.default.fileExists(atPath: fileURL.path)
        let fileData: Data? = fileExists ? try? Data(contentsOf: fileURL) : nil
        let mirrorData = defaults.data(forKey: mirrorKey)
        if let fileData, let state = try? decoder.decode(CausalJournalState.self, from: fileData) {
            let canonical = try encoder.encode(state)
            if fileData != canonical || mirrorData != canonical { try writeReplicas(canonical) }
            return state
        }
        if let mirrorData, let state = try? decoder.decode(CausalJournalState.self, from: mirrorData) {
            try writeReplicas(try encoder.encode(state))
            return state
        }
        if !fileExists && mirrorData == nil { return nil }
        throw SyncError.corruptStorage("The causal journal is damaged. Nothing was discarded; recovery requires operator review.")
    }

    private func writeReplicas(_ data: Data) throws {
        try ensureDirectory()
        do { try data.write(to: fileURL, options: [.atomic]) }
        catch { throw SyncError.writeFailed("the causal journal could not be written") }
        guard (try? Data(contentsOf: fileURL)) == data else { throw SyncError.readBackMismatch }
        defaults.set(data, forKey: mirrorKey)
        guard defaults.synchronize(), defaults.data(forKey: mirrorKey) == data else {
            throw SyncError.writeFailed("the causal journal mirror did not become durable")
        }
    }

    private func ensureDirectory() throws {
        let dir = fileURL.deletingLastPathComponent()
        if !FileManager.default.fileExists(atPath: dir.path) {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        }
    }

    private static func withLock<Value>(_ body: () throws -> Value) rethrows -> Value {
        persistenceLock.lock()
        defer { persistenceLock.unlock() }
        return try body()
    }
}
