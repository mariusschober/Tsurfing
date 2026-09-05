import XCTest
@testable import GoalflowMac

final class CalendarCollisionTests: XCTestCase {
    func test_no_scheduledTime_returns_nil() async {
        let svc = NoopCalendarService()
        let task = GoalflowTask(id: "t", title: "No time", schedulePrecision: .day, scheduledFor: "2026-09-01", scheduledTime: nil)
        let res = await svc.collision(for: task, today: "2026-09-01")
        XCTAssertNil(res)
    }

    func test_month_precision_returns_nil() async {
        let svc = NoopCalendarService()
        let task = GoalflowTask(id: "t", title: "Month", schedulePrecision: .month, scheduledFor: "2026-09", scheduledTime: "14:30")
        let res = await svc.collision(for: task, today: "2026-09-01")
        XCTAssertNil(res)
    }

    func test_mock_collision_overlap() async {
        struct Mock: CalendarCollisionService {
            func collision(for task: GoalflowTask, today: String) async -> CalendarCollision? {
                guard task.scheduledTime == "14:30" else { return nil }
                let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd HH:mm"; f.timeZone = .current
                let s = f.date(from: "\(today) 14:40")!
                let e = f.date(from: "\(today) 15:00")!
                return CalendarCollision(eventTitle: "Sprint Planning", start: s, end: e)
            }
            func requestAccessIfNeeded() async -> Bool { true }
        }
        let svc = Mock()
        let task = GoalflowTask(id: "t", title: "Overlap", schedulePrecision: .day, scheduledFor: "2026-09-01", scheduledTime: "14:30", plannedOrder: 0, durationMinutes: 25)
        let res = await svc.collision(for: task, today: "2026-09-01")
        XCTAssertNotNil(res)
        XCTAssertEqual(res?.eventTitle, "Sprint Planning")
    }

    func test_no_collision_when_no_time_match() async {
        struct MockNo: CalendarCollisionService {
            func collision(for task: GoalflowTask, today: String) async -> CalendarCollision? { nil }
            func requestAccessIfNeeded() async -> Bool { false }
        }
        let svc = MockNo()
        let task = GoalflowTask(id: "t", title: "No overlap", schedulePrecision: .day, scheduledFor: "2026-09-01", scheduledTime: "09:00", durationMinutes: 25)
        let res = await svc.collision(for: task, today: "2026-09-01")
        XCTAssertNil(res)
    }

    func test_task_interval_computation() {
        let today = "2026-09-01"
        let task = GoalflowTask(id: "t", title: "Interval", schedulePrecision: .day, scheduledFor: today, scheduledTime: "14:30", durationMinutes: 25)
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd HH:mm"; f.timeZone = .current
        let start = f.date(from: "\(today) \(task.scheduledTime!)")!
        let end = Calendar.current.date(byAdding: .minute, value: task.durationMinutes, to: start)!
        let expectedStart = f.date(from: "2026-09-01 14:30")!
        let expectedEnd = f.date(from: "2026-09-01 14:55")!
        XCTAssertEqual(start, expectedStart)
        XCTAssertEqual(end, expectedEnd)
    }

    func test_request_access_mock_returns() async {
        let svc = NoopCalendarService()
        let ok = await svc.requestAccessIfNeeded()
        XCTAssertFalse(ok)
    }
}
