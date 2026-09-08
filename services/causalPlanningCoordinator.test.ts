import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { IDBObjectStore } from 'fake-indexeddb';
import { expect, it, vi } from 'vitest';
import { admitLocalPlanningVisit, validatePlanningEvidence, type PlanningVisitIntent } from './causalPlanningCoordinator';
import { CAUSAL_STORE, fenceLegacyTracking } from './causalStorage';
import { admitLocalCounter } from './causalCounterCoordinator';
import { admitLocalCounterDay } from './causalCounterDayCoordinator';
import { applyDownloadedCausalHistory } from './causalProjection';
import { bindCausalCapability } from './causalEnrollment';
import { causalHistoryHash } from './causalHistoryProtocol';

async function fixture(mode: 'off' | 'gentle' | 'classic' = 'classic', count = 5, known = true) {
  const name = 's2-planning-' + crypto.randomUUID(), accountId = crypto.randomUUID(), epoch = crypto.randomUUID();
  const tracking = { date: '2026-09-08', planViewCount: count, dailyPostponeCount: 3, focusSession: null, unknown: ['keep'] };
  const progress = { xp: 80, level: 2, xpToNextLevel: 120, unknown: { retained: true } };
  const db = await openDB(name, 1, { upgrade(db) { for (const store of ['tracking', 'progress', 'settings', 'sync', 'tasks']) db.createObjectStore(store); } });
  await db.put('tracking', tracking, accountId); await db.put('progress', progress, accountId);
  await db.put('settings', { penaltyMode: mode }, accountId); await db.put('tasks', [], accountId); db.close();
  (await fenceLegacyTracking(name)).close();
  const baseline = { schemaVersion: 1 as const, baselineId: epoch, accountId, day: tracking.date,
    counts: { planViewCount: count, dailyPostponeCount: 3 }, evidenceIds: [epoch] };
  const intent = (): PlanningVisitIntent => ({ schemaVersion: 1, actionId: crypto.randomUUID(), accountId, actorId: 'tab', deviceId: 'device',
    day: tracking.date, timeZone: 'UTC', capturedAt: '2026-09-08T10:00:00.000Z' });
  if (known) {
    const db = await openDB(name); const state = await db.get(CAUSAL_STORE, accountId);
    state.counterBaselines = { [baseline.day]: baseline }; await db.put(CAUSAL_STORE, state); db.close();
  } else {
    await admitLocalCounterDay(name, { ...intent(), actionId: crypto.randomUUID(), kind: 'establish' });
  }
  const read = async () => { const db = await openDB(name); const state = await db.get(CAUSAL_STORE, accountId), progress = await db.get('progress', accountId), meta = await db.get('sync', accountId); db.close(); return { state, progress, meta }; };
  const saveBaselineHistory = async () => {
    const record = { user_id: accountId, entity_type: 'tracking', entity_id: 'singleton', version: 1, server_version: 7,
      device_id: 'fixture', updated_at: '2026-09-08T00:00:00.000Z', deleted_at: null, payload: tracking };
    const receipt = { schemaVersion: 2, epoch, projectionRevision: 0, baseline,
      operation: { schemaVersion: 2, accountId, cutoverId: epoch, expectedTrackingServerVersion: 7, expectedTrackingPayload: tracking }, record };
    const body = JSON.stringify({ schemaVersion: 2, accountId, epoch, revision: 0, receipt });
    const sha256 = await causalHistoryHash(new TextEncoder().encode(body));
    await bindCausalCapability(name, accountId, { schemaVersion: 2, accountId, enrolled: true, epoch, projectionRevision: 0, rolloutReady: false });
    const db = await openDB(name); const state = await db.get(CAUSAL_STORE, accountId);
    state.causalHistory = { schemaVersion: 1, epoch, throughRevision: 0, downloadedRevision: 0, entries: { '0': { body, sha256 } } };
    await db.put(CAUSAL_STORE, state); db.close();
  };
  return { name, accountId, tracking, progress, baseline, intent, read, saveBaselineHistory };
}
it('admits concurrent equal-time visits once each and applies the sixth warning before the seventh penalty', async () => {
  const f = await fixture(); const a = f.intent(), b = f.intent();
  const results = await Promise.all([admitLocalPlanningVisit(f.name, a), admitLocalPlanningVisit(f.name, b)]);
  expect(results.map(r => r.admission.effect)).toMatchObject([
    { status: 'APPLIED', count: 6, warning: true, penaltyAmount: 0 }, { status: 'APPLIED', count: 7, warning: false, penaltyAmount: 50 }
  ]);
  const after = await f.read();
  expect(after.state.trackingValue).toEqual({ ...f.tracking, planViewCount: 7 });
  expect(after.progress).toEqual({ ...f.progress, xp: 30 });
  expect(after.meta.outbox).toHaveLength(1);
  expect(Object.keys(after.state.counterOutbox)).toHaveLength(2);
  await Promise.all([admitLocalPlanningVisit(f.name, a), admitLocalPlanningVisit(f.name, b)]);
  expect(await f.read()).toEqual(after);
  await expect(admitLocalPlanningVisit(f.name, { ...a, actorId: 'other' })).rejects.toThrow('different intent');
});
it.each([['off', 80, 0], ['gentle', 55, 25], ['classic', 30, 50]] as const)('preserves %s penalty mode and unknown progress fields', async (mode, xp, amount) => {
  const f = await fixture(mode, 6); const result = await admitLocalPlanningVisit(f.name, f.intent());
  expect(result.admission.effect).toMatchObject({ status: 'APPLIED', penaltyAmount: amount });
  expect((await f.read()).progress).toEqual({ ...f.progress, xp });
});
it('rolls back counter, penalty, queue and applied marker together on final write failure', async () => {
  const f = await fixture('classic', 6); const intent = f.intent(), before = await f.read(), put = IDBObjectStore.prototype.put;
  const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function(this: IDBObjectStore, ...args) {
    if (this.name === 'tracking') throw new Error('Synthetic planning write failure');
    return put.apply(this, args);
  });
  try { await expect(admitLocalPlanningVisit(f.name, intent)).rejects.toThrow('Synthetic'); } finally { spy.mockRestore(); }
  expect(await f.read()).toEqual(before);
  await admitLocalPlanningVisit(f.name, intent);
  expect((await f.read()).progress.xp).toBe(30);
});
it('waits for a baseline and settles the original observed frontier in the history transaction', async () => {
  const f = await fixture('gentle', 5, false), a = f.intent(), b = f.intent();
  await admitLocalPlanningVisit(f.name, a); await admitLocalPlanningVisit(f.name, b);
  expect((await f.read()).state.trackingValue).toEqual(f.tracking);
  expect((await f.read()).progress).toEqual(f.progress);
  // A later known action must not change the sixth-visit warning into a penalty.
  const later = { schemaVersion: 1 as const, actionId: crypto.randomUUID(), accountId: f.accountId, actorId: 'peer', day: a.day,
    timeZone: a.timeZone, capturedAt: a.capturedAt, counter: 'planViewCount' as const, delta: 1, businessActionId: null, correctionOf: null };
  await admitLocalCounter(f.name, later);
  await f.saveBaselineHistory();
  await applyDownloadedCausalHistory(f.name, f.accountId);
  const after = await f.read();
  expect(after.state.trackingValue.planViewCount).toBe(8);
  expect(after.state.planningAdmissions[a.actionId].effect).toMatchObject({ count: 6, warning: true, penaltyAmount: 0 });
  expect(after.state.planningAdmissions[b.actionId].effect).toMatchObject({ count: 7, warning: false, penaltyAmount: 25 });
  expect(after.progress).toEqual({ ...f.progress, xp: 55 });
  expect(after.meta.outbox).toHaveLength(1);
  await applyDownloadedCausalHistory(f.name, f.accountId);
  expect(await f.read()).toEqual(after);
});
it('keeps deferred penalties retryable when history application fails after its progress write', async () => {
  const f = await fixture('classic', 6, false); await admitLocalPlanningVisit(f.name, f.intent()); await f.saveBaselineHistory();
  const before = await f.read(), put = IDBObjectStore.prototype.put;
  const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function(this: IDBObjectStore, ...args) {
    if (this.name === 'tracking') throw new Error('Synthetic history write failure'); return put.apply(this, args);
  });
  try { await expect(applyDownloadedCausalHistory(f.name, f.accountId)).rejects.toThrow('Synthetic'); } finally { spy.mockRestore(); }
  expect(await f.read()).toEqual(before);
  await applyDownloadedCausalHistory(f.name, f.accountId);
  expect((await f.read()).progress.xp).toBe(30);
});
it('fails closed when retained planning evidence was changed', async () => {
  const f = await fixture(); const a = f.intent(); await admitLocalPlanningVisit(f.name, a);
  const { state } = await f.read(); state.planningAdmissions[a.actionId].effect.count = 7;
  expect(() => validatePlanningEvidence(f.accountId, state)).toThrow('observed counter');
});
