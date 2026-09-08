import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { IDBObjectStore } from 'fake-indexeddb';
import { afterEach, expect, it, vi } from 'vitest';
import { CAUSAL_BUSINESS_STORES, fenceLegacyBusinessStores, causalBusinessTransactionStores, readCausalBusiness, writeCausalBusiness } from './causalBusinessStorage';
import { CAUSAL_STORE, fenceLegacyTracking } from './causalStorage';
import { admitPlanningConfirmation, discardPlanningDraft, readDailyPlanning, savePlanningDraft, preparePlanningRequest, commitPlanningResponse, commitPlanningDay, retainPlanningReview, resolvePlanningReview, validatePlanningBackup, PLANNING_STORE } from './deliberatePlanningStorage';
import { appendStagedTransactions, buildStagedLocalTransaction, normalizeSyncMeta, readyOutbox } from './syncProtocol';
import type { ConfirmOrder, PlanningDraft } from '../src/domain/deliberatePlanning';

afterEach(() => vi.restoreAllMocks());
const accountId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', localDate = '2026-09-08';
async function fixture() {
  const name = `planning-${crypto.randomUUID()}`;
  const db = await openDB(name, 1, { upgrade(db) {
    for (const store of ['tracking', ...CAUSAL_BUSINESS_STORES]) db.createObjectStore(store);
  } });
  await db.put('tracking', { date: localDate, planViewCount: 47 }, accountId);
  await db.put('tasks', ['a', 'b', 'c'].map((id, plannedOrder) => ({ id, title: id, plannedOrder,
    dateAssigned: localDate, createdAt: plannedOrder, completed: false, description: 'saved note' })), accountId);
  await db.put('progress', { level: 1, xp: 200, xpToNextLevel: 500 }, accountId);
  await db.put('settings', { penaltyMode: 'classic' }, accountId);
  await db.put('daily_plans', [], accountId);
  db.close();
  (await fenceLegacyTracking(name)).close();
  (await fenceLegacyBusinessStores(name)).close();
  return name;
}
const request = (baselineRevision: string | null, proposedOrder = ['a', 'b', 'c']): ConfirmOrder => ({
  schemaVersion: 1, operationId: crypto.randomUUID(), accountId, localDate, baselineRevision,
  proposedOrder, ratings: [], maximumAcceptedXp: 50, capturedAt: '2026-09-08T18:00:00.000Z',
});
async function value(name: string, store: string) {
  const db = await openDB(name);
  try { const tx = db.transaction(causalBusinessTransactionStores(db, [store])); return await readCausalBusiness(tx, store, accountId); }
  finally { db.close(); }
}

it('preserves a draft across reopening and discards only draft changes', async () => {
  const name = await fixture();
  const draft: PlanningDraft = { schemaVersion: 1, accountId, localDate, baselineRevision: null,
    proposedOrder: ['c', 'a', 'b'], ratings: [{ taskId: 'a', excitement: 80, roi: 90 }], maximumAcceptedXp: 0,
    updatedAt: '2026-09-08T18:00:00.000Z' };
  await savePlanningDraft(name, draft);
  expect((await readDailyPlanning(name, accountId, localDate)).draft).toEqual(draft);
  expect((await value(name, 'tasks') as any[]).map(task => task.id)).toEqual(['a', 'b', 'c']);
  await discardPlanningDraft(name, accountId, localDate);
  expect((await readDailyPlanning(name, accountId, localDate)).draft).toBeNull();
  expect((await value(name, 'tasks') as any[])[0].description).toBe('saved note');
});

it('commits one provisional debit and pending command despite duplicate delivery and reopen', async () => {
  const name = await fixture();
  let revision: string | null = null;
  let last!: ConfirmOrder;
  for (let i = 0; i < 5; i++) {
    last = request(revision, i % 2 ? ['b', 'a', 'c'] : ['a', 'b', 'c']);
    const result = await admitPlanningConfirmation(name, last);
    revision = result.policy.revision;
  }
  expect((await value(name, 'progress') as any).xp).toBe(150);
  const replay = await admitPlanningConfirmation(name, last);
  expect(replay.replay).toBe(true);
  expect((await value(name, 'progress') as any).xp).toBe(150);
  const stored = await readDailyPlanning(name, accountId, localDate);
  expect(stored.policy.acceptedReplans).toBe(4);
  expect(stored.pending).toHaveLength(5);
  expect(stored.pending.at(-1)!.command).toEqual(last);
});

