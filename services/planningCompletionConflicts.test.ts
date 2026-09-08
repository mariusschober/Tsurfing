import { expect, it } from 'vitest';
import { rebasePlanningCompletionMember } from './planningCompletionRebase';

const task = () => ({ id: 'task', completed: false, description: 'before', actualDuration: 1, flowState: 1,
  plannedOrder: 0, scheduledFor: '2026-09-08' });
const complete = (before: ReturnType<typeof task>) => ({ ...before, completed: true, lifecycleStatus: 'completed', completedAt: 10 });

it.each([
  ['description', 'local note', 'remote note'],
  ['actualDuration', 12, 20],
  ['flowState', 3, 5],
] as const)('retains a concurrent %s conflict instead of overwriting it during completion recovery', (key, local, remote) => {
  const before = task(), after = { ...complete(before), [key]: local }, synced = { ...before, [key]: remote };
  const originals = structuredClone({ before, after, synced });
  expect(() => rebasePlanningCompletionMember('tasks', before, after, synced, 30))
    .toThrow(`Both devices changed ${key}. Your completion is retained for review.`);
  expect({ before, after, synced }).toEqual(originals);
});

it.each([
  ['description', 'same note'], ['actualDuration', 12], ['flowState', 3],
] as const)('accepts matching %s changes on both devices without inventing a conflict', (key, value) => {
  const before = task(), after = { ...complete(before), [key]: value }, synced = { ...before, [key]: value, plannedOrder: 4 };
  expect(rebasePlanningCompletionMember('tasks', before, after, synced, 30)).toEqual({ ...after, plannedOrder: 4 });
});

it('keeps independent remote order, schedule and title while applying uncontested final notes', () => {
  const before = task(), after = { ...complete(before), description: 'local note' };
  const synced = { ...before, plannedOrder: 4, scheduledFor: '2026-09-09', title: 'remote title' };
  const originals = structuredClone({ before, after, synced });
  expect(rebasePlanningCompletionMember('tasks', before, after, synced, 30))
    .toEqual({ ...synced, completed: true, lifecycleStatus: 'completed', completedAt: 10, description: 'local note' });
  expect({ before, after, synced }).toEqual(originals);
});

it('preserves remote-only notes when completion did not edit them', () => {
  const before = task();
  expect(rebasePlanningCompletionMember('tasks', before, complete(before), { ...before, description: 'remote note' }, 30))
    .toMatchObject({ completed: true, description: 'remote note' });
});

it('allows explicit empty final notes only when no competing note was saved', () => {
  const before = task(), after = { ...complete(before), description: '' };
  expect(rebasePlanningCompletionMember('tasks', before, after, before, 30)).toMatchObject({ description: '' });
  expect(() => rebasePlanningCompletionMember('tasks', before, after, { ...before, description: 'remote note' }, 30))
    .toThrow('Both devices changed description');
});

it('distinguishes independent note deletion from deleting a concurrent remote note', () => {
  const before = task(), { description: _description, ...after } = complete(before);
  expect(rebasePlanningCompletionMember('tasks', before, after, before, 30)).not.toHaveProperty('description');
  expect(() => rebasePlanningCompletionMember('tasks', before, after, { ...before, description: 'remote note' }, 30))
    .toThrow('Both devices changed description');
});
