import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { afterEach, expect, it, vi } from 'vitest';
import { storageService, STORES } from './storage';
import { isPermanentSyncFailure, synchronizeCloudOnce } from './cloudSync';
import { CAUSAL_STORE, fenceLegacyTracking } from './causalStorage';
import { admitLocalCounter } from './causalCounterCoordinator';
import { admitLocalFocus } from './causalFocusCoordinator';
import { initialFocusJournal, applyFocusCommand } from '../src/domain/causalFocus';
import { projectCounters, type CounterDelta } from '../src/domain/counterLedger';
import { causalHistoryHash } from './causalHistoryProtocol';
import { emptySyncMeta, normalizeSyncMeta } from './syncProtocol';
import { IDBObjectStore } from 'fake-indexeddb';
import { encodeCausalBackup, readCausalBackup } from './causalBackup';
afterEach(() => { vi.unstubAllGlobals(); });

async function fixture(enrolled = true, emptyLocal = false, serverAbsent = false) {
  const accountId = crypto.randomUUID(), sessionId = crypto.randomUUID(), name = 's2-cloud-' + crypto.randomUUID();
  let epoch = crypto.randomUUID();
  const values = new Map<string, string>([['goalflow_active_database_v2', name]]);
  const localStorage = { get length() { return values.size; }, key: (i: number) => [...values.keys()][i] ?? null,
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  vi.stubGlobal('window', { localStorage, dispatchEvent: () => true }); vi.stubGlobal('localStorage', localStorage);
  const tracking = { date: '2026-09-08', planViewCount: 27, dailyPostponeCount: 3, unknown: 'retained', focusSession: {
    schemaVersion: 1, sessionId, taskId: 'task', phase: 'active', plannedDurationSeconds: 600,
    startedAt: '2026-09-08T09:00:00.000Z', updatedAt: '2026-09-08T09:00:00.000Z', elapsedSeconds: 0, pausedAt: null, endedAt: null } };
  const baseline = { schemaVersion: 1 as const, baselineId: epoch, accountId, day: tracking.date, counts: { planViewCount: 27, dailyPostponeCount: 3 }, evidenceIds: [epoch] };
  const db = await openDB(name, 1, { upgrade(db) { for (const store of Object.values(STORES)) db.createObjectStore(store); } });
  if (!emptyLocal) await db.put('tracking', tracking, accountId);
  if (!emptyLocal) await db.put('tasks', [{ id: 'task', title: 'Synthetic', completed: false }], accountId);
  const initialMeta = emptySyncMeta();
  if (!enrolled) initialMeta.versions['tracking:singleton'] = { local: 1, server: 1 };
  if (!emptyLocal) await db.put('sync', initialMeta, accountId);
  db.close(); (await fenceLegacyTracking(name)).close();
  if (emptyLocal) await storageService.initializeIfAbsent('tracking', accountId,
    { date: tracking.date, planViewCount: 0, dailyPostponeCount: 0, focusSession: null, localDefault: 'retained' });
  const record = (payload: unknown, revision: number) => ({ user_id: accountId, entity_type: 'tracking', entity_id: 'singleton',
    version: revision + 1, server_version: revision + 1, device_id: 'causal-v2', updated_at: '2026-09-08T10:00:00.000Z', deleted_at: null, payload });
  const receipts: any[] = [{ schemaVersion: 2, epoch, projectionRevision: 0, baseline,
    operation: { schemaVersion: 2, accountId, cutoverId: epoch, expectedTrackingServerVersion: 1, expectedTrackingPayload: tracking }, record: record(tracking, 0) }];
  let serverTracking: any = structuredClone(tracking), journal = initialFocusJournal(accountId, tracking.focusSession);
  const events: CounterDelta[] = [], requests: string[] = [];
  let loseResponse = false;
  let loseEnrollmentResponse = false;
  let initializationReceipt: any;
  let peerInitializationWins = false;
  let unverifiedPull = false;
  let beforePull: (() => Promise<void>) | undefined;
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'https://fixture.invalid');
    if (url.pathname.endsWith('/causal-capability')) return Response.json({ schemaVersion: 2, accountId, enrolled,
      epoch: enrolled ? epoch : null, projectionRevision: enrolled ? receipts.length - 1 : null, rolloutReady: false });
    if (url.pathname.endsWith('/causal-initialize')) {
      const submitted = JSON.parse(String(init?.body));
      const peerWon = peerInitializationWins; peerInitializationWins = false;
      const operation = peerWon ? { ...submitted, initializationId: crypto.randomUUID() } : submitted;
      if (initializationReceipt) {
        expect(operation).toEqual(initializationReceipt.operation);
        return Response.json(initializationReceipt);
      }
      expect(operation.initialTracking.planViewCount).toBe(0);
      epoch = operation.initializationId; enrolled = true;
      if (serverAbsent) {
        serverTracking = structuredClone(operation.initialTracking);
        journal = initialFocusJournal(accountId, serverTracking.focusSession);
        baseline.counts = { planViewCount: 0, dailyPostponeCount: 0 };
      }
      baseline.baselineId = epoch; baseline.evidenceIds = [epoch];
      receipts[0] = { schemaVersion: 2, epoch, projectionRevision: 0, baseline,
        operation: { schemaVersion: 2, accountId, cutoverId: epoch, expectedTrackingServerVersion: 1, expectedTrackingPayload: serverTracking },
        record: { ...record(structuredClone(serverTracking), 0), device_id: serverAbsent ? 'causal-initialization-v2' : 'causal-v2' } };
      initializationReceipt = structuredClone({ schemaVersion: 2, type: 'initialization', operation, created: serverAbsent, cutoverReceipt: receipts[0] });
      if (peerWon) return Response.json({ error: { code: 'causal_initialization_review_required' } }, { status: 409 });
      if (loseEnrollmentResponse) { loseEnrollmentResponse = false; throw new Error('Synthetic lost initialization response'); }
      return Response.json(initializationReceipt);
    }
    if (url.pathname.endsWith('/causal-cutover')) {
      const operation = JSON.parse(String(init?.body));
      expect(operation.expectedTrackingPayload).toEqual(tracking);
      expect(operation.expectedTrackingServerVersion).toBe(1);
      epoch = operation.cutoverId; enrolled = true;
      baseline.baselineId = epoch; baseline.evidenceIds = [epoch];
      receipts[0] = { ...receipts[0], operation, epoch, baseline };
      if (loseEnrollmentResponse) { loseEnrollmentResponse = false; throw new Error('Synthetic lost enrollment response'); }
      return Response.json(receipts[0]);
    }
    if (url.pathname.endsWith('/causal-history')) {
      const revision = Number(url.searchParams.get('revision')), throughRevision = Number(url.searchParams.get('throughRevision'));
      const body = JSON.stringify({ schemaVersion: 2, accountId, epoch, revision, receipt: receipts[revision] });
      const bytes = new TextEncoder().encode(body), hash = await causalHistoryHash(bytes);
      return Response.json({ schemaVersion: 2, accountId, epoch, revision, throughRevision, offset: 0, totalBytes: bytes.length,
        sha256: hash, chunkSha256: hash, data: btoa(String.fromCharCode(...bytes)), nextOffset: null });
    }
    if (url.pathname.endsWith('/actions')) {
      const bytes = String(init?.body); requests.push(bytes); const operation = JSON.parse(bytes), command = operation.command;
      const existing = receipts.find(receipt => receipt.operation.command?.actionId === command.actionId);
      if (existing) return Response.json(existing);
      let outcome: unknown;
      if (operation.type === 'counter') {
        events.push(command); const counts = projectCounters(baseline, events); serverTracking = { ...serverTracking, ...counts };
        outcome = { accepted: true, code: 'APPLIED', day: command.day, counts };
      } else if (operation.type === 'counterDay') {
        expect(command.day).toBe(baseline.day);
        outcome = undefined;
      } else {
        const result = applyFocusCommand(journal, command); journal = result.journal; outcome = result.outcome;
        serverTracking = { ...serverTracking, focusSession: journal.sessions[journal.currentSessionId!].projection };
      }
      const receipt = { schemaVersion: 2, epoch, operation, projectionRevision: receipts.length, accepted: true,
        ...(operation.type === 'counterDay' ? { baseline, counts: projectCounters(baseline, events) } : { outcome }),
        record: record(structuredClone(serverTracking), receipts.length) };
      receipts.push(receipt);
      if (loseResponse) { loseResponse = false; throw new TypeError('Synthetic lost receipt'); }
      return Response.json(receipt);
    }
    if (url.pathname.endsWith('/pull')) {
      const callback = beforePull; beforePull = undefined; await callback?.();
      const cursor = Number(url.searchParams.get('cursor')), version = receipts.length;
      return Response.json({ records: cursor < version ? [{ entityType: 'tracking', entityId: 'singleton', version, serverVersion: version,
        deviceId: 'causal-v2', updatedAt: '2026-09-08T10:00:00.000Z', deletedAt: null, payload: unverifiedPull ? { ...serverTracking, planViewCount: 99 } : serverTracking }] : [], nextCursor: Math.max(cursor, version), hasMore: false });
    }
    if (url.pathname.endsWith('/conflicts/page')) return Response.json({ conflicts: [], nextAfter: null, hasMore: false });
    throw new Error('Unexpected synthetic request ' + url.pathname);
  };
  const event: CounterDelta = { schemaVersion: 1, actionId: crypto.randomUUID(), accountId, actorId: 'tab', day: tracking.date,
    timeZone: 'UTC', capturedAt: '2026-09-08T10:00:00.000Z', counter: 'planViewCount', delta: 1, businessActionId: null, correctionOf: null };
  const run = () => synchronizeCloudOnce(accountId, { fetch, isOnline: () => true, now: () => new Date(), deviceId: () => 'local', maxAttempts: 1 }, { seedLocalData: false });
  return { accountId, name, epoch, sessionId, tracking, baseline, event, requests, run, unverified: () => { unverifiedPull = true; }, onPull: (callback: () => Promise<void>) => { beforePull = callback; },
    loseEnrollment: () => { loseEnrollmentResponse = true; },
    peerEnrollment: () => { peerInitializationWins = true; },
    peerIncrement: () => fetch('/api/v1/sync/actions', { method: 'POST', body: JSON.stringify({ schemaVersion: 2, epoch, type: 'counter',
      command: { ...event, actionId: crypto.randomUUID(), actorId: 'peer' } }) }).then(() => undefined), lose: () => { loseResponse = true; } };
}