it('rolls back task order, XP and history when any write fails', async () => {
  const name = await fixture();
  await readDailyPlanning(name, accountId, localDate);
  const beforeTasks = await value(name, 'tasks'), beforeXp = await value(name, 'progress');
  const original = IDBObjectStore.prototype.put;
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, data: any, key?: IDBValidKey) {
    if (this.name === 'causal_business' && data.storeName === 'daily_plans') throw new Error('Synthetic storage failure');
    return key === undefined ? original.call(this, data) : original.call(this, data, key);
  });
  await expect(admitPlanningConfirmation(name, request(null, ['c', 'b', 'a']))).rejects.toThrow('Synthetic storage failure');
  vi.restoreAllMocks();
  expect(await value(name, 'tasks')).toEqual(beforeTasks);
  expect(await value(name, 'progress')).toEqual(beforeXp);
  const stored = await readDailyPlanning(name, accountId, localDate);
  expect(stored.policy.history).toHaveLength(0);
  expect(stored.pending).toHaveLength(0);
});

it('preserves policy after legacy mirror deletion and independently saved plan clearing', async () => {
  const name = await fixture();
  const result = await admitPlanningConfirmation(name, request(null));
  const db = await openDB(name);
  const tx = db.transaction(causalBusinessTransactionStores(db, ['daily_plans']), 'readwrite');
  await writeCausalBusiness(tx, 'daily_plans', accountId, []);
  await tx.done;
  await db.clear('daily_plans');
  db.close();
  expect((await readDailyPlanning(name, accountId, localDate)).policy.revision).toBe(result.policy.revision);
});

it('keeps an old draft on its original day and isolates account state', async () => {
  const name = await fixture();
  const draft: PlanningDraft = { schemaVersion: 1, accountId, localDate, baselineRevision: null,
    proposedOrder: ['b', 'a'], ratings: [], maximumAcceptedXp: 0, updatedAt: '2026-09-08T23:59:59.000Z' };
  await savePlanningDraft(name, draft);
  expect((await readDailyPlanning(name, accountId, '2026-09-09')).draft).toBeNull();
  expect((await readDailyPlanning(name, accountId, localDate)).draft).toEqual(draft);
  const other = await readDailyPlanning(name, 'different-account', localDate);
  expect(other.draft).toBeNull();
  expect(other.policy.revision).toBeNull();
});

async function serverResponse(name: string, command: ConfirmOrder) {
  const stored = await readDailyPlanning(name, accountId, localDate);
  const pending = stored.pending.find(item => item.command.operationId === command.operationId)!;
  return { schemaVersion: 1, accountId, receipt: pending.provisional, policy: stored.policy,
    records: pending.members.map((member, index) => ({ user_id: accountId, entity_type: member.entityType,
      entity_id: member.entityId, payload: JSON.parse(JSON.stringify(member.payload)), version: member.version,
      server_version: 100 + index, device_id: 'server-planning', updated_at: command.capturedAt, deleted_at: null })) };
}
it('retires reservations only once after the exact durable response and preserves later notes', async () => {
  const name = await fixture(), command = request(null);
  await admitPlanningConfirmation(name, command);
  const response = await serverResponse(name, command);
  expect(await preparePlanningRequest(name, accountId)).toEqual({ request: JSON.stringify(command) });
  const db = await openDB(name);
  const tx = db.transaction(causalBusinessTransactionStores(db, ['tasks']), 'readwrite');
  const tasks = await readCausalBusiness(tx, 'tasks', accountId) as any[];
  tasks[0].description = 'later note';
  await writeCausalBusiness(tx, 'tasks', accountId, tasks); await tx.done; db.close();
  expect(await commitPlanningResponse(name, accountId, command, response)).toEqual({ applied: true, duplicate: false });
  expect((await value(name, 'tasks') as any[])[0].description).toBe('later note');
  expect((await readDailyPlanning(name, accountId, localDate)).pending).toHaveLength(0);
  expect((await value(name, 'sync') as any).localState.planningReservations).toEqual({});
  expect(await commitPlanningResponse(name, accountId, command, response)).toEqual({ applied: true, duplicate: true });
  const changed = structuredClone(response); changed.records[0].server_version++;
  await expect(commitPlanningResponse(name, accountId, command, changed)).rejects.toThrow('changed on retry');
});
it('retains both versions when the same field changed after provisional confirmation', async () => {
  const name = await fixture(), command = request(null);
  await admitPlanningConfirmation(name, command);
  const response = await serverResponse(name, command);
  response.records[0].payload.description = 'peer note';
  await preparePlanningRequest(name, accountId);
  const db = await openDB(name), tx = db.transaction(causalBusinessTransactionStores(db, ['tasks']), 'readwrite');
  const tasks = await readCausalBusiness(tx, 'tasks', accountId) as any[];
  tasks[0].description = 'local note';
  await writeCausalBusiness(tx, 'tasks', accountId, tasks); await tx.done; db.close();
  expect(await commitPlanningResponse(name, accountId, command, response)).toMatchObject({ applied: false });
  expect((await value(name, 'tasks') as any[])[0].description).toBe('local note');
  const pending = (await readDailyPlanning(name, accountId, localDate)).pending[0];
  expect(pending.response).toEqual(response);
  expect(pending.review).toContain('both');
});


