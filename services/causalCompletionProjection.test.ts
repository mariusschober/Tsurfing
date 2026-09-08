import { fenceLegacyBusinessStores, causalBusinessTransactionStores, readCausalBusiness, writeCausalBusiness } from './causalBusinessStorage';
import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { IDBObjectStore } from 'fake-indexeddb';
import { afterEach, expect, it, vi } from 'vitest';
import { applyFocusCommand, initialFocusJournal, type FocusCommand } from '../src/domain/causalFocus';
import { CAUSAL_STORE, fenceLegacyTracking } from './causalStorage';
import { bindCausalCapability } from './causalEnrollment';
import { admitLocalCompletion, prepareCompletionRequest, commitCompletionReceipt, type CompletionIntent } from './causalCompletionCoordinator';
import { admitLocalFocus } from './causalFocusCoordinator';
import { applyDownloadedCausalHistory, replayCausalHistory } from './causalProjection';
import { causalHistoryHash } from './causalHistoryProtocol';
import { appendStagedTransactions, applyRemotePage, buildStagedLocalTransaction, emptySyncMeta, readyOutbox } from './syncProtocol';
import { STORES, storageService } from './storage';
import type { SavedCausalHistory } from './causalHistory';
import { validateCompletionApplicationEvidence } from './causalCompletionProjection';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const business = ['tasks', 'stats', 'progress', 'goals', 'habits', 'task_events', 'daily_plans'] as const;

