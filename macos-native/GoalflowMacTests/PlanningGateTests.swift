import XCTest
@testable import GoalflowMac

final class PlanningGateTests: XCTestCase {
    func makeTask(id: String, title: String = "T", scheduledFor: String, precision: SchedulePrecision = .day, plannedOrder: Int = 0, status: TaskStatus = .open) -> GoalflowTask {
        GoalflowTask(id: id, title: title, schedulePrecision: precision, scheduledFor: scheduledFor, plannedOrder: plannedOrder, status: status)
    }

    func test_monthly_required_blocks() {
        let today = "2026-09-01"
        let tasks = [
            makeTask(id: "m1", scheduledFor: "2026-09", precision: .month),
            makeTask(id: "t1", scheduledFor: today)
        ]
        let gate = getPlanningGate(tasks: tasks, today: today, dailyPlan: nil)
        if case .monthlyPlanningRequired(let month, let ids) = gate {
            XCTAssertEqual(month, "2026-09")
            XCTAssertTrue(ids.contains("m1"))
        } else { XCTFail("expected monthly") }
    }

    func test_month_future_not_blocking() {
        let today = "2026-09-01"
        let tasks = [ makeTask(id: "m1", scheduledFor: "2026-10", precision: .month) ]
        let gate = getPlanningGate(tasks: tasks, today: today, dailyPlan: nil)
        XCTAssertEqual(gate, .empty) // no day queue, month future not required
    }

    func test_overdue_triggers_daily_required() {
        let today = "2026-09-01"
        let tasks = [ makeTask(id: "o1", scheduledFor: "2026-08-31") ]
        let gate = getPlanningGate(tasks: tasks, today: today, dailyPlan: nil)
        if case .dailyPlanningRequired(let date, let over, _) = gate {
            XCTAssertEqual(date, today)
            XCTAssertTrue(over.contains("o1"))
        } else { XCTFail("expected daily") }
    }

    func test_queue_without_plan_requires_daily() {
        let today = "2026-09-01"
        let tasks = [ makeTask(id: "t1", scheduledFor: today, plannedOrder: 0) ]
        let gate = getPlanningGate(tasks: tasks, today: today, dailyPlan: nil)
        if case .dailyPlanningRequired(_, _, let ids) = gate {
            XCTAssertEqual(ids, ["t1"])
        } else { XCTFail("expected daily planning") }
    }

    func test_ready_when_plan_matches() {
        let today = "2026-09-01"
        let tasks = [
            makeTask(id: "t1", scheduledFor: today, plannedOrder: 0),
            makeTask(id: "t2", scheduledFor: today, plannedOrder: 1)
        ]
        let plan = DailyPlan(localDate: today, confirmedAt: ISO8601DateFormatter().string(from: Date()), taskIds: ["t1","t2"])
        let gate = getPlanningGate(tasks: tasks, today: today, dailyPlan: plan)
        if case .ready(let q) = gate {
            XCTAssertEqual(q.map(\.id), ["t1","t2"])
        } else { XCTFail("expected ready") }
    }

    func test_ready_ignores_completed() {
        let today = "2026-09-01"
        let tasks = [
            makeTask(id: "t1", scheduledFor: today, plannedOrder: 0, status: .completed),
            makeTask(id: "t2", scheduledFor: today, plannedOrder: 1)
        ]
        let plan = DailyPlan(localDate: today, confirmedAt: ISO8601DateFormatter().string(from: Date()), taskIds: ["t2"])
        let gate = getPlanningGate(tasks: tasks, today: today, dailyPlan: plan)
        if case .ready(let q) = gate { XCTAssertEqual(q.map(\.id), ["t2"]) }
        else { XCTFail("expected ready") }
    }

    func test_empty_when_no_tasks() {
        let gate = getPlanningGate(tasks: [], today: "2026-09-01", dailyPlan: nil)
        XCTAssertEqual(gate, .empty)
    }

    func test_plan_mismatch_order_triggers_daily() {
        let today = "2026-09-01"
        let tasks = [
            makeTask(id: "a", scheduledFor: today, plannedOrder: 0),
            makeTask(id: "b", scheduledFor: today, plannedOrder: 1)
        ]
        let plan = DailyPlan(localDate: today, confirmedAt: "x", taskIds: ["b","a"])
        let gate = getPlanningGate(tasks: tasks, today: today, dailyPlan: plan)
        if case .dailyPlanningRequired = gate {} else { XCTFail("expected daily") }
    }
}
