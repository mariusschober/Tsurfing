import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { IDBObjectStore } from 'fake-indexeddb';
import { afterEach, expect, it, vi } from 'vitest';
import { storageService, STORES } from './storage';
import { CAUSAL_STORE, fenceLegacyTracking } from './causalStorage';
import { CAUSAL_BUSINESS_STORE, fenceLegacyBusinessStores, causalBusinessTransactionStores, readCausalBusiness, writeCausalBusiness } from './causalBusinessStorage';
import { buildStagedLocalTransaction, emptySyncMeta } from './syncProtocol';
import { assertCompletionCapturesMaterialized } from './causalCompletionCoordinator';
import { wireMutation } from './syncEnvelope';
import { ensurePlanningStorage } from './deliberatePlanningStorage';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function fixture() {
  const name = `s2-storage-active-${crypto.randomUUID()}`, user = crypto.randomUUID();
  const values = new Map<string, string>([['goalflow_active_database_v2', name]]);
  const localStorage = { get length() { return values.size; }, key: (i: number) => [...values.keys()][i] ?? null,
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  vi.stubGlobal('window', { localStorage, dispatchEvent: () => true }); vi.stubGlobal('localStorage', localStorage);
  const db = await openDB(name, 1, { upgrade(db) { for (const store of Object.values(STORES)) db.createObjectStore(store); } });
  const tasks = [{ id: 'task', title: 'synthetic', description: 'original synthetic notes', completed: false }];
  const tracking = { date: '2026-09-08', planViewCount: 27, dailyPostponeCount: 3, future: 'retained',
    focusSession: { schemaVersion: 1, sessionId: crypto.randomUUID(), taskId: 'task', phase: 'active', plannedDurationSeconds: 600,
      startedAt: '2026-09-08T00:00:00.000Z', updatedAt: '2026-09-08T00:00:00.000Z', elapsedSeconds: 0, pausedAt: null, endedAt: null } };
  await db.put('tasks', tasks, user); await db.put('tracking', tracking, user);
  await db.put('sync', { ...emptySyncMeta(), future: { raw: 'retained' } }, user);
  db.close(); (await fenceLegacyTracking(name)).close(); (await fenceLegacyBusinessStores(name)).close();
  (await ensurePlanningStorage(name)).close();
  const read = async () => {
    const db = await openDB(name), tx = db.transaction(causalBusinessTransactionStores(db, ['tasks', 'tracking', 'sync', CAUSAL_STORE]));
    const tasks = await readCausalBusiness(tx, 'tasks', user), sync = await readCausalBusiness(tx, 'sync', user);
    const state = await tx.objectStore(CAUSAL_STORE).get(user); await tx.done; db.close(); return { tasks, sync: sync as any, state };
  };
  return { name, user, values, tasks, tracking, read };
}
it('uses authority for actual reads, new note captures, immutable retry requests and exact receipt retirement', async () => {
  const f = await fixture(), old = await openDB(f.name); await old.clear('tasks'); await old.clear('sync'); await old.clear('tracking'); old.close();
  expect(await storageService.get('tasks', f.user)).toEqual(f.tasks);
  expect((await storageService.readCommittedSnapshot(f.user)).values.tracking).toEqual(f.tracking);
  const notes = [{ ...f.tasks[0], description: 'new synthetic notes' }];
  const id = storageService.stageLocalValue('tasks', f.user, f.tasks, notes)!;
  expect(await storageService.get('tasks', f.user)).toEqual(notes);
  const batch = await storageService.preparePushBatch(f.user); expect(batch).toHaveLength(1);
  expect((await f.read()).tasks).toEqual(notes); expect((await f.read()).sync.localState.journal[id].captureProtocol).toBe('causal-compatible-v1');
  expect((await storageService.preparePushBatch(f.user)).map(wireMutation)).toEqual(batch.map(wireMutation));
  await storageService.commitPushResults(f.user, batch, batch.map(request => ({ mutationId: request.mutationId, accepted: true, serverVersion: 1,
    record: { ...request, serverVersion: 1 } })));
  const final = await f.read(); expect(final.sync.outbox).toEqual([]); expect(final.sync.cursor).toBe(0);
  expect(final.sync.localState.receipts[batch[0].mutationId].request).toEqual(batch[0]);
  expect(final.sync.future).toEqual({ raw: 'retained' }); expect(final.state.trackingValue).toEqual(f.tracking);
});
it('retains two ambiguous legacy counter captures verbatim and never infers their increments', async () => {
  const f = await fixture(), oldFocus = { ...f.tracking.focusSession, updatedAt: '2026-09-07T23:59:00.000Z' };
  const captures = [f.tracking, { ...f.tracking, focusSession: oldFocus }].map((base, index) => {
    const transaction = buildStagedLocalTransaction('tracking', f.user, base, { ...base, planViewCount: 28 }, index + 1, '2026-09-08T00:01:00.000Z', () => crypto.randomUUID())!;
    const key = `goalflow_wal_v2_${encodeURIComponent(f.user)}_${transaction.id}`, raw = JSON.stringify(transaction, null, 2);
    f.values.set(key, raw); return { transaction, key, raw };
  });
  expect(await storageService.get('tracking', f.user)).toEqual(f.tracking);
  await storageService.flushPendingLocalChanges(f.user);
  const after = await f.read(); expect(after.state.trackingValue).toEqual(f.tracking); expect(after.sync.outbox).toEqual([]);
  for (const capture of captures) {
    expect(after.state.legacyWal[capture.key]).toEqual([capture.raw]);
    expect(after.sync.localState.journal[capture.transaction.id]).toEqual(capture.transaction);
    expect(after.sync.localState.blocked[capture.transaction.id]).toContain('CAUSAL_CAPTURE_REVIEW');
  }
  expect((await storageService.readCommittedSnapshot(f.user)).pendingCount).toBe(2);
  expect(() => assertCompletionCapturesMaterialized(f.user, after.sync)).toThrow('reviews must be resolved');
  const notes = [{ ...f.tasks[0], description: 'independent new notes' }];
  storageService.stageLocalValue('tasks', f.user, f.tasks, notes);
  await storageService.flushPendingLocalChanges(f.user);
  expect((await f.read()).tasks).toEqual(notes); expect((await f.read()).state.trackingValue.planViewCount).toBe(27);
});
it('keeps a whole new grouped snapshot pending when one member changes causal focus or counters', async () => {
  const f = await fixture();
  storageService.stageLocalValues(f.user, [{ storeName: 'tasks', previousValue: f.tasks, nextValue: [{ ...f.tasks[0], completed: true, description: 'retained final draft' }] },
    { storeName: 'tracking', previousValue: f.tracking, nextValue: { ...f.tracking, planViewCount: 28 } }]);
  const [key, raw] = [...f.values].find(([key]) => key.startsWith('goalflow_wal_v2_'))!;
  expect(await storageService.get('tasks', f.user)).toEqual(f.tasks);
  await storageService.flushPendingLocalChanges(f.user);
  const after = await f.read(); expect(after.tasks).toEqual(f.tasks); expect(after.state.trackingValue).toEqual(f.tracking);
  expect(after.sync.outbox).toEqual([]); expect(after.state.legacyWal[key]).toEqual([raw]);
  expect(Object.keys(after.sync.localState.blocked)).toHaveLength(2);
});
it('does not trust a compatibility marker when the captured projection and mutation payload differ', async () => {
  const f = await fixture(), next = [{ ...f.tasks[0], description: 'intended synthetic notes' }];
  storageService.stageLocalValue('tasks', f.user, f.tasks, next);
  const [key, raw] = [...f.values].find(([key]) => key.startsWith('goalflow_wal_v2_'))!;
  const damaged = JSON.parse(raw); damaged.changes[0].payload = { ...f.tasks[0], description: 'different payload' };
  const changedRaw = JSON.stringify(damaged); f.values.set(key, changedRaw);
  expect(await storageService.get('tasks', f.user)).toEqual(f.tasks);
  await storageService.flushPendingLocalChanges(f.user);
  const after = await f.read(); expect(after.tasks).toEqual(f.tasks); expect(after.sync.outbox).toEqual([]);
  expect(after.state.legacyWal[key]).toEqual([changedRaw]);
});
it('archives fallback replacements without merging notes, counter snapshots or fallback cursors into authority', async () => {
  const f = await fixture(), key = `goalflow_fallback_tracking_${f.user}`;
  const first = JSON.stringify({ ...f.tracking, planViewCount: 28 }); f.values.set(key, first);
  await storageService.flushPendingLocalChanges(f.user);
  const second = JSON.stringify({ ...f.tracking, planViewCount: 29 }); f.values.set(key, second);
  await storageService.flushPendingLocalChanges(f.user);
  const after = await f.read(); expect(after.state.trackingValue).toEqual(f.tracking); expect(after.sync.cursor).toBe(0);
  expect(after.state.legacyFallback.tracking).toEqual([first, second]); expect(f.values.get(key)).toBe(second);
  expect(after.sync.localState.blocked['causal-fallback:tracking']).toContain('CAUSAL_FALLBACK_REVIEW');
});
it('commits ordinary pull records and cursor together but refuses a tracking snapshot that changes causal state', async () => {
  const f = await fixture();
  await storageService.applyRemotePage(f.user, [{ entityType: 'tasks', entityId: 'task', payload: { ...f.tasks[0], description: 'remote notes' },
    serverVersion: 1, version: 1, deviceId: 'peer', deletedAt: null }], 1, 'own');
  const before = await f.read(); expect(before.sync.cursor).toBe(1); expect((before.tasks as any[])[0].description).toBe('remote notes');
  await expect(storageService.applyRemotePage(f.user, [{ entityType: 'tasks', entityId: 'task', payload: { ...f.tasks[0], description: 'partial would be invalid' },
    serverVersion: 2, version: 2, deviceId: 'peer', deletedAt: null }, { entityType: 'tracking', entityId: 'singleton', payload: { ...f.tracking, planViewCount: 99 },
    serverVersion: 3, version: 1, deviceId: 'peer', deletedAt: null }], 3, 'own')).rejects.toThrow('causal command');
  expect(await f.read()).toEqual(before);
});
it('retains WAL and every authoritative value when the final sync write fails, then retries exactly once', async () => {
  const f = await fixture(), before = await f.read(), notes = [{ ...f.tasks[0], description: 'survives a failed commit' }];
  const id = storageService.stageLocalValue('tasks', f.user, f.tasks, notes)!;
  const put = IDBObjectStore.prototype.put;
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function(this: IDBObjectStore, ...args) {
    if (this.name === CAUSAL_BUSINESS_STORE && (args[0] as any).storeName === 'sync') throw new Error('Synthetic final sync failure');
    return put.apply(this, args);
  });
  await expect(storageService.flushPendingLocalChanges(f.user)).rejects.toThrow('Synthetic final sync failure'); vi.restoreAllMocks();
  expect(await f.read()).toEqual(before); expect([...f.values.keys()].some(key => key.includes(id))).toBe(true);
  await storageService.flushPendingLocalChanges(f.user);
  const after = await f.read(); expect(after.tasks).toEqual(notes); expect(after.sync.outbox).toHaveLength(1);
  await storageService.flushPendingLocalChanges(f.user); expect((await f.read()).sync.outbox).toEqual(after.sync.outbox);
});
it('does not reset authority after a mirror deletion, initialize a tombstone, or rebind causal account identities', async () => {
  const f = await fixture(), db = await openDB(f.name); await db.delete('tasks', f.user);
  for (const store of [CAUSAL_STORE, CAUSAL_BUSINESS_STORE]) {
    await expect(storageService.clear(store)).rejects.toThrow('cannot be cleared');
    await expect(storageService.delete(store, f.user)).rejects.toThrow('cannot be deleted');
    await expect(storageService.set(store, f.user, {})).rejects.toThrow('owning coordinator');
  }
  expect(await storageService.initializeIfAbsent('tasks', f.user, [])).toEqual(f.tasks);
  const tx = db.transaction(causalBusinessTransactionStores(db, ['habits']), 'readwrite');
  await writeCausalBusiness(tx, 'habits', f.user, undefined, false); await tx.done; db.close();
  await expect(storageService.initializeIfAbsent('habits', f.user, [])).rejects.toThrow('Recorded absence');
  await expect(storageService.migrateUserKey(f.user, 'other-user')).rejects.toThrow('cannot be rebound');
  expect((await f.read()).tasks).toEqual(f.tasks);
  await storageService.seedUnsynchronizedLocalData(f.user);
  expect((await f.read()).sync.outbox.every((request: any) => request.entityType !== 'tracking')).toBe(true);
});

