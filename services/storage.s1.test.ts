import 'fake-indexeddb/auto';
import { describe, it, expect, vi } from 'vitest';
import { openDB, unwrap } from 'idb';
import { IDBObjectStore } from 'fake-indexeddb';
import { appendStagedTransactions, buildStagedLocalTransaction, normalizeSyncMeta } from './syncProtocol';
import { storageService, STORES } from './storage';

const install = () => {
  const values = new Map<string, string>();
  const localStorage = {
    get length() { return values.size; },
    key: (i: number) => [...values.keys()][i] ?? null,
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => { values.set(k, String(v)); },
    removeItem: (k: string) => { values.delete(k); }
  };
  Object.assign(globalThis, { window: { localStorage, dispatchEvent: () => true }, localStorage });
  return values;
};

describe('S1 deterministic storage schedules', () => {
  it('G: equal key count is not a WAL content revision', async () => {
    const values = install();
    const user = crypto.randomUUID();
    storageService.stageLocalValue(STORES.TASKS, user, [], [{ id: 'a', title: 'A' }]);
    expect(await storageService.get(STORES.TASKS, user)).toEqual([{ id: 'a', title: 'A' }]);
    const [key, raw] = [...values.entries()].find(([key]) => key.startsWith('goalflow_wal'))!;
    const replacement = JSON.parse(raw);
    replacement.id = crypto.randomUUID();
    replacement.value = [{ id: 'b', title: 'B' }];
    values.delete(key);
    values.set(key + '-peer', JSON.stringify(replacement));
    expect(await storageService.get(STORES.TASKS, user)).toEqual([{ id: 'b', title: 'B' }]);
  });

  it.each(['markSyncSuccessful', 'mergeServerConflicts', 'commitPushResults', 'preparePushBatch', 'resolveConflictLocally', 'resolveConflictWithCloud'] as const)(
    'B: %s must not replace a concurrently appended outbox', async method => {
      install();
      const user = crypto.randomUUID();
      await storageService.set(STORES.TASKS, user, [], 'cloud');
      let conflictId = '';
      if (method === 'preparePushBatch' || method.startsWith('resolveConflict')) {
        storageService.stageLocalValue(STORES.TASKS, user, [], [{ id: 'a', title: 'A' }]);
        await storageService.flushPendingLocalChanges(user);
      }
      if (method.startsWith('resolveConflict')) {
        const applied = await storageService.applyRemotePage(user, [{ entityType: STORES.TASKS, entityId: 'a',
          version: 1, serverVersion: 1, payload: { id: 'a', title: 'remote A' }, deviceId: 'remote', deletedAt: null }], 1, 'local');
        conflictId = applied.meta.conflicts[0].id;
      }
      const db = await openDB('GoalflowDB');
      const native = unwrap(db);
      const staged = buildStagedLocalTransaction(STORES.TASKS, user, [], [{ id: 'b', title: 'B' }], 1,
        '2026-09-07T10:00:00.000Z', () => crypto.randomUUID())!;
      let injected = false;
      let reads = 0;
      let peerDone: Promise<void> = Promise.resolve();
      const get = IDBObjectStore.prototype.get;
      const spy = vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (this: IDBObjectStore, key) {
        const request = get.call(this, key);
        if (this.name === STORES.SYNC && key === user && !injected && (++reads > (method === 'preparePushBatch' ? 1 : 0))) {
          injected = true;
          request.addEventListener('success', () => {
            // B queues while A's read transaction is still active. In the old
            // code B precedes A's later put; in the repair B follows A's commit.
            const tx = native.transaction([STORES.TASKS, STORES.SYNC], 'readwrite');
            peerDone = new Promise((resolve, reject) => {
              tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
            });
            const latest = tx.objectStore(STORES.SYNC).get(user);
            latest.onsuccess = () => {
              tx.objectStore(STORES.TASKS).put(staged.value, user);
              tx.objectStore(STORES.SYNC).put(appendStagedTransactions(normalizeSyncMeta(latest.result), [staged], 'peer-B'), user);
            };
          }, { once: true });
        }
        return request;
      });
      try {
        if (method === 'markSyncSuccessful') await storageService.markSyncSuccessful(user);
        if (method === 'mergeServerConflicts') await storageService.mergeServerConflicts(user, []);
        if (method === 'commitPushResults') await storageService.commitPushResults(user, [], []);
        if (method === 'preparePushBatch') await storageService.preparePushBatch(user);
        if (method === 'resolveConflictLocally') await storageService.resolveConflictLocally(user, conflictId);
        if (method === 'resolveConflictWithCloud') await storageService.resolveConflictWithCloud(user, conflictId);
        await peerDone;
      } finally { spy.mockRestore(); }
      expect(injected).toBe(true);
      const restarted = await openDB('GoalflowDB');
      const meta = await restarted.get(STORES.SYNC, user);
      expect(meta.outbox.map((m: any) => m.mutationId)).toContain(staged.changes[0].mutationId);
      expect(await restarted.get(STORES.TASKS, user)).toEqual(staged.value);
    });
});

