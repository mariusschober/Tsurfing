import XCTest
@testable import GoalflowMac
import Foundation

final class ExecutionStatePauseTests: XCTestCase {
    func test_pause_freezes_remaining() {
        let start = Date(timeIntervalSince1970: 1_000_000)
        var s = ExecutionState(taskId: "t", phase: .active, startedAt: start, plannedDurationSeconds: 600)
        let pauseAt = start.addingTimeInterval(100)
        s = s.paused(at: pauseAt)!
        XCTAssertTrue(s.isPaused)
        XCTAssertEqual(s.remainingSeconds(now: pauseAt), 500)
        // 50s later while paused, still 500
        XCTAssertEqual(s.remainingSeconds(now: pauseAt.addingTimeInterval(50)), 500)
        XCTAssertEqual(s.elapsedSeconds(now: pauseAt.addingTimeInterval(50)), 100)
    }

    func test_resume_adds_pause_interval() {
        let start = Date(timeIntervalSince1970: 1_000_000)
        var s = ExecutionState(taskId: "t", phase: .active, startedAt: start, plannedDurationSeconds: 600)
        s = s.paused(at: start.addingTimeInterval(100))!
        s = s.resumed(at: start.addingTimeInterval(160))! // 60s pause
        XCTAssertEqual(s.accumulatedPauseSeconds, 60)
        XCTAssertEqual(s.remainingSeconds(now: start.addingTimeInterval(160)), 500) // still 500 at resume
        XCTAssertEqual(s.remainingSeconds(now: start.addingTimeInterval(200)), 460) // 40s after resume
        XCTAssertEqual(s.elapsedSeconds(now: start.addingTimeInterval(200)), 140)
    }

    func test_pause_resume_10_cycles_additive() {
        let start = Date(timeIntervalSince1970: 2_000_000)
        var s = ExecutionState(taskId: "t", phase: .active, startedAt: start, plannedDurationSeconds: 3600)
        var now = start.addingTimeInterval(100)
        var totalPause = 0
        for i in 1...10 {
            s = s.paused(at: now)!
            let pauseDur = TimeInterval(i * 5) // 5,10,15...
            totalPause += Int(pauseDur)
            now = now.addingTimeInterval(pauseDur)
            s = s.resumed(at: now)!
            // advance 10s focused
            now = now.addingTimeInterval(10)
        }
        XCTAssertEqual(s.accumulatedPauseSeconds, totalPause)
        // elapsed = (now - start) - totalPause
        let raw = Int(now.timeIntervalSince(start).rounded(.down))
        XCTAssertEqual(s.elapsedSeconds(now: now), raw - totalPause)
    }

    func test_overtime_counts_separately() {
        let start = Date(timeIntervalSince1970: 3_000_000)
        var s = ExecutionState(taskId: "t", phase: .active, startedAt: start, plannedDurationSeconds: 100)
        XCTAssertEqual(s.remainingSeconds(now: start.addingTimeInterval(99)), 1)
        XCTAssertEqual(s.overtimeSeconds(now: start.addingTimeInterval(99)), 0)
        XCTAssertEqual(s.remainingSeconds(now: start.addingTimeInterval(100)), 0)
        XCTAssertEqual(s.overtimeSeconds(now: start.addingTimeInterval(100)), 0)
        XCTAssertEqual(s.remainingSeconds(now: start.addingTimeInterval(150)), 0)
        XCTAssertEqual(s.overtimeSeconds(now: start.addingTimeInterval(150)), 50)
        // Overtime frozen while paused
        s = s.paused(at: start.addingTimeInterval(150))!
        XCTAssertEqual(s.overtimeSeconds(now: start.addingTimeInterval(200)), 0)
        XCTAssertEqual(s.remainingSeconds(now: start.addingTimeInterval(200)), 0)
    }

