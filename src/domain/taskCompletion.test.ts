import { expect, it } from 'vitest';
import { deriveTaskCompletion } from './taskCompletion';

const details = { day: '2026-09-08', timeZone: 'UTC' };
function input(xp = 0, level = 1, xpToNextLevel = 100) {
  return { tasks: [{ id: 'task', completed: false, duration: 10, dateAssigned: '2026-09-08', description: 'retained notes' }],
    goals: [], habits: [], task_events: [], stats: {}, progress: { xp, level, xpToNextLevel } };
}

it('matches existing level transitions across level boundaries and preserves explicit zero duration', () => {
  for (let start = 0; start < 5000; start += 37) {
    const result = deriveTaskCompletion(input(start), 'task', '2026-09-08T00:00:00.000Z', { ...details, actualDuration: 0 }, 'event', 'action');
    let xp = start + 60, level = 1, next = 100;
    while (xp >= next) { xp -= next; level++; next = level * 100; }
    expect(result.collections.progress).toEqual({ xp, level, xpToNextLevel: next });
    expect(result.collections.stats[details.day].timeFocused).toBe(0);
    expect(result.collections.tasks[0].description).toBe('retained notes');
  }
});

it('handles large valid accumulated XP without a level-by-level loop and rejects invalid effects', () => {
  const result = deriveTaskCompletion(input(1_000_000_000_000), 'task', '2026-09-08T00:00:00.000Z', details, 'event', 'action');
  expect(result.collections.progress.xp).toBeLessThan(result.collections.progress.xpToNextLevel);
  expect(result.collections.progress.level).toBeGreaterThan(100_000);
  for (const state of [input(NaN), input(0, 1, 0), { ...input(), stats: { [details.day]: { tasksCompleted: -1, frogsEaten: 0, timeFocused: 0 } } }]) {
    expect(() => deriveTaskCompletion(state, 'task', '2026-09-08T00:00:00.000Z', details, 'event', 'action')).toThrow();
  }
});