it.each(['before', 'during', 'after'] as const)('D: focus admission %s inbound application remains recoverable', async timing => {
  const values = install();
  const user = crypto.randomUUID();
  const focus = { schemaVersion: 1, sessionId: '11111111-1111-4111-8111-111111111111', taskId: 'task-A',
    phase: 'active', plannedDurationSeconds: 1500, startedAt: '2026-09-07T10:00:00.000Z', elapsedSeconds: 0,
    pausedAt: null, endedAt: null, updatedAt: '2026-09-07T10:00:00.000Z' };
  const before = { date: '2026-09-07', planViewCount: 0, dailyPostponeCount: 0, focusSession: focus };
  const remote = { ...before, focusSession: { ...focus, phase: 'completed', elapsedSeconds: 60,
    endedAt: '2026-09-07T10:01:00.000Z', updatedAt: '2026-09-07T10:01:00.000Z' } };
  await storageService.set(STORES.TRACKING, user, before, 'cloud');
  const get = IDBObjectStore.prototype.get;
  let captured: string | null = null;
  let exact = '';
  const capture = () => {
    captured = storageService.stageLocalValue(STORES.TRACKING, user, before,
      { ...before, focusSession: { ...focus, plannedDurationSeconds: 1800, updatedAt: '2026-09-07T10:02:00.000Z' } });
    exact = [...values.entries()].find(([key]) => key.endsWith(captured!))![1];
  };
  if (timing === 'before') capture();
  const spy = vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (this: IDBObjectStore, key) {
    const request = get.call(this, key);
    if (timing === 'during' && this.name === STORES.TRACKING && key === user && !captured) {
      request.addEventListener('success', capture, { once: true });
    }
    return request;
  });
  try {
    await storageService.applyRemotePage(user, [{ entityType: STORES.TRACKING, entityId: 'singleton',
      version: 1, serverVersion: 1, deviceId: 'remote', payload: remote, updatedAt: '2026-09-07T10:01:00.000Z', deletedAt: null }], 1, 'local');
  } finally { spy.mockRestore(); }
  if (timing === 'after') capture();
  expect(captured).not.toBeNull();
  const meta = await storageService.flushPendingLocalChanges(user);
  expect(meta.localState?.journal[captured!]).toEqual(JSON.parse(exact));
  if (timing === 'before') {
    const represented = [...meta.outbox.map(item => item.mutationId), ...meta.conflicts.flatMap(item => item.localHistory.map(history => history.mutationId))];
    for (const change of JSON.parse(exact).changes) expect(represented).toContain(change.mutationId);
  } else {
    expect(meta.localState?.blocked?.[captured!]).toMatch(/STALE_FOCUS_INTENT/);
    expect(meta.outbox).toEqual([]);
    expect(await storageService.get(STORES.TRACKING, user)).toEqual(remote);
  }
  expect((await storageService.flushPendingLocalChanges(user)).localState).toEqual(meta.localState);
});