    func test_extend_increases_planned() {
        let start = Date(timeIntervalSince1970: 4_000_000)
        var s = ExecutionState(taskId: "t", phase: .active, startedAt: start, plannedDurationSeconds: 600)
        s = s.extended(by: 300)!
        XCTAssertEqual(s.plannedDurationSeconds, 900)
        XCTAssertEqual(s.remainingSeconds(now: start.addingTimeInterval(100)), 800)
        // Overtime after extend: 650 elapsed vs 900 planned => no overtime
        XCTAssertEqual(s.overtimeSeconds(now: start.addingTimeInterval(650)), 0)
        XCTAssertEqual(s.remainingSeconds(now: start.addingTimeInterval(650)), 250)
    }

    func test_extend_while_paused_stays_paused() {
        let start = Date(timeIntervalSince1970: 5_000_000)
        var s = ExecutionState(taskId: "t", phase: .active, startedAt: start, plannedDurationSeconds: 600)
        s = s.paused(at: start.addingTimeInterval(100))!
        s = s.extended(by: 300)!
        XCTAssertTrue(s.isPaused)
        XCTAssertEqual(s.plannedDurationSeconds, 900)
        XCTAssertEqual(s.remainingSeconds(now: start.addingTimeInterval(100)), 800)
    }

    func test_extend_caps_1440() {
        let s = ExecutionState(taskId: "t", phase: .active, startedAt: Date(), plannedDurationSeconds: 1440*60 - 100)
        let e = s.extended(by: 500)!
        XCTAssertEqual(e.plannedDurationSeconds, 1440*60)
    }

    func test_pause_idempotent_guard() {
        let s = ExecutionState(taskId: "t", phase: .idle, startedAt: Date(), plannedDurationSeconds: 600)
        XCTAssertNil(s.paused(at: Date()))
        let a = ExecutionState(taskId: "t", phase: .active, startedAt: Date(), plannedDurationSeconds: 600)
        let p = a.paused(at: Date())!
        XCTAssertNil(p.paused(at: Date())) // already paused
        XCTAssertNotNil(p.resumed(at: Date().addingTimeInterval(5)))
        XCTAssertNil(a.resumed(at: Date())) // active can't resume
    }

    func test_clock_skew_clamped() {
        let start = Date(timeIntervalSince1970: 6_000_000)
        let s = ExecutionState(taskId: "t", phase: .active, startedAt: start, plannedDurationSeconds: 600)
        // now before start (clock set back)
        XCTAssertEqual(s.remainingSeconds(now: start.addingTimeInterval(-10)), 600)
        XCTAssertEqual(s.elapsedSeconds(now: start.addingTimeInterval(-10)), 0)
    }
}

final class MonotonicClockTests: XCTestCase {
    func test_wall_vs_monotonic_2h_within_2s() {
        let start = Date(timeIntervalSince1970: 7_000_000)
        let clock = ManualClock(now: start, monotonic: 0)
        let state = ExecutionState(taskId: "t", phase: .active, startedAt: start, startedAtMonotonic: 0, plannedDurationSeconds: 7200)
        // Advance 2 hours wall + monotonic together
        clock.advance(by: 7200)
        XCTAssertEqual(state.remainingSeconds(now: clock.now()), 0)
        XCTAssertEqual(state.overtimeSeconds(now: clock.now()), 0)
        // Wall elapsed 7200, monotonic ~7200e9 ticks; our ManualClock keeps them synced, diff 0 <=2s
        let wallElapsed = Int(clock.now().timeIntervalSince(start).rounded(.down))
        let monoElapsedSec = Int(Double(clock.monotonicNow) / 1_000_000_000.0)
        XCTAssertEqual(abs(wallElapsed - monoElapsedSec), 0)
        // Simulate wall clock jumped 100s ahead (NTP) but monotonic didn't — we detect drift
        clock.set(start.addingTimeInterval(7300), monotonic: 7200 * 1_000_000_000)
        let wall2 = Int(clock.now().timeIntervalSince(start).rounded(.down))
        let mono2 = Int(Double(clock.monotonicNow) / 1_000_000_000.0)
        XCTAssertEqual(abs(wall2 - mono2), 100) // detectable drift
        // But remaining still based on wall; monotonic is for sleep detection not yet auto-correcting — just measurable
    }
}

