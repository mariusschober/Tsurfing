export type SchedulePrecision = "day" | "month";
export type ScheduledTaskStatus =
  | "open"
  | "completed"
  | "broken_down"
  | "dropped"
  | "archived";
export type TaskSource = "manual" | "habit" | "telegram" | "share" | "ai" | "migration";

export interface ScheduledTask {
  id: string;
  userId: string;
  title: string;
  notes: string;
  tags: string[];
  schedulePrecision: SchedulePrecision;
  scheduledFor: string;
  scheduledTime?: string;
  plannedOrder: number;
  status: ScheduledTaskStatus;
  isFrog: boolean;
  frogFailures: number;
  beforeFrog: boolean;
  source: TaskSource;
  parentTaskId?: string;
  habitId?: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
  version: number;
  serverVersion?: number;
  circadianRank?: number;
}

export interface DailyPlan {
  localDate: string;
  confirmedAt: string;
  taskIds: string[];
}

export interface TaskEvent {
  id: string;
  taskId: string;
  userId: string;
  type: "created" | "skipped" | "rescheduled" | "promoted_to_frog" | "broken_down" | "dropped";
  localDate: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface CreateScheduledTaskInput {
  title: string;
  notes?: string;
  tags?: string[];
  schedulePrecision: SchedulePrecision;
  scheduledFor: string;
  scheduledTime?: string;
  plannedOrder?: number;
  isFrog?: boolean;
  beforeFrog?: boolean;
  source?: TaskSource;
  parentTaskId?: string;
  habitId?: string;
}

export interface SchedulingContext {
  userId: string;
  today: string;
  now: string;
  id: () => string;
}

export class SchedulingError extends Error {
  constructor(
    public readonly code:
      | "invalid_title"
      | "invalid_day"
      | "invalid_month"
      | "current_month_requires_day"
      | "invalid_time"
      | "task_not_found"
      | "task_not_open"
      | "duplicate_habit"
      | "frog_locked"
      | "children_required",
    message: string
  ) {
    super(message);
    this.name = "SchedulingError";
  }
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_PATTERN = /^\d{4}-\d{2}$/;
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

const isRealDay = (value: string): boolean => {
  if (!DAY_PATTERN.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (year < 1) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
};

const isRealMonth = (value: string): boolean => {
  if (!MONTH_PATTERN.test(value)) return false;
  if (Number(value.slice(0, 4)) < 1) return false;
  const month = Number(value.slice(5));
  return month >= 1 && month <= 12;
};

export const monthOf = (localDate: string): string => localDate.slice(0, 7);

export const assertSchedule = (
  precision: SchedulePrecision,
  scheduledFor: string,
  today: string,
  scheduledTime?: string
): void => {
  if (!isRealDay(today)) {
    throw new SchedulingError("invalid_day", "The scheduling context needs a valid local day.");
  }
  if (scheduledTime && !TIME_PATTERN.test(scheduledTime)) {
    throw new SchedulingError("invalid_time", "Time must use the 24-hour HH:mm format.");
  }
  if (precision === "day") {
    if (!isRealDay(scheduledFor)) {
      throw new SchedulingError("invalid_day", "Choose a valid calendar day.");
    }
    return;
  }
  if (!isRealMonth(scheduledFor)) {
    throw new SchedulingError("invalid_month", "Choose a valid calendar month.");
  }
  if (scheduledFor <= monthOf(today)) {
    throw new SchedulingError(
      "current_month_requires_day",
      "Tasks in the current or a past month need an exact day."
    );
  }
  if (scheduledTime) {
    throw new SchedulingError("invalid_time", "A time can only be set for an exact day.");
  }
};

export const createScheduledTask = (
  input: CreateScheduledTaskInput,
  context: SchedulingContext
): ScheduledTask => {
  const title = input.title.trim();
  if (!title) throw new SchedulingError("invalid_title", "A task needs an actionable title.");
  assertSchedule(input.schedulePrecision, input.scheduledFor, context.today, input.scheduledTime);
  return {
    id: context.id(),
    userId: context.userId,
    title,
    notes: input.notes?.trim() ?? "",
    tags: [...new Set((input.tags ?? []).map((tag) => tag.trim()).filter(Boolean))],
    schedulePrecision: input.schedulePrecision,
    scheduledFor: input.scheduledFor,
    scheduledTime: input.scheduledTime,
    plannedOrder: input.plannedOrder ?? 0,
    status: "open",
    isFrog: input.isFrog ?? false,
    frogFailures: 0,
    beforeFrog: Boolean(input.beforeFrog && input.habitId),
    source: input.source ?? "manual",
    parentTaskId: input.parentTaskId,
    habitId: input.habitId,
    createdAt: context.now,
    updatedAt: context.now,
    version: 1
  };
};

const isOpen = (task: ScheduledTask): boolean => task.status === "open" && !task.deletedAt;

export interface QueueCandidate {
  id: string;
  isFrog: boolean;
  beforeFrog?: boolean;
  habitId?: string;
  plannedOrder?: number;
  circadianRank?: number;
  scheduledTime?: string;
  createdAt: string | number;
}

const groupRank = (task: QueueCandidate): number => {
  if (task.beforeFrog && task.habitId) return 0;
  if (task.isFrog) return 1;
  return 2;
};

const optionalRank = (value: number | undefined): number =>
  Number.isFinite(value) ? value as number : Number.MAX_SAFE_INTEGER;

export const compareQueueCandidates = (left: QueueCandidate, right: QueueCandidate): number =>
  groupRank(left) - groupRank(right)
  || optionalRank(left.plannedOrder) - optionalRank(right.plannedOrder)
  || optionalRank(left.circadianRank) - optionalRank(right.circadianRank)
  || (left.scheduledTime ?? "99:99").localeCompare(right.scheduledTime ?? "99:99")
  || compareCreatedAt(left.createdAt, right.createdAt)
  || left.id.localeCompare(right.id);

const compareCreatedAt = (left: string | number, right: string | number): number => {
  const leftTime = typeof left === "number" ? left : Date.parse(left);
  const rightTime = typeof right === "number" ? right : Date.parse(right);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return leftTime - rightTime;
  return String(left).localeCompare(String(right));
};

export const compareCurrentTasks = (left: ScheduledTask, right: ScheduledTask): number =>
  compareQueueCandidates(left, right);

export const buildTodayQueue = (tasks: ScheduledTask[], today: string): ScheduledTask[] =>
  tasks
    .filter((task) => isOpen(task)
      && task.schedulePrecision === "day"
      && task.scheduledFor === today)
    .sort(compareCurrentTasks);

export type PlanningGate =
  | { state: "monthly_planning_required"; month: string; taskIds: string[] }
  | { state: "daily_planning_required"; localDate: string; overdueTaskIds: string[]; taskIds: string[] }
  | { state: "ready"; queue: ScheduledTask[] }
  | { state: "empty" };

export const getPlanningGate = (
  tasks: ScheduledTask[],
  today: string,
  dailyPlan?: DailyPlan
): PlanningGate => {
  const currentMonth = monthOf(today);
  const monthTasks = tasks.filter((task) => isOpen(task)
    && task.schedulePrecision === "month"
    && task.scheduledFor <= currentMonth);
  if (monthTasks.length > 0) {
    return {
      state: "monthly_planning_required",
      month: currentMonth,
      taskIds: monthTasks.map((task) => task.id)
    };
  }

  const overdue = tasks.filter((task) => isOpen(task)
    && task.schedulePrecision === "day"
    && task.scheduledFor < today);
  const queue = buildTodayQueue(tasks, today);
  const plannedIds = queue.map((task) => task.id);
  const planMatches = dailyPlan?.localDate === today;
  if (overdue.length > 0 || (queue.length > 0 && !planMatches)) {
    return {
      state: "daily_planning_required",
      localDate: today,
      overdueTaskIds: overdue.map((task) => task.id),
      taskIds: plannedIds
    };
  }
  return queue.length > 0 ? { state: "ready", queue } : { state: "empty" };
};

const replaceTask = (
  tasks: ScheduledTask[],
  taskId: string,
  change: (task: ScheduledTask) => ScheduledTask
): { tasks: ScheduledTask[]; task: ScheduledTask } => {
  let changed: ScheduledTask | undefined;
  const next = tasks.map((task) => {
    if (task.id !== taskId) return task;
    if (!isOpen(task)) throw new SchedulingError("task_not_open", "Only an open task can be changed.");
    changed = change(task);
    return changed;
  });
  if (!changed) throw new SchedulingError("task_not_found", "Task not found.");
  return { tasks: next, task: changed };
};

const touched = (task: ScheduledTask, now: string): ScheduledTask => ({
  ...task,
  updatedAt: now,
  version: task.version + 1
});

export const skipTask = (
  tasks: ScheduledTask[],
  taskId: string,
  today: string,
  now: string
): { tasks: ScheduledTask[]; task: ScheduledTask } => {
  const queue = buildTodayQueue(tasks, today);
  const maxOrder = queue.reduce((maximum, task) => Math.max(maximum, task.plannedOrder), 0);
  return replaceTask(tasks, taskId, (task) => {
    if (task.isFrog) throw new SchedulingError("frog_locked", "A frog cannot be skipped.");
    if (task.schedulePrecision !== "day" || task.scheduledFor !== today) {
      throw new SchedulingError("task_not_open", "Only a task in today's queue can be skipped.");
    }
    return touched({ ...task, plannedOrder: maxOrder + 1 }, now);
  });
};

export const rescheduleTask = (
  tasks: ScheduledTask[],
  taskId: string,
  schedule: Pick<CreateScheduledTaskInput, "schedulePrecision" | "scheduledFor" | "scheduledTime">,
  context: Pick<SchedulingContext, "today" | "now">
): { tasks: ScheduledTask[]; task: ScheduledTask; promotedToFrog: boolean } => {
  assertSchedule(schedule.schedulePrecision, schedule.scheduledFor, context.today, schedule.scheduledTime);
  let promotedToFrog = false;
  const result = replaceTask(tasks, taskId, (task) => {
    if (task.habitId && schedule.schedulePrecision === "day") {
      const duplicate = tasks.some((other) => other.id !== task.id
        && isOpen(other)
        && other.habitId === task.habitId
        && other.schedulePrecision === "day"
        && other.scheduledFor === schedule.scheduledFor);
      if (duplicate) {
        throw new SchedulingError("duplicate_habit", "A habit instance already exists on that day.");
      }
    }
    const currentSchedule = task.schedulePrecision === "month"
      ? `${task.scheduledFor}-01`
      : task.scheduledFor;
    const nextSchedule = schedule.schedulePrecision === "month"
      ? `${schedule.scheduledFor}-01`
      : schedule.scheduledFor;
    const movingForward = nextSchedule > currentSchedule;
    if (task.isFrog && movingForward) {
      throw new SchedulingError("frog_locked", "A frog cannot be moved forward.");
    }
    const frogFailures = task.frogFailures + (movingForward ? 1 : 0);
    promotedToFrog = !task.isFrog && frogFailures >= 2;
    return touched({
      ...task,
      ...schedule,
      plannedOrder: 0,
      frogFailures,
      isFrog: task.isFrog || promotedToFrog
    }, context.now);
  });
  return { ...result, promotedToFrog };
};

export const breakDownTask = (
  tasks: ScheduledTask[],
  taskId: string,
  children: CreateScheduledTaskInput[],
  context: SchedulingContext
): { tasks: ScheduledTask[]; parent: ScheduledTask; children: ScheduledTask[] } => {
  if (children.length === 0) {
    throw new SchedulingError("children_required", "Add at least one scheduled next action.");
  }
  const parent = tasks.find((task) => task.id === taskId);
  if (!parent) throw new SchedulingError("task_not_found", "Task not found.");
  if (!isOpen(parent)) throw new SchedulingError("task_not_open", "Only an open task can be broken down.");
  const created = children.map((child, index) => createScheduledTask({
    ...child,
    parentTaskId: parent.id,
    plannedOrder: child.plannedOrder ?? parent.plannedOrder + index
  }, context));
  const closed = touched({ ...parent, status: "broken_down" }, context.now);
  return {
    tasks: tasks.map((task) => task.id === parent.id ? closed : task).concat(created),
    parent: closed,
    children: created
  };
};

export const dropTask = (
  tasks: ScheduledTask[],
  taskId: string,
  now: string
): { tasks: ScheduledTask[]; task: ScheduledTask } =>
  replaceTask(tasks, taskId, (task) => touched({ ...task, status: "dropped" }, now));

export interface HabitSchedule {
  id: string;
  title: string;
  notes?: string;
  tags?: string[];
  estimatedMinutes?: number;
  beforeFrog: boolean;
}

export const generateHabitInstance = (
  tasks: ScheduledTask[],
  habit: HabitSchedule,
  context: SchedulingContext
): { tasks: ScheduledTask[]; task?: ScheduledTask } => {
  const existing = tasks.find((task) => task.habitId === habit.id
    && task.schedulePrecision === "day"
    && task.scheduledFor === context.today
    && !task.deletedAt);
  if (existing) return { tasks };
  const task = createScheduledTask({
    title: habit.title,
    notes: habit.notes,
    tags: habit.tags,
    schedulePrecision: "day",
    scheduledFor: context.today,
    source: "habit",
    habitId: habit.id,
    beforeFrog: habit.beforeFrog
  }, context);
  return { tasks: [...tasks, task], task };
};

export interface LegacyTaskLike {
  id: string;
  userId: string;
  title: string;
  notes?: string;
  localDate?: string;
  dateAssigned?: string;
  status?: string;
  completedAt?: string;
  hashtags?: string[];
  isFrog?: boolean;
  rescheduleCount?: number;
  habitId?: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
  version?: number;
}

export const migrateLegacyTask = (legacy: LegacyTaskLike, today: string): ScheduledTask => {
  const scheduledFor = legacy.localDate ?? legacy.dateAssigned;
  if (!scheduledFor || !isRealDay(scheduledFor)) {
    throw new SchedulingError("invalid_day", `Legacy task ${legacy.id} has no recoverable schedule.`);
  }
  return {
    id: legacy.id,
    userId: legacy.userId,
    title: legacy.title.trim(),
    notes: legacy.notes ?? "",
    tags: legacy.hashtags ?? [],
    schedulePrecision: "day",
    scheduledFor,
    plannedOrder: 0,
    status: legacy.status === "completed" ? "completed" : legacy.status === "archived" ? "archived" : "open",
    isFrog: legacy.isFrog ?? false,
    frogFailures: legacy.rescheduleCount ?? 0,
    beforeFrog: false,
    source: "migration",
    habitId: legacy.habitId,
    createdAt: legacy.createdAt,
    updatedAt: legacy.updatedAt,
    deletedAt: legacy.deletedAt,
    version: legacy.version ?? 1
  };
};
