import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { IDBObjectStore } from 'fake-indexeddb';
import { expect, it, vi } from 'vitest';
import { storageService, STORES } from './storage';
import { CAUSAL_STORE } from './causalStorage';
import { admitLocalCounter } from './causalCounterCoordinator';
import { prepareCausalRequest, commitCausalReceipt, syncCausalAction } from './causalReceipts';
import { decodeCausalBackup } from './causalBackup';
import { bindCausalCapability } from './causalEnrollment';
import type { CounterBaseline, CounterDelta } from '../src/domain/counterLedger';

function install() {
  const name = `s2-restore-${crypto.randomUUID()}`;
  const values = new Map<string, string>([['goalflow_active_database_v2', name]]);
  const localStorage = { get length() { return values.size; }, key: (i: number) => [...values.keys()][i] ?? null,
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  Object.assign(globalThis, { window: { localStorage, dispatchEvent: () => true }, localStorage });
  return { name, values };
}

async function fixture() {
  const source = install(); const accountId = crypto.randomUUID();
  const baseline: CounterBaseline = { schemaVersion: 1, baselineId: crypto.randomUUID(), accountId, day: '2026-09-07', counts: { planViewCount: 27, dailyPostponeCount: 3 }, evidenceIds: [] };
  const tasks = [{ id: 'task', title: 'Synthetic retained task', description: 'Synthetic final notes' }];
  await storageService.set(STORES.TRACKING, accountId, { date: baseline.day, ...baseline.counts, focusSession: { retained: 'malformed legacy focus remains inspectable' } }, 'cloud');
  await storageService.set(STORES.TASKS, accountId, tasks, 'cloud');
  const event: CounterDelta = { schemaVersion: 1, actionId: crypto.randomUUID(), accountId, actorId: 'tab', day: baseline.day, timeZone: 'Atlantic/Canary', counter: 'planViewCount', delta: 1, capturedAt: '2026-09-07T10:00:00.000Z', businessActionId: null, correctionOf: null };
  await admitLocalCounter(source.name, event, baseline);
  const operation = { schemaVersion: 2, epoch: crypto.randomUUID(), type: 'counter', command: event };
  await bindCausalCapability(source.name, accountId, { schemaVersion: 2, accountId, enrolled: true, epoch: operation.epoch, projectionRevision: 0, rolloutReady: false });
  const bytes = await prepareCausalRequest(source.name, accountId, operation);
  const receipt = { schemaVersion: 2, operation, epoch: operation.epoch, accepted: true, projectionRevision: 1,
    outcome: { accepted: true, code: 'APPLIED', day: event.day, counts: { planViewCount: 28, dailyPostponeCount: 3 } },
    record: { user_id: accountId, entity_type: 'tracking', entity_id: 'singleton', version: 2, server_version: 5, device_id: 'server', updated_at: event.capturedAt, deleted_at: null,
      payload: { date: event.day, planViewCount: 28, dailyPostponeCount: 3 } } };
  await commitCausalReceipt(source.name, accountId, event.actionId, receipt);
  const pending = { ...event, actionId: crypto.randomUUID() };
  await admitLocalCounter(source.name, pending, baseline);
  const pendingOperation = { ...operation, command: pending };
  const pendingBytes = await prepareCausalRequest(source.name, accountId, pendingOperation);
  const walKey = `goalflow_wal_v2_${accountId}_late`;
  source.values.set(walKey, 'synthetic legacy capture, deliberately uninterpreted');
  source.values.set(`goalflow_dr_deleted_tracking_${accountId}`, 'true');
  const backup = JSON.parse(JSON.stringify(await storageService.exportBackup(accountId)));
  const evidence = decodeCausalBackup(backup.collections[CAUSAL_STORE].encoded) as any;
  return { accountId, baseline, event, pending, operation, pendingOperation, pendingBytes, receipt, bytes, backup, evidence, tasks, walKey };
}

it('restores fresh business state and exact causal evidence atomically, with stable retries', async () => {
  const f = await fixture(); const target = install();
  await storageService.importBackup(f.accountId, f.backup);
  const db = await openDB(target.name);
  const state = await db.get(CAUSAL_STORE, f.accountId);
  const { restoredBackups, ...original } = state;
  expect(original).toEqual(f.evidence.authority);
  expect(restoredBackups[f.backup.checksum]).toEqual(f.backup);
  expect(f.evidence.captures[`goalflow_dr_deleted_tracking_${f.accountId}`]).toBe('true');
  expect(await db.get(STORES.TASKS, f.accountId)).toEqual(f.tasks);
  expect(await db.get(STORES.SYNC, f.accountId)).toEqual(f.evidence.sync);
  expect((await db.get(STORES.TRACKING, f.accountId)).payload.planViewCount).toBe(29);
  expect(target.values.has(f.walKey)).toBe(false);
  expect(await prepareCausalRequest(target.name, f.accountId, f.pendingOperation)).toBe(f.pendingBytes);
  const network = vi.fn();
  expect(await syncCausalAction(target.name, f.accountId, f.operation, { authenticatedFetch: network })).toEqual({ accepted: true, duplicate: true });
  expect(network).not.toHaveBeenCalled();
  expect((await admitLocalCounter(target.name, f.event, f.baseline)).duplicate).toBe(true);
  const later = { ...f.pending, actionId: crypto.randomUUID() };
  await admitLocalCounter(target.name, later, f.baseline);
  const newer = await db.get(CAUSAL_STORE, f.accountId);
  await storageService.importBackup(f.accountId, f.backup, 'replace');
  expect(await db.get(CAUSAL_STORE, f.accountId)).toEqual(newer);
  expect(newer.trackingValue.planViewCount).toBe(30);
  db.close();
});

it('rolls back all restored entities on journal write failure, then retries unchanged', async () => {
  const f = await fixture(); const target = install();
  const add = IDBObjectStore.prototype.add;
  const spy = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function(this: IDBObjectStore, ...args) {
    if (this.name === CAUSAL_STORE) throw new Error('Synthetic final restore write failure');
    return add.apply(this, args);
  });
  try { await expect(storageService.importBackup(f.accountId, f.backup)).rejects.toThrow('Synthetic final restore'); }
  finally { spy.mockRestore(); }
  const db = await openDB(target.name);
  for (const store of [STORES.TASKS, STORES.TRACKING, STORES.SYNC, CAUSAL_STORE]) expect(await db.get(store, f.accountId)).toBeUndefined();
  db.close();
  await storageService.importBackup(f.accountId, f.backup);
  expect(await prepareCausalRequest(target.name, f.accountId, f.pendingOperation)).toBe(f.pendingBytes);
});

