import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { IDBObjectStore } from 'fake-indexeddb';
import { expect, it, vi } from 'vitest';
import { admitLocalCounter } from './causalCounterCoordinator';
import { CAUSAL_STORE } from './causalStorage';
import { type CounterBaseline, type CounterDelta } from '../src/domain/counterLedger';
import { admitLocalFocus } from './causalFocusCoordinator';
import { prepareCausalRequest, commitCausalReceipt, syncCausalAction } from './causalReceipts';
import { bindCausalCapability } from './causalEnrollment';
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

async function prepared() {
  const f = await fixture(); const event = f.event('planViewCount');
  await admitLocalCounter(f.name, event, f.baseline);
  const operation = { schemaVersion: 2, epoch: crypto.randomUUID(), type: 'counter', command: event };
  await bindCausalCapability(f.name, event.accountId, { schemaVersion: 2, accountId: event.accountId, enrolled: true, epoch: operation.epoch, projectionRevision: 0, rolloutReady: false });
  const bytes = await prepareCausalRequest(f.name, event.accountId, operation);
  const receipt = { schemaVersion: 2, operation, epoch: operation.epoch, accepted: true, projectionRevision: 1,
    outcome: { accepted: true, code: 'APPLIED', day: event.day, counts: { planViewCount: 28, dailyPostponeCount: 3 } },
    record: { user_id: event.accountId, entity_type: 'tracking', entity_id: 'singleton', version: 2, server_version: 5,
      device_id: 'server', updated_at: event.capturedAt, deleted_at: null,
      payload: { date: event.day, planViewCount: 28, dailyPostponeCount: 3 } } };
  return { ...f, operation, bytes, receipt, event };
}
it('archives exact receipts while preserving newer local counters, focus and all admissions', async () => {
  const f = await prepared(); const later = { ...f.event, actionId: crypto.randomUUID() };
  await admitLocalCounter(f.name, later, f.baseline);
  const before = await f.read();
  expect(await commitCausalReceipt(f.name, f.event.accountId, f.event.actionId, f.receipt)).toEqual({ accepted: true, duplicate: false });
  const after = await f.read();
  expect(after.trackingValue).toEqual(before.trackingValue);
  expect(after.trackingValue.planViewCount).toBe(29);
  expect(after.counterOutbox[f.event.actionId]).toBeUndefined();
  expect(after.counterOutbox[later.actionId]).toEqual(later);
  expect(after.counterEvents).toEqual(before.counterEvents);
  expect(after.causalRequests[f.event.actionId]).toBe(f.bytes);
  expect(after.causalReceipts[f.event.actionId]).toEqual(f.receipt);
  expect(after.cutover).toEqual(before.cutover);
  expect(await commitCausalReceipt(f.name, f.event.accountId, f.event.actionId, f.receipt)).toEqual({ accepted: true, duplicate: true });
});
it('keeps attempted epoch immutable across restarts and rejects unadmitted commands', async () => {
  const f = await prepared();
  expect(await prepareCausalRequest(f.name, f.event.accountId, f.operation)).toBe(f.bytes);
  await expect(prepareCausalRequest(f.name, f.event.accountId, { ...f.operation, epoch: crypto.randomUUID() })).rejects.toThrow('epoch');
  await expect(prepareCausalRequest(f.name, f.event.accountId, { ...f.operation, command: { ...f.event, delta: 2 } })).rejects.toThrow();
  expect((await f.read()).causalRequests[f.event.actionId]).toBe(f.bytes);
});
it('rejects wrong receipts without touching the pending operation', async () => {
  const f = await prepared(); const before = await f.read();
  await expect(commitCausalReceipt(f.name, f.event.accountId, f.event.actionId, { ...f.receipt, epoch: crypto.randomUUID() })).rejects.toThrow();
  expect(await f.read()).toEqual(before);
  await commitCausalReceipt(f.name, f.event.accountId, f.event.actionId, f.receipt);
  await expect(commitCausalReceipt(f.name, f.event.accountId, f.event.actionId, { ...f.receipt, projectionRevision: 2 })).rejects.toThrow('immutable');
});
it('rolls back receipt retirement on storage failure and retries the same request', async () => {
  const f = await prepared(); const before = await f.read();
  const original = IDBObjectStore.prototype.put;
  const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function(this: IDBObjectStore, ...args) {
    if (this.name === CAUSAL_STORE) throw new Error('Synthetic receipt failure');
    return original.apply(this, args);
  });
  try { await expect(commitCausalReceipt(f.name, f.event.accountId, f.event.actionId, f.receipt)).rejects.toThrow('Synthetic receipt failure'); }
  finally { spy.mockRestore(); }
  expect(await f.read()).toEqual(before);
  await commitCausalReceipt(f.name, f.event.accountId, f.event.actionId, f.receipt);
  expect((await f.read()).counterOutbox[f.event.actionId]).toBeUndefined();
});