it.each([[false, false], [false, true], [true, false], [true, true]])(
  'initializes unenrolled server state without inventing pending counts (absent: %s, lost response: %s)', async (absent, lost) => {
    const f = await fixture(false, true, absent);
    await admitLocalCounter(f.name, f.event);
    const db = await openDB(f.name), before = await db.get(CAUSAL_STORE, f.accountId);
    if (lost) {
      f.loseEnrollment();
      await expect(f.run()).rejects.toThrow('Synthetic lost initialization');
    }
    const meta = await f.run(), after = await db.get(CAUSAL_STORE, f.accountId);
    expect(after.cutover).toEqual(before.cutover);
    expect(after.localInitialization).toEqual(before.localInitialization);
    expect(after.serverInitializationReceipt.operation).toEqual(JSON.parse(after.serverInitializationRequest));
    expect(after.serverInitializationReceipt.created).toBe(absent);
    expect(after.trackingValue.planViewCount).toBe(absent ? 1 : 28);
    expect(after.trackingValue.dailyPostponeCount).toBe(absent ? 0 : 3);
    expect(after.trackingValue.focusSession).toEqual(absent ? null : f.tracking.focusSession);
    expect(after.counterEvents[f.event.actionId]).toEqual(f.event);
    expect(after.counterOutbox).toEqual({}); expect(after.counterDayOutbox).toEqual({});
    expect(meta.cursor).toBe(3);
    await f.run(); expect(f.requests).toHaveLength(2);
    db.close();
  });

