import XCTest
@testable import GoalflowMac
import Foundation

final class FocusSessionStoreTests: XCTestCase {
    func test_persists_and_recovers() throws {
        let suite = "test.store.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = UserDefaultsFocusSessionStore(defaults: defaults)
        XCTAssertNil(try store.load())
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let s = ExecutionState(taskId: "demo-1", phase: .active, startedAt: now, plannedDurationSeconds: 1500)
        try store.save(s)
        let loaded = try store.load()
        XCTAssertEqual(loaded, s)
        try store.clear()
        XCTAssertNil(try store.load())
    }

    func test_overwrite_updates() throws {
        let suite = "test.store.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = UserDefaultsFocusSessionStore(defaults: defaults)
        let a = ExecutionState(taskId: "a", phase: .active, startedAt: Date(), plannedDurationSeconds: 600)
        try store.save(a)
        let b = ExecutionState(taskId: "b", phase: .active, startedAt: Date().addingTimeInterval(10), plannedDurationSeconds: 900)
        try store.save(b)
        let loaded = try store.load()
        XCTAssertEqual(loaded?.taskId, b.taskId)
        XCTAssertEqual(loaded?.phase, b.phase)
        XCTAssertEqual(loaded?.plannedDurationSeconds, b.plannedDurationSeconds)
        XCTAssertNotNil(loaded?.startedAt)
        // Millisecond tolerance due to Double codec
        XCTAssertEqual(loaded!.startedAt.timeIntervalSince1970, b.startedAt.timeIntervalSince1970, accuracy: 0.001)
    }

    func test_clear_idempotent() throws {
        let suite = "test.store.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = UserDefaultsFocusSessionStore(defaults: defaults)
        try store.clear() // should not throw
        XCTAssertNil(try store.load())
    }
}
