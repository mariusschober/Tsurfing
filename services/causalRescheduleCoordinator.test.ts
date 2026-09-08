import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { IDBObjectStore } from 'fake-indexeddb';
import { expect, it, vi } from 'vitest';
import { admitLocalReschedule, type RescheduleIntent } from './causalRescheduleCoordinator';
import { CAUSAL_STORE, fenceLegacyTracking } from './causalStorage';
import { admitLocalCounter } from './causalCounterCoordinator';
import { admitLocalCounterDay } from './causalCounterDayCoordinator';

async function fixture() {
  const name = 's2-reschedule-' + crypto.randomUUID(), accountId = crypto.randomUUID(), taskId = crypto.randomUUID();
  const tracking = { date: '2026-09-08', planViewCount: 27, dailyPostponeCount: 3, focusSession: { retained: true }, unknown: ['keep'] };
  const task = { id: taskId, title: 'Synthetic', completed: false, isFrog: false, dateAssigned: tracking.date, description: 'Synthetic notes', unknown: { preserved: true } };
  const db = await openDB(name, 1, { upgrade(db) { for (const store of ['tasks', 'tracking', 'sync']) db.createObjectStore(store); } });
  await db.put('tracking', tracking, accountId); await db.put('tasks', [task], accountId); db.close();
  (await fenceLegacyTracking(name)).close();
  const baseline = { schemaVersion: 1 as const, baselineId: crypto.randomUUID(), accountId, day: tracking.date, counts: { planViewCount: 27, dailyPostponeCount: 3 }, evidenceIds: [] };
  // Establish the fixture baseline without manufacturing an accepted increment.
  const seeded = await openDB(name); const state = await seeded.get(CAUSAL_STORE, accountId);
  state.counterBaselines = { [baseline.day]: baseline }; await seeded.put(CAUSAL_STORE, state); seeded.close();
  const intent: RescheduleIntent = { schemaVersion: 1, actionId: crypto.randomUUID(), accountId, actorId: 'tab', deviceId: 'device',
    taskId, day: tracking.date, timeZone: 'Atlantic/Canary', capturedAt: '2026-09-08T10:00:00.000Z', newDate: '2026-09-09' };
  const read = async () => { const db = await openDB(name); const state = await db.get(CAUSAL_STORE, accountId), tasks = await db.get('tasks', accountId), meta = await db.get('sync', accountId); db.close(); return { state, tasks, meta }; };
  return { name, accountId, task, tracking, intent, read };
}
it('admits the task and exactly one counter, preserving focus, notes and exact retries', async () => {
  const f = await fixture();
  const first = await admitLocalReschedule(f.name, f.intent);
  const after = await f.read();
  expect(first.admission.outcome).toBe('applied');
  expect(after.state.trackingValue).toEqual({ ...f.tracking, dailyPostponeCount: 4 });
  expect(after.tasks[0]).toMatchObject({ ...f.task, dateAssigned: f.intent.newDate, rescheduleCount: 1 });
  expect(after.meta.outbox).toHaveLength(1);
  expect(Object.values(after.state.counterOutbox)).toEqual([first.admission.counter]);
  expect(first.admission.counter?.businessActionId).toBe(f.intent.actionId);
  expect((await admitLocalReschedule(f.name, f.intent)).duplicate).toBe(true);
  expect(await f.read()).toEqual(after);
  await expect(admitLocalReschedule(f.name, { ...f.intent, newDate: '2026-09-10' })).rejects.toThrow('different');
});
it('derives concurrent reschedules from their actual task parent and retains the frog commitment', async () => {
  const f = await fixture();
  const second = { ...f.intent, actionId: crypto.randomUUID(), newDate: '2026-09-10' };
  await Promise.all([admitLocalReschedule(f.name, f.intent), admitLocalReschedule(f.name, second)]);
  const after = await f.read();
  expect(after.tasks[0]).toMatchObject({ dateAssigned: second.newDate, rescheduleCount: 2, isFrog: true });
  expect(after.state.trackingValue.dailyPostponeCount).toBe(4); // only first moved today's task
  expect(after.meta.outbox).toHaveLength(2);
  expect(after.meta.outbox[1].dependsOnMutationId).toBe(after.meta.outbox[0].mutationId);
  const blocked = { ...second, actionId: crypto.randomUUID(), newDate: '2026-09-11' };
  expect((await admitLocalReschedule(f.name, blocked)).admission.outcome).toBe('frog');
  expect((await f.read()).tasks).toEqual(after.tasks);
  expect((await admitLocalReschedule(f.name, blocked)).duplicate).toBe(true);
});
it('rolls back every task, sync and counter effect when the final mirror write fails', async () => {
  const f = await fixture(); const before = await f.read(); const put = IDBObjectStore.prototype.put;
  const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function(this: IDBObjectStore, ...args) {
    if (this.name === 'tracking') throw new Error('Synthetic reschedule failure');
    return put.apply(this, args);
  });
  try { await expect(admitLocalReschedule(f.name, f.intent)).rejects.toThrow('Synthetic'); } finally { spy.mockRestore(); }
  expect(await f.read()).toEqual(before);
  await admitLocalReschedule(f.name, f.intent);
  expect((await f.read()).state.trackingValue.dailyPostponeCount).toBe(4);
});
it('preserves attributed day when a delayed reschedule follows day rollover', async () => {
  const f = await fixture(); const db = await openDB(f.name); const state = await db.get(CAUSAL_STORE, f.accountId);
  state.trackingValue = { ...state.trackingValue, date: '2026-09-09', dailyPostponeCount: 0 };
  await db.put(CAUSAL_STORE, state); db.close();
  await admitLocalReschedule(f.name, f.intent);
  const after = await f.read();
  expect(after.state.trackingValue).toEqual(state.trackingValue);
  expect(Object.values(after.state.counterEvents)[0]).toMatchObject({ day: f.intent.day });
});
it('retains an unknown-day delta without projecting yesterday as its baseline', async () => {
  const f = await fixture(); const db = await openDB(f.name); const state = await db.get(CAUSAL_STORE, f.accountId);
  delete state.counterBaselines; await db.put(CAUSAL_STORE, state); db.close();
  await admitLocalCounterDay(f.name, { ...f.intent, kind: 'establish', actionId: crypto.randomUUID() });
  await admitLocalReschedule(f.name, f.intent);
  const after = await f.read();
  expect(after.state.trackingValue).toEqual(f.tracking);
  expect(Object.keys(after.state.counterEvents)).toHaveLength(1);
  expect(after.tasks[0].dateAssigned).toBe(f.intent.newDate);
});
it('does not reapply an admitted reschedule after unrelated counter activity', async () => {
  const f = await fixture(); await admitLocalReschedule(f.name, f.intent);
  await admitLocalCounter(f.name, { schemaVersion: 1, actionId: crypto.randomUUID(), accountId: f.accountId, actorId: 'peer', day: f.intent.day,
    timeZone: f.intent.timeZone, capturedAt: f.intent.capturedAt, counter: 'dailyPostponeCount', delta: 1, correctionOf: null, businessActionId: null });
  const after = await f.read(); await admitLocalReschedule(f.name, f.intent); expect(await f.read()).toEqual(after);
  expect(after.state.trackingValue.dailyPostponeCount).toBe(5);
});
