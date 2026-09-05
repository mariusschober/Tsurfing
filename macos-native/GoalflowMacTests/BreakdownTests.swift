import XCTest
@testable import GoalflowMac

final class LocalBreakdownTests: XCTestCase {
    private func makeStore() -> (LocalTaskStore, DailyPlanStore, URL, UserDefaults) {
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try! FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        let f = tmp.appendingPathComponent("tasks.json")
        let p = tmp.appendingPathComponent("plans.json")
        let defaults = UserDefaults(suiteName: UUID().uuidString)!
        let store = LocalTaskStore(fileURL: f, defaults: defaults)
        let planStore = DailyPlanStore(fileURL: p, defaults: defaults)
        return (store, planStore, tmp, defaults)
    }

    func test_breakdown_closes_parent_and_creates_children() throws {
        let (store, planStore, tmp, _) = makeStore()
        defer { try? FileManager.default.removeItem(at: tmp) }
        let today = "2026-09-01"
        let clock = ManualClock(now: ISO8601DateFormatter().date(from: "2026-09-01T10:00:00Z")!)
        let parent = GoalflowTask(id: "parent", title: "Big task", schedulePrecision: .day, scheduledFor: today, plannedOrder: 0, status: .open)
        try store.saveAll([parent])
        let svc = LocalBreakdownService(taskStore: store, clock: clock, dailyPlanStore: planStore)
        let res = try svc.breakdown(taskId: "parent", children: [
            BreakdownChildInput(title: "Child 1", durationMinutes: 15),
            BreakdownChildInput(title: "Child 2", durationMinutes: 20)
        ])
        XCTAssertEqual(res.parent.status, .brokenDown)
        XCTAssertEqual(res.children.count, 2)
        XCTAssertEqual(res.children[0].parentTaskId, "parent")
        XCTAssertEqual(res.children[1].parentTaskId, "parent")
        XCTAssertEqual(res.children[0].plannedOrder, 0)
        XCTAssertEqual(res.children[1].plannedOrder, 1)
        // persisted
        let all = try store.loadAll()
        XCTAssertEqual(all.count, 3)
        XCTAssertTrue(all.contains { $0.id == "parent" && $0.status == .brokenDown })
        XCTAssertEqual(all.filter { $0.parentTaskId == "parent" }.count, 2)
    }

    func test_breakdown_fails_empty() throws {
        let (store, planStore, tmp, _) = makeStore()
        defer { try? FileManager.default.removeItem(at: tmp) }
        let parent = GoalflowTask(id: "p", title: "Big", schedulePrecision: .day, scheduledFor: "2026-09-01")
        try store.saveAll([parent])
        let svc = LocalBreakdownService(taskStore: store, clock: ManualClock(now: Date()), dailyPlanStore: planStore)
        XCTAssertThrowsError(try svc.breakdown(taskId: "p", children: []))
    }

    func test_breakdown_fails_too_many() throws {
        let (store, planStore, tmp, _) = makeStore()
        defer { try? FileManager.default.removeItem(at: tmp) }
        let parent = GoalflowTask(id: "p", title: "Big", schedulePrecision: .day, scheduledFor: "2026-09-01")
        try store.saveAll([parent])
        let svc = LocalBreakdownService(taskStore: store, clock: ManualClock(now: Date()), dailyPlanStore: planStore)
        let many = (0..<51).map { BreakdownChildInput(title: "C\($0)") }
        XCTAssertThrowsError(try svc.breakdown(taskId: "p", children: many))
    }

    func test_breakdown_preserves_plan_when_matching() throws {
        let (store, planStore, tmp, _) = makeStore()
        defer { try? FileManager.default.removeItem(at: tmp) }
        let today = "2026-09-01"
        let clock = ManualClock(now: ISO8601DateFormatter().date(from: "2026-09-01T10:00:00Z")!)
        let p = GoalflowTask(id: "parent", title: "Parent", schedulePrecision: .day, scheduledFor: today, plannedOrder: 0)
        let other = GoalflowTask(id: "other", title: "Other", schedulePrecision: .day, scheduledFor: today, plannedOrder: 1)
        try store.saveAll([p, other])
        // Create plan matching queue [parent, other]
        let plan = DailyPlan(localDate: today, confirmedAt: ISO8601DateFormatter().string(from: clock.now()), taskIds: ["parent","other"])
        try planStore.save(plan)
        let svc = LocalBreakdownService(taskStore: store, clock: clock, dailyPlanStore: planStore)
        let res = try svc.breakdown(taskId: "parent", children: [BreakdownChildInput(title: "Child A"), BreakdownChildInput(title: "Child B")])
        // Plan should be replaced with [ChildA, ChildB, other] (or sorted by comparator preserves parent order)
        let newPlan = try planStore.load(for: today)
        XCTAssertNotNil(newPlan)
        XCTAssertEqual(newPlan?.taskIds.count, 3)
        XCTAssertTrue(newPlan?.taskIds.contains(res.children[0].id) ?? false)
        XCTAssertTrue(newPlan?.taskIds.contains(res.children[1].id) ?? false)
        XCTAssertTrue(newPlan?.taskIds.contains("other") ?? false)
    }

    func test_breakdown_parent_not_open_fails() throws {
        let (store, planStore, tmp, _) = makeStore()
        defer { try? FileManager.default.removeItem(at: tmp) }
        let p = GoalflowTask(id: "p", title: "Big", schedulePrecision: .day, scheduledFor: "2026-09-01", status: .completed)
        try store.saveAll([p])
        let svc = LocalBreakdownService(taskStore: store, clock: ManualClock(now: Date()), dailyPlanStore: planStore)
        XCTAssertThrowsError(try svc.breakdown(taskId: "p", children: [BreakdownChildInput(title: "Child")]))
    }

    func test_suggest_stub_returns_empty() async throws {
        let gw = StubBreakdownGateway()
        let t = GoalflowTask(id: "x", title: "Test", schedulePrecision: .day, scheduledFor: "2026-09-01")
        let res = try await gw.suggest(for: t)
        XCTAssertTrue(res.isEmpty)
    }
}
