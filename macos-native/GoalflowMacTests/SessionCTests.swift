import XCTest
@testable import GoalflowMac
import Foundation
final class CompletionHoldTests: XCTestCase {
    func test_ordinary_3s_frog_5s() {
        let clock = ManualClock(now: Date(timeIntervalSince1970: 1_000_000))
        let ordinary = CompletionHoldController(isFrog: false, clock: clock)
        XCTAssertEqual(ordinary.duration, 3.0, accuracy: 0.01)
        let frog = CompletionHoldController(isFrog: true, clock: clock)
        XCTAssertEqual(frog.duration, 5.0, accuracy: 0.01)
    }
    func test_hold_progress_and_completion() {
        let start = Date(timeIntervalSince1970: 2_000_000)
        let clock = ManualClock(now: start)
        let hc = CompletionHoldController(isFrog: false, clock: clock)
        hc.start(at: start)
        XCTAssertEqual(hc.progress(at: start), 0, accuracy: 0.01)
        XCTAssertFalse(hc.isCompleted(at: start))
        XCTAssertEqual(hc.progress(at: start.addingTimeInterval(1.5)), 0.5, accuracy: 0.01)
        XCTAssertFalse(hc.isCompleted(at: start.addingTimeInterval(2.9)))
        XCTAssertTrue(hc.isCompleted(at: start.addingTimeInterval(3.0)))
        XCTAssertTrue(hc.isCompleted(at: start.addingTimeInterval(4.0)))
    }
    func test_hold_cancel_before_threshold() {
        let start = Date(timeIntervalSince1970: 3_000_000)
        let clock = ManualClock(now: start)
        let hc = CompletionHoldController(isFrog: false, clock: clock)
        hc.start(at: start)
        XCTAssertEqual(hc.progress(at: start.addingTimeInterval(1.0)), 0.33, accuracy: 0.02)
        hc.cancel()
        XCTAssertEqual(hc.progress(at: start.addingTimeInterval(2.0)), 0, accuracy: 0.01)
        XCTAssertFalse(hc.isCompleted(at: start.addingTimeInterval(5.0)))
        XCTAssertFalse(hc.isHolding)
    }
    func test_frog_requires_5s() {
        let start = Date(timeIntervalSince1970: 4_000_000)
        let clock = ManualClock(now: start)
        let hc = CompletionHoldController(isFrog: true, clock: clock)
        hc.start(at: start)
        XCTAssertFalse(hc.isCompleted(at: start.addingTimeInterval(3.0)))
        XCTAssertTrue(hc.isCompleted(at: start.addingTimeInterval(5.0)))
    }
}
final class FlowStateTests: XCTestCase {
    func test_flowState_allCases() {
        XCTAssertEqual(FlowState.allCases.count, 4)
        XCTAssertNotNil(FlowState(rawValue: "distracted"))
        XCTAssertNotNil(FlowState(rawValue: "good"))
        XCTAssertNotNil(FlowState(rawValue: "high"))
        XCTAssertNotNil(FlowState(rawValue: "flow"))
        XCTAssertNil(FlowState(rawValue: "invalid"))
        XCTAssertNil(FlowState(rawValue: ""))
    }
    func test_withCompleted_preserves_extraJson() throws {
        var task = GoalflowTask(id: "t", title: "Test", scheduledFor: "2026-08-30", createdAt: "2026-08-30T00:00:00Z", updatedAt: "2026-08-30T00:00:00Z", extraJson: "{\"keep\":\"x\",\"duration\":25}")
        task = try task.withCompleted(at: Date(timeIntervalSince1970: 1_700_000_000), actualDurationMinutes: 10, flowState: FlowState.high)
        XCTAssertEqual(task.status, .completed)
        XCTAssertEqual(task.version, 2)
        XCTAssertEqual(task.flowState, FlowState.high)
        XCTAssertEqual(task.actualDurationMinutes, 10)
        if let data = task.extraJson.data(using: .utf8),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            XCTAssertEqual(obj["keep"] as? String, "x")
        } else { XCTFail() }
    }
    func test_withFlowState_merges() throws {
        var task = GoalflowTask(id: "t", title: "Test", scheduledFor: "2026-08-30", status: .completed, createdAt: "2026-08-30T00:00:00Z", updatedAt: "2026-08-30T00:00:00Z", version: 2, extraJson: "{\"actualDuration\":10,\"keep\":\"y\"}")
        task = try task.withFlowState(FlowState.flow)
        XCTAssertEqual(task.flowState, FlowState.flow)
        XCTAssertEqual(task.version, 3)
        if let data = task.extraJson.data(using: .utf8),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            XCTAssertEqual(obj["keep"] as? String, "y")
            XCTAssertEqual(obj["actualDuration"] as? Int, 10)
        } else { XCTFail() }
    }

    func test_corrupt_extra_json_blocks_completion_without_changing_identity() {
        let task = GoalflowTask(
            id: "durable-corrupt-metadata-id",
            title: "Do not partially complete",
            scheduledFor: "2026-08-30",
            extraJson: "not-json"
        )
        XCTAssertThrowsError(try task.withCompleted(at: Date(), actualDurationMinutes: 10, flowState: nil))
        XCTAssertEqual(task.id, "durable-corrupt-metadata-id")
        XCTAssertEqual(task.status, .open)
        XCTAssertEqual(task.version, 1)
    }
}
final class TaskCompletionPersistenceTests: XCTestCase {
    func test_complete_persists_before_next() throws {
        let suite = "test.complete.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }
        let file = tmp.appendingPathComponent("tasks.json")
        let store = LocalTaskStore(fileURL: file, defaults: defaults)
        let today = "2026-08-30"
        try store.seedIfEmpty(today: today)
        let before = try store.loadAll()
        XCTAssertEqual(before.filter(\.isOpen).count, 2)
        let firstId = try XCTUnwrap(before.first?.id)
        let secondId = try XCTUnwrap(before.dropFirst().first?.id)
        let completed = try store.completeTask(id: firstId, actualDurationMinutes: 5, flowState: nil)
        XCTAssertEqual(completed.status, .completed)
        XCTAssertEqual(completed.version, 2)
        XCTAssertNil(completed.flowState)
        let after = try store.loadAll()
        XCTAssertEqual(after.first(where: { $0.id == firstId })?.status, .completed)
        let queue = buildTodayQueue(tasks: after, today: today)
        XCTAssertEqual(queue.first?.id, secondId)
        var tasks = after
        guard let idx = tasks.firstIndex(where: { $0.id == firstId }) else { XCTFail(); return }
        tasks[idx] = try tasks[idx].withFlowState(FlowState.good)
        try store.saveAll(tasks)
        let final = try store.loadAll()
        XCTAssertEqual(final.first(where: { $0.id == firstId })?.flowState, FlowState.good)
        XCTAssertEqual(final.first(where: { $0.id == firstId })?.version, 3)
    }
    func test_no_resurrection_after_reload() throws {
        let suite = "test.nores.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }
        let file = tmp.appendingPathComponent("tasks.json")
        let store = LocalTaskStore(fileURL: file, defaults: defaults)
        let today = "2026-08-30"
        try store.seedIfEmpty(today: today)
        let seeded = try store.loadAll()
        for task in seeded { _ = try store.completeTask(id: task.id, actualDurationMinutes: 3, flowState: nil) }
        let after = try store.loadAll()
        let queue = buildTodayQueue(tasks: after, today: today)
        XCTAssertTrue(queue.isEmpty)
        let store2 = LocalTaskStore(fileURL: file, defaults: defaults)
        let after2 = try store2.loadAll()
        XCTAssertEqual(after2.filter(\.isOpen).count, 0)
        XCTAssertEqual(after2.filter { $0.status == .completed }.count, 2)
    }
    func test_complete_only_open() throws {
        let suite = "test.onlyopen.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }
        let file = tmp.appendingPathComponent("tasks.json")
        let store = LocalTaskStore(fileURL: file, defaults: defaults)
        let today = "2026-08-30"
        try store.seedIfEmpty(today: today)
        let firstId = try XCTUnwrap(store.loadAll().first?.id)
        _ = try store.completeTask(id: firstId, actualDurationMinutes: 2, flowState: nil)
        XCTAssertThrowsError(try store.completeTask(id: firstId, actualDurationMinutes: 2, flowState: nil))
    }
}
