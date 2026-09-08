import { fenceLegacyBusinessStores, causalBusinessTransactionStores, readCausalBusiness, writeCausalBusiness } from './causalBusinessStorage';
import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { IDBObjectStore } from 'fake-indexeddb';
import { afterEach, expect, it, vi } from 'vitest';
import { admitLocalCompletion, prepareCompletionRequest, commitCompletionReceipt, syncLocalCompletion, validateCompletionEvidence, type CompletionIntent } from './causalCompletionCoordinator';
import { CAUSAL_STORE, fenceLegacyTracking } from './causalStorage';
import { bindCausalCapability } from './causalEnrollment';
import { admitLocalFocus } from './causalFocusCoordinator';
import { appendStagedTransactions, applyPushResults, applyRemotePage, buildStagedLocalTransaction, emptySyncMeta, normalizeSyncMeta, readyOutbox, markMutationsAttempted } from './syncProtocol';
import { storageService, STORES } from './storage';
import { prepareCausalRequest, commitCausalReceipt } from './causalReceipts';
import { applyDownloadedCausalHistory } from './causalProjection';
import { causalHistoryHash } from './causalHistoryProtocol';

const stores = ['tasks', 'stats', 'progress', 'goals', 'habits', 'task_events', 'tracking', 'sync'];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function fixture(fenced = false) {
  const name = `s2-completion-local-${crypto.randomUUID()}`, accountId = crypto.randomUUID(), sessionId = crypto.randomUUID(), epoch = crypto.randomUUID();
  const db = await openDB(name, 1, { upgrade(db) { for (const store of Object.values(STORES)) db.createObjectStore(store); } });
  const tracking = { date: '2026-09-08', planViewCount: 27, dailyPostponeCount: 3, unknown: { retained: true },
    focusSession: { schemaVersion: 1, sessionId, taskId: 'task', phase: 'active', plannedDurationSeconds: 600,
      startedAt: '2026-09-08T00:00:00.000Z', updatedAt: '2026-09-08T00:00:00.000Z', elapsedSeconds: 0, pausedAt: null, endedAt: null } };
  await db.put('tracking', tracking, accountId);
  await db.put('tasks', [{ id: 'task', title: 'Synthetic completion', description: 'original synthetic notes', completed: false,
    isFrog: true, goalId: 'goal', habitId: 'habit', duration: 10, dateAssigned: '2026-09-08', future: { retained: true } },
  { id: 'other', title: 'Another task', completed: false, dateAssigned: '2026-09-09' }], accountId);
  await db.put('goals', [{ id: 'goal', completedTasks: 2, future: 'retained' }], accountId);
  await db.put('habits', [{ id: 'habit', streak: 3, bestStreak: 8, future: 'retained' }], accountId);
  await db.put('stats', { '2026-09-08': { tasksCompleted: 2, frogsEaten: 1, timeFocused: 7, totalBreakMinutes: 3, future: true } }, accountId);
  await db.put('progress', { level: 1, xp: 0, xpToNextLevel: 100, future: true }, accountId);
  await db.put('task_events', [], accountId);
  await db.put('sync', { ...emptySyncMeta(), cursor: 7 }, accountId); db.close();
  (await fenceLegacyTracking(name)).close();
    if (fenced) (await fenceLegacyBusinessStores(name)).close();
  await bindCausalCapability(name, accountId, { schemaVersion: 2, accountId, enrolled: true, epoch, projectionRevision: 0, rolloutReady: false });
  const intent = (): CompletionIntent => ({ focus: { schemaVersion: 1, accountId, actionId: crypto.randomUUID(), actorId: 'synthetic-tab', kind: 'complete',
    sessionId, taskId: 'task', epoch: sessionId, expectedCurrentSessionId: sessionId, capturedAt: '2026-09-08T00:05:00.000Z', durationSeconds: null },
  details: { day: '2026-09-08', timeZone: 'Atlantic/Canary', actualDuration: 5, flowState: 'flow', finalDescription: '🧭'.repeat(12000) }, deviceId: 'synthetic-tab' });
  const read = async () => {
    const db = await openDB(name), values: any = {};
    for (const store of [...stores, CAUSAL_STORE]) {
      const tx = db.transaction(causalBusinessTransactionStores(db, [store]));
      values[store] = store === 'tracking' || store === CAUSAL_STORE ? await tx.objectStore(store).get(accountId) : await readCausalBusiness(tx, store, accountId);
      await tx.done;
    }
    db.close(); return values;
  };
  const write = async (store: string, value: unknown) => { const db = await openDB(name); await db.put(store, value, accountId); db.close(); };
  const receipt = (bytes: string, trackingValue: any) => {
    const operation = JSON.parse(bytes);
    return { schemaVersion: 2, epoch, projectionRevision: 1, operation, accepted: true,
      outcome: { accepted: true, code: 'APPLIED', revision: operation.command.actionId },
      record: { user_id: accountId, entity_type: 'tracking', entity_id: 'singleton', payload: trackingValue, version: 2, server_version: 100,
        device_id: 'causal-completion-v2', updated_at: operation.command.capturedAt, deleted_at: null },
      changes: operation.changes.map((member: any, index: number) => ({ mutationId: member.mutationId, accepted: true, serverVersion: 80 + index,
        record: { user_id: accountId, entity_type: member.entityType, entity_id: member.entityId, payload: member.payload, version: member.version,
          server_version: 80 + index, device_id: member.deviceId, updated_at: member.updatedAt, deleted_at: null } })) };
  };
  return { name, accountId, sessionId, epoch, tracking, intent, read, write, receipt };
}