it('routes an explicit rendered focus control through the private transaction and reports pending causal work', async () => {
  const f = await fixture();
  const before = await storageService.readCommittedSnapshot(f.user);
  const control = { schemaVersion: 1 as const, actionId: crypto.randomUUID(), accountId: f.user, kind: 'pause' as const,
    sessionId: f.tracking.focusSession.sessionId, taskId: 'task', expectedCurrentSessionId: f.tracking.focusSession.sessionId,
    capturedAt: '2026-09-08T00:00:30.000Z', durationSeconds: null };
  const result = await storageService.admitFocusControl(f.user, control);
  expect(result.outcome.accepted).toBe(true);
  const snapshot = await storageService.readCommittedSnapshot(f.user);
  expect(snapshot.causal).toBeTruthy(); expect(snapshot.generation).toBeGreaterThan(before.generation);
  expect(snapshot.pendingCount).toBe(1); expect(snapshot.meta.outbox).toEqual([]);
  expect(snapshot.values.tracking).toEqual({ ...f.tracking, focusSession: (result.tracking as any).focusSession });
  expect((snapshot.values.tracking as any).focusSession.phase).toBe('paused');
  expect((await storageService.admitFocusControl(f.user, control)).duplicate).toBe(true);
  expect(await storageService.readCommittedSnapshot(f.user)).toEqual(snapshot);
});
it('hydrates a causal new day as a retained request instead of resetting counters or duplicating it on reload', async () => {
  const f = await fixture();
  expect(await storageService.rolloverTrackingDay(f.user, '2026-09-09')).toEqual(f.tracking);
  const snapshot = await storageService.readCommittedSnapshot(f.user);
  expect(snapshot.causal?.daySelection?.requestedDay).toBe('2026-09-09');
  expect(snapshot.causal?.daySelection?.status).toBe('WAITING_BASELINE');
  expect(snapshot.pendingCount).toBe(1);
  await storageService.rolloverTrackingDay(f.user, '2026-09-09');
  expect(await storageService.readCommittedSnapshot(f.user)).toEqual(snapshot);
});

