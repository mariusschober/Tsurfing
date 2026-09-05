import Foundation
final class CompletionHoldController: @unchecked Sendable {
    let duration: TimeInterval
    private var startedAt: Date?
    private let clock: any Clock
    private let lock = NSLock()
    init(isFrog: Bool, clock: any Clock = SystemClock()) { self.duration = isFrog ? 5.0 : 3.0; self.clock = clock }
    func start(at date: Date? = nil) { lock.lock(); defer { lock.unlock() }; startedAt = date ?? clock.now() }
    func cancel() { lock.lock(); defer { lock.unlock() }; startedAt = nil }
    func progress(at date: Date? = nil) -> Double {
        let s: Date? = { lock.lock(); defer { lock.unlock() }; return startedAt }()
        guard let s else { return 0 }
        let now = date ?? clock.now(); let elapsed = now.timeIntervalSince(s)
        return max(0, min(1, elapsed / duration))
    }
    func isCompleted(at date: Date? = nil) -> Bool { progress(at: date) >= 1.0 }
    var isHolding: Bool { lock.lock(); defer { lock.unlock() }; return startedAt != nil }
}
