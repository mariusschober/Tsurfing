import { test, expect } from '@playwright/test';

async function load(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.waitForFunction(() => Boolean((window as any).__s1Fence));
  await page.evaluate(() => (window as any).__s1Unmount());
}

test('real S1 storage rejects a tracking flush after cutover and retains exact captured WAL', async ({ page }) => {
  await load(page);
  const result = await page.evaluate(async () => {
    const storage = (window as any).__s1Storage;
    const name = 's2-browser-' + crypto.randomUUID();
    localStorage.setItem('goalflow_active_database_v2', name);
    const account = crypto.randomUUID();
    const tracking = { date: '2026-09-07', planViewCount: 27, dailyPostponeCount: 3, unknown: { preserved: true } };
    await storage.set('tracking', account, tracking, 'cloud');
    storage.stageLocalValue('tracking', account, tracking, { ...tracking, planViewCount: 28 });
    const wal = Object.fromEntries(Object.keys(localStorage).filter(k => k.startsWith('goalflow_wal')).map(k => [k, localStorage.getItem(k)]));
    const db = await (window as any).__s1Fence(name);
    let error = '';
    try { await storage.flushPendingLocalChanges(account); } catch (e) { error = (e as Error).name + ': ' + (e as Error).message; }
    const after = Object.fromEntries(Object.keys(wal).map(k => [k, localStorage.getItem(k)]));
    let directWriteError = '';
    try { await db.put('tracking', tracking, account); } catch (e) { directWriteError = (e as Error).name; }
    const authority = await db.get('causal_actions', account);
    db.close();
    return { error, directWriteError, wal, after, authority, tracking };
  });
  expect(result.error).toBe('DurableStorageError: Pending tracking data diverged from recovered storage. Neither version was overwritten.');
  expect(result.directWriteError).toBe('DataError');
  expect(Object.keys(result.wal)).toHaveLength(1);
  expect(result.after).toEqual(result.wal);
  expect(result.authority.trackingValue).toEqual(result.tracking);
  expect(result.authority.cutover.trackingValue).toEqual(result.tracking);
});

test('an uncooperative older connection delays cutover; its final committed write is preserved', async ({ page, context }) => {
  await load(page);
  const name = 's2-blocked-' + crypto.randomUUID();
  await page.evaluate(async name => {
    localStorage.setItem('goalflow_active_database_v2', name);
    await (window as any).__s1Storage.set('tracking', 'fixture', { planViewCount: 27 }, 'cloud');
  }, name);
  const peer = await context.newPage();
  await peer.goto('/');
  await peer.evaluate(async name => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open(name); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
    });
    (window as any).__oldConnection = db;
    db.onversionchange = () => { (window as any).__sawUpgrade = true; }; // Historical S1 failed to close.
  }, name);
  await page.evaluate(name => {
    (window as any).__fencePromise = (window as any).__s1Fence(name).then((db: any) => { (window as any).__finished = true; return db; });
  }, name);
  await peer.waitForFunction(() => (window as any).__sawUpgrade);
  expect(await page.evaluate(() => Boolean((window as any).__finished))).toBe(false);
  await peer.evaluate(async () => {
    const db = (window as any).__oldConnection as IDBDatabase;
    const tx = db.transaction('tracking', 'readwrite');
    tx.objectStore('tracking').put({ planViewCount: 28, preservedLateWrite: true }, 'fixture');
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
    db.close();
  });
  const preserved = await page.evaluate(async () => {
    const db = await (window as any).__fencePromise;
    const state = await db.get('causal_actions', 'fixture'); db.close(); return state;
  });
  expect(preserved.cutover.trackingValue).toEqual({ planViewCount: 28, preservedLateWrite: true });
});