async function fixture(fenced = false) {
  const accountId = crypto.randomUUID(), epoch = crypto.randomUUID(), sessionId = crypto.randomUUID();
  const tracking = { date: '2026-09-08', planViewCount: 27, dailyPostponeCount: 3, future: 'retained',
    focusSession: { schemaVersion: 1, sessionId, taskId: 'task', phase: 'active', plannedDurationSeconds: 600,
      startedAt: '2026-09-08T00:00:00.000Z', updatedAt: '2026-09-08T00:00:00.000Z', elapsedSeconds: 0, pausedAt: null, endedAt: null } };
  const collections: Record<string, any> = {
    tasks: [{ id: 'task', title: 'Synthetic F', description: 'Original F notes', completed: false, dateAssigned: '2026-09-08', goalId: 'goal', habitId: 'habit', isFrog: true, duration: 10, future: true },
      { id: 'other', title: 'Synthetic G', completed: false, dateAssigned: '2026-09-09' }],
    stats: { '2026-09-08': { tasksCompleted: 2, frogsEaten: 1, timeFocused: 7, totalBreakMinutes: 4, future: true } },
    progress: { level: 1, xp: 0, xpToNextLevel: 100, future: true }, goals: [{ id: 'goal', completedTasks: 2, future: true }],
    habits: [{ id: 'habit', streak: 3, bestStreak: 8, future: true }], task_events: [],
    daily_plans: [{ id: 'plan', localDate: '2026-09-08', confirmed: true, future: true }]
  };
  const baselineMeta = emptySyncMeta(); baselineMeta.cursor = 20;
  for (const [key, server] of Object.entries({ 'tasks:task': 10, 'tasks:other': 11, 'stats:singleton': 12, 'progress:singleton': 13,
    'goals:goal': 14, 'habits:habit': 15, 'tracking:singleton': 20 })) baselineMeta.versions[key] = { local: 1, server };
  const replica = async (empty = false) => {
    const name = `s2-completion-projection-${crypto.randomUUID()}`;
    const db = await openDB(name, 1, { upgrade(db) { for (const store of Object.values(STORES)) db.createObjectStore(store); } });
    for (const [store, value] of Object.entries(collections)) await db.put(store, empty
      ? store === 'stats' ? {} : store === 'progress' ? { level: 1, xp: 0, xpToNextLevel: 100 } : [] : value, accountId);
    await db.put('tracking', tracking, accountId); await db.put('sync', empty ? emptySyncMeta() : baselineMeta, accountId); db.close();
    (await fenceLegacyTracking(name)).close();
    if (fenced) (await fenceLegacyBusinessStores(name)).close();
    await bindCausalCapability(name, accountId, { schemaVersion: 2, accountId, enrolled: true, epoch, projectionRevision: 0, rolloutReady: false });
    return name;
  };
  const read = async (name: string) => {
    const db = await openDB(name), result: any = {};
    for (const store of [...business, 'tracking', 'sync', CAUSAL_STORE]) {
      const tx = db.transaction(causalBusinessTransactionStores(db, [store]));
      result[store] = store === 'tracking' || store === CAUSAL_STORE ? await tx.objectStore(store).get(accountId) : await readCausalBusiness(tx, store, accountId);
      await tx.done;
    }
    db.close(); return result;
  };
  const write = async (name: string, values: Record<string, any>) => {
    const db = await openDB(name), tx = db.transaction(causalBusinessTransactionStores(db, Object.keys(values)), 'readwrite');
    for (const [store, value] of Object.entries(values)) {
      if (store === CAUSAL_STORE) await tx.objectStore(store).put(value); else await writeCausalBusiness(tx, store, accountId, value);
    }
    await tx.done; db.close();
  };
  const record = (payload: any, serverVersion: number, version: number) => ({ user_id: accountId, entity_type: 'tracking', entity_id: 'singleton', payload,
    device_id: 'server', server_version: serverVersion, version, updated_at: '2026-09-08T00:05:00.000Z', deleted_at: null });
  const receipts: any[] = [{ schemaVersion: 2, epoch, projectionRevision: 0,
    baseline: { schemaVersion: 1, accountId, baselineId: epoch, day: tracking.date, counts: { planViewCount: 27, dailyPostponeCount: 3 }, evidenceIds: [epoch] },
    operation: { schemaVersion: 2, accountId, cutoverId: epoch, expectedTrackingServerVersion: 20, expectedTrackingPayload: tracking }, record: record(tracking, 20, 1) }];
  let journal = initialFocusJournal(accountId, tracking.focusSession), serverVersion = 20;
  const intent = (): CompletionIntent => ({ focus: { schemaVersion: 1, accountId, actorId: 'fixture', actionId: crypto.randomUUID(), kind: 'complete',
    sessionId, taskId: 'task', epoch: sessionId, expectedCurrentSessionId: sessionId, capturedAt: '2026-09-08T00:05:00.000Z', durationSeconds: null },
    details: { day: '2026-09-08', timeZone: 'UTC', finalDescription: '🧭'.repeat(12000), actualDuration: 5, flowState: 'flow' }, deviceId: 'fixture' });
  const complete = async (name: string, capture = intent()) => {
    await admitLocalCompletion(name, capture);
    const bytes = await prepareCompletionRequest(name, accountId, capture.focus.actionId), operation = JSON.parse(bytes);
    const transition = applyFocusCommand(journal, operation.command); journal = transition.journal;
    const changes = transition.outcome.accepted ? operation.changes.map((member: any) => ({ mutationId: member.mutationId, accepted: true, serverVersion: ++serverVersion,
      record: { user_id: accountId, entity_type: member.entityType, entity_id: member.entityId, payload: member.payload, version: member.version,
        server_version: serverVersion, device_id: member.deviceId, updated_at: member.updatedAt, deleted_at: null } })) : [];
    const receipt = { schemaVersion: 2, epoch, projectionRevision: receipts.length, operation, accepted: transition.outcome.accepted, outcome: transition.outcome,
      changes, record: transition.outcome.accepted ? record({ ...tracking, focusSession: journal.sessions[journal.currentSessionId!].projection }, ++serverVersion, receipts.length + 1) : receipts.at(-1).record };
    receipts.push(receipt); return { capture, bytes, receipt };
  };
  const focus = (command: FocusCommand) => {
    const result = applyFocusCommand(journal, command); journal = result.journal;
    const receipt = { schemaVersion: 2, epoch, projectionRevision: receipts.length, operation: { schemaVersion: 2, epoch, type: 'focus', command },
      accepted: result.outcome.accepted, outcome: result.outcome,
      record: record({ ...tracking, focusSession: journal.sessions[journal.currentSessionId!].projection }, ++serverVersion, receipts.length + 1) };
    receipts.push(receipt); return receipt;
  };
  const save = async (name: string, throughRevision = receipts.length - 1) => {
    await bindCausalCapability(name, accountId, { schemaVersion: 2, accountId, enrolled: true, epoch, projectionRevision: throughRevision, rolloutReady: false });
    const history: SavedCausalHistory = { schemaVersion: 1, epoch, throughRevision, downloadedRevision: throughRevision, entries: {} };
    for (let revision = 0; revision <= throughRevision; revision++) {
      const body = JSON.stringify({ schemaVersion: 2, accountId, epoch, revision, receipt: receipts[revision] });
      history.entries[String(revision)] = { body, sha256: await causalHistoryHash(new TextEncoder().encode(body)) };
    }
    const state = (await read(name))[CAUSAL_STORE]; state.causalHistory = history; await write(name, { [CAUSAL_STORE]: state }); return history;
  };
  return { accountId, epoch, sessionId, tracking, collections, replica, read, write, receipts, intent, complete, focus, save };
}

