import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { IDBObjectStore } from 'fake-indexeddb';
import { expect, it, vi } from 'vitest';
import { applyFocusCommand, initialFocusJournal, type FocusCommand } from '../src/domain/causalFocus';
import { CAUSAL_STORE, fenceLegacyTracking } from './causalStorage';
import { admitLocalCounter } from './causalCounterCoordinator';
import { admitLocalCounterDay } from './causalCounterDayCoordinator';
import { admitLocalFocus, type LocalFocusIntent } from './causalFocusCoordinator';
import { bindCausalCapability } from './causalEnrollment';
import { prepareCausalRequest } from './causalReceipts';
import { applyDownloadedCausalHistory, replayCausalHistory } from './causalProjection';
import { causalHistoryHash } from './causalHistoryProtocol';
import type { SavedCausalHistory } from './causalHistory';

async function fixture() {
  const name = `s2-projection-${crypto.randomUUID()}`, accountId = crypto.randomUUID(), epoch = crypto.randomUUID(), sessionId = crypto.randomUUID();
  const tracking: any = { date: '2026-09-08', planViewCount: 27, dailyPostponeCount: 3, future: { retained: true },
    focusSession: { schemaVersion: 1, sessionId, taskId: 'task', phase: 'active', plannedDurationSeconds: 600,
      startedAt: '2026-09-08T00:00:00.000Z', updatedAt: '2026-09-08T00:00:00.000Z', elapsedSeconds: 0, pausedAt: null, endedAt: null } };
  const baseline = { schemaVersion: 1 as const, accountId, baselineId: epoch, day: tracking.date, counts: { planViewCount: 27, dailyPostponeCount: 3 }, evidenceIds: [epoch] };
  const db = await openDB(name, 1, { upgrade(db) { for (const store of ['tracking', 'sync', 'tasks']) db.createObjectStore(store); } });
  await db.put('tracking', tracking, accountId); await db.put('sync', { cursor: 7, outbox: ['synthetic retained legacy request'] }, accountId);
  await db.put('tasks', [{ id: 'task', completed: false, notes: 'synthetic retained final notes' }], accountId); db.close();
  (await fenceLegacyTracking(name)).close();
  const record = (payload: unknown) => ({ user_id: accountId, entity_type: 'tracking', entity_id: 'singleton', version: 1, server_version: 7,
    device_id: 'fixture', updated_at: '2026-09-08T00:00:00.000Z', deleted_at: null, payload });
  const receipts: any[] = [{ schemaVersion: 2, epoch, projectionRevision: 0, baseline,
    operation: { schemaVersion: 2, accountId, cutoverId: epoch, expectedTrackingServerVersion: 7, expectedTrackingPayload: tracking }, record: record(tracking) }];
  let serverTracking = structuredClone(tracking), journal = initialFocusJournal(accountId, tracking.focusSession);
  const event = (counter: 'planViewCount' | 'dailyPostponeCount' = 'planViewCount') => ({ schemaVersion: 1 as const, accountId,
    actorId: 'tab', actionId: crypto.randomUUID(), day: tracking.date, timeZone: 'UTC', counter, delta: 1, capturedAt: '2026-09-08T00:00:10.000Z', businessActionId: null, correctionOf: null });
  const intent = (kind: LocalFocusIntent['kind'], durationSeconds: number | null = null): LocalFocusIntent => ({ schemaVersion: 1, accountId,
    actorId: 'tab', actionId: crypto.randomUUID(), kind, sessionId, taskId: 'task', epoch: sessionId,
    expectedCurrentSessionId: sessionId, capturedAt: '2026-09-08T00:00:30.000Z', durationSeconds });
  const accept = (type: 'counter' | 'focus', command: any) => {
    let outcome: any;
    if (type === 'counter') {
      serverTracking[command.counter]++;
      outcome = { accepted: true, code: 'APPLIED', day: tracking.date, counts: { planViewCount: serverTracking.planViewCount, dailyPostponeCount: serverTracking.dailyPostponeCount } };
    } else {
      const result = applyFocusCommand(journal, command as FocusCommand); journal = result.journal; outcome = result.outcome;
      if (outcome.accepted) serverTracking.focusSession = journal.sessions[journal.currentSessionId!].projection;
    }
    const receipt = { schemaVersion: 2, epoch, projectionRevision: receipts.length, accepted: outcome.accepted, outcome,
      operation: { schemaVersion: 2, epoch, type, command }, record: record(structuredClone(serverTracking)) };
    receipts.push(receipt); return receipt;
  };
  const save = async () => {
    await bindCausalCapability(name, accountId, { schemaVersion: 2, accountId, enrolled: true, epoch, projectionRevision: receipts.length - 1, rolloutReady: false });
    const history: SavedCausalHistory = { schemaVersion: 1, epoch, throughRevision: receipts.length - 1, downloadedRevision: receipts.length - 1, entries: {} };
    for (let revision = 0; revision < receipts.length; revision++) {
      const body = JSON.stringify({ schemaVersion: 2, accountId, epoch, revision, receipt: receipts[revision] });
      history.entries[String(revision)] = { body, sha256: await causalHistoryHash(new TextEncoder().encode(body)) };
    }
    const db = await openDB(name); const state = await db.get(CAUSAL_STORE, accountId); state.causalHistory = history; await db.put(CAUSAL_STORE, state); db.close(); return history;
  };
  const read = async () => { const db = await openDB(name); const state = await db.get(CAUSAL_STORE, accountId); db.close(); return state; };
  await save();
  return { name, accountId, epoch, sessionId, tracking, baseline, receipts, event, intent, accept, save, read };
}

