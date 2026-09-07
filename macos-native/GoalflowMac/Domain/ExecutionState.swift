import Foundation

enum ExecutionPhase: String, Codable, Sendable, Equatable { case idle, active, paused }

struct ExecutionState: Codable, Sendable, Equatable {
    var taskId: String
    var phase: ExecutionPhase
    var startedAt: Date
    var startedAtMonotonic: UInt64?
    var plannedDurationSeconds: Int
    var accumulatedPauseSeconds: Int
    var lastPausedAt: Date?
    /// Shared-session identity and elapsed base are migration-safe local
    /// mirror fields. Old execution.json files decode with nil/zero values.
    var sessionId: String?
    var elapsedBaseSeconds: Int

    init(
        taskId: String,
        phase: ExecutionPhase,
        startedAt: Date,
        startedAtMonotonic: UInt64? = nil,
        plannedDurationSeconds: Int,
        accumulatedPauseSeconds: Int = 0,
        lastPausedAt: Date? = nil,
        sessionId: String? = nil,
        elapsedBaseSeconds: Int = 0
    ) {
        self.taskId = taskId
        self.phase = phase
        self.startedAt = startedAt
        self.startedAtMonotonic = startedAtMonotonic
        self.plannedDurationSeconds = max(60, min(1440 * 60, plannedDurationSeconds))
        self.accumulatedPauseSeconds = max(0, accumulatedPauseSeconds)
        self.lastPausedAt = lastPausedAt
        self.sessionId = sessionId
        self.elapsedBaseSeconds = max(0, elapsedBaseSeconds)
    }

    enum CodingKeys: String, CodingKey {
        case taskId, phase, startedAt, startedAtMonotonic, plannedDurationSeconds, accumulatedPauseSeconds, lastPausedAt
        case sessionId, elapsedBaseSeconds
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        taskId = try c.decode(String.self, forKey: .taskId)
        phase = try c.decode(ExecutionPhase.self, forKey: .phase)
        startedAt = try c.decode(Date.self, forKey: .startedAt)
        startedAtMonotonic = try c.decodeIfPresent(UInt64.self, forKey: .startedAtMonotonic)
        plannedDurationSeconds = try c.decode(Int.self, forKey: .plannedDurationSeconds)
        accumulatedPauseSeconds = try c.decodeIfPresent(Int.self, forKey: .accumulatedPauseSeconds) ?? 0
        lastPausedAt = try c.decodeIfPresent(Date.self, forKey: .lastPausedAt)
        sessionId = try c.decodeIfPresent(String.self, forKey: .sessionId)
        elapsedBaseSeconds = try c.decodeIfPresent(Int.self, forKey: .elapsedBaseSeconds) ?? 0
        plannedDurationSeconds = max(60, min(1440 * 60, plannedDurationSeconds))
        accumulatedPauseSeconds = max(0, accumulatedPauseSeconds)
        elapsedBaseSeconds = max(0, elapsedBaseSeconds)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(taskId, forKey: .taskId)
        try c.encode(phase, forKey: .phase)
        try c.encode(startedAt, forKey: .startedAt)
        try c.encodeIfPresent(startedAtMonotonic, forKey: .startedAtMonotonic)
        try c.encode(plannedDurationSeconds, forKey: .plannedDurationSeconds)
        try c.encode(accumulatedPauseSeconds, forKey: .accumulatedPauseSeconds)
        try c.encodeIfPresent(lastPausedAt, forKey: .lastPausedAt)
        try c.encodeIfPresent(sessionId, forKey: .sessionId)
        try c.encode(elapsedBaseSeconds, forKey: .elapsedBaseSeconds)
    }