it('archives a rejected focus receipt without retiring or replaying away its local intent', async () => {
  const name = 's2-focus-receipt-' + crypto.randomUUID(); const accountId = crypto.randomUUID();
  const db = await openDB(name, 1, { upgrade(db) { for (const store of ['tracking', 'sync', 'tasks']) db.createObjectStore(store); } });
  await db.put('tracking', { date: '2026-09-07', planViewCount: 27, dailyPostponeCount: 3, focusSession: null }, accountId);
  await db.put('tasks', [{ id: 'task', completed: false }], accountId); db.close();
  const intent = { schemaVersion: 1 as const, actionId: crypto.randomUUID(), accountId, actorId: 'tab',
    kind: 'start' as const, sessionId: crypto.randomUUID(), taskId: 'task', epoch: crypto.randomUUID(),
    expectedCurrentSessionId: null, capturedAt: '2026-09-07T10:00:00.000Z', durationSeconds: 600 };
  intent.epoch = intent.actionId;
  const local = await admitLocalFocus(name, intent);
  const operation = { schemaVersion: 2, epoch: crypto.randomUUID(), type: 'focus', command: local.command };
  await bindCausalCapability(name, accountId, { schemaVersion: 2, accountId, enrolled: true, epoch: operation.epoch, projectionRevision: 0, rolloutReady: false });
  await prepareCausalRequest(name, accountId, operation);
  const receipt = { schemaVersion: 2, operation, epoch: operation.epoch, accepted: false, projectionRevision: 2,
    outcome: { accepted: false, code: 'STALE_TARGET', revision: null },
    record: { user_id: accountId, entity_type: 'tracking', entity_id: 'singleton', version: 2, server_version: 9,
      device_id: 'server', updated_at: intent.capturedAt, deleted_at: null, payload: { focusSession: null } } };
  await commitCausalReceipt(name, accountId, intent.actionId, receipt);
  const reopened = await openDB(name); const state = await reopened.get(CAUSAL_STORE, accountId); reopened.close();
  expect(state.focusOutbox[intent.actionId]).toEqual(local.command);
  expect(state.trackingValue).toEqual(local.tracking);
  expect(state.causalReceipts[intent.actionId]).toEqual(receipt);
  expect(await commitCausalReceipt(name, accountId, intent.actionId, receipt)).toEqual({ accepted: false, duplicate: true });
});

it('retries an interrupted durable pipeline with the exact saved wire request and does not resend archived receipts', async () => {
  const f = await prepared(); const sent: string[] = [];
  const authenticatedFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    sent.push(init!.body as string);
    if (sent.length === 1) throw new TypeError('Synthetic network interruption');
    return Response.json(f.receipt);
  });
  await expect(syncCausalAction(f.name, f.event.accountId, f.operation, { authenticatedFetch })).rejects.toThrow('Synthetic network');
  expect((await f.read()).counterOutbox[f.event.actionId]).toEqual(f.event);
  expect(await syncCausalAction(f.name, f.event.accountId, f.operation, { authenticatedFetch })).toEqual({ accepted: true, duplicate: false });
  expect(await syncCausalAction(f.name, f.event.accountId, f.operation, { authenticatedFetch })).toEqual({ accepted: true, duplicate: true });
  expect(sent).toEqual([f.bytes, f.bytes]);
});