it.each([false, true])('applies remote notes, all six effects and completed focus atomically, retaining preimages and planning (business fence %s)', async fenced => {
  const f = await fixture(fenced), source = await f.replica(), target = await f.replica(), before = await f.read(target);
  const completed = await f.complete(source); const history = await f.save(target);
  expect(replayCausalHistory(f.accountId, history).focus.sessions[f.sessionId].projection.phase).toBe('completed');
  expect((await applyDownloadedCausalHistory(target, f.accountId)).blocked).toBe(false);
  const after = await f.read(target), original = await f.read(source);
  for (const store of business) expect(after[store]).toEqual(original[store]);
  expect(after[CAUSAL_STORE].trackingValue).toMatchObject({ planViewCount: 27, dailyPostponeCount: 3, focusSession: { phase: 'completed' } });
  expect(after.sync.cursor).toBe(before.sync.cursor);
  expect(after[CAUSAL_STORE].completionApplications[completed.capture.focus.actionId].preimages['tasks:task']).toEqual(before.tasks[0]);
  expect(after[CAUSAL_STORE].completionRequests).toBeUndefined();
  expect(after[CAUSAL_STORE].completionReceipts).toBeUndefined(); // Remote evidence never impersonates a local attempt.
  expect((await applyDownloadedCausalHistory(target, f.accountId)).duplicate).toBe(true);
  expect(await f.read(target)).toEqual(after);
});

it.each(['stats', 'sync', CAUSAL_STORE, 'tracking'])('rolls back every completion effect and projection when %s fails', async failed => {
  const f = await fixture(), source = await f.replica(), target = await f.replica();
  await f.complete(source); await f.save(target); const before = await f.read(target);
  const put = IDBObjectStore.prototype.put;
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function(this: IDBObjectStore, ...args) {
    if (this.name === failed) throw new Error('Synthetic application failure');
    return put.apply(this, args);
  });
  await expect(applyDownloadedCausalHistory(target, f.accountId)).rejects.toThrow('Synthetic application failure');
  vi.restoreAllMocks(); expect(await f.read(target)).toEqual(before);
  expect((await applyDownloadedCausalHistory(target, f.accountId)).blocked).toBe(false);
});

