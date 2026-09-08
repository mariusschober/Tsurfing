import { expect, it } from 'vitest';
import { applyCompletionReward } from '../src/domain/taskCompletion';
import { rebasePlanningCompletionMember, rebaseSavedTaskEdit } from './planningCompletionRebase';

it('replays a captured reward across a different level boundary without retaining the provisional debit', () => {
  const before = { xp: 490, level: 1, xpToNextLevel: 500, marker: 'saved' };
  const after = applyCompletionReward(before, 30).progress;
  expect(after).toMatchObject({ xp: 20, level: 2, xpToNextLevel: 200 });
  const synced = { xp: 460, level: 1, xpToNextLevel: 500, marker: 'synced' };
  expect(rebasePlanningCompletionMember('progress', before, after, synced, 30))
    .toEqual({ xp: 490, level: 1, xpToNextLevel: 500, marker: 'synced' });
  expect(() => rebasePlanningCompletionMember('progress', before, after, synced, 50)).toThrow('captured reward');
  expect(before.xp).toBe(490);
});

it('carries completion and final notes onto the synced order and schedule without restoring rejected ratings', () => {
  const before = { id: 'task', completed: false, plannedOrder: 0, isFrog: true, excitement: 90,
    scheduledFor: '2026-09-08', description: 'before' };
  const after = { ...before, completed: true, lifecycleStatus: 'completed', completedAt: 10, description: 'final note', actualDuration: 12 };
  const synced = { ...before, plannedOrder: 4, isFrog: false, excitement: 20, scheduledFor: '2026-09-09', title: 'remote edit' };
  expect(rebasePlanningCompletionMember('tasks', before, after, synced, 30)).toEqual({ ...synced,
    completed: true, lifecycleStatus: 'completed', completedAt: 10, description: 'final note', actualDuration: 12 });
  expect(() => rebasePlanningCompletionMember('tasks', before, { ...after, plannedOrder: 3 }, synced, 30)).toThrow('unrelated');
  expect(() => rebasePlanningCompletionMember('tasks', before, after, { ...synced, completed: true }, 30)).toThrow('already completed');
  expect(() => rebasePlanningCompletionMember('tasks', before, after, { ...synced, deletedAt: '2026-09-08' }, 30)).toThrow('removed');
});


it('keeps independent saved metadata while refusing overlapping changes or order bypasses', () => {
  const before = { id: 'task', plannedOrder: 1, description: 'before', duration: 10, completed: false };
  const after = { ...before, description: 'local note', duration: 30 };
  const synced = { ...before, plannedOrder: 4, title: 'remote title' };
  expect(rebaseSavedTaskEdit('tasks', before, after, synced)).toEqual({ ...synced, description: 'local note', duration: 30 });
  expect(() => rebaseSavedTaskEdit('tasks', before, after, { ...synced, description: 'remote note' })).toThrow('Both devices');
  expect(() => rebaseSavedTaskEdit('tasks', before, { ...after, plannedOrder: 0 }, synced)).toThrow('ordering');
});
