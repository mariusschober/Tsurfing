import XCTest
@testable import GoalflowMac
import Foundation

final class BreakStateTests: XCTestCase {
    func test_durations() {
        let now = Date()
        let s5 = BreakState(durationSeconds: 5*60, startedAt: now, sourcePhase: .active, taskId: "t")
        XCTAssertEqual(s5.durationSeconds, 300)
        XCTAssertEqual(s5.remainingSeconds(now: now), 300)
        let sOpen = BreakState(durationSeconds: nil, startedAt: now, sourcePhase: .active, taskId: "t")
        XCTAssertNil(sOpen.durationSeconds)
        XCTAssertTrue(sOpen.isOpenEnded)
        XCTAssertNil(sOpen.remainingSeconds(now: now))
        XCTAssertEqual(sOpen.elapsedSeconds(now: now.addingTimeInterval(123)), 123)
    }
    func test_remaining_and_expired() {
        let start = Date(timeIntervalSince1970: 1_000_000)
        let bs = BreakState(durationSeconds: 300, startedAt: start, sourcePhase: .active, taskId: "t")
        XCTAssertEqual(bs.remainingSeconds(now: start), 300)
        XCTAssertFalse(bs.isExpired(now: start))
        XCTAssertEqual(bs.remainingSeconds(now: start.addingTimeInterval(150)), 150)
        XCTAssertFalse(bs.isExpired(now: start.addingTimeInterval(299)))
        XCTAssertEqual(bs.remainingSeconds(now: start.addingTimeInterval(300)), 0)
        XCTAssertTrue(bs.isExpired(now: start.addingTimeInterval(300)))
        XCTAssertEqual(bs.remainingSeconds(now: start.addingTimeInterval(400)), 0)
        XCTAssertTrue(bs.isExpired(now: start.addingTimeInterval(400)))
    }
    func test_open_ended_never_expired() {
        let start = Date(timeIntervalSince1970: 2_000_000)
        let bs = BreakState(durationSeconds: nil, startedAt: start, sourcePhase: .paused, taskId: nil)
        XCTAssertNil(bs.remainingSeconds(now: start.addingTimeInterval(10000)))
        XCTAssertFalse(bs.isExpired(now: start.addingTimeInterval(10000)))
        XCTAssertEqual(bs.elapsedSeconds(now: start.addingTimeInterval(100)), 100)
    }
}

final class BreakSessionStoreTests: XCTestCase {
    func test_file_persists_and_clears() throws {
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }
        let file = tmp.appendingPathComponent("break.json")
        let store = BreakSessionStore(fileURL: file)
        XCTAssertNil(try store.load())
        let bs = BreakState(durationSeconds: 600, startedAt: Date(timeIntervalSince1970: 1_700_000_000), sourcePhase: .active, taskId: "t1")
        try store.save(bs)
        let loaded = try store.load()
        XCTAssertEqual(loaded?.durationSeconds, 600)
        XCTAssertEqual(loaded?.taskId, "t1")
        try store.clear()
        XCTAssertNil(try store.load())
    }
    func test_open_ended_persists() throws {
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }
        let file = tmp.appendingPathComponent("break.json")
        let store = BreakSessionStore(fileURL: file)
        let bs = BreakState(durationSeconds: nil, startedAt: Date(), sourcePhase: .paused, taskId: nil)
        try store.save(bs)
        XCTAssertNil(try store.load()?.durationSeconds)
        XCTAssertTrue(try store.load()?.isOpenEnded == true)
    }

    func test_corrupt_break_state_is_not_treated_as_no_break() throws {
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }
        let file = tmp.appendingPathComponent("break.json")
        try Data("damaged".utf8).write(to: file, options: [.atomic])
        let store = BreakSessionStore(fileURL: file)

        XCTAssertThrowsError(try store.load())
        XCTAssertEqual(try Data(contentsOf: file), Data("damaged".utf8))
    }
}

final class BreakTimerTests: XCTestCase {
    func test_break_timer_counts() {
        let start = Date(timeIntervalSince1970: 3_000_000)
        let clock = ManualClock(now: start)
        let bs = BreakState(durationSeconds: 300, startedAt: start, sourcePhase: .active, taskId: "t")
        // Simulate tick via BreakState directly (BreakTimer is @MainActor, test via state)
        XCTAssertEqual(bs.remainingSeconds(now: clock.now()), 300)
        clock.advance(by: 60)
        XCTAssertEqual(bs.remainingSeconds(now: clock.now()), 240)
        XCTAssertEqual(bs.elapsedSeconds(now: clock.now()), 60)
        clock.advance(by: 240)
        XCTAssertEqual(bs.remainingSeconds(now: clock.now()), 0)
        XCTAssertTrue(bs.isExpired(now: clock.now()))
    }
    func test_break_open_elapsed() {
        let start = Date(timeIntervalSince1970: 4_000_000)
        let clock = ManualClock(now: start)
        let bs = BreakState(durationSeconds: nil, startedAt: start, sourcePhase: .active, taskId: nil)
        clock.advance(by: 123)
        XCTAssertEqual(bs.elapsedSeconds(now: clock.now()), 123)
        XCTAssertNil(bs.remainingSeconds(now: clock.now()))
    }
}

final class BreakReturnTests: XCTestCase {
    func test_pause_before_break_freeze() {
        // Start active, then pause, then break
        let start = Date(timeIntervalSince1970: 5_000_000)
        var exec = ExecutionState(taskId: "t", phase: .active, startedAt: start, plannedDurationSeconds: 600)
        // 100s elapsed active
        let pauseAt = start.addingTimeInterval(100)
        exec = exec.paused(at: pauseAt)!
        XCTAssertEqual(exec.remainingSeconds(now: pauseAt), 500)
        // Start break at pauseAt
        let clock = ManualClock(now: pauseAt)
        let bs = BreakState(durationSeconds: 300, startedAt: clock.now(), sourcePhase: exec.phase, taskId: exec.taskId)
        // Simulate break 60s
        clock.advance(by: 60)
        // Focus remaining should still be 500 (frozen)
        XCTAssertEqual(exec.remainingSeconds(now: clock.now()), 500)
        // Break remaining should be 240
        XCTAssertEqual(bs.remainingSeconds(now: clock.now()), 240)
        // Break elapsed 60
        XCTAssertEqual(bs.elapsedSeconds(now: clock.now()), 60)
    }
    func test_break_does_not_bleed_into_focus() {
        let start = Date(timeIntervalSince1970: 6_000_000)
        var exec = ExecutionState(taskId: "t", phase: .active, startedAt: start, plannedDurationSeconds: 600)
        let breakStart = start.addingTimeInterval(100)
        exec = exec.paused(at: breakStart)!
        let clock = ManualClock(now: breakStart)
        let bs = BreakState(durationSeconds: 300, startedAt: clock.now(), sourcePhase: exec.phase, taskId: exec.taskId)
        // Simulate sleep 10 min during break (wall clock jumps, but exec is paused so should not count)
        clock.advance(by: 600)
        // Focus still 500
        XCTAssertEqual(exec.remainingSeconds(now: clock.now()), 500)
        // Break should be expired after 300, but we advanced 600, so remaining 0, elapsed 600
        XCTAssertEqual(bs.remainingSeconds(now: clock.now()), 0)
        XCTAssertTrue(bs.isExpired(now: clock.now()))
        XCTAssertEqual(bs.elapsedSeconds(now: clock.now()), 600)
    }
}
