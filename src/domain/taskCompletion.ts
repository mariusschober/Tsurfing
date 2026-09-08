import type { FlowState } from '../../types';

type RecordValue = Record<string, any>;
export interface CompletionDetails {
  day: string;
  timeZone: string;
  /** Minutes, matching the existing task/statistics model. */
  actualDuration?: number;
  flowState?: FlowState;
  /** Absent retains notes; an explicit empty string is an intentional edit. */
  finalDescription?: string;
}
export interface CompletionCollections {
  tasks: RecordValue[];
  goals: RecordValue[];
  habits: RecordValue[];
  stats: RecordValue;
  progress: RecordValue;
  task_events: RecordValue[];
}
const object = (value: unknown): value is RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const integer = (value: unknown): value is number => nonnegative(value) && Number.isSafeInteger(value);
const invalid = () => { throw new Error('Completion requires valid task and effect state. Nothing was completed.'); };

export function validateCompletionDetails(details: CompletionDetails) {
  if (!object(details) || typeof details.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(details.day)
    || !Number.isFinite(Date.parse(details.day)) || new Date(details.day).toISOString().slice(0, 10) !== details.day
    || typeof details.timeZone !== 'string' || !/^[A-Za-z0-9_+./-]{1,128}$/.test(details.timeZone)
    || (details.actualDuration !== undefined && !nonnegative(details.actualDuration))
    || (details.flowState !== undefined && !['distracted', 'good', 'high', 'flow'].includes(details.flowState))
    || (details.finalDescription !== undefined && typeof details.finalDescription !== 'string')) invalid();
  // Attribution is captured explicitly and never recomputed on retry. Reject
  // an unsupported zone before admission instead of silently using this host.
  try { new Intl.DateTimeFormat('en', { timeZone: details.timeZone }); } catch (_) { invalid(); }
}

/** Existing Web completion rewards, evaluated from one transaction's current
 * collections. Unknown fields and unrelated records are carried through. */
export function deriveTaskCompletion(input: CompletionCollections, taskId: string, capturedAt: string,
  details: CompletionDetails, eventId: string, actionId: string): {
    collections: CompletionCollections; earnedXp: number; dayComplete: boolean; leveledUp: boolean;
  } {
  validateCompletionDetails(details);
  if (!Number.isFinite(Date.parse(capturedAt))) invalid();
  for (const key of ['tasks', 'goals', 'habits', 'task_events'] as const) {
    const rows = input[key];
    if (!Array.isArray(rows) || rows.some(row => !object(row) || typeof row.id !== 'string' || !row.id)
      || new Set(rows.map(row => row.id)).size !== rows.length) invalid();
  }
  if (!object(input.stats) || !object(input.progress)) invalid();
  const task = input.tasks.find(row => row.id === taskId);
  if (!task || task.completed || task.wontDo || task.deletedAt
    || ['completed', 'dropped', 'archived', 'broken_down'].includes(task.lifecycleStatus)) invalid();
  if (input.task_events.some(row => row.id === eventId)) invalid();
  const duration = details.actualDuration ?? task.duration ?? 0;
  if (!nonnegative(duration)) invalid();
  const stats = input.stats[details.day] ?? { tasksCompleted: 0, frogsEaten: 0, timeFocused: 0, totalBreakMinutes: 0 };
  if (!object(stats) || !integer(stats.tasksCompleted) || !integer(stats.frogsEaten) || !nonnegative(stats.timeFocused)) invalid();
  const nextStats = { ...stats, tasksCompleted: stats.tasksCompleted + 1,
    frogsEaten: stats.frogsEaten + (task.isFrog ? 1 : 0), timeFocused: stats.timeFocused + duration };
  if (!integer(nextStats.tasksCompleted) || !integer(nextStats.frogsEaten) || !nonnegative(nextStats.timeFocused)) invalid();
  let goals = input.goals, habits = input.habits, habitStreak = 0;
  if (task.goalId) {
    const goal = goals.find(row => row.id === task.goalId);
    if (!goal || !integer(goal.completedTasks) || !integer(goal.completedTasks + 1)) invalid();
    goals = goals.map(row => row.id === task.goalId ? { ...row, completedTasks: row.completedTasks + 1 } : row);
  }
  if (task.habitId) {
    const habit = habits.find(row => row.id === task.habitId);
    if (!habit || !integer(habit.streak) || !integer(habit.bestStreak) || !integer(habit.streak + 1)) invalid();
    habitStreak = habit.streak + 1;
    habits = habits.map(row => row.id === task.habitId
      ? { ...row, streak: habitStreak, bestStreak: Math.max(row.bestStreak, habitStreak), lastCompletedDate: details.day } : row);
  }
  let earnedXp = (task.isFrog ? 30 : 10) + (task.habitId ? habitStreak * 2 : 0)
    + (task.goalId || task.habitId ? 15 : 0) + (details.flowState === 'flow' ? 15 : details.flowState === 'high' ? 10 : 0);
  const dayComplete = input.tasks.every(row => row.id === taskId || row.dateAssigned !== details.day || row.completed || row.wontDo);
  if (dayComplete) earnedXp += 50;
  let { xp, level, xpToNextLevel: next } = input.progress;
  if (!integer(xp) || !integer(level) || level < 1 || !integer(next) || next < 1 || !integer(xp + earnedXp)) invalid();
  xp += earnedXp;
  let leveledUp = false;
  // The existing level cost is 100 * level. Use integer arithmetic to skip
  // arbitrarily many levels without a data-dependent, unbounded loop.
  if (xp >= next) {
    xp -= next; level++; leveledUp = true;
    const remainder = BigInt(xp), currentLevel = BigInt(level);
    let low = 0n, high = remainder / 100n + 1n;
    while (low < high) {
      const middle = (low + high + 1n) / 2n;
      const cost = 50n * middle * (2n * currentLevel + middle - 1n);
      if (cost <= remainder) low = middle; else high = middle - 1n;
    }
    xp = Number(remainder - 50n * low * (2n * currentLevel + low - 1n));
    level += Number(low); next = level * 100;
    if (!integer(level) || !integer(next)) invalid();
  }
  const completed = { ...task, completed: true, lifecycleStatus: 'completed', completedAt: Date.parse(capturedAt),
    ...(details.actualDuration !== undefined ? { actualDuration: details.actualDuration } : {}),
    ...(details.flowState !== undefined ? { flowState: details.flowState } : {}),
    ...(details.finalDescription !== undefined ? { description: details.finalDescription } : {}) };
  const event = { id: eventId, taskId, eventType: 'completed', localDate: details.day,
    createdAt: Date.parse(capturedAt), metadata: { source: 'web', actionId, timeZone: details.timeZone, actualDuration: duration } };
  return { collections: { tasks: input.tasks.map(row => row.id === taskId ? completed : row), goals, habits,
    stats: { ...input.stats, [details.day]: nextStats }, progress: { ...input.progress, xp, level, xpToNextLevel: next },
    task_events: [...input.task_events, event] }, earnedXp, dayComplete, leveledUp };
}
