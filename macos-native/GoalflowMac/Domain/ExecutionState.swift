import Foundation
enum ExecutionPhase: String, Codable, Sendable, Equatable { case idle, active, paused }
struct ExecutionState: Codable, Sendable, Equatable {
    var taskId: String; var phase: ExecutionPhase; var startedAt: Date; var startedAtMonotonic: UInt64?; var plannedDurationSeconds: Int; var accumulatedPauseSeconds: Int; var lastPausedAt: Date?
    init(taskId: String, phase: ExecutionPhase, startedAt: Date, startedAtMonotonic: UInt64? = nil, plannedDurationSeconds: Int, accumulatedPauseSeconds: Int = 0, lastPausedAt: Date? = nil) {
        self.taskId = taskId; self.phase = phase; self.startedAt = startedAt; self.startedAtMonotonic = startedAtMonotonic; self.plannedDurationSeconds = max(60, plannedDurationSeconds); self.accumulatedPauseSeconds = max(0, accumulatedPauseSeconds); self.lastPausedAt = lastPausedAt
    }
    enum CodingKeys: String, CodingKey { case taskId, phase, startedAt, startedAtMonotonic, plannedDurationSeconds, accumulatedPauseSeconds, lastPausedAt }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        taskId = try c.decode(String.self, forKey: .taskId); phase = try c.decode(ExecutionPhase.self, forKey: .phase); startedAt = try c.decode(Date.self, forKey: .startedAt)
        startedAtMonotonic = try c.decodeIfPresent(UInt64.self, forKey: .startedAtMonotonic); plannedDurationSeconds = try c.decode(Int.self, forKey: .plannedDurationSeconds)
        accumulatedPauseSeconds = try c.decodeIfPresent(Int.self, forKey: .accumulatedPauseSeconds) ?? 0; lastPausedAt = try c.decodeIfPresent(Date.self, forKey: .lastPausedAt)
        plannedDurationSeconds = max(60, plannedDurationSeconds); accumulatedPauseSeconds = max(0, accumulatedPauseSeconds)
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(taskId, forKey: .taskId); try c.encode(phase, forKey: .phase); try c.encode(startedAt, forKey: .startedAt)
        try c.encodeIfPresent(startedAtMonotonic, forKey: .startedAtMonotonic); try c.encode(plannedDurationSeconds, forKey: .plannedDurationSeconds)
        try c.encode(accumulatedPauseSeconds, forKey: .accumulatedPauseSeconds); try c.encodeIfPresent(lastPausedAt, forKey: .lastPausedAt)
    }
    func elapsedSeconds(now: Date) -> Int {
        switch phase {
        case .idle: return 0
        case .paused:
            guard let pausedAt = lastPausedAt else { let raw = max(0, Int(now.timeIntervalSince(startedAt).rounded(.down))); return max(0, raw - accumulatedPauseSeconds) }
            let rawPaused = max(0, Int(pausedAt.timeIntervalSince(startedAt).rounded(.down))); return max(0, rawPaused - accumulatedPauseSeconds)
        case .active: let raw = max(0, Int(now.timeIntervalSince(startedAt).rounded(.down))); return max(0, raw - accumulatedPauseSeconds)
        }
    }
    func remainingSeconds(now: Date) -> Int {
        switch phase { case .idle: return plannedDurationSeconds; case .paused, .active: return max(0, plannedDurationSeconds - elapsedSeconds(now: now)) }
    }
    func overtimeSeconds(now: Date) -> Int {
        switch phase { case .idle: return 0; case .paused: return 0; case .active: return max(0, elapsedSeconds(now: now) - plannedDurationSeconds) }
    }
    var isActive: Bool { phase == .active }; var isPaused: Bool { phase == .paused }; var isIdle: Bool { phase == .idle }
    func paused(at now: Date) -> ExecutionState? { guard phase == .active else { return nil }; var n = self; n.phase = .paused; n.lastPausedAt = now; return n }
    func resumed(at now: Date) -> ExecutionState? { guard phase == .paused, let pa = lastPausedAt else { return nil }; let iv = max(0, Int(now.timeIntervalSince(pa).rounded(.down))); var n = self; n.phase = .active; n.accumulatedPauseSeconds = accumulatedPauseSeconds + iv; n.lastPausedAt = nil; return n }
    func extended(by deltaSeconds: Int) -> ExecutionState? { guard deltaSeconds > 0 else { return nil }; var n = self; n.plannedDurationSeconds = min(1440*60, max(60, plannedDurationSeconds + deltaSeconds)); return n }
}
