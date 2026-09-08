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
    var causalRequests: [String: AnyCodable]
    var causalReceipts: [String: AnyCodable]

    enum CodingKeys: String, CodingKey {
        case schemaVersion, accountId, generation, trackingPresent, trackingValue
        case cutoverTracking, focus, focusAdmissions, focusOutbox
        case counterAdmissions, counterOutbox, counterDayAdmissions, counterDayOutbox
        case counterBaselines, taskCompletionAdmissions, causalRequests, causalReceipts
    }

    init(schemaVersion: Int, accountId: String, generation: Int, trackingPresent: Bool,
         trackingValue: AnyCodable?, cutoverTracking: AnyCodable?,
         focus: [String: AnyCodable], focusAdmissions: [String: AnyCodable], focusOutbox: [String: AnyCodable],
         counterAdmissions: [String: AnyCodable], counterOutbox: [String: AnyCodable],
         counterDayAdmissions: [String: AnyCodable], counterDayOutbox: [String: AnyCodable],
         counterBaselines: [String: AnyCodable], taskCompletionAdmissions: [String: AnyCodable],
         causalRequests: [String: AnyCodable], causalReceipts: [String: AnyCodable]) {
        self.schemaVersion = schemaVersion; self.accountId = accountId; self.generation = generation
        self.trackingPresent = trackingPresent; self.trackingValue = trackingValue; self.cutoverTracking = cutoverTracking
        self.focus = focus; self.focusAdmissions = focusAdmissions; self.focusOutbox = focusOutbox
        self.counterAdmissions = counterAdmissions; self.counterOutbox = counterOutbox
        self.counterDayAdmissions = counterDayAdmissions; self.counterDayOutbox = counterDayOutbox
        self.counterBaselines = counterBaselines; self.taskCompletionAdmissions = taskCompletionAdmissions
        self.causalRequests = causalRequests; self.causalReceipts = causalReceipts
    }

    init(from decoder: Decoder) throws {
        let box = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = try box.decode(Int.self, forKey: .schemaVersion)
        accountId = try box.decode(String.self, forKey: .accountId)
        generation = try box.decode(Int.self, forKey: .generation)
        trackingPresent = try box.decode(Bool.self, forKey: .trackingPresent)
        trackingValue = try box.decodeIfPresent(AnyCodable.self, forKey: .trackingValue)
        cutoverTracking = try box.decodeIfPresent(AnyCodable.self, forKey: .cutoverTracking)
        focus = try box.decode([String: AnyCodable].self, forKey: .focus)
        focusAdmissions = try box.decodeIfPresent([String: AnyCodable].self, forKey: .focusAdmissions) ?? [:]
        focusOutbox = try box.decodeIfPresent([String: AnyCodable].self, forKey: .focusOutbox) ?? [:]
        counterAdmissions = try box.decodeIfPresent([String: AnyCodable].self, forKey: .counterAdmissions) ?? [:]
        counterOutbox = try box.decodeIfPresent([String: AnyCodable].self, forKey: .counterOutbox) ?? [:]
        counterDayAdmissions = try box.decodeIfPresent([String: AnyCodable].self, forKey: .counterDayAdmissions) ?? [:]
        counterDayOutbox = try box.decodeIfPresent([String: AnyCodable].self, forKey: .counterDayOutbox) ?? [:]
        counterBaselines = try box.decodeIfPresent([String: AnyCodable].self, forKey: .counterBaselines) ?? [:]
        taskCompletionAdmissions = try box.decodeIfPresent([String: AnyCodable].self, forKey: .taskCompletionAdmissions) ?? [:]
        causalRequests = try box.decodeIfPresent([String: AnyCodable].self, forKey: .causalRequests) ?? [:]
        causalReceipts = try box.decodeIfPresent([String: AnyCodable].self, forKey: .causalReceipts) ?? [:]
    }
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

    /// Validates identity, schema, generation and cutover preservation, then
    /// replays focus admissions in sequence order from the cutover baseline
    /// and requires the stored journal and tracking projection to match.
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
            guard state.trackingValue?.value is [String: Any] else {
                throw SyncError.corruptStorage("Retained causal tracking is missing. Nothing was discarded; recovery requires operator review.")
            }
        }
        let focus = Dictionary(uniqueKeysWithValues: state.focus.map { ($0.key, $0.value.value ?? NSNull()) })
        guard focus["schemaVersion"] as? Int == 1,
              focus["accountId"] as? String == state.accountId,
              focus["sessions"] is [String: Any], focus["operations"] is [String: Any] else {
            throw SyncError.corruptStorage("The causal focus journal is damaged. Nothing was discarded; recovery requires operator review.")
        }
        var admissions: [(sequence: Int, id: String, command: [String: Any])] = []
        for (id, raw) in state.focusAdmissions {
            guard let entry = raw.value as? [String: Any],
                  let sequence = entry["sequence"] as? Int, sequence >= 1,
                  let command = entry["command"] as? [String: Any] else {
                throw SyncError.corruptStorage("A focus admission is damaged. Nothing was discarded; recovery requires operator review.")
            }
            admissions.append((sequence, id, command))
        }
        var counterEvents: [(sequence: Int, event: [String: Any])] = []
        for (id, raw) in state.counterAdmissions {
            guard let entry = raw.value as? [String: Any],
                  let sequence = entry["sequence"] as? Int, sequence >= 1,
                  let event = entry["event"] as? [String: Any],
                  event["actionId"] as? String == id else {
                throw SyncError.corruptStorage("A counter admission is damaged. Nothing was discarded; recovery requires operator review.")
            }
            counterEvents.append((sequence, event))
        }
        var dayCommands: [(sequence: Int, id: String, command: [String: Any])] = []
        for (id, raw) in state.counterDayAdmissions {
            guard let entry = raw.value as? [String: Any],
                  let sequence = entry["sequence"] as? Int, sequence >= 1,
                  let command = entry["command"] as? [String: Any],
                  command["actionId"] as? String == id else {
                throw SyncError.corruptStorage("A day admission is damaged. Nothing was discarded; recovery requires operator review.")
            }
            dayCommands.append((sequence, id, command))
        }
        let usedSequences = (admissions.map(\.sequence) + counterEvents.map(\.sequence) + dayCommands.map(\.sequence)).sorted()
        // One shared generation sequence across admission kinds.
        let expectedSequence: [Int] = state.generation == 0 ? [] : Array(1...state.generation)
        guard usedSequences == expectedSequence else {
            throw SyncError.corruptStorage("The causal admission sequence is incomplete. Nothing was discarded; recovery requires operator review.")
        }
        for (id, raw) in state.causalRequests {
            guard raw.value is String else {
                throw SyncError.corruptStorage("A saved causal request is damaged. Nothing was discarded; recovery requires operator review.")
            }
        }
        for (id, raw) in state.causalReceipts {
            guard raw.value is [String: Any], state.causalRequests[id] != nil else {
                throw SyncError.corruptStorage("A causal receipt has no original request. Nothing was discarded; recovery requires operator review.")
            }
        }
        let cutover = state.cutoverTracking?.value as? [String: Any]
        var replay = try initialFocusJournal(accountId: state.accountId, baseline: cutover?["focusSession"])
        admissions.sort { $0.sequence < $1.sequence }
        for admission in admissions {
            replay = try CausalFocus.apply(replay, command: admission.command).journal
        }
        guard stableJson(focus) == stableJson(replay) else {
            throw SyncError.corruptStorage("The causal focus journal differs from its admissions. Nothing was discarded; recovery requires operator review.")
        }
        // Project counters per established day and require the current
        // tracking day to match. Days without a baseline stay retained.
        var baselines: [String: [String: Any]] = [:]
        for raw in state.counterBaselines.values {
            guard let baseline = raw.value as? [String: Any],
                  let day = baseline["day"] as? String else {
                throw SyncError.corruptStorage("A counter baseline is damaged. Nothing was discarded; recovery requires operator review.")
            }
            baselines[day] = baseline
        }
        var eventsByDay: [String: [[String: Any]]] = [:]
        for event in counterEvents.sorted(by: { $0.sequence < $1.sequence }).map(\.event) {
            guard let day = event["day"] as? String else {
                throw SyncError.corruptStorage("A counter admission is damaged. Nothing was discarded; recovery requires operator review.")
            }
            eventsByDay[day, default: []].append(event)
        }
        if let tracking = state.trackingValue?.value as? [String: Any],
           let date = tracking["date"] as? String,
           let baseline = baselines[date] {
            let projected = try CounterLedger.project(baseline: baseline, events: eventsByDay[date] ?? [])
            guard (projected["planViewCount"] as? Int) == (tracking["planViewCount"] as? Int),
                  (projected["dailyPostponeCount"] as? Int) == (tracking["dailyPostponeCount"] as? Int) else {
                throw SyncError.corruptStorage("Retained causal counters differ from their evidence. Nothing was discarded; recovery requires operator review.")
            }
        }
        if admissions.isEmpty && counterEvents.isEmpty && dayCommands.isEmpty {
            // Before any admission, the projection is exactly the preserved
            // cutover.
            guard stableJson(state.trackingValue?.value) == stableJson(state.cutoverTracking?.value) else {
                throw SyncError.corruptStorage("Retained causal tracking differs from its cutover evidence. Nothing was discarded; recovery requires operator review.")
            }
        } else if let sessions = replay["sessions"] as? [String: Any] {
            let current = (replay["currentSessionId"] as? String).flatMap { sessions[$0] as? [String: Any] }
            let expected = current?["projection"]
            let actual = (state.trackingValue?.value as? [String: Any])?["focusSession"]
            guard stableJson(actual) == stableJson(expected) else {
                throw SyncError.corruptStorage("Retained causal tracking differs from its journal. Nothing was discarded; recovery requires operator review.")
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
                counterBaselines: [:], taskCompletionAdmissions: [:],
                causalRequests: [:], causalReceipts: [:]
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

    struct FocusAdmission {
        let tracking: [String: Any]
        let outcome: [String: Any]
        let duplicate: Bool
        let generation: Int
    }

    /// Admits one focus command: validates, resolves the actual parent and
    /// epoch inside this transaction, applies through `CausalFocus`, and
    /// persists journal, projection, outbox and generation together. The
    /// caller supplies intent fields except `expectedRevision`,
    /// `expectedCurrentSessionId` and `epoch`, which are derived
    /// authoritatively here. `taskOpen` answers current task eligibility;
    /// bare `complete` requires the atomic task coordinator (later slice).
    func admitFocus(_ intent: [String: Any], taskOpen: (String) -> Bool) throws -> FocusAdmission {
        try Self.withLock {
            guard var state = try loadWithoutValidation() else {
                throw SyncError.validation("Causal account preparation is required. Nothing was admitted.")
            }
            try Self.validate(state)
            guard let actionId = intent["actionId"] as? String, ActionJSON.identity(actionId),
                  let kind = intent["kind"] as? String,
                  let sessionId = intent["sessionId"] as? String, ActionJSON.identity(sessionId),
                  let taskId = intent["taskId"] as? String, !taskId.isEmpty,
                  let capturedAt = intent["capturedAt"] as? String, ActionJSON.instant(capturedAt) else {
                throw SyncError.validation("The focus intent is invalid. Nothing was admitted.")
            }
            guard kind != "complete" else {
                throw SyncError.validation("Completion requires the atomic task coordinator. Nothing was admitted.")
            }
            var journal = Dictionary(uniqueKeysWithValues: state.focus.map { ($0.key, $0.value.value ?? NSNull()) })
            let operations = journal["operations"] as? [String: Any] ?? [:]
            func core(_ command: [String: Any]) -> [String: Any] {
                command.filter { $0.key != "expectedRevision" && $0.key != "expectedCurrentSessionId" && $0.key != "epoch" }
            }
            if let prior = operations[actionId] as? [String: Any] {
                var candidate = intent
                candidate["accountId"] = state.accountId
                candidate["schemaVersion"] = 1
                guard let priorCommand = prior["command"] as? [String: Any],
                      stableJson(core(priorCommand)) == stableJson(core(candidate)),
                      let outcome = prior["outcome"] as? [String: Any] else {
                    throw SyncError.validation("The focus action identity has different intent. Nothing was admitted.")
                }
                guard let tracking = state.trackingValue?.value as? [String: Any] else {
                    throw SyncError.corruptStorage("Retained causal tracking is missing. Nothing was admitted.")
                }
                return FocusAdmission(tracking: tracking, outcome: outcome, duplicate: true, generation: state.generation)
            }
            let crossKindMaps: [[String: AnyCodable]] = [state.counterAdmissions, state.counterDayAdmissions, state.taskCompletionAdmissions]
            if crossKindMaps.contains(where: { $0[actionId] != nil }) {
                throw SyncError.validation("The focus action identity is already in use. Nothing was admitted.")
            }
            if ["start", "resume", "extendAndResume"].contains(kind) {
                guard taskOpen(taskId) else {
                    throw SyncError.validation("The focus task is no longer eligible. Nothing was admitted.")
                }
            }
            let sessions = journal["sessions"] as? [String: Any] ?? [:]
            let parent: [String: Any]? = if kind == "start" {
                (journal["currentSessionId"] as? String).flatMap { sessions[$0] as? [String: Any] }
            } else {
                sessions[sessionId] as? [String: Any]
            }
            var command = intent
            command["expectedRevision"] = parent?["revision"] ?? NSNull()
            command["expectedCurrentSessionId"] = journal["currentSessionId"] ?? NSNull()
            if kind == "start" {
                command["epoch"] = actionId
            } else {
                command["epoch"] = parent?["epoch"] ?? sessionId
            }
            command["accountId"] = state.accountId
            command["schemaVersion"] = 1
            let reply = try CausalFocus.apply(journal, command: command)
            let stored = reply.journal
            let generation = state.generation + 1
            guard generation <= ActionJSON.maxSafeInteger else {
                throw SyncError.validation("Local causal generation exhausted. Nothing was admitted.")
            }
            state.focus = Dictionary(uniqueKeysWithValues: stored.map { ($0.key, AnyCodable($0.value)) })
            state.focusAdmissions[actionId] = AnyCodable(["command": command, "sequence": generation])
            let accepted = (reply.outcome["accepted"] as? Bool) == true
            if accepted {
                state.focusOutbox[actionId] = AnyCodable(command)
                if var tracking = state.trackingValue?.value as? [String: Any],
                   let projection = (stored["sessions"] as? [String: Any])?[sessionId] as? [String: Any],
                   let updated = projection["projection"] {
                    tracking["focusSession"] = updated
                    state.trackingValue = AnyCodable(tracking)
                }
            }
            state.generation = generation
            try save(state)
            guard let tracking = state.trackingValue?.value as? [String: Any] else {
                throw SyncError.corruptStorage("The admitted focus projection is damaged. Nothing was admitted.")
            }
            return FocusAdmission(tracking: tracking, outcome: reply.outcome, duplicate: false, generation: generation)
        }
    }

    struct CounterDayAdmission {
        let outcome: [String: Any]
        let duplicate: Bool
        let generation: Int
    }

    struct CounterAdmission {
        let tracking: [String: Any]?
        let outcome: [String: Any]
        let duplicate: Bool
        let generation: Int
    }

    struct ReceiptApplication {
        let duplicate: Bool
        let accepted: Bool
    }

    private func pendingCommand(_ state: CausalJournalState, _ actionId: String) -> (kind: String, command: [String: Any])? {
        if let raw = state.focusOutbox[actionId]?.value as? [String: Any] { return ("focus", raw) }
        if let raw = state.counterOutbox[actionId]?.value as? [String: Any] { return ("counter", raw) }
        if let raw = state.counterDayOutbox[actionId]?.value as? [String: Any] { return ("counterDay", raw) }
        return nil
    }

    /// Persists exact wire bytes for an admitted command before transport.
    /// Bytes are immutable across retry: re-saving different bytes fails.
    /// Never retires anything and never touches projections or cursors.
    func saveRequest(actionId: String, bytes: Data) throws -> [String: Any] {
        guard let text = String(data: bytes, encoding: .utf8),
              let parsed = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              let operation = parsed as? [String: Any],
              let type = operation["type"] as? String, ["focus", "counter", "counterDay"].contains(type),
              let command = operation["command"] as? [String: Any],
              command["actionId"] as? String == actionId,
              let epoch = operation["epoch"] as? String, UUID(uuidString: epoch) != nil,
              operation["schemaVersion"] as? Int == 2 else {
            throw SyncError.validation("The saved causal request does not prove its admitted command. Nothing was saved.")
        }
        return try Self.withLock {
            guard var state = try loadWithoutValidation() else {
                throw SyncError.validation("Causal account preparation is required. Nothing was saved.")
            }
            try Self.validate(state)
            guard state.accountId == accountId else {
                throw SyncError.validation("The causal request belongs to another account. Nothing was saved.")
            }
            guard let pending = pendingCommand(state, actionId),
                  pending.kind == type,
                  stableJson(pending.command) == stableJson(command) else {
                throw SyncError.validation("The saved causal request differs from its durable admission. Nothing was saved.")
            }
            if let existing = state.causalRequests[actionId]?.value as? String {
                guard existing == text else {
                    throw SyncError.validation("The attempted causal request was rewritten. Original bytes are retained.")
                }
                return operation
            }
            state.causalRequests[actionId] = AnyCodable(text)
            try save(state)
            return operation
        }
    }

    /// Archives a validated receipt and retires its accepted outbox entry in
    /// one persist. Rejected receipts keep their pending intent for explicit
    /// resolution. Transport success alone never calls this.
    func commitReceipt(actionId: String, receipt: [String: Any]) throws -> ReceiptApplication {
        try Self.withLock {
            guard var state = try loadWithoutValidation() else {
                throw SyncError.validation("Causal account preparation is required. Nothing was retired.")
            }
            try Self.validate(state)
            guard state.accountId == accountId else {
                throw SyncError.validation("The causal receipt belongs to another account. Nothing was retired.")
            }
            if let prior = state.causalReceipts[actionId]?.value as? [String: Any] {
                guard stableJson(prior) == stableJson(receipt) else {
                    throw SyncError.validation("The original causal receipt is immutable. Nothing was retired.")
                }
                return ReceiptApplication(duplicate: true, accepted: (prior["accepted"] as? Bool) == true)
            }
            guard let saved = state.causalRequests[actionId]?.value as? String,
                  let savedData = saved.data(using: .utf8),
                  let operation = try? JSONSerialization.jsonObject(with: savedData) as? [String: Any] else {
                throw SyncError.validation("The causal receipt has no original request. Nothing was retired.")
            }
            try CausalReceiptValidator.assert(operation: operation, receipt: receipt, accountId: state.accountId)
            guard pendingCommand(state, actionId) != nil else {
                throw SyncError.validation("The receipt has no pending intent. Nothing was retired.")
            }
            state.causalReceipts[actionId] = AnyCodable(receipt)
            if (receipt["accepted"] as? Bool) == true {
                state.focusOutbox.removeValue(forKey: actionId)
                state.counterOutbox.removeValue(forKey: actionId)
                state.counterDayOutbox.removeValue(forKey: actionId)
            }
            try save(state)
            return ReceiptApplication(duplicate: false, accepted: (receipt["accepted"] as? Bool) == true)
        }
    }

    private static let counters = ["planViewCount", "dailyPostponeCount"]

    private static func validateDayCommand(_ command: [String: Any], accountId: String) throws {
        guard ActionJSON.integer(command["schemaVersion"]) == 1,
              ActionJSON.identity(command["actionId"]), command["accountId"] as? String == accountId,
              let actor = command["actorId"] as? String, (1...240).contains(actor.utf16.count),
              let kind = command["kind"] as? String, ["establish", "select"].contains(kind),
              ActionJSON.day(command["day"]),
              let zone = command["timeZone"] as? String,
              zone.range(of: "^[A-Za-z0-9_+./-]{1,128}$", options: .regularExpression) != nil,
              ActionJSON.instant(command["capturedAt"]) else {
            throw SyncError.validation("The day intent is invalid. Nothing was admitted.")
        }
    }

    private static func validateCounterEvent(_ event: [String: Any], accountId: String) throws {
        guard ActionJSON.integer(event["schemaVersion"]) == 1,
              ActionJSON.identity(event["actionId"]), event["accountId"] as? String == accountId,
              let actor = event["actorId"] as? String, (1...240).contains(actor.utf16.count),
              ActionJSON.day(event["day"]),
              let zone = event["timeZone"] as? String,
              zone.range(of: "^[A-Za-z0-9_+./-]{1,128}$", options: .regularExpression) != nil,
              let counter = event["counter"] as? String, counters.contains(counter),
              let delta = ActionJSON.integer(event["delta"]), delta != 0,
              ActionJSON.instant(event["capturedAt"]),
              event["businessActionId"] == nil || event["businessActionId"] is NSNull || ActionJSON.identity(event["businessActionId"]),
              (event["correctionOf"] == nil || event["correctionOf"] is NSNull ? delta == 1 : ActionJSON.identity(event["correctionOf"])) else {
            throw SyncError.validation("The counter event is invalid. Nothing was admitted.")
        }
    }

    /// Admits a day selection. `establish` records the current tracking
    /// counts as the day baseline; a second baseline for the same day fails
    /// closed. `select` records intent without projecting: verified history
    /// settles unknown days in a later slice.
    func admitCounterDay(_ command: [String: Any], actorId: String) throws -> CounterDayAdmission {
        try Self.withLock {
            guard var state = try loadWithoutValidation() else {
                throw SyncError.validation("Causal account preparation is required. Nothing was admitted.")
            }
            try Self.validate(state)
            guard state.accountId == accountId,
                  var intent = command as? [String: Any],
                  let actionId = intent["actionId"] as? String, ActionJSON.identity(actionId),
                  let kind = intent["kind"] as? String else {
                throw SyncError.validation("The day intent is invalid. Nothing was admitted.")
            }
            intent["accountId"] = state.accountId
            intent["actorId"] = actorId
            intent["schemaVersion"] = 1
            try Self.validateDayCommand(intent, accountId: state.accountId)
            let day = intent["day"] as! String
            if let prior = state.counterDayAdmissions[actionId]?.value as? [String: Any] {
                guard let priorCommand = prior["command"] as? [String: Any],
                      stableJson(priorCommand) == stableJson(intent) else {
                    throw SyncError.validation("The day action identity has different intent. Nothing was admitted.")
                }
                return CounterDayAdmission(
                    outcome: ["accepted": true, "baselinePending": state.counterBaselines[day] == nil] as [String: Any],
                    duplicate: true, generation: state.generation)
            }
            for map in [state.focusAdmissions, state.counterAdmissions, state.taskCompletionAdmissions] {
                if map[actionId] != nil {
                    throw SyncError.validation("The day action identity is already in use. Nothing was admitted.")
                }
            }
            if kind == "establish" {
                guard state.counterBaselines[day] == nil else {
                    throw SyncError.validation("The day baseline is already established. Nothing was admitted.")
                }
                guard let tracking = state.trackingValue?.value as? [String: Any] else {
                    throw SyncError.validation("Day establishment requires retained tracking. Nothing was admitted.")
                }
                let counts: [String: Any] = [
                    "planViewCount": (tracking["planViewCount"] as? Int) ?? 0,
                    "dailyPostponeCount": (tracking["dailyPostponeCount"] as? Int) ?? 0
                ]
                state.counterBaselines[day] = AnyCodable([
                    "schemaVersion": 1, "baselineId": actionId, "accountId": state.accountId,
                    "day": day, "counts": counts, "evidenceIds": []
                ] as [String: Any])
            }
            let generation = state.generation + 1
            guard generation <= ActionJSON.maxSafeInteger else {
                throw SyncError.validation("Local causal generation exhausted. Nothing was admitted.")
            }
            state.counterDayAdmissions[actionId] = AnyCodable(["command": intent, "sequence": generation])
            state.counterDayOutbox[actionId] = AnyCodable(intent)
            state.generation = generation
            try save(state)
            return CounterDayAdmission(
                outcome: ["accepted": true, "baselinePending": state.counterBaselines[day] == nil] as [String: Any],
                duplicate: false, generation: generation)
        }
    }

    /// Admits one counter increment. With an established baseline the counts
    /// project atomically; otherwise the event is retained with
    /// `baselinePending` and no invented zero baseline.
    func admitCounter(_ event: [String: Any], actorId: String) throws -> CounterAdmission {
        try Self.withLock {
            guard var state = try loadWithoutValidation() else {
                throw SyncError.validation("Causal account preparation is required. Nothing was admitted.")
            }
            try Self.validate(state)
            guard state.accountId == accountId,
                  var delta = event as? [String: Any],
                  let actionId = delta["actionId"] as? String, ActionJSON.identity(actionId) else {
                throw SyncError.validation("The counter event is invalid. Nothing was admitted.")
            }
            delta["accountId"] = state.accountId
            delta["actorId"] = actorId
            delta["schemaVersion"] = 1
            if delta["businessActionId"] == nil { delta["businessActionId"] = NSNull() }
            if delta["correctionOf"] == nil { delta["correctionOf"] = NSNull() }
            try Self.validateCounterEvent(delta, accountId: state.accountId)
            let day = delta["day"] as! String
            if let prior = state.counterAdmissions[actionId]?.value as? [String: Any] {
                guard let priorEvent = prior["event"] as? [String: Any],
                      stableJson(priorEvent) == stableJson(delta) else {
                    throw SyncError.validation("The counter action identity has different intent. Nothing was admitted.")
                }
                var tracking: [String: Any]? = nil
                if state.counterBaselines[day] != nil {
                    tracking = state.trackingValue?.value as? [String: Any]
                }
                return CounterAdmission(tracking: tracking,
                    outcome: ["accepted": true, "baselinePending": state.counterBaselines[day] == nil] as [String: Any],
                    duplicate: true, generation: state.generation)
            }
            for map in [state.focusAdmissions, state.counterDayAdmissions, state.taskCompletionAdmissions] {
                if map[actionId] != nil {
                    throw SyncError.validation("The counter action identity is already in use. Nothing was admitted.")
                }
            }
            let generation = state.generation + 1
            guard generation <= ActionJSON.maxSafeInteger else {
                throw SyncError.validation("Local causal generation exhausted. Nothing was admitted.")
            }
            state.counterAdmissions[actionId] = AnyCodable(["event": delta, "sequence": generation])
            state.counterOutbox[actionId] = AnyCodable(delta)
            var tracking: [String: Any]? = nil
            if let baseline = state.counterBaselines[day]?.value as? [String: Any] {
                var dayEvents: [[String: Any]] = []
                for raw in state.counterAdmissions.values {
                    guard let entry = raw.value as? [String: Any],
                          let sequence = entry["sequence"] as? Int,
                          let candidate = entry["event"] as? [String: Any],
                          candidate["day"] as? String == day else { continue }
                    dayEvents.append(["sequence": sequence, "event": candidate])
                }
                dayEvents.sort { ($0["sequence"] as! Int) < ($1["sequence"] as! Int) }
                let projected = try CounterLedger.project(baseline: baseline, events: dayEvents.map { $0["event"]! })
                guard var current = state.trackingValue?.value as? [String: Any],
                      let plans = projected["planViewCount"] as? Int,
                      let postpones = projected["dailyPostponeCount"] as? Int else {
                    throw SyncError.corruptStorage("Retained causal tracking is missing. Nothing was admitted.")
                }
                current["planViewCount"] = plans
                current["dailyPostponeCount"] = postpones
                state.trackingValue = AnyCodable(current)
                tracking = current
            }
            state.generation = generation
            try save(state)
            return CounterAdmission(tracking: tracking,
                outcome: ["accepted": true, "baselinePending": state.counterBaselines[day] == nil] as [String: Any],
                duplicate: false, generation: generation)
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
