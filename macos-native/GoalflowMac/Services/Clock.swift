import Foundation
import Darwin
protocol Clock: Sendable { func now() -> Date }
protocol MonotonicClock: Clock { var monotonicNow: UInt64 { get } }
struct SystemClock: MonotonicClock { func now() -> Date { Date() }; var monotonicNow: UInt64 { mach_continuous_time() } }
struct FixedClock: MonotonicClock { var fixed: Date; var fixedMonotonic: UInt64; init(fixed: Date, fixedMonotonic: UInt64 = 0) { self.fixed = fixed; self.fixedMonotonic = fixedMonotonic }; func now() -> Date { fixed }; var monotonicNow: UInt64 { fixedMonotonic } }
final class ManualClock: MonotonicClock, @unchecked Sendable {
    private var _now: Date; private var _mono: UInt64; private let lock = NSLock()
    init(now: Date, monotonic: UInt64 = 0) { self._now = now; self._mono = monotonic }
    func now() -> Date { lock.lock(); defer { lock.unlock() }; return _now }
    var monotonicNow: UInt64 { lock.lock(); defer { lock.unlock() }; return _mono }
    func advance(by seconds: TimeInterval) { lock.lock(); _now = _now.addingTimeInterval(seconds); _mono &+= UInt64(seconds * 1_000_000_000); lock.unlock() }
    func advanceMonotonic(by ticks: UInt64) { lock.lock(); _mono &+= ticks; lock.unlock() }
    func set(_ date: Date, monotonic: UInt64? = nil) { lock.lock(); _now = date; if let m = monotonic { _mono = m }; lock.unlock() }
}