final class FileFocusSessionStoreTests: XCTestCase {
    func test_file_persists_and_recovers() throws {
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }
        let file = tmp.appendingPathComponent("execution.json")
        let store = FileFocusSessionStore(fileURL: file)
        XCTAssertNil(try store.load())
        let s = ExecutionState(taskId: "t", phase: .active, startedAt: Date(timeIntervalSince1970: 1_700_000_000), plannedDurationSeconds: 900)
        try store.save(s)
        let loaded = try store.load()
        XCTAssertEqual(loaded?.taskId, s.taskId)
        XCTAssertEqual(loaded?.plannedDurationSeconds, s.plannedDurationSeconds)
        try store.clear()
        XCTAssertNil(try store.load())
    }

    func test_composite_migrates_from_wal() throws {
        let suite = "test.migrate.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let wal = UserDefaultsFocusSessionStore(defaults: defaults)
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }
        let file = tmp.appendingPathComponent("execution.json")
        let fileStore = FileFocusSessionStore(fileURL: file)
        let s = ExecutionState(taskId: "migrate", phase: .active, startedAt: Date(), plannedDurationSeconds: 600)
        try wal.save(s)
        XCTAssertNil(try fileStore.load())
        let composite = CompositeFocusSessionStore(fileStore: fileStore, walStore: wal)
        let loaded = try composite.load()
        XCTAssertEqual(loaded?.taskId, "migrate")
        XCTAssertNotNil(try fileStore.load())
        // second load prefers file
        let second = try composite.load()
        XCTAssertEqual(second?.taskId, "migrate")
    }

    func test_composite_double_write() throws {
        let suite = "test.double.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let wal = UserDefaultsFocusSessionStore(defaults: defaults)
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }
        let file = tmp.appendingPathComponent("execution.json")
        let fileStore = FileFocusSessionStore(fileURL: file)
        let composite = CompositeFocusSessionStore(fileStore: fileStore, walStore: wal)
        let s = ExecutionState(taskId: "both", phase: .paused, startedAt: Date(), plannedDurationSeconds: 900, accumulatedPauseSeconds: 30, lastPausedAt: Date())
        try composite.save(s)
        XCTAssertEqual(try fileStore.load()?.taskId, "both")
        XCTAssertEqual(try wal.load()?.taskId, "both")
    }

    func test_composite_repairs_corrupt_file_from_valid_mirror() throws {
        let suite = "test.focus.repair.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let wal = UserDefaultsFocusSessionStore(defaults: defaults)
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }
        let file = tmp.appendingPathComponent("execution.json")
        let expected = ExecutionState(taskId: "recover-focus", phase: .paused, startedAt: Date(), plannedDurationSeconds: 900)
        try wal.save(expected)
        try Data("damaged".utf8).write(to: file, options: [.atomic])

        let fileStore = FileFocusSessionStore(fileURL: file)
        let composite = CompositeFocusSessionStore(fileStore: fileStore, walStore: wal)
        XCTAssertEqual(try composite.load()?.taskId, expected.taskId)
        XCTAssertEqual(try fileStore.load()?.taskId, expected.taskId)
    }

    func test_composite_surfaces_two_corrupt_replicas() throws {
        let suite = "test.focus.corrupt.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let wal = UserDefaultsFocusSessionStore(defaults: defaults)
        wal.setRawData(Data("damaged-mirror".utf8))
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }
        let file = tmp.appendingPathComponent("execution.json")
        try Data("damaged-file".utf8).write(to: file, options: [.atomic])

        let composite = CompositeFocusSessionStore(fileStore: FileFocusSessionStore(fileURL: file), walStore: wal)
        XCTAssertThrowsError(try composite.load())
        XCTAssertEqual(try Data(contentsOf: file), Data("damaged-file".utf8))
    }
}