it.each([false, true])('admits all six effects with final notes and derives rewards once (business fence %s)', async fenced => {
  const f = await fixture(fenced), intent = f.intent();
  const admitted = await admitLocalCompletion(f.name, intent);
  expect(admitted.admission.outcome.accepted).toBe(true);
  expect(admitted.admission.members).toHaveLength(6);
  const values = await f.read(), state = values[CAUSAL_STORE];
  expect(values.tasks[0]).toMatchObject({ completed: true, lifecycleStatus: 'completed', description: intent.details.finalDescription, future: { retained: true } });
  expect(values.stats['2026-09-08']).toEqual({ tasksCompleted: 3, frogsEaten: 2, timeFocused: 12, totalBreakMinutes: 3, future: true });
  expect(values.goals[0]).toMatchObject({ completedTasks: 3, future: 'retained' });
  expect(values.habits[0]).toMatchObject({ streak: 4, bestStreak: 8, lastCompletedDate: '2026-09-08' });
  expect(values.progress).toEqual({ level: 2, xp: 18, xpToNextLevel: 200, future: true });
  expect(values.task_events).toHaveLength(1);
  expect(state.trackingValue).toMatchObject({ planViewCount: 27, dailyPostponeCount: 3, unknown: f.tracking.unknown, focusSession: { phase: 'completed' } });
  expect(values.sync.cursor).toBe(7); expect(values.sync.outbox).toEqual([]);
  expect(Object.keys(values.sync.localState.completionReservations)).toHaveLength(6);
  expect((await admitLocalCompletion(f.name, intent)).duplicate).toBe(true);
  expect(await f.read()).toEqual(values);
  await expect(admitLocalCompletion(f.name, { ...intent, details: { ...intent.details, finalDescription: 'different' } })).rejects.toThrow('different intent');
});

it('concurrent distinct taps award once and retain the rejected tap notes without retargeting', async () => {
  const f = await fixture(), a = f.intent(), b = f.intent(); b.details.finalDescription = 'second retained draft';
  const results = await Promise.all([admitLocalCompletion(f.name, a), admitLocalCompletion(f.name, b)]);
  expect(results.filter(result => result.admission.outcome.accepted)).toHaveLength(1);
  const values = await f.read();
  expect(values.task_events).toHaveLength(1); expect(values.stats['2026-09-08'].tasksCompleted).toBe(3);
  expect(Object.keys(values[CAUSAL_STORE].completionAdmissions)).toHaveLength(2);
  expect(Object.keys(values[CAUSAL_STORE].completionOutbox)).toHaveLength(1);
  expect(values[CAUSAL_STORE].completionAdmissions[b.focus.actionId].intent.details.finalDescription).toBe('second retained draft');
});