test('causal local admission serializes real browser transactions and preserves an action across rollback', async ({ page }) => {
  await load(page);
  const result = await page.evaluate(async () => {
    const storage = (window as any).__s1Storage;
    const name = 's2-admission-' + crypto.randomUUID();
    localStorage.setItem('goalflow_active_database_v2', name);
    const accountId = crypto.randomUUID(); const sessionId = crypto.randomUUID();
    const tracking = { date: '2026-09-07', planViewCount: 27, dailyPostponeCount: 3,
      focusSession: { schemaVersion: 1, sessionId, taskId: 'task', phase: 'active', plannedDurationSeconds: 600,
        startedAt: '2026-09-07T10:00:00.000Z', updatedAt: '2026-09-07T10:00:00.000Z', elapsedSeconds: 0, pausedAt: null, endedAt: null } };
    await storage.set('tracking', accountId, tracking, 'cloud');
    await storage.set('tasks', accountId, [{ id: 'task', completed: false }], 'cloud');
    const action = (durationSeconds: number) => ({ schemaVersion: 1, accountId, sessionId, taskId: 'task', actorId: 'browser',
      actionId: crypto.randomUUID(), epoch: sessionId, expectedCurrentSessionId: sessionId, kind: 'extend', durationSeconds,
      capturedAt: '2026-09-07T10:00:30.000Z' });
    const a = action(300); const b = action(120);
    const admitted = await Promise.all([(window as any).__s1AdmitFocus(name, a), (window as any).__s1AdmitFocus(name, b)]);
    const retry = await (window as any).__s1AdmitFocus(name, a);
    const c = action(60);
    const put = IDBObjectStore.prototype.put;
    let failure = '';
    IDBObjectStore.prototype.put = function(...args: Parameters<typeof put>) {
      if (this.name === 'tracking') throw new Error('Synthetic write failure');
      return put.apply(this, args);
    };
    try { await (window as any).__s1AdmitFocus(name, c); } catch (e) { failure = (e as Error).message; }
    finally { IDBObjectStore.prototype.put = put; }
    const db = await (window as any).__s1Fence(name);
    const afterFailure = await db.get('causal_actions', accountId); db.close();
    const recovered = await (window as any).__s1AdmitFocus(name, c);
    return { admitted, retry, failure, afterFailure, recovered, a, b, c };
  });
  expect(result.admitted.every((item: any) => item.outcome.accepted)).toBe(true);
  expect(result.retry.duplicate).toBe(true);
  expect(result.failure).toBe('Synthetic write failure');
  expect(result.afterFailure.trackingValue.focusSession.plannedDurationSeconds).toBe(1020);
  expect(result.afterFailure.trackingValue.planViewCount).toBe(27);
  expect(Object.keys(result.afterFailure.focusOutbox).sort()).toEqual([result.a.actionId, result.b.actionId].sort());
  expect(result.afterFailure.focusAdmissions[result.c.actionId]).toBeUndefined();
  expect(result.recovered.tracking.focusSession.plannedDurationSeconds).toBe(1080);
  expect(result.recovered.command.actionId).toBe(result.c.actionId);
});

test('counter and focus admissions share one authority across concurrent browser transactions', async ({ page }) => {
  await load(page);
  const result = await page.evaluate(async () => {
    const api = window as any;
    const name = 's2-mixed-' + crypto.randomUUID();
    localStorage.setItem('goalflow_active_database_v2', name);
    const accountId = crypto.randomUUID(); const sessionId = crypto.randomUUID();
    const baseline = { schemaVersion: 1, baselineId: crypto.randomUUID(), accountId, day: '2026-09-07',
      counts: { planViewCount: 27, dailyPostponeCount: 3 }, evidenceIds: [] };
    await api.__s1Storage.set('tracking', accountId, { date: baseline.day, ...baseline.counts, unknown: 'preserved',
      focusSession: { schemaVersion: 1, sessionId, taskId: 'task', phase: 'active', plannedDurationSeconds: 600,
        startedAt: '2026-09-07T10:00:00.000Z', updatedAt: '2026-09-07T10:00:00.000Z', elapsedSeconds: 0, pausedAt: null, endedAt: null } }, 'cloud');
    await api.__s1Storage.set('tasks', accountId, [{ id: 'task', completed: false }], 'cloud');
    const events = ['planViewCount', 'dailyPostponeCount', 'planViewCount', 'dailyPostponeCount'].map(counter => ({ schemaVersion: 1,
      accountId, actionId: crypto.randomUUID(), actorId: 'browser', day: baseline.day, timeZone: 'Atlantic/Canary', counter, delta: 1,
      capturedAt: '2026-09-07T10:00:30.000Z', businessActionId: null, correctionOf: null }));
    const focus = { schemaVersion: 1, accountId, sessionId, taskId: 'task', actorId: 'browser', actionId: crypto.randomUUID(),
      epoch: sessionId, expectedCurrentSessionId: sessionId, kind: 'extend', durationSeconds: 300, capturedAt: '2026-09-07T10:00:30.000Z' };
    await Promise.all([...events.map(e => api.__s1AdmitCounter(name, e, baseline)), api.__s1AdmitFocus(name, focus)]);
    await Promise.all(events.map(e => api.__s1AdmitCounter(name, e, baseline)));
    let collision = '';
    try { await api.__s1AdmitCounter(name, { ...events[0], actionId: focus.actionId }, baseline); }
    catch (e) { collision = (e as Error).message; }
    const db = await api.__s1Fence(name); const state = await db.get('causal_actions', accountId); db.close();
    return { state, collision };
  });
  expect(result.state.trackingValue.planViewCount).toBe(29);
  expect(result.state.trackingValue.dailyPostponeCount).toBe(5);
  expect(result.state.trackingValue.focusSession.plannedDurationSeconds).toBe(900);
  expect(result.state.trackingValue.unknown).toBe('preserved');
  expect(result.state.generation).toBe(5);
  expect(Object.keys(result.state.counterOutbox)).toHaveLength(4);
  expect(result.collision).toContain('different intent');
});