it('refuses existing local state or captures before applying the backup', async () => {
  const f = await fixture(); const target = install();
  const existing = [{ id: 'local', description: 'Synthetic local notes must survive' }];
  await storageService.set(STORES.TASKS, f.accountId, existing, 'cloud');
  await expect(storageService.importBackup(f.accountId, f.backup, 'replace')).rejects.toThrow('journal reconciliation');
  const db = await openDB(target.name);
  expect(db.objectStoreNames.contains(CAUSAL_STORE)).toBe(false);
  expect(await db.get(STORES.TASKS, f.accountId)).toEqual(existing); db.close();
  const capturedTarget = install(); capturedTarget.values.set(f.walKey, 'different captured intent');
  await expect(storageService.importBackup(f.accountId, f.backup)).rejects.toThrow('local captures');
  expect(capturedTarget.values.get(f.walKey)).toBe('different captured intent');
  const deletedTarget = install();
  deletedTarget.values.set(`goalflow_dr_deleted_tracking_${f.accountId}`, 'true');
  await expect(storageService.importBackup(f.accountId, f.backup)).rejects.toThrow('local captures');
});

it('preserves a peer write committed after the empty-account preflight', async () => {
  const f = await fixture(); const target = install();
  await storageService.getDatabaseStatus();
  const peer = await openDB(target.name, undefined, { blocking() { peer.close(); } });
  let injected = false; let write: Promise<unknown> = Promise.resolve();
  const getKey = IDBObjectStore.prototype.getKey;
  const spy = vi.spyOn(IDBObjectStore.prototype, 'getKey').mockImplementation(function(this: IDBObjectStore, key) {
    const request = getKey.call(this, key);
    if (!injected && this.name === STORES.TASKS && this.transaction.db.name === target.name) {
      injected = true;
      request.addEventListener('success', () => {
        write = peer.put(STORES.TASKS, [{ id: 'peer', description: 'Synthetic concurrent notes' }], f.accountId);
      });
    }
    return request;
  });
  try { await expect(storageService.importBackup(f.accountId, f.backup)).rejects.toThrow('journal reconciliation'); }
  finally { spy.mockRestore(); peer.close(); }
  await write;
  expect(injected).toBe(true);
  const reopened = await openDB(target.name);
  expect(await reopened.get(STORES.TASKS, f.accountId)).toEqual([{ id: 'peer', description: 'Synthetic concurrent notes' }]);
  expect(await reopened.get(CAUSAL_STORE, f.accountId)).toBeUndefined();
  reopened.close();
});