it('ignores delayed policy snapshots after a confirmation receipt is durable', async () => {
  const name = await fixture(), command = request(null);
  const oldPolicy = (await readDailyPlanning(name, accountId, localDate)).policy;
  await admitPlanningConfirmation(name, command);
  await preparePlanningRequest(name, accountId);
  const response = await serverResponse(name, command);
  await commitPlanningResponse(name, accountId, command, response);
  expect(await commitPlanningDay(name, accountId, localDate, {
    schemaVersion: 1, accountId, policy: oldPolicy, enforcementEnabled: true,
  })).toBe(false);
  expect((await readDailyPlanning(name, accountId, localDate)).policy).toEqual(response.policy);
  expect(await commitPlanningDay(name, accountId, localDate, {
    schemaVersion: 1, accountId, policy: response.policy, enforcementEnabled: true,
  })).toBe(true);
});

it('retains a conflict review without changing provisional tasks, XP or the attempted command', async () => {
  const name = await fixture(), command = request(null);
  const originalPolicy = (await readDailyPlanning(name, accountId, localDate)).policy;
  await admitPlanningConfirmation(name, command);
  const provisional = await serverResponse(name, command);
  await preparePlanningRequest(name, accountId);
  const receipt = { ...provisional.receipt, code: 'STALE_REVISION', revision: null, order: [], acceptedReplans: 0, actualDebit: 0 };
  const policy = { ...originalPolicy, history: [receipt] };
  const response = { ...provisional, receipt, policy, records: [] };
  await commitPlanningResponse(name, accountId, command, response);
  const before = await value(name, 'sync');
  const snapshot = { schemaVersion: 1, accountId, operationId: command.operationId, response, policy,
    records: provisional.records, missingTaskIds: [] };
  await retainPlanningReview(name, accountId, command, snapshot);
  await retainPlanningReview(name, accountId, command, snapshot);
  const pending = (await readDailyPlanning(name, accountId, localDate)).pending[0];
  expect(pending.reviewSnapshots).toEqual([snapshot]);
  expect(pending.request).toBe(JSON.stringify(command));
  expect(pending.response).toEqual(response);
  expect(await value(name, 'sync')).toEqual(before);
  expect((await value(name, 'progress') as any).xp).toBe(200);
  expect((await preparePlanningRequest(name, accountId))?.reviewRequest).toBeUndefined();
  const unrelated = structuredClone(snapshot); unrelated.response.receipt.requiredCost = 25;
  unrelated.response.policy.history[0].requiredCost = 25;
  await expect(retainPlanningReview(name, accountId, command, unrelated)).rejects.toThrow();
});

async function rejectedReview() {
  const name = await fixture(), command = request(null, ['c', 'b', 'a']);
  const originalPolicy = (await readDailyPlanning(name, accountId, localDate)).policy;
  await admitPlanningConfirmation(name, command);
  const provisional = await serverResponse(name, command);
  await preparePlanningRequest(name, accountId);
  const receipt = { ...provisional.receipt, code: 'STALE_REVISION', revision: null, order: [], acceptedReplans: 0, actualDebit: 0 };
  const policy = { ...originalPolicy, history: [receipt] };
  const response = { ...provisional, receipt, policy, records: [] };
  await commitPlanningResponse(name, accountId, command, response);
  const snapshot = { schemaVersion: 1, accountId, operationId: command.operationId, response, policy,
    records: provisional.records.map(row => row.entity_type === 'tasks' && row.entity_id === 'a'
      ? { ...row, payload: { ...row.payload, completed: true, lifecycleStatus: 'completed' } } : row), missingTaskIds: [] };
  await retainPlanningReview(name, accountId, command, snapshot);
  return { name, command, response, snapshot };
}