it.each(['tracking', 'sync'])('rolls back every effect and admission when the final %s write fails', async failedStore => {
  const f = await fixture(), intent = f.intent(), before = await f.read();
  const original = IDBObjectStore.prototype.put;
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function(this: IDBObjectStore, ...args) {
    if (this.name === failedStore) throw new Error('Synthetic final write failure');
    return original.apply(this, args);
  });
  await expect(admitLocalCompletion(f.name, intent)).rejects.toThrow('Synthetic final write');
  vi.restoreAllMocks(); expect(await f.read()).toEqual(before);
  expect((await admitLocalCompletion(f.name, intent)).admission.outcome.accepted).toBe(true);
  expect((await f.read()).tasks[0].description).toBe(intent.details.finalDescription);
});

it('copies notes before awaiting and refuses a combined oversize action before any local success', async () => {
  const f = await fixture(), intent = f.intent();
  intent.details.finalDescription = 'x'.repeat(2_500_000);
  const stats = (await f.read()).stats; stats.future = 'y'.repeat(2_000_000); await f.write('stats', stats);
  const before = await f.read();
  await expect(admitLocalCompletion(f.name, intent)).rejects.toThrow('4 MiB');
  expect(await f.read()).toEqual(before);
  intent.details.finalDescription = '';
  const pending = admitLocalCompletion(f.name, intent); intent.details.finalDescription = 'changed after capture';
  await pending; expect((await f.read()).tasks[0].description).toBe('');
});

it('preserves queued predecessors, then freezes their exact acknowledged server versions', async () => {
  const f = await fixture(), before = await f.read(), intent = f.intent();
  const transaction = buildStagedLocalTransaction('tasks', f.accountId, [], before.tasks.slice(0, 1), 1, intent.focus.capturedAt, () => crypto.randomUUID())!;
  const queued = appendStagedTransactions(before.sync, [transaction], intent.deviceId);
  await f.write('sync', queued);
  await admitLocalCompletion(f.name, intent);
  await expect(prepareCompletionRequest(f.name, f.accountId, intent.focus.actionId)).rejects.toThrow('preceding entity receipt');
  let values = await f.read(); expect(readyOutbox(values.sync)).toEqual(queued.outbox);
  const request = queued.outbox[0];
  const result = { mutationId: request.mutationId, accepted: true, serverVersion: 20,
    record: { entityType: request.entityType, entityId: request.entityId, deviceId: request.deviceId, version: request.version,
      serverVersion: 20, payload: request.payload, updatedAt: request.updatedAt, deletedAt: null, user_id: f.accountId } };
  const acknowledged = applyPushResults(values.sync, [request], [result], intent.focus.capturedAt);
  acknowledged.localState!.receipts[request.mutationId] = { request, result };
  await f.write('sync', acknowledged);
  const bytes = await prepareCompletionRequest(f.name, f.accountId, intent.focus.actionId);
  expect(JSON.parse(bytes).changes.find((member: any) => member.entityType === 'tasks')).toMatchObject({ baseServerVersion: 20, version: 2 });
  expect(await prepareCompletionRequest(f.name, f.accountId, intent.focus.actionId)).toBe(bytes);
  values = await f.read(); expect(values.sync.cursor).toBe(7); expect(values.tasks[0].completed).toBe(true);
});

it('preserves ambiguous same-version predecessors without choosing one for completion', async () => {
  const f = await fixture(), before = await f.read(), intent = f.intent();
  const transaction = buildStagedLocalTransaction('tasks', f.accountId, [], before.tasks.slice(0, 1), 1, intent.focus.capturedAt, () => crypto.randomUUID())!;
  const meta = appendStagedTransactions(before.sync, [transaction], intent.deviceId);
  meta.outbox.push({ ...meta.outbox[0], mutationId: crypto.randomUUID() });
  await f.write('sync', meta); const captured = await f.read();
  await expect(admitLocalCompletion(f.name, intent)).rejects.toThrow('Ambiguous predecessor');
  expect(await f.read()).toEqual(captured);
});

