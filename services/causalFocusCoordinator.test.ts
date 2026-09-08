import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { IDBObjectStore } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import { admitLocalFocus, admitLocalFocusControl, type LocalFocusIntent, type LocalFocusControl } from './causalFocusCoordinator';
import { CAUSAL_STORE } from './causalStorage';

async function fixture() {
  const name = 's2-admit-' + crypto.randomUUID();
  const accountId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const db = await openDB(name, 1, { upgrade(db) { for (const store of ['tracking', 'sync', 'tasks']) db.createObjectStore(store); } });
  const baseline = { schemaVersion: 1, sessionId, taskId: 'task', phase: 'active', plannedDurationSeconds: 600,
    startedAt: '2026-09-07T10:00:00.000Z', updatedAt: '2026-09-07T10:00:00.000Z', elapsedSeconds: 0, pausedAt: null, endedAt: null };
  await db.put('tracking', { date: '2026-09-07', planViewCount: 27, dailyPostponeCount: 3, unknown: { preserved: true }, focusSession: baseline }, accountId);
  await db.put('tasks', [{ id: 'task', completed: false }], accountId);
  db.close();
  const intent = (kind: LocalFocusIntent['kind'], durationSeconds: number | null = null): LocalFocusIntent => ({ schemaVersion: 1,
    accountId, actorId: 'synthetic-tab', actionId: crypto.randomUUID(), kind, sessionId, taskId: 'task', epoch: sessionId,
    expectedCurrentSessionId: sessionId, capturedAt: '2026-09-07T10:00:30.000Z', durationSeconds });
  const read = async () => { const db = await openDB(name); const state = await db.get(CAUSAL_STORE, accountId); db.close(); return state; };
  return { name, accountId, sessionId, baseline, intent, read };
}