it.each(['synced', 'draft'] as const)('resolves a rejected order as %s while retaining exact evidence and completed tasks', async choice => {
  const { name, command, response, snapshot } = await rejectedReview();
  expect(await resolvePlanningReview(name, accountId, command.operationId, choice)).toEqual({ duplicate: false });
  const state = await readDailyPlanning(name, accountId, localDate);
  expect(state.pending).toHaveLength(0);
  expect(state.policy).toEqual(snapshot.policy);
  expect((await value(name, 'tasks') as any[]).find(task => task.id === 'a').completed).toBe(true);
  expect(state.draft?.proposedOrder ?? null).toEqual(choice === 'draft' ? command.proposedOrder : null);
  expect((await value(name, 'sync') as any).localState.planningReservations).toEqual({});
  expect(await resolvePlanningReview(name, accountId, command.operationId, choice)).toEqual({ duplicate: true });
  expect(await commitPlanningResponse(name, accountId, command, response)).toEqual({ applied: false, duplicate: true });
  const db = await openDB(name), stored = await db.get(PLANNING_STORE, accountId); db.close();
  expect(stored.planning.resolutions[command.operationId].pending.request).toBe(JSON.stringify(command));
  expect(validatePlanningBackup(accountId, stored, await value(name, 'sync'))).toEqual(stored);
});

it('rolls back the entire resolution when a later saved edit needs reconciliation', async () => {
  const { name, command } = await rejectedReview();
  const db = await openDB(name), tx = db.transaction(causalBusinessTransactionStores(db, ['tasks']), 'readwrite');
  const tasks = await readCausalBusiness(tx, 'tasks', accountId) as any[];
  tasks[2].description = 'independently saved';
  await writeCausalBusiness(tx, 'tasks', accountId, tasks); await tx.done; db.close();
  const before = await value(name, 'sync');
  await expect(resolvePlanningReview(name, accountId, command.operationId, 'synced')).rejects.toThrow('Later saved edits');
  expect(await value(name, 'sync')).toEqual(before);
  expect((await readDailyPlanning(name, accountId, localDate)).pending).toHaveLength(1);
  expect((await value(name, 'tasks') as any[])[2].description).toBe('independently saved');
});

it('exposes saved dates after midnight without copying the old order or allowance into today', async () => {
  const { name, command } = await rejectedReview();
  const tomorrow = '2026-09-09';
  const today = await readDailyPlanning(name, accountId, tomorrow);
  expect(today.otherDates).toEqual([localDate]);
  expect(today.pending).toEqual([]);
  expect(today.draft).toBeNull();
  expect(today.policy.acceptedReplans).toBe(0);
  await resolvePlanningReview(name, accountId, command.operationId, 'draft');
  expect((await readDailyPlanning(name, accountId, tomorrow)).otherDates).toEqual([localDate]);
  expect((await readDailyPlanning(name, accountId, localDate)).draft?.localDate).toBe(localDate);
  await discardPlanningDraft(name, accountId, localDate);
  expect((await readDailyPlanning(name, accountId, tomorrow)).otherDates).toEqual([]);
});


