import XCTest
@testable import GoalflowMac

final class SchedulingTests: XCTestCase {
    func test_queue_ordering_frog_before_ordinary() {
        let today = "2026-08-30"
        let base = "2026-08-30T10:00:00Z"
        let frog = GoalflowTask(id: "f", title: "Frog", scheduledFor: today, plannedOrder: 10, status: .open, isFrog: true, createdAt: base, updatedAt: base)
        let normal = GoalflowTask(id: "n", title: "Normal", scheduledFor: today, plannedOrder: 0, status: .open, isFrog: false, createdAt: base, updatedAt: base)
        let beforeFrog = GoalflowTask(id: "b", title: "Habit before frog", scheduledFor: today, plannedOrder: 5, status: .open, isFrog: false, beforeFrog: true, habitId: "h1", createdAt: base, updatedAt: base)
        let sorted = [normal, frog, beforeFrog].sorted(by: goalflowTaskComparator)
        XCTAssertEqual(sorted.map(\.id), ["b","f","n"])
    }

    func test_today_queue_filters() {
        let t1 = GoalflowTask(id: "1", title: "Today open", scheduledFor: "2026-08-30", status: .open, createdAt: "2026-08-30T00:00:00Z", updatedAt: "2026-08-30T00:00:00Z")
        let t2 = GoalflowTask(id: "2", title: "Other day", scheduledFor: "2026-08-31", status: .open, createdAt: "2026-08-30T00:00:00Z", updatedAt: "2026-08-30T00:00:00Z")
        let t3 = GoalflowTask(id: "3", title: "Completed today", scheduledFor: "2026-08-30", status: .completed, createdAt: "2026-08-30T00:00:00Z", updatedAt: "2026-08-30T00:00:00Z")
        let q = buildTodayQueue(tasks: [t1,t2,t3], today: "2026-08-30")
        XCTAssertEqual(q.map(\.id), ["1"])
    }

    func test_plannedOrder_determines_tiebreak() {
        let today = "2026-08-30"
        let a = GoalflowTask(id: "a", title: "A", scheduledFor: today, plannedOrder: 2, status: .open, createdAt: "2026-08-30T01:00:00Z", updatedAt: "2026-08-30T01:00:00Z")
        let b = GoalflowTask(id: "b", title: "B", scheduledFor: today, plannedOrder: 1, status: .open, createdAt: "2026-08-30T01:00:00Z", updatedAt: "2026-08-30T01:00:00Z")
        let q = [a,b].sorted(by: goalflowTaskComparator)
        XCTAssertEqual(q.map(\.id), ["b","a"])
    }
}
