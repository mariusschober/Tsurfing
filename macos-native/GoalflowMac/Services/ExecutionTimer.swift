import Foundation
import Combine
import AppKit
@MainActor
final class ExecutionTimer: ObservableObject {
    @Published private(set) var remainingSeconds: Int
    @Published private(set) var overtimeSeconds: Int
    @Published private(set) var isActive: Bool = false
    @Published private(set) var isPaused: Bool = false
    private var state: ExecutionState?
    private var clock: any Clock
    private var cancellable: AnyCancellable?
    private var sleepObservers: [Any] = []
    init(clock: any Clock = SystemClock()) { self.clock = clock; self.remainingSeconds = 0; self.overtimeSeconds = 0 }
    func configure(state: ExecutionState?, clock: any Clock) {
        removeSleepObservers(); self.state = state; self.clock = clock
        if let s = state {
            switch s.phase {
            case .active: remainingSeconds = s.remainingSeconds(now: clock.now()); overtimeSeconds = s.overtimeSeconds(now: clock.now()); isActive = true; isPaused = false; startTicker(); installSleepObservers()
            case .paused: remainingSeconds = s.remainingSeconds(now: clock.now()); overtimeSeconds = 0; isActive = false; isPaused = true; stopTicker()
            case .idle: remainingSeconds = s.plannedDurationSeconds; overtimeSeconds = 0; isActive = false; isPaused = false; stopTicker()
            }
        } else { remainingSeconds = 0; overtimeSeconds = 0; isActive = false; isPaused = false; stopTicker() }
    }
    func start(state: ExecutionState) {
        removeSleepObservers(); self.state = state; remainingSeconds = state.remainingSeconds(now: clock.now()); overtimeSeconds = state.overtimeSeconds(now: clock.now()); isActive = state.isActive; isPaused = state.isPaused
        if isActive { startTicker(); installSleepObservers() } else if isPaused { stopTicker() }
    }
    func stop() { state = nil; remainingSeconds = 0; overtimeSeconds = 0; isActive = false; isPaused = false; stopTicker(); removeSleepObservers() }
    func reflectPause(_ newState: ExecutionState) { state = newState; remainingSeconds = newState.remainingSeconds(now: clock.now()); overtimeSeconds = 0; isActive = false; isPaused = true; stopTicker() }
    func reflectResume(_ newState: ExecutionState) { state = newState; remainingSeconds = newState.remainingSeconds(now: clock.now()); overtimeSeconds = newState.overtimeSeconds(now: clock.now()); isActive = true; isPaused = false; startTicker(); installSleepObservers() }
    func reflectExtend(_ newState: ExecutionState) { state = newState; remainingSeconds = newState.remainingSeconds(now: clock.now()); overtimeSeconds = newState.overtimeSeconds(now: clock.now()) }
    func tick() {
        guard let s = state else { return }
        switch s.phase {
        case .idle: remainingSeconds = s.plannedDurationSeconds; overtimeSeconds = 0
        case .paused: remainingSeconds = s.remainingSeconds(now: clock.now()); overtimeSeconds = 0
        case .active: remainingSeconds = s.remainingSeconds(now: clock.now()); overtimeSeconds = s.overtimeSeconds(now: clock.now())
        }
    }
    private func startTicker() { stopTicker(); cancellable = Timer.publish(every: 1.0, on: .main, in: .common).autoconnect().sink { [weak self] _ in Task { @MainActor in self?.tick() } } }
    private func stopTicker() { cancellable?.cancel(); cancellable = nil }
    private func installSleepObservers() {
        let center = NSWorkspace.shared.notificationCenter
        let s = center.addObserver(forName: NSWorkspace.screensDidSleepNotification, object: nil, queue: .main) { [weak self] _ in Task { @MainActor in self?.handleSleep() } }
        let w = center.addObserver(forName: NSWorkspace.screensDidWakeNotification, object: nil, queue: .main) { [weak self] _ in Task { @MainActor in self?.handleWake() } }
        sleepObservers = [s, w]
    }
    private func removeSleepObservers() { for o in sleepObservers { NSWorkspace.shared.notificationCenter.removeObserver(o) }; sleepObservers.removeAll() }
    private func handleSleep() { tick() }
    private func handleWake() {
        if let s = state, let startMono = s.startedAtMonotonic, let mono = (clock as? any MonotonicClock)?.monotonicNow {
            let wallElapsed = clock.now().timeIntervalSince(s.startedAt)
            let monoElapsed = Double(mono > startMono ? mono - startMono : 0) / 1_000_000_000
            if abs(wallElapsed - monoElapsed) > 2 {
                // Wall jumped (sleep/clock skew) — re-tick will clamp via wall; monotonic drift detectable
            }
        }
        tick()
    }
    var formattedRemaining: String { let m = remainingSeconds / 60; let s = remainingSeconds % 60; return String(format: "%02d:%02d", m, s) }
    var formattedOvertime: String { let m = overtimeSeconds / 60; let s = overtimeSeconds % 60; return String(format: "+%02d:%02d", m, s) }
    var isOvertime: Bool { overtimeSeconds > 0 }
    nonisolated func remainingForTest(state: ExecutionState, now: Date) -> Int { state.remainingSeconds(now: now) }
    nonisolated func overtimeForTest(state: ExecutionState, now: Date) -> Int { state.overtimeSeconds(now: now) }
    deinit { for o in sleepObservers { NSWorkspace.shared.notificationCenter.removeObserver(o) } }
}
