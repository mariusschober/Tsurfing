import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { IDBObjectStore } from 'fake-indexeddb';
import { expect, it, vi } from 'vitest';
import { admitLocalCounterDay, projectPendingCounterDays, validateCounterDayEvidence } from './causalCounterDayCoordinator';
import { admitLocalCounter } from './causalCounterCoordinator';
import { CAUSAL_STORE, fenceLegacyTracking } from './causalStorage';
import { bindCausalCapability } from './causalEnrollment';
import { prepareCausalRequest, commitCausalReceipt } from './causalReceipts';

async function fixture() {
  const name = 's2-day-' + crypto.randomUUID(); const accountId = crypto.randomUUID();
  const tracking = { date: '2026-09-07', planViewCount: 27, dailyPostponeCount: 3, focusSession: { retained: true }, unknown: [1] };
  const db = await openDB(name, 1, { upgrade(db) { db.createObjectStore('tracking'); db.createObjectStore('sync'); } });
  await db.put('tracking', tracking, accountId); db.close();
  const command = { schemaVersion: 1 as const, actionId: crypto.randomUUID(), accountId, actorId: 'tab', kind: 'select' as const,
    day: '2026-09-08', timeZone: 'Atlantic/Canary', capturedAt: '2026-09-08T00:00:00.000Z', unknown: { evidence: true } };
  const read = async () => { const db = await openDB(name); try { return await db.get(CAUSAL_STORE, accountId); } finally { db.close(); } };
  return { name, accountId, tracking, command, read };
}
it('retains offline day intent without inventing a baseline or changing focus and counts', async () => {
  const f = await fixture();
  expect(await admitLocalCounterDay(f.name, f.command)).toEqual({ duplicate: false, sequence: 1 });
  expect(await admitLocalCounterDay(f.name, f.command)).toEqual({ duplicate: true, sequence: 1 });
  const state = await f.read();
  expect(state.trackingValue).toEqual(f.tracking);
  expect(state.counterBaselines).toBeUndefined();
  expect(state.counterDayOutbox[f.command.actionId]).toEqual(f.command);
  expect(state.counterDayAdmissions[f.command.actionId]).toEqual({ command: f.command, sequence: 1 });
  await expect(admitLocalCounterDay(f.name, { ...f.command, day: '2026-09-09' })).rejects.toThrow('different intent');
  expect(await f.read()).toEqual(state);
});
it('serializes distinct equal-clock actions and preserves order across retries', async () => {
  const f = await fixture(); const other = { ...f.command, actionId: crypto.randomUUID(), day: '2026-09-09' };
  await Promise.all([admitLocalCounterDay(f.name, f.command), admitLocalCounterDay(f.name, other)]);
  const before = await f.read();
  expect(Object.values(before.counterDayAdmissions).map((a: any) => a.sequence).sort()).toEqual([1, 2]);
  await admitLocalCounterDay(f.name, f.command);
  expect(await f.read()).toEqual(before);
});
it('selects an established day offline and rolls back the journal with a failed mirror write', async () => {
  const f = await fixture();
  const baseline = { schemaVersion: 1 as const, baselineId: crypto.randomUUID(), accountId: f.accountId,
    day: f.command.day, counts: { planViewCount: 7, dailyPostponeCount: 2 }, evidenceIds: [] };
  await admitLocalCounter(f.name, { schemaVersion: 1, actionId: crypto.randomUUID(), accountId: f.accountId,
    actorId: 'tab', day: baseline.day, timeZone: 'UTC', counter: 'planViewCount', delta: 1,
    capturedAt: f.command.capturedAt, businessActionId: null, correctionOf: null }, baseline);
  const before = await f.read(); const put = IDBObjectStore.prototype.put;
  const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function(this: IDBObjectStore, ...args) {
    if (this.name === 'tracking') throw new Error('Synthetic mirror failure');
    return put.apply(this, args);
  });
  try { await expect(admitLocalCounterDay(f.name, f.command)).rejects.toThrow('Synthetic mirror failure'); }
  finally { spy.mockRestore(); }
  expect(await f.read()).toEqual(before);
  await admitLocalCounterDay(f.name, f.command);
  const after = await f.read();
  expect(after.trackingValue).toEqual({ ...f.tracking, date: baseline.day, planViewCount: 8, dailyPostponeCount: 2 });
  expect(after.counterDaySelection.status).toBe('PROJECTED');
});
it('never overlays an older pending selection over a newer represented selection', async () => {
  const f = await fixture();
  const commands = [f.command, { ...f.command, actionId: crypto.randomUUID(), day: '2026-09-09' },
    { ...f.command, actionId: crypto.randomUUID(), day: '2026-09-10' }];
  for (const command of commands) await admitLocalCounterDay(f.name, command);
  const state = await f.read();
  expect(projectPendingCounterDays(state, '2026-09-09', new Set([commands[1].actionId]))).toEqual({
    day: '2026-09-09', selection: { actionId: commands[2].actionId, requestedDay: '2026-09-10', status: 'WAITING_BASELINE' } });
  expect(projectPendingCounterDays(state, '2026-09-10', new Set([commands[2].actionId]))).toEqual({ day: '2026-09-10', selection: undefined });
});
it('rejects restored day evidence with missing identity, duplicate order or substituted pending intent', async () => {
  const f = await fixture(); await admitLocalCounterDay(f.name, f.command);
  const state = await f.read();
  const changed = structuredClone(state); delete changed.actionIdentities[f.command.actionId];
  expect(() => validateCounterDayEvidence(f.accountId, changed)).toThrow('identity');
  const pending = structuredClone(state); pending.counterDayOutbox[f.command.actionId] = { ...f.command, day: '2026-09-09' };
  expect(() => validateCounterDayEvidence(f.accountId, pending)).toThrow('exact admission');
  const duplicate = structuredClone(state); const id = crypto.randomUUID();
  const command = { ...f.command, actionId: id };
  duplicate.counterDayAdmissions[id] = { command, sequence: 1 };
  duplicate.actionIdentities[id] = { kind: 'counterDay', intent: command };
  expect(() => validateCounterDayEvidence(f.accountId, duplicate)).toThrow('sequence');
  expect(() => validateCounterDayEvidence(f.accountId, { ...state, counterDayAdmissions: [] })).toThrow('journal');
  expect(() => validateCounterDayEvidence(crypto.randomUUID(), state)).toThrow('identity');
});
it('rolls back admission and identity on a failed write and rejects malformed dates before cutover', async () => {
  const f = await fixture();
  await expect(admitLocalCounterDay(f.name, { ...f.command, day: '2026-02-30' })).rejects.toThrow();
  const originalDb = await openDB(f.name); expect(originalDb.version).toBe(1); originalDb.close();
  (await fenceLegacyTracking(f.name)).close(); const before = await f.read();
  const put = IDBObjectStore.prototype.put;
  const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function(this: IDBObjectStore, ...args) {
    if (this.name === CAUSAL_STORE) throw new Error('Synthetic day write failure');
    return put.apply(this, args);
  });
  try { await expect(admitLocalCounterDay(f.name, f.command)).rejects.toThrow('Synthetic day write failure'); }
  finally { spy.mockRestore(); }
  expect(await f.read()).toEqual(before);
  expect(await admitLocalCounterDay(f.name, f.command)).toEqual({ duplicate: false, sequence: 1 });
});
it('retires only the exactly receipted day command and retains request and admission after restart', async () => {
  const f = await fixture(); await admitLocalCounterDay(f.name, f.command);
  const other = { ...f.command, actionId: crypto.randomUUID(), day: '2026-09-09' }; await admitLocalCounterDay(f.name, other);
  const operation = { schemaVersion: 2, epoch: crypto.randomUUID(), type: 'counterDay', command: f.command };
  await bindCausalCapability(f.name, f.accountId, { schemaVersion: 2, accountId: f.accountId, enrolled: true, epoch: operation.epoch, projectionRevision: 0, rolloutReady: false });
  const bytes = await prepareCausalRequest(f.name, f.accountId, operation);
  const counts = { planViewCount: 0, dailyPostponeCount: 0 };
  const receipt = { schemaVersion: 2, epoch: operation.epoch, operation, accepted: true, projectionRevision: 1, counts,
    baseline: { schemaVersion: 1, baselineId: crypto.randomUUID(), accountId: f.accountId, day: f.command.day, counts, evidenceIds: [] },
    record: { user_id: f.accountId, entity_type: 'tracking', entity_id: 'singleton', version: 2, server_version: 9,
      device_id: 'server', updated_at: f.command.capturedAt, deleted_at: null, payload: { date: f.command.day, ...counts } } };
  const before = await f.read();
  await expect(commitCausalReceipt(f.name, f.accountId, f.command.actionId, { ...receipt, epoch: crypto.randomUUID() })).rejects.toThrow();
  expect(await f.read()).toEqual(before);
  await commitCausalReceipt(f.name, f.accountId, f.command.actionId, receipt);
  const after = await f.read();
  expect(after.counterDayOutbox).toEqual({ [other.actionId]: other });
  expect(after.counterDayAdmissions).toEqual(before.counterDayAdmissions);
  expect(after.trackingValue).toEqual(f.tracking);
  expect(after.counterBaselines).toBeUndefined();
  expect(after.causalRequests[f.command.actionId]).toBe(bytes);
  expect(await prepareCausalRequest(f.name, f.accountId, operation)).toBe(bytes);
  expect(await commitCausalReceipt(f.name, f.accountId, f.command.actionId, receipt)).toEqual({ accepted: true, duplicate: true });
  expect(await admitLocalCounterDay(f.name, f.command)).toEqual({ duplicate: true, sequence: 1 });
  expect(await f.read()).toEqual(after);
});