it('recovers an initialization receipt write failure and validates its backup evidence', async () => {
  const f = await fixture(false, true, true);
  await admitLocalCounter(f.name, f.event);
  const put = IDBObjectStore.prototype.put;
  const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function(this: IDBObjectStore, ...args) {
    if (this.name === CAUSAL_STORE && args[0]?.serverInitializationReceipt) throw new Error('Synthetic initialization receipt failure');
    return put.apply(this, args);
  });
  try { await expect(f.run()).rejects.toThrow('Synthetic initialization receipt failure'); }
  finally { spy.mockRestore(); }
  const db = await openDB(f.name), interrupted = await db.get(CAUSAL_STORE, f.accountId);
  expect(interrupted.serverInitializationReceipt).toBeUndefined();
  expect(interrupted.counterOutbox[f.event.actionId]).toEqual(f.event);
  await f.run();
  const state = await db.get(CAUSAL_STORE, f.accountId);
  expect(state.serverInitializationRequest).toBe(interrupted.serverInitializationRequest);
  expect(state.trackingValue.planViewCount).toBe(1);
  const evidence = { authority: state, trackingMirror: await db.get('tracking', f.accountId),
    sync: await storageService.get('sync', f.accountId), captures: {} };
  const backup = () => ({ schemaVersion: 1, encoded: encodeCausalBackup(evidence) });
  expect(readCausalBackup(f.accountId, backup()).authority.serverInitializationReceipt).toEqual(state.serverInitializationReceipt);
  evidence.authority.serverInitializationReceipt.operation.initialTracking.planViewCount = 1;
  expect(() => readCausalBackup(f.accountId, backup())).toThrow();
  db.close();
});