it.each([false, true])('recovers a lost local response from exact history without rewinding newer notes or session G (business fence %s)', async fenced => {
  const f = await fixture(fenced), source = await f.replica(), completed = await f.complete(source);
  const current = await f.read(source), edited = structuredClone(current.tasks); edited[0].description = 'Newer retained local notes';
  const action = buildStagedLocalTransaction('tasks', f.accountId, current.tasks, edited, 1, '2026-09-08T00:06:00.000Z', () => crypto.randomUUID())!;
  await f.write(source, { tasks: edited, sync: appendStagedTransactions(current.sync, [action], 'fixture') });
  const startId = crypto.randomUUID(), newSession = crypto.randomUUID();
  await admitLocalFocus(source, { ...completed.capture.focus, actionId: startId, sessionId: newSession, taskId: 'other', epoch: startId, kind: 'start', durationSeconds: 600 });
  await f.save(source);
  expect((await applyDownloadedCausalHistory(source, f.accountId)).blocked).toBe(false);
  const after = await f.read(source), id = completed.capture.focus.actionId;
  expect(after.tasks[0].description).toBe('Newer retained local notes');
  expect(after[CAUSAL_STORE].trackingValue.focusSession.sessionId).toBe(newSession);
  expect(after[CAUSAL_STORE].completionRequests[id]).toBe(completed.bytes);
  expect(after[CAUSAL_STORE].completionReceipts[id]).toEqual(completed.receipt);
  expect(after[CAUSAL_STORE].completionOutbox[id]).toBeUndefined();
  expect(Object.keys(after.sync.localState.completionReservations)).toHaveLength(0);
  expect(readyOutbox(after.sync)[0].baseServerVersion).toBe(completed.receipt.changes[0].serverVersion);
  expect(after.sync.cursor).toBe(20);
});

it('does not manufacture an attempted request when a restored admission sees its accepted peer history', async () => {
  const f = await fixture(), source = await f.replica(), restored = await f.replica(), intent = f.intent();
  await admitLocalCompletion(restored, intent); const completed = await f.complete(source, intent);
  await f.save(restored); expect((await applyDownloadedCausalHistory(restored, f.accountId)).blocked).toBe(false);
  const before = await f.read(restored);
  expect(before[CAUSAL_STORE].completionRequests).toBeUndefined();
  expect(before[CAUSAL_STORE].completionOutbox[intent.focus.actionId]).toBeDefined();
  expect(Object.keys(before.sync.localState.completionReservations)).toHaveLength(6);
  const bytes = await prepareCompletionRequest(restored, f.accountId, intent.focus.actionId);
  expect(bytes).toBe(completed.bytes);
  await commitCompletionReceipt(restored, f.accountId, intent.focus.actionId, completed.receipt);
  const after = await f.read(restored);
  expect(after.tasks).toEqual(before.tasks); expect(after.stats).toEqual(before.stats);
  expect(Object.keys(after.sync.localState.completionReservations)).toHaveLength(0);
});

it('replays interleaved pending completion/start/completion by parents while preserving all local effects', async () => {
  const f = await fixture(), source = await f.replica(), first = f.intent();
  await admitLocalCompletion(source, first);
  const startId = crypto.randomUUID(), sessionId = crypto.randomUUID();
  await admitLocalFocus(source, { ...first.focus, actionId: startId, sessionId, taskId: 'other', epoch: startId, kind: 'start', durationSeconds: 600 });
  const second = f.intent(); second.focus = { ...second.focus, sessionId, taskId: 'other', epoch: startId, expectedCurrentSessionId: sessionId };
  await admitLocalCompletion(source, second); const before = await f.read(source);
  await f.save(source, 0); expect((await applyDownloadedCausalHistory(source, f.accountId)).blocked).toBe(false);
  const after = await f.read(source);
  for (const store of business) expect(after[store]).toEqual(before[store]);
  expect(after[CAUSAL_STORE].trackingValue.focusSession).toEqual(before[CAUSAL_STORE].trackingValue.focusSession);
  expect(after[CAUSAL_STORE].trackingValue.focusSession.phase).toBe('completed');
  expect(after[CAUSAL_STORE].trackingValue.focusSession.sessionId).toBe(sessionId);
  expect(Object.keys(after[CAUSAL_STORE].completionOutbox)).toHaveLength(2);
});