    func elapsedSeconds(now: Date) -> Int {
        switch phase {
        case .idle:
            return 0
        case .paused:
            if elapsedBaseSeconds > 0 { return elapsedBaseSeconds }
            guard let pausedAt = lastPausedAt else {
                let raw = max(0, Int(now.timeIntervalSince(startedAt).rounded(.down)))
                return max(0, raw - accumulatedPauseSeconds)
            }
            let rawPaused = max(0, Int(pausedAt.timeIntervalSince(startedAt).rounded(.down)))
            return max(0, rawPaused - accumulatedPauseSeconds)
        case .active:
            let raw = max(0, Int(now.timeIntervalSince(startedAt).rounded(.down)))
            return max(0, elapsedBaseSeconds + raw - accumulatedPauseSeconds)
        }
    }

    func remainingSeconds(now: Date) -> Int {
        switch phase {
        case .idle: return plannedDurationSeconds
        case .paused, .active: return max(0, plannedDurationSeconds - elapsedSeconds(now: now))
        }
    }

    func overtimeSeconds(now: Date) -> Int {
        switch phase {
        case .idle, .paused: return 0
        case .active: return max(0, elapsedSeconds(now: now) - plannedDurationSeconds)
        }
    }

    var isActive: Bool { phase == .active }
    var isPaused: Bool { phase == .paused }
    var isIdle: Bool { phase == .idle }

    func paused(at now: Date) -> ExecutionState? {
        guard phase == .active else { return nil }
        var n = self
        n.phase = .paused
        n.lastPausedAt = now
        return n
    }

    func resumed(at now: Date) -> ExecutionState? {
        guard phase == .paused, let pa = lastPausedAt else { return nil }
        let iv = max(0, Int(now.timeIntervalSince(pa).rounded(.down)))
        var n = self
        n.phase = .active
        n.accumulatedPauseSeconds = accumulatedPauseSeconds + iv
        n.lastPausedAt = nil
        return n
    }

    func extended(by deltaSeconds: Int) -> ExecutionState? {
        guard deltaSeconds > 0 else { return nil }
        var n = self
        n.plannedDurationSeconds = min(1440 * 60, max(60, plannedDurationSeconds + deltaSeconds))
        return n
    }
}

private let sharedFocusSessionSchemaVersion = 1
private let sharedFocusSessionDurationRange = 60...(1440 * 60)

enum SharedFocusPhase: String {
    case active, paused, stopped, completed
}

/** The exact action record exchanged inside the tracking singleton. */
struct SharedFocusSessionRecord: Equatable, Sendable {
    let schemaVersion: Int
    let sessionId: String
    let taskId: String
    let phase: SharedFocusPhase
    let plannedDurationSeconds: Int
    let startedAt: Date
    let elapsedSeconds: Int
    let pausedAt: Date?
    let endedAt: Date?
    let updatedAt: Date

    init?(
        schemaVersion: Int = sharedFocusSessionSchemaVersion,
        sessionId: String,
        taskId: String,
        phase: SharedFocusPhase,
        plannedDurationSeconds: Int,
        startedAt: Date,
        elapsedSeconds: Int,
        pausedAt: Date?,
        endedAt: Date?,
        updatedAt: Date
    ) {
        guard schemaVersion == sharedFocusSessionSchemaVersion,
              UUID(uuidString: sessionId) != nil,
              !taskId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              taskId.count <= 240,
              sharedFocusSessionDurationRange.contains(plannedDurationSeconds),
              elapsedSeconds >= 0, elapsedSeconds <= 9_007_199_254_740_991,
              startedAt <= updatedAt,
              pausedAt.map({ $0 >= startedAt && $0 <= updatedAt }) ?? true,
              endedAt.map({ $0 >= startedAt && $0 <= updatedAt }) ?? true else { return nil }
        switch phase {
        case .active:
            guard pausedAt == nil, endedAt == nil else { return nil }
        case .paused:
            guard pausedAt != nil, endedAt == nil else { return nil }
        case .stopped, .completed:
            guard endedAt != nil, pausedAt == nil else { return nil }
        }
        self.schemaVersion = schemaVersion
        self.sessionId = sessionId.lowercased()
        self.taskId = taskId
        self.phase = phase
        self.plannedDurationSeconds = plannedDurationSeconds
        self.startedAt = startedAt
        self.elapsedSeconds = elapsedSeconds
        self.pausedAt = pausedAt
        self.endedAt = endedAt
        self.updatedAt = updatedAt
    }