it('retains a competing initialization attempt while joining the winning verified epoch', async () => {
  const f = await fixture(false, true, true);
  await admitLocalCounter(f.name, f.event); f.peerEnrollment();
  await expect(f.run()).rejects.toThrow();
  const db = await openDB(f.name), before = await db.get(CAUSAL_STORE, f.accountId);
  await f.run();
  const after = await db.get(CAUSAL_STORE, f.accountId);
  expect(after.serverInitializationRequest).toBe(before.serverInitializationRequest);
  expect(after.serverInitializationReceipt).toBeUndefined();
  expect(JSON.parse(after.serverInitializationRequest).initializationId).not.toBe(after.causalHistory.epoch);
  expect(after.localInitializationHistory.body).toBe(after.causalHistory.entries['0'].body);
  expect(after.trackingValue.planViewCount).toBe(1);
  expect(after.counterEvents[f.event.actionId]).toEqual(f.event);
  expect(after.counterOutbox).toEqual({});
  db.close();
});

it('joins enrolled history from preserved local absence before sending a queued increment', async () => {
  const f = await fixture(true, true);
  await admitLocalCounter(f.name, f.event);
  const db = await openDB(f.name), before = await db.get(CAUSAL_STORE, f.accountId);
  expect(before.counterBaselines).toBeUndefined();
  const meta = await f.run(), after = await db.get(CAUSAL_STORE, f.accountId);
  expect(after.cutover).toEqual(before.cutover);
  expect(after.localInitialization).toEqual(before.localInitialization);
  expect(after.localInitializationHistory.body).toBe(after.causalHistory.entries['0'].body);
  expect(after.localInitialization.trackingValue.localDefault).toBe('retained');
  expect(after.trackingValue).toMatchObject({ planViewCount: 28, dailyPostponeCount: 3, unknown: 'retained', focusSession: f.tracking.focusSession });
  expect(after.counterEvents[f.event.actionId]).toEqual(f.event);
  expect(after.counterOutbox).toEqual({}); expect(after.counterDayOutbox).toEqual({});
  expect(meta.cursor).toBe(3);
  await f.run(); expect(f.requests).toHaveLength(2);
  db.close();
});

it.each(['counts', 'day', 'absence'])('rejects inconsistent local initialization evidence (%s)', async field => {
  const f = await fixture(true, true), db = await openDB(f.name);
  const damaged = await db.get(CAUSAL_STORE, f.accountId);
  if (field === 'counts') damaged.localInitialization.trackingValue.planViewCount = 1;
  if (field === 'day') damaged.localInitialization.trackingValue.date = '2026-09-09';
  if (field === 'absence') damaged.cutover.trackingPresent = true;
  await db.put(CAUSAL_STORE, damaged);
  await expect(f.run()).rejects.toThrow(/initial/i);
  expect(await db.get(CAUSAL_STORE, f.accountId)).toEqual(damaged);
  expect(f.requests).toHaveLength(0);
  db.close();
});

it.each([false, true])('enrolls the preserved baseline before sending a pending increment (lost response: %s)', async lost => {
  const f = await fixture(false);
  const originalBaseline = structuredClone(f.baseline);
  await admitLocalCounter(f.name, f.event, f.baseline);
  if (lost) {
    f.loseEnrollment();
    await expect(f.run()).rejects.toThrow('Synthetic lost enrollment');
  }
  const meta = await f.run();
  const db = await openDB(f.name); const state = await db.get(CAUSAL_STORE, f.accountId); db.close();
  expect(JSON.parse(state.cutoverRequest).expectedTrackingPayload.planViewCount).toBe(27);
  expect(state.cutoverReceipt.operation).toEqual(JSON.parse(state.cutoverRequest));
  expect(state.counterBaselineBindings[f.event.day].original).toEqual(originalBaseline);
  expect(state.counterBaselineBindings[f.event.day].canonical).toEqual(state.cutoverReceipt.baseline);
  expect(state.trackingValue.planViewCount).toBe(28);
  expect(Object.keys(state.counterOutbox)).toHaveLength(0);
  expect(f.requests).toHaveLength(1);
  expect(meta.cursor).toBe(2);
});

