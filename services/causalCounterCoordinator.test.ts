import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { IDBObjectStore } from 'fake-indexeddb';
import { expect, it, vi } from 'vitest';
import { admitLocalCounter } from './causalCounterCoordinator';
import { admitLocalCounterDay } from './causalCounterDayCoordinator';
import { CAUSAL_STORE, fenceLegacyTracking } from './causalStorage';
import { type CounterBaseline, type CounterDelta } from '../src/domain/counterLedger';

async function fixture() {
  const name = 's2-counters-' + crypto.randomUUID();
  const accountId = crypto.randomUUID();
  const baseline: CounterBaseline = { schemaVersion: 1, baselineId: crypto.randomUUID(), accountId, day: '2026-09-07', counts: { planViewCount: 27, dailyPostponeCount: 3 }, evidenceIds: [] };
  const tracking = { date: baseline.day, ...baseline.counts, focusSession: { retained: 'newer focus' }, unknown: [1, 2] };
  const db = await openDB(name, 1, { upgrade(db) { db.createObjectStore('tracking'); db.createObjectStore('sync'); } });
  await db.put('tracking', tracking, accountId); db.close();
  const event = (counter: CounterDelta['counter']): CounterDelta => ({ schemaVersion: 1, actionId: crypto.randomUUID(), accountId, actorId: 'tab', day: baseline.day, timeZone: 'Atlantic/Canary', counter, delta: 1, capturedAt: '2026-09-07T10:00:00.000Z', businessActionId: null, correctionOf: null });
  const read = async () => { const db = await openDB(name); const state = await db.get(CAUSAL_STORE, accountId); db.close(); return state; };
  return { name, baseline, tracking, event, read };
}
it('conserves independent equal-time actions, both counters, retries and unrelated fields', async () => {
  const f = await fixture();
  const actions = [f.event('planViewCount'), f.event('dailyPostponeCount')];
  await Promise.all(actions.map(e => admitLocalCounter(f.name, e, f.baseline)));
  expect((await f.read()).trackingValue).toEqual({ ...f.tracking, planViewCount: 28, dailyPostponeCount: 4 });
  actions.push(f.event('planViewCount'), f.event('dailyPostponeCount'));
  await Promise.all(actions.map(e => admitLocalCounter(f.name, e, f.baseline)));
  const state = await f.read();
  expect(state.trackingValue).toEqual({ ...f.tracking, planViewCount: 29, dailyPostponeCount: 5 });
  expect(state.generation).toBe(4);
  expect(Object.keys(state.counterOutbox)).toHaveLength(4);
  expect(state.cutover.trackingValue).toEqual(f.tracking);
  await expect(admitLocalCounter(f.name, { ...actions[0], actorId: 'another' }, f.baseline)).rejects.toThrow('different intent');
});
it('rolls back the event, outbox and projection together and retries the original identity', async () => {
  const f = await fixture(); const event = f.event('planViewCount');
  (await fenceLegacyTracking(f.name)).close();
  const put = IDBObjectStore.prototype.put;
  const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function(this: IDBObjectStore, ...args) {
    if (this.name === 'tracking') throw new Error('Synthetic failure');
    return put.apply(this, args);
  });
  try { await expect(admitLocalCounter(f.name, event, f.baseline)).rejects.toThrow('Synthetic failure'); } finally { spy.mockRestore(); }
  expect((await f.read()).counterEvents).toBeUndefined();
  expect((await f.read()).generation).toBe(0);
  await admitLocalCounter(f.name, event, f.baseline);
  expect((await f.read()).trackingValue.planViewCount).toBe(28);
});
it('retains previous-day attribution without changing the visible day or focus', async () => {
  const f = await fixture();
  const old = { ...f.baseline, baselineId: crypto.randomUUID(), day: '2026-09-06' };
  const event = { ...f.event('planViewCount'), day: old.day };
  await admitLocalCounter(f.name, event, old);
  expect((await f.read()).trackingValue).toEqual(f.tracking);
  expect((await f.read()).counterEvents[event.actionId]).toEqual(event);
  await expect(admitLocalCounter(f.name, event, { ...old, counts: { ...old.counts, planViewCount: 99 } })).rejects.toThrow('immutable');
});
it('refuses unexplained baselines and historical replay instead of guessing a delta', async () => {
  const f = await fixture(); const event = f.event('planViewCount');
  await expect(admitLocalCounter(f.name, event, { ...f.baseline, counts: { ...f.baseline.counts, planViewCount: 28 } })).rejects.toThrow('recovery');
  await expect(admitLocalCounter(f.name, event, { ...f.baseline, evidenceIds: [event.actionId] })).rejects.toThrow('Historical');
  expect((await f.read()).generation).toBe(0);
});
it('captures unknown-day increments only after durable day admission, without guessing a count', async () => {
  const f = await fixture(); const event = { ...f.event('planViewCount'), day: '2026-09-08' };
  await expect(admitLocalCounter(f.name, event)).rejects.toThrow('durable day admission');
  const command = { schemaVersion: 1 as const, actionId: crypto.randomUUID(), accountId: event.accountId,
    actorId: event.actorId, kind: 'establish' as const, day: event.day, timeZone: event.timeZone, capturedAt: event.capturedAt };
  await admitLocalCounterDay(f.name, command);
  const before = await f.read();
  await expect(admitLocalCounter(f.name, { ...event, correctionOf: crypto.randomUUID(), delta: -1 })).rejects.toThrow('durable day admission');
  expect(await f.read()).toEqual(before);
  const result = await admitLocalCounter(f.name, event);
  expect(result.baselinePending).toBe(true);
  expect(result.tracking).toEqual(f.tracking);
  const state = await f.read();
  expect(state.counterBaselines).toBeUndefined();
  expect(state.counterOutbox[event.actionId]).toEqual(event);
  await admitLocalCounter(f.name, event);
  expect(await f.read()).toEqual(state);
});