it('keeps completed F terminal after server starts G and a stale local F pause arrives', async () => {
  const f = await fixture(), source = await f.replica(), target = await f.replica(), completion = await f.complete(source);
  const startId = crypto.randomUUID(), sessionId = crypto.randomUUID();
  f.focus({ ...completion.receipt.operation.command, actionId: startId, sessionId, taskId: 'other', epoch: startId, kind: 'start', durationSeconds: 600,
    expectedRevision: completion.capture.focus.actionId });
  const pause = await admitLocalFocus(target, { ...f.intent().focus, kind: 'pause' });
  await f.save(target); const result = await applyDownloadedCausalHistory(target, f.accountId);
  expect(result.blocked).toBe(false); expect(result.reviews[pause.command.actionId].code).toBe('STALE_TARGET');
  const after = await f.read(target);
  expect(after[CAUSAL_STORE].trackingValue.focusSession.sessionId).toBe(sessionId);
  expect(after[CAUSAL_STORE].focus.sessions[f.sessionId].projection.phase).toBe('completed');
  expect(after.tasks[0].completed).toBe(true);
});

it('retains a durable review for missing base evidence and resumes once that base is installed', async () => {
  const f = await fixture(), source = await f.replica(), target = await f.replica(), completion = await f.complete(source);
  const current = await f.read(target); current.sync.versions['stats:singleton'].server = null; current.sync.cursor = 0;
  await f.write(target, { sync: current.sync }); await f.save(target); const before = await f.read(target);
  const blocked = await applyDownloadedCausalHistory(target, f.accountId);
  expect(blocked.blocked).toBe(true); expect(blocked.reviews[completion.capture.focus.actionId].code).toBe('COMPLETION_BASE_REQUIRED');
  const reviewed = await f.read(target);
  for (const store of [...business, 'tracking', 'sync']) expect(reviewed[store]).toEqual(before[store]);
  expect(reviewed[CAUSAL_STORE].causalProjection).toBeUndefined();
  expect(Object.keys(reviewed[CAUSAL_STORE].completionApplicationReviews)).toHaveLength(1);
  expect((await applyDownloadedCausalHistory(target, f.accountId)).duplicate).toBe(true);
  const base = applyRemotePage(reviewed.sync, { stats: reviewed.stats }, [{ entityType: 'stats', entityId: 'singleton', version: 1, serverVersion: 12,
    deviceId: 'fixture', payload: f.collections.stats }], 12, 'consumer', '2026-09-08T00:06:00.000Z');
  await f.write(target, { stats: base.values.stats, sync: base.meta });
  expect((await applyDownloadedCausalHistory(target, f.accountId)).blocked).toBe(false);
  const after = await f.read(target); expect(after.sync.cursor).toBe(12);
  expect(after[CAUSAL_STORE].causalProjectionReviewHistory[completion.capture.focus.actionId]).toContain('COMPLETION_BASE_REQUIRED');
  expect(after[CAUSAL_STORE].causalProjectionReviews[completion.capture.focus.actionId]).toBeUndefined();
});

it('hydrates an empty replica from complete receipts without requiring discarded intermediate snapshots', async () => {
  const f = await fixture(), source = await f.replica(), empty = await f.replica(true);
  const completion = await f.complete(source); await f.save(empty);
  expect((await applyDownloadedCausalHistory(empty, f.accountId)).blocked).toBe(false);
  const after = await f.read(empty);
  expect(after.tasks).toHaveLength(1); expect(after.tasks[0].description).toBe(completion.capture.details.finalDescription);
  expect(after.tasks[0].completed).toBe(true); expect(after.task_events).toHaveLength(1);
  expect(after.stats['2026-09-08'].tasksCompleted).toBe(3); expect(after.sync.cursor).toBe(0);
  expect(after.daily_plans).toEqual([]);
});

it('catches up a versioned replica across intermediate record versions from the authoritative receipt', async () => {
  const f = await fixture(), source = await f.replica(), target = await f.replica(); await f.complete(source);
  const prior = await f.read(target); prior.sync.versions['stats:singleton'].server = 5;
  await f.write(target, { sync: prior.sync }); await f.save(target);
  expect((await applyDownloadedCausalHistory(target, f.accountId)).blocked).toBe(false);
  const after = await f.read(target); expect(after.stats['2026-09-08'].tasksCompleted).toBe(3); expect(after.sync.cursor).toBe(20);
});