    static func start(taskId: String, plannedDurationSeconds: Int, now: Date = Date(), sessionId: String = UUID().uuidString.lowercased()) -> SharedFocusSessionRecord? {
        SharedFocusSessionRecord(
            sessionId: sessionId,
            taskId: taskId,
            phase: .active,
            plannedDurationSeconds: plannedDurationSeconds,
            startedAt: now,
            elapsedSeconds: 0,
            pausedAt: nil,
            endedAt: nil,
            updatedAt: now
        )
    }

    func elapsedSeconds(at now: Date) -> Int {
        guard phase == .active else { return elapsedSeconds }
        return max(0, elapsedSeconds + Int(max(0, now.timeIntervalSince(startedAt)).rounded(.down)))
    }

    func remainingSeconds(at now: Date) -> Int {
        max(0, plannedDurationSeconds - elapsedSeconds(at: now))
    }

    func overtimeSeconds(at now: Date) -> Int {
        phase == .active ? max(0, elapsedSeconds(at: now) - plannedDurationSeconds) : 0
    }

    func paused(at now: Date) -> SharedFocusSessionRecord? {
        guard phase == .active else { return self }
        let e = elapsedSeconds(at: now)
        return SharedFocusSessionRecord(sessionId: sessionId, taskId: taskId, phase: .paused, plannedDurationSeconds: plannedDurationSeconds, startedAt: startedAt, elapsedSeconds: e, pausedAt: now, endedAt: nil, updatedAt: now)
    }

    func resumed(at now: Date) -> SharedFocusSessionRecord? {
        guard phase == .paused else { return self }
        return SharedFocusSessionRecord(sessionId: sessionId, taskId: taskId, phase: .active, plannedDurationSeconds: plannedDurationSeconds, startedAt: now, elapsedSeconds: elapsedSeconds, pausedAt: nil, endedAt: nil, updatedAt: now)
    }

    func stopped(at now: Date) -> SharedFocusSessionRecord? {
        guard phase != .stopped, phase != .completed else { return self }
        return SharedFocusSessionRecord(sessionId: sessionId, taskId: taskId, phase: .stopped, plannedDurationSeconds: plannedDurationSeconds, startedAt: startedAt, elapsedSeconds: elapsedSeconds(at: now), pausedAt: nil, endedAt: now, updatedAt: now)
    }

    func completed(at now: Date) -> SharedFocusSessionRecord? {
        guard phase != .completed else { return self }
        return SharedFocusSessionRecord(sessionId: sessionId, taskId: taskId, phase: .completed, plannedDurationSeconds: plannedDurationSeconds, startedAt: startedAt, elapsedSeconds: elapsedSeconds(at: now), pausedAt: nil, endedAt: now, updatedAt: now)
    }

    func extended(by deltaSeconds: Int, now: Date = Date()) -> SharedFocusSessionRecord? {
        guard deltaSeconds > 0 else { return self }
        return SharedFocusSessionRecord(sessionId: sessionId, taskId: taskId, phase: phase, plannedDurationSeconds: min(1440 * 60, plannedDurationSeconds + deltaSeconds), startedAt: startedAt, elapsedSeconds: elapsedSeconds, pausedAt: pausedAt, endedAt: endedAt, updatedAt: now)
    }

    func toDictionary() -> [String: Any] {
        [
            "schemaVersion": schemaVersion,
            "sessionId": sessionId,
            "taskId": taskId,
            "phase": phase.rawValue,
            "plannedDurationSeconds": plannedDurationSeconds,
            "startedAt": Self.format(startedAt),
            "elapsedSeconds": elapsedSeconds,
            "pausedAt": pausedAt.map(Self.format) ?? NSNull(),
            "endedAt": endedAt.map(Self.format) ?? NSNull(),
            "updatedAt": Self.format(updatedAt)
        ]
    }

