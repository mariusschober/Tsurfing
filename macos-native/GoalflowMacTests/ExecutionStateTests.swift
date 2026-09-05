import XCTest
@testable import GoalflowMac
import Foundation

final class ExecutionStateTests: XCTestCase {
    func test_remaining_init_full() {
        let now = Date()
        let s = ExecutionState(taskId: "t1", phase: .active, startedAt: now, plannedDurationSeconds: 25*60)
        XCTAssertEqual(s.remainingSeconds(now: now), 1500)
        XCTAssertEqual(s.remainingSeconds(now: now.addingTimeInterval(10)), 1490)
        XCTAssertEqual(s.remainingSeconds(now: now.addingTimeInterval(1500)), 0)
        XCTAssertEqual(s.remainingSeconds(now: now.addingTimeInterval(2000)), 0) // clamped
    }

    func test_idle_returns_planned() {
        let s = ExecutionState(taskId: "t1", phase: .idle, startedAt: Date(), plannedDurationSeconds: 600)
        XCTAssertEqual(s.remainingSeconds(now: Date()), 600)
    }

    func test_action_creates_active() {
        let now = Date()
        let state = ExecutionState(taskId: "demo-1", phase: .active, startedAt: now, plannedDurationSeconds: 1500)
        XCTAssertTrue(state.isActive)
        XCTAssertEqual(state.taskId, "demo-1")
    }

    func test_relaunch_recovery() {
        // Start 47s ago, planned 25m -> remaining 1453
        let now = Date()
        let start = now.addingTimeInterval(-47)
        let s = ExecutionState(taskId: "t", phase: .active, startedAt: start, plannedDurationSeconds: 1500)
        XCTAssertEqual(s.remainingSeconds(now: now), 1453)
    }

    func test_monotonic_derivation_not_decrement() {
        // Even if tick missed, recompute correct
        let start = Date(timeIntervalSince1970: 1_000_000)
        let s = ExecutionState(taskId: "t", phase: .active, startedAt: start, plannedDurationSeconds: 300)
        // Simulate 2 ticks spaced 5s apart
        XCTAssertEqual(s.remainingSeconds(now: start.addingTimeInterval(5)), 295)
        XCTAssertEqual(s.remainingSeconds(now: start.addingTimeInterval(10)), 290)
        // No loss if interval skips
        XCTAssertEqual(s.remainingSeconds(now: start.addingTimeInterval(15)), 285)
    }
}