it('initializes a newly used account behind the global fence without inventing a server baseline', async () => {
  const f = await fixture(), user = crypto.randomUUID(), before = await f.read();
  const defaults = { date: '2026-09-08', planViewCount: 0, dailyPostponeCount: 0, focusSession: null, future: 'retained default' };
  const results = await Promise.all([
    storageService.initializeIfAbsent('tracking', user, defaults),
    storageService.initializeIfAbsent('tracking', user, { ...defaults, date: '2026-09-09' })
  ]);
  expect(results).toEqual([defaults, defaults]);
  const db = await openDB(f.name), state = await db.get(CAUSAL_STORE, user); db.close();
  expect(state.cutover.trackingPresent).toBe(false); expect(state.cutover.trackingValue).toBeUndefined();
  expect(state.trackingValue).toEqual(defaults); expect(state.localInitialization.trackingValue).toEqual(defaults);
  expect(state.counterBaselines).toBeUndefined();
  expect(state.counterDaySelection).toMatchObject({ requestedDay: defaults.date, status: 'WAITING_BASELINE' });
  expect(Object.keys(state.counterDayAdmissions)).toEqual([state.localInitialization.dayActionId]);
  const visit = await storageService.admitPlanningVisit(user, { schemaVersion: 1, actionId: crypto.randomUUID(), accountId: user,
    day: defaults.date, timeZone: 'UTC', capturedAt: '2026-09-08T10:00:00.000Z' });
  expect(visit.admission.effect.status).toBe('WAITING_BASELINE');
  expect(await storageService.get('tracking', user)).toEqual(defaults);
  expect(await f.read()).toEqual(before);
});