    init?(dictionary: [String: Any]) {
        guard let schema = Self.strictInt(dictionary["schemaVersion"]),
              let sessionId = dictionary["sessionId"] as? String,
              let taskId = dictionary["taskId"] as? String,
              let phaseRaw = dictionary["phase"] as? String,
              let phase = SharedFocusPhase(rawValue: phaseRaw),
              let planned = Self.strictInt(dictionary["plannedDurationSeconds"]),
              let started = Self.parseDate(dictionary["startedAt"]),
              let elapsed = Self.strictInt(dictionary["elapsedSeconds"]),
              let updated = Self.parseDate(dictionary["updatedAt"]) else { return nil }
        guard let paused = Self.optionalDate(dictionary["pausedAt"]),
              let ended = Self.optionalDate(dictionary["endedAt"]) else { return nil }
        self.init(schemaVersion: schema, sessionId: sessionId, taskId: taskId, phase: phase, plannedDurationSeconds: planned, startedAt: started, elapsedSeconds: elapsed, pausedAt: paused, endedAt: ended, updatedAt: updated)
    }

    func toExecutionState() -> ExecutionState? {
        guard phase == .active || phase == .paused else { return nil }
        return ExecutionState(
            taskId: taskId,
            phase: phase == .active ? .active : .paused,
            startedAt: startedAt,
            plannedDurationSeconds: plannedDurationSeconds,
            lastPausedAt: pausedAt,
            sessionId: sessionId,
            elapsedBaseSeconds: elapsedSeconds
        )
    }

    private static func strictInt(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        let double = number.doubleValue
        // These values cross JSON/JavaScript on the other clients. Reject
        // integers outside its exact safe range before converting to Int;
        // converting a rounded Double(Int.max) can otherwise trap.
        let maxSafeJSONInteger = 9_007_199_254_740_991.0
        guard double.isFinite, double.rounded() == double,
              double >= -maxSafeJSONInteger, double <= maxSafeJSONInteger else { return nil }
        return Int(double)
    }

    private static func optionalDate(_ value: Any?) -> Date?? {
        if value == nil || value is NSNull { return .some(nil) }
        guard let parsed = parseDate(value) else { return nil }
        return .some(parsed)
    }

    private static func parseDate(_ value: Any?) -> Date? {
        guard let text = value as? String else { return nil }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: text) ?? ISO8601DateFormatter().date(from: text)
    }

    private static func format(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }
}

/// Converts the pre-sync execution mirror without changing its meaning. This
/// is deliberately pure so migration can be regression-tested independently
/// of the menu-bar view model.
func sharedFocusSessionRecord(from state: ExecutionState, now: Date, sessionId: String? = nil) -> SharedFocusSessionRecord? {
    guard state.phase == .active || state.phase == .paused else { return nil }
    let resolvedSessionId = state.sessionId ?? sessionId ?? UUID().uuidString.lowercased()
    let phase: SharedFocusPhase = state.phase == .paused ? .paused : .active
    // Active records carry a base for time already spent before the current
    // anchor; wall time after that anchor is derived by the shared model.
    // Legacy mirrors have no base, so using their live elapsed value here
    // would count the same segment twice.
    let elapsed = phase == .active ? state.elapsedBaseSeconds : state.elapsedSeconds(now: now)
    let startedAt: Date
    let pausedAt: Date?
    let updatedAt: Date
    if phase == .active {
        startedAt = state.startedAt.addingTimeInterval(TimeInterval(state.accumulatedPauseSeconds))
        pausedAt = nil
        updatedAt = startedAt
    } else {
        startedAt = state.startedAt
        pausedAt = state.lastPausedAt ?? now
        updatedAt = pausedAt ?? now
    }
    return SharedFocusSessionRecord(
        sessionId: resolvedSessionId,
        taskId: state.taskId,
        phase: phase,
        plannedDurationSeconds: state.plannedDurationSeconds,
        startedAt: startedAt,
        elapsedSeconds: elapsed,
        pausedAt: pausedAt,
        endedAt: nil,
        updatedAt: updatedAt
    )
}