it('E: grouped completion and independent note edit retain every exact mutation on repeated drains', async () => {
  install();
  const user = crypto.randomUUID();
  const tasks = [{ id: 'a', completed: false, description: 'base' }, { id: 'b', description: 'old' }];
  await storageService.set(STORES.TASKS, user, tasks, 'cloud');
  await storageService.set(STORES.STATS, user, {}, 'cloud');
  const completed = [{ ...tasks[0], completed: true }, tasks[1]];
  storageService.stageLocalValues(user, [
    { storeName: STORES.TASKS, previousValue: tasks, nextValue: completed },
    { storeName: STORES.STATS, previousValue: {}, nextValue: { '2026-09-07': { tasksCompleted: 1 } } }
  ]);
  storageService.stageLocalValue(STORES.TASKS, user, completed, [completed[0], { ...completed[1], description: 'new note' }]);
  const first = await storageService.flushPendingLocalChanges(user);
  expect(first.outbox).toHaveLength(3);
  expect((await storageService.flushPendingLocalChanges(user)).outbox).toEqual(first.outbox);
  expect(await storageService.get(STORES.TASKS, user)).toEqual([completed[0], { ...completed[1], description: 'new note' }]);
  expect(Object.keys(first.localState?.journal ?? {})).toHaveLength(3);
});

it('receipt evidence prevents a retired WAL from manufacturing a second action after acknowledgment', async () => {
  const values = install();
  const user = crypto.randomUUID();
  storageService.stageLocalValue(STORES.TASKS, user, [], [{ id: 'a', title: 'accepted' }]);
  const wal = [...values.entries()].find(([key]) => key.startsWith('goalflow_wal'))!;
  const batch = await storageService.preparePushBatch(user);
  const request = batch[0];
  const receipt = { mutationId: request.mutationId, accepted: true, serverVersion: 1,
    record: { entityType: request.entityType, entityId: request.entityId, deviceId: request.deviceId,
      version: request.version, serverVersion: 1, payload: request.payload, updatedAt: request.updatedAt, deletedAt: request.deletedAt } };
  const accepted = await storageService.commitPushResults(user, batch, [receipt]);
  expect(accepted.outbox).toHaveLength(0);
  expect(accepted.localState?.receipts[request.mutationId]).toEqual({ request, result: receipt });
  values.set(...wal);
  const replay = await storageService.flushPendingLocalChanges(user);
  expect(replay.outbox).toHaveLength(0);
  expect(replay.localState?.receipts).toEqual(accepted.localState?.receipts);
});

it('aborts an inbound transaction after materialization if the page is invalid', async () => {
  const values = install();
  const user = crypto.randomUUID();
  await storageService.set(STORES.TASKS, user, [], 'cloud');
  storageService.stageLocalValues(user, [
    { storeName: STORES.TASKS, previousValue: [], nextValue: [{ id: 'a', title: 'atomic' }] },
    { storeName: STORES.STATS, previousValue: undefined, nextValue: { completed: 1 } }
  ]);
  const wal = [...values.entries()].filter(([key]) => key.startsWith('goalflow_wal'));
  await expect(storageService.applyRemotePage(user, [{ entityType: STORES.TASKS, entityId: 'bad',
    serverVersion: 10, version: 1, payload: null }], 2, 'local')).rejects.toThrow();
  const db = await openDB('GoalflowDB');
  expect(await db.get(STORES.TASKS, user)).toEqual([]);
  expect(await db.get(STORES.STATS, user)).toBeUndefined();
  expect((await db.get(STORES.SYNC, user)).cursor).toBe(0);
  expect([...values.entries()].filter(([key]) => key.startsWith('goalflow_wal'))).toEqual(wal);
  expect((await storageService.flushPendingLocalChanges(user)).outbox).toHaveLength(2);
});