it('preserves successive saved task edits over a resolved order and replays the original WAL unchanged', async () => {
  const { name, command, snapshot } = await rejectedReview();
  const originalTasks = await value(name, 'tasks') as any[];
  const first = originalTasks.map(task => task.id === 'b' ? { ...task, description: 'saved later note' } : task);
  const second = first.map(task => task.id === 'b' ? { ...task, duration: 45 } : task);
  const tx1 = buildStagedLocalTransaction('tasks', accountId, originalTasks, first, 1, command.capturedAt, () => crypto.randomUUID())!;
  const tx2 = buildStagedLocalTransaction('tasks', accountId, first, second, 2, command.capturedAt, () => crypto.randomUUID())!;
  const meta = appendStagedTransactions(normalizeSyncMeta(await value(name, 'sync')), [tx1, tx2], 'saved-device');
  meta.localState!.journal[tx1.id] = tx1; meta.localState!.journal[tx2.id] = tx2;
  const originals = structuredClone(meta.outbox);
  const db = await openDB(name), tx = db.transaction(causalBusinessTransactionStores(db, ['tasks', 'sync']), 'readwrite');
  await writeCausalBusiness(tx, 'tasks', accountId, second); await writeCausalBusiness(tx, 'sync', accountId, meta); await tx.done; db.close();
  const remoteB = snapshot.records.find(row => row.entity_type === 'tasks' && row.entity_id === 'b')!;
  remoteB.payload = { ...remoteB.payload, plannedOrder: 8, title: 'remote title' };
  await retainPlanningReview(name, accountId, command, snapshot);
  await resolvePlanningReview(name, accountId, command.operationId, 'synced');
  const tasks = await value(name, 'tasks') as any[], result = normalizeSyncMeta(await value(name, 'sync'));
  expect(tasks.find(task => task.id === 'b')).toMatchObject({ description: 'saved later note', duration: 45, title: 'remote title', plannedOrder: 8 });
  expect(result.outbox.map(m => m.mutationId)).toEqual(originals.map(m => m.mutationId));
  expect(result.localState!.planningRebase!.planningEdits![originals[0].mutationId].original).toEqual(originals[0]);
  expect(appendStagedTransactions(result, [tx1, tx2], 'saved-device').outbox).toEqual(result.outbox);
  expect(readyOutbox(result)).toHaveLength(1);
  expect(readyOutbox(result)[0].baseServerVersion).toBe(remoteB.server_version);
  const planDb = await openDB(name), planning = await planDb.get(PLANNING_STORE, accountId); planDb.close();
  expect(() => validatePlanningBackup(accountId, planning, result)).not.toThrow();
  const damaged = structuredClone(result); (damaged.outbox[0].payload as any).description = 'lost original';
  expect(() => normalizeSyncMeta(damaged)).toThrow('projection differs');
});


it.each(['synced', 'draft'] as const)('resolves a chain of unattempted offline confirmations as %s without fabricating receipts', async choice => {
  const name = await fixture(), command = request(null, ['c', 'b', 'a']);
  const originalPolicy = (await readDailyPlanning(name, accountId, localDate)).policy;
  await admitPlanningConfirmation(name, command);
  await preparePlanningRequest(name, accountId);
  const provisional = await serverResponse(name, command);
  const second = request(command.operationId, ['b', 'a', 'c']);
  const third = request(second.operationId, ['a', 'c', 'b']);
  await admitPlanningConfirmation(name, second); await admitPlanningConfirmation(name, third);
  const originals = structuredClone((await readDailyPlanning(name, accountId, localDate)).pending);
  const receipt = { ...provisional.receipt, code: 'STALE_REVISION', revision: null, order: [], acceptedReplans: 0, actualDebit: 0 };
  const policy = { ...originalPolicy, history: [receipt] };
  const response = { ...provisional, receipt, policy, records: [] };
  await commitPlanningResponse(name, accountId, command, response);
  const snapshot = { schemaVersion: 1, accountId, operationId: command.operationId, response, policy,
    records: provisional.records.map(row => row.entity_type === 'tasks' ? { ...row, payload: { ...row.payload, plannedOrder: row.entity_id.charCodeAt(0) } } : row), missingTaskIds: [] };
  await retainPlanningReview(name, accountId, command, snapshot);
  await resolvePlanningReview(name, accountId, command.operationId, choice);
  const result = await readDailyPlanning(name, accountId, localDate);
  expect(result.pending).toHaveLength(0);
  expect(result.policy.acceptedReplans).toBe(0);
  expect(result.draft?.proposedOrder ?? null).toEqual(choice === 'draft' ? third.proposedOrder : null);
  const db = await openDB(name), saved = await db.get(PLANNING_STORE, accountId); db.close();
  expect(saved.planning.resolutions[second.operationId].pending).toEqual(originals.find(item => item.command.operationId === second.operationId));
  expect(saved.planning.resolutions[third.operationId].pending).toEqual(originals.find(item => item.command.operationId === third.operationId));
  expect(Object.keys(saved.planning.receipts)).toEqual([command.operationId]);
  const meta = await value(name, 'sync');
  expect(() => validatePlanningBackup(accountId, saved, meta)).not.toThrow();
  expect((await value(name, 'tasks') as any[]).map(row => row.plannedOrder)).toEqual([97, 98, 99]);
  expect(await resolvePlanningReview(name, accountId, command.operationId, choice)).toEqual({ duplicate: true });
});