it('rolls back new-account authority, day intent and sync initialization if the tracking mirror fails', async () => {
  const f = await fixture(), user = crypto.randomUUID(), before = await f.read();
  const defaults = { date: '2026-09-08', planViewCount: 0, dailyPostponeCount: 0 };
  const add = IDBObjectStore.prototype.add;
  const spy = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function(this: IDBObjectStore, ...args) {
    if (this.name === 'tracking') throw new Error('Synthetic account initialization failure');
    return add.apply(this, args);
  });
  try { await expect(storageService.initializeIfAbsent('tracking', user, defaults)).rejects.toThrow('Synthetic'); } finally { spy.mockRestore(); }
  const db = await openDB(f.name);
  expect(await db.get(CAUSAL_STORE, user)).toBeUndefined(); expect(await db.get('tracking', user)).toBeUndefined();
  expect(await db.get(CAUSAL_BUSINESS_STORE, ['sync', user])).toBeUndefined(); db.close();
  expect(await f.read()).toEqual(before);
  expect(await storageService.initializeIfAbsent('tracking', user, defaults)).toEqual(defaults);
  const snapshot = await storageService.readCommittedSnapshot(user);
  expect(snapshot.pendingCount).toBe(1);
});

it('never treats retained mirrors, fallback evidence or imported legacy tracking as a new account', async () => {
  const f = await fixture(), defaults = { date: '2026-09-08', planViewCount: 0, dailyPostponeCount: 0 };
  const mirrorUser = crypto.randomUUID(), db = await openDB(f.name);
  await db.put('tracking', { causalAccountKey: mirrorUser, payload: { ...defaults, planViewCount: 27 } }); db.close();
  await expect(storageService.initializeIfAbsent('tracking', mirrorUser, defaults)).rejects.toThrow('explicit recovery');
  const fallbackUser = crypto.randomUUID(), key = `goalflow_fallback_tracking_${fallbackUser}`, raw = JSON.stringify({ ...defaults, planViewCount: 27 });
  f.values.set(key, raw);
  await expect(storageService.initializeIfAbsent('tracking', fallbackUser, defaults)).rejects.toThrow('explicit recovery');
  expect(f.values.get(key)).toBe(raw);
  const legacyUser = crypto.randomUUID();
  await expect(storageService.initializeIfAbsent('tracking', legacyUser, defaults, true)).rejects.toThrow('explicit recovery');
  const inspect = await openDB(f.name);
  for (const user of [mirrorUser, fallbackUser, legacyUser]) expect(await inspect.get(CAUSAL_STORE, user)).toBeUndefined();
  expect((await inspect.get('tracking', mirrorUser)).payload.planViewCount).toBe(27); inspect.close();
});

