import Foundation

final class SyncBackedCurrentTaskProvider: CurrentTaskProvider, @unchecked Sendable {
    let taskStore: any TaskStore
    let dailyPlanStore: DailyPlanStore
    let goalStore: GoalStore
    let trueNorthStore: TrueNorthStore
    let amalgamStore: AmalgamStore
    private let clock: any Clock

    init(taskStore: any TaskStore = LocalTaskStore(),
         dailyPlanStore: DailyPlanStore = DailyPlanStore(),
         goalStore: GoalStore = GoalStore(),
         trueNorthStore: TrueNorthStore = TrueNorthStore(),
         amalgamStore: AmalgamStore = AmalgamStore(),
         clock: any Clock = SystemClock()) {
        self.taskStore = taskStore; self.dailyPlanStore = dailyPlanStore
        self.goalStore = goalStore; self.trueNorthStore = trueNorthStore
        self.amalgamStore = amalgamStore; self.clock = clock
    }

    private func todayString() -> String { makeTodayString(from: clock.now()) }

    func fetchGate() throws -> PlanningGate {
        let today = todayString()
        let tasks = try taskStore.loadAll()
        let plan = try dailyPlanStore.load(for: today)
        return getPlanningGate(tasks: tasks, today: today, dailyPlan: plan)
    }

    func fetchCurrent() throws -> GoalflowTask? {
        switch try fetchGate() {
        case .ready(let queue): return queue.first
        default: return nil
        }
    }

    func allDemoTasks(today: String) throws -> [GoalflowTask] {
        // Keep compatibility: return queue for today regardless of gate
        try buildTodayQueue(tasks: taskStore.loadAll(), today: today)
    }

    // Read-only context
    func allGoals() throws -> [Goal] { try goalStore.loadAll() }
    func allTrueNorth() throws -> [TrueNorthGoal] { try trueNorthStore.loadAll() }
    func amalgam() throws -> String? { try amalgamStore.load() }
    func goal(for id: String?) throws -> Goal? {
        guard let id else { return nil }
        return try goalStore.loadAll().first { $0.id == id }
    }
}