it('retains unknown baseline evidence and rejects replay of its historical identities after enrollment', async () => {
  const f = await fixture(false);
  const historicalId = crypto.randomUUID();
  const original = { ...structuredClone(f.baseline), evidenceIds: [historicalId], audit: { source: 'preserved fixture' } };
  await admitLocalCounter(f.name, f.event, original);
  await f.run();
  const db = await openDB(f.name);
  const before = await db.get(CAUSAL_STORE, f.accountId);
  expect(before.counterBaselineBindings[f.event.day].original).toEqual(original);
  await expect(admitLocalCounter(f.name, { ...f.event, actionId: historicalId })).rejects.toThrow('Historical baseline evidence');
  expect(await db.get(CAUSAL_STORE, f.accountId)).toEqual(before);
  const damaged = structuredClone(before);
  damaged.counterBaselineBindings[f.event.day].original.counts.planViewCount++;
  await db.put(CAUSAL_STORE, damaged);
  await expect(f.run()).rejects.toThrow('baseline binding differs');
  expect(await db.get(CAUSAL_STORE, f.accountId)).toEqual(damaged);
  db.close();
});

it('sends saved focus parents and counters through the actual cloud loop and applies the ordinary tracking row', async () => {
  const f = await fixture();
  await admitLocalCounter(f.name, f.event, f.baseline);
  for (const durationSeconds of [300, 120]) await admitLocalFocus(f.name, { schemaVersion: 1, actionId: crypto.randomUUID(), accountId: f.accountId,
    actorId: 'tab', kind: 'extend', sessionId: f.sessionId, taskId: 'task', epoch: f.sessionId, expectedCurrentSessionId: f.sessionId,
    durationSeconds, capturedAt: '2026-09-08T10:00:00.000Z' });
  const meta = await f.run(); const db = await openDB(f.name); const state = await db.get(CAUSAL_STORE, f.accountId); db.close();
  expect(state.trackingValue.planViewCount).toBe(28); expect(state.trackingValue.focusSession.plannedDurationSeconds).toBe(1020);
  expect(Object.keys(state.focusOutbox)).toHaveLength(0); expect(Object.keys(state.counterOutbox)).toHaveLength(0);
  expect(f.requests.map(raw => JSON.parse(raw).command.durationSeconds).filter(Boolean)).toEqual([300, 120]);
  expect(meta.cursor).toBe(4); expect(meta.lastSuccessfulSync).toBeTruthy();
  await f.run(); expect(f.requests).toHaveLength(3);
});

it('recovers a lost accepted receipt from verified history without minting another counter', async () => {
  const f = await fixture(); await admitLocalCounter(f.name, f.event, f.baseline); f.lose();
  await expect(f.run()).rejects.toThrow('Synthetic lost receipt');
  await f.run();
  const db = await openDB(f.name); const state = await db.get(CAUSAL_STORE, f.accountId); db.close();
  expect(f.requests).toHaveLength(1); expect(state.causalRequests[f.event.actionId]).toBe(f.requests[0]);
  expect(state.trackingValue.planViewCount).toBe(28); expect(Object.keys(state.counterOutbox)).toHaveLength(0);
});


it('refreshes verified history when a peer counter commits during the ordinary pull', async () => {
  const f = await fixture(); f.onPull(f.peerIncrement);
  const meta = await f.run();
  const db = await openDB(f.name); const state = await db.get(CAUSAL_STORE, f.accountId); db.close();
  expect(state.trackingValue.planViewCount).toBe(28);
  expect(meta.cursor).toBe(2); expect(meta.lastSuccessfulSync).toBeTruthy();
});

it('retains and sends a local increment admitted during the ordinary pull', async () => {
  const f = await fixture(); f.onPull(async () => { await admitLocalCounter(f.name, f.event, f.baseline); });
  const meta = await f.run();
  const db = await openDB(f.name); const state = await db.get(CAUSAL_STORE, f.accountId); db.close();
  expect(state.trackingValue.planViewCount).toBe(28);
  expect(Object.keys(state.counterOutbox)).toHaveLength(0);
  expect(f.requests).toHaveLength(1); expect(meta.cursor).toBe(2);
});


it('does not advance the cursor or install a tracking snapshot absent from verified history', async () => {
  const f = await fixture(); f.unverified();
  const failure = await f.run().catch(error => error);
  expect(failure).toBeInstanceOf(Error); expect(isPermanentSyncFailure(failure)).toBe(false);
  const db = await openDB(f.name); const state = await db.get(CAUSAL_STORE, f.accountId); db.close();
  expect(state.trackingValue.planViewCount).toBe(27);
  expect(normalizeSyncMeta(await storageService.get(STORES.SYNC, f.accountId)).cursor).toBe(0);
  expect(f.requests).toHaveLength(0);
});