it('does not overwrite a local edit admitted while history hashes are being verified', async () => {
  const f = await fixture(), source = await f.replica(), target = await f.replica(); await f.complete(source); await f.save(target);
  const original = crypto.subtle.digest.bind(crypto.subtle);
  let release!: () => void, entered!: () => void, once = true;
  const ready = new Promise<void>(resolve => { entered = resolve; }), resume = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (...args) => {
    if (once) { once = false; entered(); await resume; } return original(...args);
  });
  const application = applyDownloadedCausalHistory(target, f.accountId); await ready;
  const before = await f.read(target), edited = structuredClone(before.tasks); edited[0].description = 'Concurrent retained draft';
  const change = buildStagedLocalTransaction('tasks', f.accountId, before.tasks, edited, 1, '2026-09-08T00:06:00.000Z', () => crypto.randomUUID())!;
  await f.write(target, { tasks: edited, sync: appendStagedTransactions(before.sync, [change], 'consumer') });
  release(); const result = await application;
  expect(result.blocked).toBe(true);
  const after = await f.read(target);
  expect(after.tasks).toEqual(edited); expect(after.sync.outbox).toHaveLength(1);
  expect(after[CAUSAL_STORE].trackingValue.focusSession.phase).toBe('active');
  expect(after[CAUSAL_STORE].causalProjection).toBeUndefined();
});

it.each([false, true])('round-trips applied completion evidence through actual restore (business fence %s)', async fenced => {
  const f = await fixture(fenced), source = await f.replica(), target = await f.replica(); await f.complete(source); await f.save(target);
  await applyDownloadedCausalHistory(target, f.accountId);
  const values = new Map<string, string>([['goalflow_active_database_v2', target]]);
  const localStorage = { get length() { return values.size; }, key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  vi.stubGlobal('window', { localStorage, dispatchEvent: () => true }); vi.stubGlobal('localStorage', localStorage);
  const backup = await storageService.exportBackup(f.accountId), restored = `s2-completion-restored-${crypto.randomUUID()}`;
  values.set('goalflow_active_database_v2', restored);
  await storageService.importBackup(f.accountId, JSON.parse(JSON.stringify(backup)));
  const before = await f.read(restored);
  const invalid = structuredClone(before[CAUSAL_STORE]); Object.values(invalid.completionApplications as Record<string, any>)[0].sha256 = '0'.repeat(64);
  await expect(validateCompletionApplicationEvidence(f.accountId, invalid)).rejects.toThrow('history proof');
  expect((await applyDownloadedCausalHistory(restored, f.accountId)).duplicate).toBe(true);
  expect(await f.read(restored)).toEqual(before);
});

it('retains rejected local completion notes and effects with a durable causal review', async () => {
  const f = await fixture(), source = await f.replica(), pauseId = crypto.randomUUID();
  f.focus({ ...f.intent().focus, kind: 'pause', actionId: pauseId, expectedRevision: f.sessionId } as FocusCommand);
  const completion = await f.complete(source); expect(completion.receipt.accepted).toBe(false);
  await f.save(source); const before = await f.read(source);
  const result = await applyDownloadedCausalHistory(source, f.accountId);
  expect(result.blocked).toBe(true); expect(result.reviews[completion.capture.focus.actionId].code).toBe('COMPLETION_REJECTED');
  const after = await f.read(source);
  for (const store of [...business, 'tracking', 'sync']) expect(after[store]).toEqual(before[store]);
  expect(after[CAUSAL_STORE].causalHistory).toEqual(before[CAUSAL_STORE].causalHistory);
  expect(after[CAUSAL_STORE].completionOutbox[completion.capture.focus.actionId]).toBeDefined();
  await expect(validateCompletionApplicationEvidence(f.accountId, after[CAUSAL_STORE])).resolves.toBeUndefined();
});
