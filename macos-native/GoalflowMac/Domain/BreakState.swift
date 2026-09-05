import Foundation

/// Break session — separate from ExecutionState. Pause-before-break keeps focus elapsed frozen.
struct BreakState: Codable, Equatable, Sendable {
    var durationSeconds: Int? // nil = open-ended
    var startedAt: Date
    var startedAtMonotonic: UInt64?
    var sourcePhase: ExecutionPhase // .active or .paused before break
    var taskId: String?

    var isOpenEnded: Bool { durationSeconds == nil }

    init(durationSeconds: Int?, startedAt: Date, startedAtMonotonic: UInt64? = nil, sourcePhase: ExecutionPhase, taskId: String?) {
        self.durationSeconds = durationSeconds.map { max(60, $0) }
        self.startedAt = startedAt
        self.startedAtMonotonic = startedAtMonotonic
        self.sourcePhase = sourcePhase
        self.taskId = taskId
    }

    func elapsedSeconds(now: Date) -> Int {
        max(0, Int(now.timeIntervalSince(startedAt).rounded(.down)))
    }

    func remainingSeconds(now: Date) -> Int? {
        guard let dur = durationSeconds else { return nil }
        return max(0, dur - elapsedSeconds(now: now))
    }

    func isExpired(now: Date) -> Bool {
        guard let dur = durationSeconds else { return false }
        return elapsedSeconds(now: now) >= dur
    }
}
