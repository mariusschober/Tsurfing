import { describe, expect, it } from "vitest";
import {
  SchedulingError,
  assertSchedule,
  breakDownTask,
  buildTodayQueue,
  createScheduledTask,
  compareQueueCandidates,
  generateHabitInstance,
  getPlanningGate,
  rescheduleTask,
  skipTask,
  type ScheduledTask,
  type SchedulingContext
} from "./scheduling";

const context = (today = "2026-07-18"): SchedulingContext => {
  let id = 0;
  return {
    userId: "user-1",
    today,
    now: `${today}T08:00:00.000Z`,
    id: () => `id-${++id}`
  };
};

const task = (
  title: string,
  overrides: Partial<ScheduledTask> = {}
): ScheduledTask => ({
  ...createScheduledTask({
    title,
    schedulePrecision: "day",
    scheduledFor: "2026-07-18"
  }, context()),
  id: title.toLowerCase().replaceAll(" ", "-"),
  ...overrides
});

describe("schedule invariants", () => {
  it("rejects month-only tasks in the current or a past month", () => {
    expect(() => assertSchedule("month", "2026-07", "2026-07-18")).toThrowError(SchedulingError);
    expect(() => assertSchedule("month", "2026-06", "2026-07-18")).toThrowError(
      "Tasks in the current or a past month need an exact day."
    );
    expect(() => assertSchedule("month", "2026-08", "2026-07-18")).not.toThrow();
  });

  it("rejects impossible local days without parsing them as UTC display dates", () => {
    expect(() => assertSchedule("day", "2026-02-30", "2026-07-18")).toThrowError(
      "Choose a valid calendar day."
    );
  });

  it("accepts leap days and rejects non-leap February 29", () => {
    expect(() => assertSchedule("day", "2024-02-29", "2024-02-28")).not.toThrow();
    expect(() => assertSchedule("day", "2023-02-29", "2023-03-01")).toThrowError(
      "Choose a valid calendar day."
    );
  });
});

describe("Current queue", () => {
  it("orders before-frog habit instances, frogs, then ordinary work", () => {
    const ordinary = task("Ordinary", { plannedOrder: 0 });
    const frog = task("Frog", { isFrog: true, plannedOrder: 99 });
    const anchor = task("Morning run", {
      source: "habit",
      habitId: "habit-1",
      beforeFrog: true,
      plannedOrder: 99
    });
    expect(buildTodayQueue([ordinary, frog, anchor], "2026-07-18").map((item) => item.title))
      .toEqual(["Morning run", "Frog", "Ordinary"]);
  });

  it("requires daily confirmation and blocks on overdue work", () => {
    const today = task("Today");
    const overdue = task("Overdue", { scheduledFor: "2026-07-17" });
    expect(getPlanningGate([today], "2026-07-18").state).toBe("daily_planning_required");
    expect(getPlanningGate([today, overdue], "2026-07-18", {
      localDate: "2026-07-18",
      confirmedAt: "2026-07-18T07:00:00.000Z",
      taskIds: [today.id]
    }).state).toBe("daily_planning_required");
    expect(getPlanningGate([today], "2026-07-18", {
      localDate: "2026-07-18",
      confirmedAt: "2026-07-18T07:00:00.000Z",
      taskIds: [today.id]
    }).state).toBe("ready");
  });

  it("keeps a confirmed day valid as tasks close or arrive", () => {
    const first = task("First");
    const second = task("Second", { plannedOrder: 1 });
    const plan = {
      localDate: "2026-07-18",
      confirmedAt: "2026-07-18T07:00:00.000Z",
      taskIds: [first.id, second.id]
    };
    expect(getPlanningGate([{ ...first, status: "completed" }, second], "2026-07-18", plan).state).toBe("ready");
    expect(getPlanningGate([first, second, task("Added later")], "2026-07-18", plan).state).toBe("ready");
  });

  it("keeps confirmation when the scheduling queue order changes", () => {
    const first = task("First", { plannedOrder: 0 });
    const second = task("Second", { plannedOrder: 1 });
    const plan = {
      localDate: "2026-07-18",
      confirmedAt: "2026-07-18T07:00:00.000Z",
      taskIds: [first.id, second.id]
    };
    expect(getPlanningGate([
      { ...first, plannedOrder: 1 },
      { ...second, plannedOrder: 0 }
    ], "2026-07-18", plan).state).toBe("ready");
  });
});

