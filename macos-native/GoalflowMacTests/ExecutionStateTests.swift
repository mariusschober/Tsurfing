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

    func test_shared_active_record_reanchor_preserves_elapsed_once() throws {
        let now = Date(timeIntervalSince1970: 1_700_000_600)
        let elapsed = 600
        let record = try XCTUnwrap(SharedFocusSessionRecord(
            sessionId: "11111111-1111-4111-8111-111111111111",
            taskId: "task-1",
            phase: .active,
            plannedDurationSeconds: 1_500,
            startedAt: now,
            elapsedSeconds: elapsed,
            pausedAt: nil,
            endedAt: nil,
            updatedAt: now
        ))
        XCTAssertEqual(record.elapsedSeconds(at: now), elapsed)
        XCTAssertEqual(record.elapsedSeconds(at: now.addingTimeInterval(10)), elapsed + 10)
    }

    func test_shared_paused_record_retains_owner_pause_elapsed() throws {
        let started = Date(timeIntervalSince1970: 1_700_000_000)
        let paused = started.addingTimeInterval(1_376)
        let observedLater = paused.addingTimeInterval(300)
        let record = try XCTUnwrap(SharedFocusSessionRecord(
            sessionId: "22222222-2222-4222-8222-222222222222",
            taskId: "task-1",
            phase: .paused,
            plannedDurationSeconds: 1_500,
            startedAt: started,
            elapsedSeconds: 1_376,
            pausedAt: paused,
            endedAt: nil,
            updatedAt: observedLater
        ))
        XCTAssertEqual(record.elapsedSeconds(at: observedLater), 1_376)
        XCTAssertEqual(record.remainingSeconds(at: observedLater), 124)
        XCTAssertEqual(record.toExecutionState()?.elapsedSeconds(now: observedLater), 1_376)
    }

    func test_legacy_paused_migration_preserves_original_pause_and_elapsed() throws {
        let started = Date(timeIntervalSince1970: 1_700_000_000)
        let paused = started.addingTimeInterval(952)
        let observedLater = paused.addingTimeInterval(900)
        let legacy = ExecutionState(
            taskId: "task-1",
            phase: .paused,
            startedAt: started,
            plannedDurationSeconds: 1_800,
            accumulatedPauseSeconds: 528,
            lastPausedAt: paused
        )
        let migrated = try XCTUnwrap(sharedFocusSessionRecord(
            from: legacy,
            now: observedLater,
            sessionId: "44444444-4444-4444-8444-444444444444"
        ))
        XCTAssertEqual(migrated.elapsedSeconds, 424)
        XCTAssertEqual(migrated.remainingSeconds(at: observedLater), 1_376)
        XCTAssertEqual(migrated.pausedAt, paused)
        XCTAssertEqual(migrated.updatedAt, paused)
    }

    func test_legacy_active_migration_shifts_pause_accumulator_without_double_count() throws {
        let started = Date(timeIntervalSince1970: 1_700_000_000)
        let now = started.addingTimeInterval(1_500)
        let legacy = ExecutionState(
            taskId: "task-1",
            phase: .active,
            startedAt: started,
            plannedDurationSeconds: 1_800,
            accumulatedPauseSeconds: 300
        )
        let migrated = try XCTUnwrap(sharedFocusSessionRecord(
            from: legacy,
            now: now,
            sessionId: "55555555-5555-4555-8555-555555555555"
        ))
        XCTAssertEqual(migrated.elapsedSeconds(at: now), 1_200)
        XCTAssertEqual(migrated.startedAt, started.addingTimeInterval(300))
        XCTAssertEqual(migrated.elapsedSeconds, 0)
        XCTAssertEqual(migrated.updatedAt, started.addingTimeInterval(300))
    }
}