it('does not initialize recorded tracking absence or caller-supplied nonzero defaults', async () => {
  const f = await fixture(), db = await openDB(f.name), state = await db.get(CAUSAL_STORE, f.user);
  state.trackingPresent = false; state.trackingValue = undefined; await db.put(CAUSAL_STORE, state); db.close();
  const defaults = { date: '2026-09-08', planViewCount: 0, dailyPostponeCount: 0 };
  await expect(storageService.initializeIfAbsent('tracking', f.user, defaults)).rejects.toThrow('explicit recovery');
  await expect(storageService.initializeIfAbsent('tracking', crypto.randomUUID(), { ...defaults, planViewCount: 27 })).rejects.toThrow('explicit recovery');
  expect((await f.read()).state).toEqual(state);
});


it('treats an empty legacy lookup as a no-op but never rebinds retained source evidence', async () => {
  const f = await fixture(), before = await f.read(), source = 'unused@example.test';
  await storageService.migrateUserKey(source, f.user);
  expect(await f.read()).toEqual(before);
  const key = `goalflow_tasks_${source}`, raw = JSON.stringify([{ id: 'retained-legacy-task' }]);
  f.values.set(key, raw);
  await expect(storageService.migrateUserKey(source, f.user)).rejects.toThrow('cannot be rebound');
  expect(f.values.get(key)).toBe(raw); expect(await f.read()).toEqual(before);
  await expect(storageService.initializeIfAbsent('tasks', crypto.randomUUID(), [{ id: 'legacy' }], true)).rejects.toThrow('explicit recovery');
});