it('holds successors and pull pages until the exact atomic receipt, without overwriting newer focus', async () => {
  const f = await fixture(), intent = f.intent(); await admitLocalCompletion(f.name, intent);
  const values = await f.read(), completedTracking = values[CAUSAL_STORE].trackingValue;
  const nextTasks = structuredClone(values.tasks); nextTasks[0].description = 'a newer retained edit';
  const edit = buildStagedLocalTransaction('tasks', f.accountId, values.tasks, nextTasks, 1, intent.focus.capturedAt, () => crypto.randomUUID())!;
  const meta = appendStagedTransactions(values.sync, [edit], intent.deviceId);
  expect(readyOutbox(normalizeSyncMeta(meta))).toEqual([]);
  expect(() => markMutationsAttempted(meta, [meta.outbox[0].mutationId], intent.focus.capturedAt)).toThrow('pending completion');
  const memberId = values[CAUSAL_STORE].completionAdmissions[intent.focus.actionId].members.find((item: any) => item.entityType === 'tasks').mutationId;
  expect(meta.outbox[0].dependsOnMutationId).toBe(memberId);
  expect(() => applyRemotePage(meta, { tasks: nextTasks }, [{ entityType: 'tasks', entityId: 'task', version: 2, serverVersion: 10, payload: nextTasks[0] }], 10, 'remote', intent.focus.capturedAt)).toThrow('atomic completion');
  await f.write('sync', meta); await f.write('tasks', nextTasks);
  const startId = crypto.randomUUID(), newSession = crypto.randomUUID();
  await admitLocalFocus(f.name, { ...intent.focus, actionId: startId, sessionId: newSession, taskId: 'other', epoch: startId, kind: 'start', durationSeconds: 600 });
  const bytes = await prepareCompletionRequest(f.name, f.accountId, intent.focus.actionId);
  const receipt = f.receipt(bytes, completedTracking), bad = structuredClone(receipt); bad.changes.pop();
  const before = await f.read();
  await expect(commitCompletionReceipt(f.name, f.accountId, intent.focus.actionId, bad)).rejects.toThrow(); expect(await f.read()).toEqual(before);
  expect(await commitCompletionReceipt(f.name, f.accountId, intent.focus.actionId, receipt)).toEqual({ accepted: true, duplicate: false });
  const after = await f.read();
  expect(after.tasks[0].description).toBe('a newer retained edit');
  expect(after[CAUSAL_STORE].trackingValue.focusSession.sessionId).toBe(newSession);
  expect(after.sync.cursor).toBe(7); expect(Object.keys(after.sync.localState.completionReservations)).toHaveLength(0);
  expect(readyOutbox(after.sync)[0]).toMatchObject({ baseServerVersion: 80, dependsOnMutationId: undefined });
  expect(after[CAUSAL_STORE].completionRequests[intent.focus.actionId]).toBe(bytes);
  expect(after[CAUSAL_STORE].completionOutbox[intent.focus.actionId]).toBeUndefined();
  expect((await commitCompletionReceipt(f.name, f.accountId, intent.focus.actionId, receipt)).duplicate).toBe(true);
  expect(await f.read()).toEqual(after);
  const send = vi.fn(); expect((await syncLocalCompletion(f.name, f.accountId, intent.focus.actionId, { authenticatedFetch: send })).duplicate).toBe(true); expect(send).not.toHaveBeenCalled();
});

it('retains rejected completion receipts and every reservation for explicit recovery', async () => {
  const f = await fixture(), intent = f.intent(); await admitLocalCompletion(f.name, intent);
  const bytes = await prepareCompletionRequest(f.name, f.accountId, intent.focus.actionId), values = await f.read();
  const receipt: any = f.receipt(bytes, values[CAUSAL_STORE].trackingValue);
  receipt.accepted = false; receipt.outcome = { accepted: false, code: 'STALE_REVISION', revision: f.sessionId }; receipt.changes = [];
  expect((await commitCompletionReceipt(f.name, f.accountId, intent.focus.actionId, receipt)).accepted).toBe(false);
  const after = await f.read();
  expect(Object.keys(after.sync.localState.completionReservations)).toHaveLength(6);
  expect(after[CAUSAL_STORE].completionOutbox[intent.focus.actionId]).toBeDefined();
  expect(after[CAUSAL_STORE].completionReceipts[intent.focus.actionId]).toEqual(receipt);
});

