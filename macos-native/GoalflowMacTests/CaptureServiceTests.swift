import XCTest
@testable import GoalflowMac
import Foundation

final class CaptureServiceTests: XCTestCase {
    private func makeStore() -> (LocalTaskStore, URL, URL, UserDefaults) {
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try! FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        let file = tmp.appendingPathComponent("tasks.json")
        let defaults = UserDefaults(suiteName: UUID().uuidString)!
        let store = LocalTaskStore(fileURL: file, defaults: defaults)
        return (store, tmp, file, defaults)
    }

    func test_add_persists_before_next_and_no_resurrection() throws {
        let (store, tmp, file, defaults) = makeStore()
        defer { try? FileManager.default.removeItem(at: tmp) }
        let clock = ManualClock(now: ISO8601DateFormatter().date(from: "2026-09-01T10:00:00Z")!)
        let svc = LocalCaptureService(taskStore: store, clock: clock)
        let parsed = CaptureParser.parse(raw: "Write proposal @25m #focus 2026-09-01", today: "2026-09-01")
        XCTAssertEqual(parsed.cleanTitle, "Write proposal")
        let task = try svc.createTask(from: parsed, notes: nil, scheduledFor: "2026-09-01", precision: .day, scheduledTime: nil, intent: .add)
        XCTAssertEqual(task.title, "Write proposal")
        XCTAssertEqual(task.durationMinutes, 25)
        XCTAssertEqual(task.tags, ["focus"])
        XCTAssertEqual(task.scheduledFor, "2026-09-01")
        XCTAssertEqual(task.schedulePrecision, .day)
        XCTAssertEqual(task.version, 1)
        let all = try store.loadAll()
        XCTAssertEqual(all.count, 1)
        XCTAssertEqual(all.first?.id, task.id)
        let all2 = try LocalTaskStore(fileURL: file, defaults: defaults).loadAll()
        XCTAssertEqual(all2.count, 1)
    }

    func test_no_unscheduled_rejects_empty_title() {
        let (store, tmp, _, _) = makeStore()
        defer { try? FileManager.default.removeItem(at: tmp) }
        let clock = ManualClock(now: Date())
        let svc = LocalCaptureService(taskStore: store, clock: clock)
        let parsed = CaptureParser.parse(raw: "@25m #tag 2026-09-01", today: "2026-09-01")
        XCTAssertEqual(parsed.cleanTitle, "")
        XCTAssertThrowsError(try svc.createTask(from: parsed, notes: nil, scheduledFor: "2026-09-01", precision: .day, scheduledTime: nil, intent: .add)) { e in
            XCTAssertEqual((e as? SchedulingError)?.code, .invalidTitle)
        }
    }

    func test_plannedOrder_tail() throws {
        let (store, tmp, _, _) = makeStore()
        defer { try? FileManager.default.removeItem(at: tmp) }
        let clock = ManualClock(now: Date())
        let svc = LocalCaptureService(taskStore: store, clock: clock)
        let p1 = CaptureParser.parse(raw: "First @15m 2026-09-01", today: "2026-09-01")
        let t1 = try svc.createTask(from: p1, notes: nil, scheduledFor: "2026-09-01", precision: .day, scheduledTime: nil, intent: .add)
        XCTAssertEqual(t1.plannedOrder, 0)
        let p2 = CaptureParser.parse(raw: "Second @15m 2026-09-01", today: "2026-09-01")
        let t2 = try svc.createTask(from: p2, notes: nil, scheduledFor: "2026-09-01", precision: .day, scheduledTime: nil, intent: .add)
        XCTAssertEqual(t2.plannedOrder, 1)
        let p3 = CaptureParser.parse(raw: "Other day @15m 2026-09-02", today: "2026-09-01")
        let t3 = try svc.createTask(from: p3, notes: nil, scheduledFor: "2026-09-02", precision: .day, scheduledTime: nil, intent: .add)
        XCTAssertEqual(t3.plannedOrder, 0)
    }

    func test_month_future_and_time_validation() throws {
        let (store, tmp, _, _) = makeStore()
        defer { try? FileManager.default.removeItem(at: tmp) }
        let clock = ManualClock(now: ISO8601DateFormatter().date(from: "2026-09-01T00:00:00Z")!)
        let svc = LocalCaptureService(taskStore: store, clock: clock)
        let p = CaptureParser.parse(raw: "Idea 2026-11", today: "2026-09-01")
        let t = try svc.createTask(from: p, notes: nil, scheduledFor: "2026-11", precision: .month, scheduledTime: nil, intent: .add)
        XCTAssertEqual(t.schedulePrecision, .month)
        XCTAssertThrowsError(try svc.createTask(from: p, notes: nil, scheduledFor: "2026-11", precision: .month, scheduledTime: "10:00", intent: .add))
    }

    func test_url_captured_to_notes_and_tags_preserved() throws {
        let (store, tmp, _, _) = makeStore()
        defer { try? FileManager.default.removeItem(at: tmp) }
        let clock = ManualClock(now: Date())
        let svc = LocalCaptureService(taskStore: store, clock: clock)
        let p = CaptureParser.parse(raw: "Check https://example.com #research 2026-09-01", today: "2026-09-01")
        let t = try svc.createTask(from: p, notes: "extra note", scheduledFor: "2026-09-01", precision: .day, scheduledTime: nil, intent: .add)
        XCTAssertTrue(t.notes.contains("extra note"))
        XCTAssertTrue(t.notes.contains("https://example.com"))
        XCTAssertEqual(t.tags, ["research"])
    }

    func test_scheduledTime_only_with_day() throws {
        let (store, tmp, _, _) = makeStore()
        defer { try? FileManager.default.removeItem(at: tmp) }
        let clock = ManualClock(now: Date())
        let svc = LocalCaptureService(taskStore: store, clock: clock)
        let p = CaptureParser.parse(raw: "Meet 2026-09-01 14:30", today: "2026-09-01")
        let t = try svc.createTask(from: p, notes: nil, scheduledFor: "2026-09-01", precision: .day, scheduledTime: "14:30", intent: .add)
        XCTAssertEqual(t.scheduledTime, "14:30")
        XCTAssertThrowsError(try svc.createTask(from: p, notes: nil, scheduledFor: "2026-09-01", precision: .day, scheduledTime: "25:00", intent: .add))
    }
}