it('conserves both counters across remote actions, local pending actions and exact receipt retirement', async () => {
  const f = await fixture(); const a = f.event(), b = f.event('dailyPostponeCount');
  await admitLocalCounter(f.name, a, f.baseline); await admitLocalCounter(f.name, b, f.baseline);
  const op = { schemaVersion: 2, epoch: f.epoch, type: 'counter', command: a };
  const bytes = await prepareCausalRequest(f.name, f.accountId, op);
  f.accept('counter', a); f.accept('counter', b); await f.save();
  await applyDownloadedCausalHistory(f.name, f.accountId);
  let state = await f.read();
  expect([state.trackingValue.planViewCount, state.trackingValue.dailyPostponeCount]).toEqual([28, 4]);
  expect(state.causalRequests[a.actionId]).toBe(bytes); expect(state.counterOutbox[a.actionId]).toBeUndefined();
  expect(state.counterOutbox[b.actionId]).toEqual(b); // no attempted request, so no invented acknowledgment
  expect(state.causalReceipts[a.actionId]).toEqual(f.receipts[1]);
  const c = f.event(), d = f.event('dailyPostponeCount');
  await admitLocalCounter(f.name, c, f.baseline); f.accept('counter', d); await f.save();
  await applyDownloadedCausalHistory(f.name, f.accountId); state = await f.read();
  expect([state.trackingValue.planViewCount, state.trackingValue.dailyPostponeCount]).toEqual([29, 5]);
  expect(state.counterOutbox[c.actionId]).toEqual(c);
  expect(state.trackingValue.focusSession).toEqual(f.tracking.focusSession); expect(state.trackingValue.future).toEqual({ retained: true });
  expect((await applyDownloadedCausalHistory(f.name, f.accountId)).duplicate).toBe(true);
  expect(await f.read()).toEqual(state);
  expect((await admitLocalCounter(f.name, d, f.baseline)).duplicate).toBe(true);
});

it('applies day history with exact local admission and retires only an attempted command', async () => {
  const f = await fixture();
  const command = { schemaVersion: 1 as const, actionId: crypto.randomUUID(), accountId: f.accountId,
    actorId: 'tab', kind: 'select' as const, day: f.baseline.day, timeZone: 'UTC', capturedAt: '2026-09-08T00:00:10.000Z' };
  await admitLocalCounterDay(f.name, command);
  const operation = { schemaVersion: 2, epoch: f.epoch, type: 'counterDay', command };
  const receipt = { schemaVersion: 2, epoch: f.epoch, projectionRevision: 1, accepted: true,
    operation, baseline: f.baseline, counts: f.baseline.counts, record: f.receipts[0].record };
  f.receipts.push(receipt); await f.save();
  await applyDownloadedCausalHistory(f.name, f.accountId);
  expect((await f.read()).counterDayOutbox[command.actionId]).toEqual(command);
  const bytes = await prepareCausalRequest(f.name, f.accountId, operation);
  await applyDownloadedCausalHistory(f.name, f.accountId);
  const state = await f.read();
  expect(state.counterDayOutbox).toEqual({});
  expect(state.counterDayAdmissions[command.actionId].command).toEqual(command);
  expect(state.causalRequests[command.actionId]).toBe(bytes);
  expect(state.causalReceipts[command.actionId]).toEqual(receipt);
  expect(state.trackingValue).toEqual(f.tracking);
  expect((await applyDownloadedCausalHistory(f.name, f.accountId)).duplicate).toBe(true);
});

it('applies concurrent extensions once and retains the exact local command parent', async () => {
  const f = await fixture();
  const a = await admitLocalFocus(f.name, f.intent('extend', 300));
  const b = await admitLocalFocus(f.name, f.intent('extend', 120));
  const bytes = await prepareCausalRequest(f.name, f.accountId, { schemaVersion: 2, epoch: f.epoch, type: 'focus', command: a.command });
  f.accept('focus', a.command); await f.save(); await applyDownloadedCausalHistory(f.name, f.accountId);
  const state = await f.read();
  expect(state.trackingValue.focusSession.plannedDurationSeconds).toBe(1020);
  expect(state.focusOutbox[a.command.actionId]).toBeUndefined(); expect(state.focusOutbox[b.command.actionId]).toEqual(b.command);
  expect(state.causalRequests[a.command.actionId]).toBe(bytes); expect(state.focusAdmissions[b.command.actionId].command.expectedRevision).toBe(a.command.actionId);
  f.accept('focus', b.command); await f.save(); await applyDownloadedCausalHistory(f.name, f.accountId);
  expect((await f.read()).trackingValue.focusSession.plannedDurationSeconds).toBe(1020);
});