describe("deterministic ordering", () => {
  it("compares numeric creation timestamps numerically rather than lexicographically", () => {
    expect(compareQueueCandidates(
      { id: "late", isFrog: false, plannedOrder: 0, createdAt: 1_000 },
      { id: "early", isFrog: false, plannedOrder: 0, createdAt: 900 }
    )).toBeGreaterThan(0);
  });
});

describe("task lifecycle", () => {
  it("rotates an ordinary task to the end of today without changing its day", () => {
    const first = task("First", { plannedOrder: 0 });
    const second = task("Second", { plannedOrder: 1 });
    const result = skipTask([first, second], first.id, "2026-07-18", "2026-07-18T09:00:00.000Z");
    expect(result.task.scheduledFor).toBe("2026-07-18");
    expect(buildTodayQueue(result.tasks, "2026-07-18").map((item) => item.title))
      .toEqual(["Second", "First"]);
  });

  it("never skips or moves a frog forward", () => {
    const frog = task("Frog", { isFrog: true });
    expect(() => skipTask([frog], frog.id, "2026-07-18", context().now)).toThrowError("cannot be skipped");
    expect(() => rescheduleTask([frog], frog.id, {
      schedulePrecision: "day",
      scheduledFor: "2026-07-19"
    }, context())).toThrowError("cannot be moved forward");
  });

  it("promotes an unfinished task to frog after two forward moves", () => {
    const original = task("Avoided");
    const first = rescheduleTask([original], original.id, {
      schedulePrecision: "day",
      scheduledFor: "2026-07-19"
    }, context());
    expect(first.task.isFrog).toBe(false);
    const second = rescheduleTask(first.tasks, original.id, {
      schedulePrecision: "day",
      scheduledFor: "2026-07-20"
    }, { today: "2026-07-19", now: "2026-07-19T08:00:00.000Z" });
    expect(second.promotedToFrog).toBe(true);
    expect(second.task.frogFailures).toBe(2);
  });

  it("atomically closes a broken-down parent and creates scheduled children", () => {
    const parent = task("Launch website");
    const result = breakDownTask([parent], parent.id, [
      { title: "Write copy", schedulePrecision: "day", scheduledFor: "2026-07-18" },
      { title: "Publish", schedulePrecision: "day", scheduledFor: "2026-07-19" }
    ], context());
    expect(result.parent.status).toBe("broken_down");
    expect(result.children.map((child) => child.parentTaskId)).toEqual([parent.id, parent.id]);
    expect(result.tasks).toHaveLength(3);
  });
});

describe("habit instances", () => {
  it("generates one idempotent dated instance with explicit before-frog precedence", () => {
    const first = generateHabitInstance([], {
      id: "habit-1",
      title: "Morning run",
      beforeFrog: true
    }, context());
    const second = generateHabitInstance(first.tasks, {
      id: "habit-1",
      title: "Morning run",
      beforeFrog: true
    }, context());
    expect(first.task?.beforeFrog).toBe(true);
    expect(second.task).toBeUndefined();
    expect(second.tasks).toHaveLength(1);
  });

  it("does not allow a habit instance to be moved onto another instance", () => {
    const scheduleContext = context();
    const first = generateHabitInstance([], {
      id: "habit-1",
      title: "Walk",
      beforeFrog: false
    }, scheduleContext);
    const moved = rescheduleTask(first.tasks, first.task!.id, {
      schedulePrecision: "day",
      scheduledFor: "2026-07-19"
    }, scheduleContext);
    const withTodayInstance = generateHabitInstance(moved.tasks, {
      id: "habit-1",
      title: "Walk",
      beforeFrog: false
    }, scheduleContext);

    expect(() => rescheduleTask(withTodayInstance.tasks, moved.task.id, {
      schedulePrecision: "day",
      scheduledFor: "2026-07-18"
    }, scheduleContext)).toThrow("A habit instance already exists on that day.");
  });
});