describe('transactional local focus admission', () => {
  it('resolves rapid add-time controls from the actual phase and retains the original control on retry', async () => {
    const f = await fixture(); await admitLocalFocus(f.name, f.intent('pause'));
    const control = (durationSeconds: number): LocalFocusControl => ({ schemaVersion: 1, accountId: f.accountId,
      actionId: crypto.randomUUID(), actorId: 'tab', kind: 'addTime', sessionId: f.sessionId, taskId: 'task',
      expectedCurrentSessionId: f.sessionId, capturedAt: '2026-09-07T10:01:00.000Z', durationSeconds });
    const a = control(300), b = control(120);
    const results = await Promise.all([admitLocalFocusControl(f.name, a), admitLocalFocusControl(f.name, b)]);
    expect(results.every(result => result.outcome.accepted)).toBe(true);
    expect(results.map(result => result.command.kind).sort()).toEqual(['extend', 'extendAndResume']);
    const before = await f.read();
    expect(before.trackingValue.focusSession.plannedDurationSeconds).toBe(1020);
    expect(before.trackingValue.focusSession.elapsedSeconds).toBe(30);
    expect(before.trackingValue.focusSession.phase).toBe('active');
    expect(before.focusAdmissions[a.actionId].intent.uiControl).toEqual(a);
    expect((await admitLocalFocusControl(f.name, a)).command).toEqual(results[0].command);
    expect(await f.read()).toEqual(before);
    await expect(admitLocalFocusControl(f.name, { ...a, durationSeconds: 60 })).rejects.toThrow('different intent');
  });
  it('retains a stale control target after a different focus session starts', async () => {
    const f = await fixture(); const old = f.intent('pause');
    const control: LocalFocusControl = { schemaVersion: 1, actionId: old.actionId, accountId: f.accountId, actorId: 'tab',
      kind: 'pause', sessionId: f.sessionId, taskId: 'task', expectedCurrentSessionId: f.sessionId,
      capturedAt: old.capturedAt, durationSeconds: null };
    await admitLocalFocus(f.name, f.intent('stop'));
    const start = { ...f.intent('start', 600), sessionId: crypto.randomUUID() }; start.epoch = start.actionId;
    await admitLocalFocus(f.name, start);
    const result = await admitLocalFocusControl(f.name, control);
    expect(result.outcome.code).toBe('STALE_TARGET');
    expect(result.command.sessionId).toBe(f.sessionId);
    expect((await f.read()).trackingValue.focusSession.sessionId).toBe(start.sessionId);
    expect((await f.read()).focusAdmissions[control.actionId].intent.uiControl).toEqual(control);
  });
  it('concurrent local serial actions acquire their actual parent; both extensions persist once', async () => {
    const f = await fixture();
    const a = f.intent('extend', 300); const b = f.intent('extend', 120);
    const [first, second] = await Promise.all([admitLocalFocus(f.name, a), admitLocalFocus(f.name, b)]);
    expect(first.outcome.accepted && second.outcome.accepted).toBe(true);
    const state = await f.read();
    expect(state.trackingValue.focusSession.plannedDurationSeconds).toBe(1020);
    expect(state.trackingValue.planViewCount).toBe(27);
    expect(state.trackingValue.dailyPostponeCount).toBe(3);
    expect(state.trackingValue.unknown).toEqual({ preserved: true });
    const admissions = Object.values(state.focusAdmissions) as any[];
    expect(admissions.some(x => x.command.expectedRevision === f.sessionId)).toBe(true);
    expect(admissions.some(x => [a.actionId, b.actionId].includes(x.command.expectedRevision))).toBe(true);
    expect(Object.keys(state.focusOutbox)).toHaveLength(2);
    expect((await admitLocalFocus(f.name, a)).duplicate).toBe(true);
    expect((await f.read()).generation).toBe(2);
    await expect(admitLocalFocus(f.name, { ...a, durationSeconds: 500 })).rejects.toThrow('different intent');
  });

  it('a failed projection write rolls back admission, history and outbox; retry reuses the action', async () => {
    const f = await fixture(); const action = f.intent('pause');
    // Complete schema migration first; failure below targets the business transaction.
    const { fenceLegacyTracking } = await import('./causalStorage');
    (await fenceLegacyTracking(f.name)).close();
    const put = IDBObjectStore.prototype.put;
    const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function(this: IDBObjectStore, ...args) {
      if (this.name === 'tracking') throw new Error('Synthetic projection commit failure');
      return put.apply(this, args);
    });
    await expect(admitLocalFocus(f.name, action)).rejects.toThrow('Synthetic projection');
    spy.mockRestore();
    expect((await f.read()).focusAdmissions).toBeUndefined();
    expect((await f.read()).generation).toBe(0);
    expect((await admitLocalFocus(f.name, action)).outcome.accepted).toBe(true);
    expect(Object.keys((await f.read()).focusOutbox)).toEqual([action.actionId]);
  });

  it('never retargets an old F pause to G and durably records rejection', async () => {
    const f = await fixture();
    await admitLocalFocus(f.name, f.intent('stop'));
    const start = { ...f.intent('start', 900), sessionId: crypto.randomUUID() };
    start.epoch = start.actionId;
    await admitLocalFocus(f.name, start);
    const stale = f.intent('pause');
    expect((await admitLocalFocus(f.name, stale)).outcome.code).toBe('STALE_TARGET');
    const state = await f.read();
    expect(state.trackingValue.focusSession.sessionId).toBe(start.sessionId);
    expect(state.trackingValue.focusSession.phase).toBe('active');
    expect(state.focus.sessions[f.sessionId].projection.phase).toBe('stopped');
    expect(state.focusAdmissions[stale.actionId].outcome.accepted).toBe(false);
    expect(state.focusOutbox[stale.actionId]).toBeUndefined();
  });

  it('captures immutable intent before awaiting schema and reads task eligibility in the transaction', async () => {
    const f = await fixture(); const action = f.intent('extend', 120);
    const pending = admitLocalFocus(f.name, action);
    action.durationSeconds = 300;
    expect((await pending).command.durationSeconds).toBe(120);
    const db = await openDB(f.name);
    await db.put('tasks', [{ id: 'task', completed: true }], f.accountId); db.close();
    const start = { ...f.intent('start', 600), sessionId: crypto.randomUUID() }; start.epoch = start.actionId;
    await expect(admitLocalFocus(f.name, start)).rejects.toThrow('no longer open');
    await expect(admitLocalFocus(f.name, f.intent('complete'))).rejects.toThrow('atomic final-notes');
    expect((await f.read()).trackingValue.focusSession.phase).toBe('active');
  });
});