it('keeps a stale F command pending for review without pausing G or reviving terminal F', async () => {
  const f = await fixture(); const pause = await admitLocalFocus(f.name, f.intent('pause'));
  const stop = { ...f.intent('stop'), expectedRevision: f.sessionId }; f.accept('focus', stop);
  const start = { ...f.intent('start', 900), sessionId: crypto.randomUUID(), expectedRevision: stop.actionId }; start.epoch = start.actionId;
  f.accept('focus', start); await f.save();
  const result = await applyDownloadedCausalHistory(f.name, f.accountId); const state = await f.read();
  expect(result.reviews[pause.command.actionId].code).toBe('STALE_TARGET');
  expect(state.trackingValue.focusSession.sessionId).toBe(start.sessionId); expect(state.trackingValue.focusSession.phase).toBe('active');
  expect(state.focus.sessions[f.sessionId].projection.phase).toBe('stopped'); expect(state.focusOutbox[pause.command.actionId]).toEqual(pause.command);
  expect(state.focusAdmissions[pause.command.actionId].outcome.accepted).toBe(true);
  await prepareCausalRequest(f.name, f.accountId, { schemaVersion: 2, epoch: f.epoch, type: 'focus', command: pause.command });
  f.accept('focus', pause.command); await f.save(); await applyDownloadedCausalHistory(f.name, f.accountId);
  const rejected = await f.read();
  expect(rejected.causalReceipts[pause.command.actionId].accepted).toBe(false);
  expect(rejected.focusOutbox[pause.command.actionId]).toEqual(pause.command);
  expect(rejected.causalProjectionReviewHistory[pause.command.actionId]).toContain('STALE_TARGET');
  expect(rejected.trackingValue.focusSession.sessionId).toBe(start.sessionId);
});

it('rolls back projection, receipt retirement and generation together on the last write failure', async () => {
  const f = await fixture(); const event = f.event(); await admitLocalCounter(f.name, event, f.baseline);
  await prepareCausalRequest(f.name, f.accountId, { schemaVersion: 2, epoch: f.epoch, type: 'counter', command: event });
  f.accept('counter', event); await f.save(); const before = await f.read();
  const put = IDBObjectStore.prototype.put;
  const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function(this: IDBObjectStore, ...args) {
    if (this.name === 'tracking') throw new Error('Synthetic final projection write failure'); return put.apply(this, args);
  });
  try { await expect(applyDownloadedCausalHistory(f.name, f.accountId)).rejects.toThrow('Synthetic final'); } finally { spy.mockRestore(); }
  expect(await f.read()).toEqual(before);
  await applyDownloadedCausalHistory(f.name, f.accountId);
  const db = await openDB(f.name); expect(await db.get('sync', f.accountId)).toEqual({ cursor: 7, outbox: ['synthetic retained legacy request'] });
  expect(await db.get('tasks', f.accountId)).toEqual([{ id: 'task', completed: false, notes: 'synthetic retained final notes' }]); db.close();
});

it('rejects a plausible receipt that violates conservation and refuses ambiguous legacy baseline replacement', async () => {
  const f = await fixture(); f.accept('counter', f.event());
  f.receipts[1].outcome.counts.planViewCount = 29; f.receipts[1].record.payload.planViewCount = 29;
  const history = await f.save();
  expect(() => replayCausalHistory(f.accountId, history)).toThrow('conservation');
  const before = await f.read(); await expect(applyDownloadedCausalHistory(f.name, f.accountId)).rejects.toThrow('conservation'); expect(await f.read()).toEqual(before);
  const g = await fixture(); const db = await openDB(g.name); const state = await db.get(CAUSAL_STORE, g.accountId);
  state.cutover.trackingValue.planViewCount = 28; await db.put(CAUSAL_STORE, state); db.close();
  await expect(applyDownloadedCausalHistory(g.name, g.accountId)).rejects.toThrow('legacy recovery'); expect(await g.read()).toEqual(state);
});

it('reads newer local admissions after asynchronous history verification without losing their increment', async () => {
  const f = await fixture(); f.accept('counter', f.event()); await f.save();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); const reached = new Promise<void>(resolve => { entered = resolve; });
  const digest = crypto.subtle.digest.bind(crypto.subtle); let first = true;
  const spy = vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (...args) => {
    if (first) { first = false; entered(); await gate; }
    return digest(...args);
  });
  try {
    const pending = applyDownloadedCausalHistory(f.name, f.accountId);
    await reached; const event = f.event(); await admitLocalCounter(f.name, event, f.baseline); release(); await pending;
    const state = await f.read(); expect(state.trackingValue.planViewCount).toBe(29); expect(state.counterOutbox[event.actionId]).toEqual(event);
  } finally { release(); spy.mockRestore(); }
});
