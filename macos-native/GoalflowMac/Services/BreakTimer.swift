import Foundation
import Combine

@MainActor
final class BreakTimer: ObservableObject {
    @Published private(set) var elapsedSeconds: Int = 0
    @Published private(set) var remainingSeconds: Int? = nil
    @Published private(set) var isActive: Bool = false
    @Published private(set) var isExpired: Bool = false

    private var state: BreakState?
    private var clock: any Clock
    private var cancellable: AnyCancellable?

    init(clock: any Clock = SystemClock()) {
        self.clock = clock
    }

    func configure(state: BreakState?, clock: any Clock) {
        self.state = state
        self.clock = clock
        if let s = state {
            elapsedSeconds = s.elapsedSeconds(now: clock.now())
            remainingSeconds = s.remainingSeconds(now: clock.now())
            isActive = true
            isExpired = s.isExpired(now: clock.now())
            startTicker()
        } else {
            elapsedSeconds = 0
            remainingSeconds = nil
            isActive = false
            isExpired = false
            stopTicker()
        }
    }

    func start(state: BreakState) {
        self.state = state
        elapsedSeconds = state.elapsedSeconds(now: clock.now())
        remainingSeconds = state.remainingSeconds(now: clock.now())
        isActive = true
        isExpired = state.isExpired(now: clock.now())
        startTicker()
    }

    func stop() {
        state = nil
        elapsedSeconds = 0
        remainingSeconds = nil
        isActive = false
        isExpired = false
        stopTicker()
    }

    func tick() {
        guard let s = state else { return }
        elapsedSeconds = s.elapsedSeconds(now: clock.now())
        remainingSeconds = s.remainingSeconds(now: clock.now())
        isExpired = s.isExpired(now: clock.now())
    }

    private func startTicker() {
        stopTicker()
        cancellable = Timer.publish(every: 1.0, on: .main, in: .common).autoconnect().sink { [weak self] _ in Task { @MainActor in self?.tick() } }
    }

    private func stopTicker() { cancellable?.cancel(); cancellable = nil }

    var formattedRemaining: String {
        guard let r = remainingSeconds else {
            let m = elapsedSeconds / 60; let s = elapsedSeconds % 60
            return String(format: "%02d:%02d", m, s)
        }
        let m = r / 60; let s = r % 60
        return String(format: "%02d:%02d", m, s)
    }

    var formattedElapsed: String {
        let m = elapsedSeconds / 60; let s = elapsedSeconds % 60
        return String(format: "%02d:%02d", m, s)
    }
}