function installWindow(name: string) {
  const values = new Map<string, string>([['goalflow_active_database_v2', name]]);
  const localStorage = { get length() { return values.size; }, key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  vi.stubGlobal('window', { localStorage, dispatchEvent: () => true }); vi.stubGlobal('localStorage', localStorage);
  return values;
}

it('restores the actual schema-5 backup and retries the original pending completion bytes', async () => {
  const f = await fixture(), intent = f.intent(); installWindow(f.name);
  await admitLocalCompletion(f.name, intent);
  const bytes = await prepareCompletionRequest(f.name, f.accountId, intent.focus.actionId);
  const before = await f.read();
  const backup = await storageService.exportBackup(f.accountId);
  expect(backup.schemaVersion).toBe(5);
  const name = `s2-restored-completion-${crypto.randomUUID()}`; installWindow(name);
  await storageService.importBackup(f.accountId, JSON.parse(JSON.stringify(backup)));
  expect(await prepareCompletionRequest(name, f.accountId, intent.focus.actionId)).toBe(bytes);
  const fetch = vi.fn(async () => Response.json(f.receipt(bytes, before[CAUSAL_STORE].trackingValue)));
  expect(await syncLocalCompletion(name, f.accountId, intent.focus.actionId, { authenticatedFetch: fetch })).toEqual({ accepted: true, duplicate: false });
  const db = await openDB(name), state = await db.get(CAUSAL_STORE, f.accountId);
  expect(state.completionRequests[intent.focus.actionId]).toBe(bytes);
  expect(await db.get('tasks', f.accountId)).toEqual(before.tasks);
  expect(await db.get('stats', f.accountId)).toEqual(before.stats);
  expect((await db.get('sync', f.accountId)).cursor).toBe(7); db.close();
  expect((await syncLocalCompletion(name, f.accountId, intent.focus.actionId, { authenticatedFetch: fetch })).duplicate).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('rejects damaged request/reservation evidence and retains late legacy captures', async () => {
  const f = await fixture(), intent = f.intent(), values = installWindow(f.name);
  const key = `goalflow_wal_v2_${encodeURIComponent(f.accountId)}_late`;
  values.set(key, '{"uninterpreted":"captured notes"}');
  const before = await f.read();
  await expect(admitLocalCompletion(f.name, intent)).rejects.toThrow('retained local captures');
  expect(await f.read()).toEqual(before); expect(values.get(key)).toBe('{"uninterpreted":"captured notes"}');
  values.delete(key); // Synthetic fixture cleanup only.
  await admitLocalCompletion(f.name, intent);
  const bytes = await prepareCompletionRequest(f.name, f.accountId, intent.focus.actionId), after = await f.read();
  expect(() => validateCompletionEvidence(f.accountId, after[CAUSAL_STORE], after.sync)).not.toThrow();
  const corrupt = structuredClone(after.sync); delete corrupt.localState.completionReservations[JSON.parse(bytes).changes[0].mutationId];
  expect(() => validateCompletionEvidence(f.accountId, after[CAUSAL_STORE], corrupt)).toThrow('reservations');
  const state = structuredClone(after[CAUSAL_STORE]), operation = JSON.parse(bytes); operation.changes[0].payload.description = 'different';
  state.completionRequests[intent.focus.actionId] = JSON.stringify(operation);
  expect(() => validateCompletionEvidence(f.accountId, state, after.sync)).toThrow('durable admission');
  const damagedCollections = { ...after, tasks: [{ ...after.tasks[0], description: 'lost final notes' }, ...after.tasks.slice(1)] };
  expect(() => validateCompletionEvidence(f.accountId, after[CAUSAL_STORE], after.sync, damagedCollections)).toThrow('final effects');
});

it('chains two local completions through their shared statistics and progress receipts', async () => {
  const f = await fixture(), first = f.intent(); await admitLocalCompletion(f.name, first);
  const firstBytes = await prepareCompletionRequest(f.name, f.accountId, first.focus.actionId), firstState = await f.read();
  const startId = crypto.randomUUID(), sessionId = crypto.randomUUID();
  const start = await admitLocalFocus(f.name, { ...first.focus, actionId: startId, sessionId, taskId: 'other', epoch: startId, kind: 'start', durationSeconds: 600 });
  const startOperation = { schemaVersion: 2, epoch: f.epoch, type: 'focus', command: start.command };
  await prepareCausalRequest(f.name, f.accountId, startOperation);
  const second = f.intent(); second.focus = { ...second.focus, sessionId, taskId: 'other', epoch: startId, expectedCurrentSessionId: sessionId };
  await admitLocalCompletion(f.name, second);
  await expect(prepareCompletionRequest(f.name, f.accountId, second.focus.actionId)).rejects.toThrow('focus predecessor receipt');
  await commitCausalReceipt(f.name, f.accountId, startId, { schemaVersion: 2, epoch: f.epoch, projectionRevision: 2, operation: startOperation,
    accepted: true, outcome: start.outcome, record: { user_id: f.accountId, entity_type: 'tracking', entity_id: 'singleton', payload: start.tracking,
      version: 3, server_version: 101, device_id: 'fixture', updated_at: start.command.capturedAt, deleted_at: null } });
  await expect(prepareCompletionRequest(f.name, f.accountId, second.focus.actionId)).rejects.toThrow('preceding logical action');
  await commitCompletionReceipt(f.name, f.accountId, first.focus.actionId, f.receipt(firstBytes, firstState[CAUSAL_STORE].trackingValue));
  const secondBytes = await prepareCompletionRequest(f.name, f.accountId, second.focus.actionId);
  expect(JSON.parse(secondBytes).changes.find((member: any) => member.entityType === 'stats')).toMatchObject({ baseServerVersion: 81, version: 2 });
  const before = await f.read(), secondReceipt = f.receipt(secondBytes, before[CAUSAL_STORE].trackingValue);
  secondReceipt.projectionRevision = 3; secondReceipt.record.server_version = 200;
  for (const result of secondReceipt.changes) { result.serverVersion += 100; result.record.server_version += 100; }
  await commitCompletionReceipt(f.name, f.accountId, second.focus.actionId, secondReceipt);
  const after = await f.read();
  expect(after.stats['2026-09-08'].tasksCompleted).toBe(4); expect(after.task_events).toHaveLength(2);
  expect(after[CAUSAL_STORE].trackingValue.focusSession.sessionId).toBe(sessionId);
  expect(Object.keys(after.sync.localState.completionReservations)).toHaveLength(0);
  expect(() => validateCompletionEvidence(f.accountId, after[CAUSAL_STORE], after.sync, after)).not.toThrow();
});

it('replays an admitted completion over earlier history without reviving active focus or losing its effects', async () => {
  const f = await fixture(), intent = f.intent(); await admitLocalCompletion(f.name, intent);
  const state = (await f.read())[CAUSAL_STORE];
  const receipt = { schemaVersion: 2, epoch: f.epoch, projectionRevision: 0,
    baseline: { schemaVersion: 1, accountId: f.accountId, baselineId: f.epoch, day: f.tracking.date, counts: { planViewCount: 27, dailyPostponeCount: 3 }, evidenceIds: [f.epoch] },
    operation: { schemaVersion: 2, accountId: f.accountId, cutoverId: f.epoch, expectedTrackingServerVersion: 7, expectedTrackingPayload: f.tracking },
    record: { user_id: f.accountId, entity_type: 'tracking', entity_id: 'singleton', version: 1, server_version: 7,
      device_id: 'fixture', updated_at: intent.focus.capturedAt, deleted_at: null, payload: f.tracking } };
  const body = JSON.stringify({ schemaVersion: 2, accountId: f.accountId, epoch: f.epoch, revision: 0, receipt });
  state.causalHistory = { schemaVersion: 1, epoch: f.epoch, throughRevision: 0, downloadedRevision: 0,
    entries: { '0': { body, sha256: await causalHistoryHash(new TextEncoder().encode(body)) } } };
  const db = await openDB(f.name); await db.put(CAUSAL_STORE, state); db.close();
  const before = await f.read();
  expect((await applyDownloadedCausalHistory(f.name, f.accountId)).blocked).toBe(false);
  const after = await f.read();
  for (const store of ['tasks', 'stats', 'progress', 'goals', 'habits', 'task_events', 'tracking']) expect(after[store]).toEqual(before[store]);
  expect(after[CAUSAL_STORE].completionOutbox).toEqual(before[CAUSAL_STORE].completionOutbox);
  expect(after[CAUSAL_STORE].trackingValue.focusSession.phase).toBe('completed');
});
