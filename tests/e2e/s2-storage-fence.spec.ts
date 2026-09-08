import { test, expect } from '@playwright/test';

async function load(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.waitForFunction(() => Boolean((window as any).__s1Fence));
  await page.evaluate(() => (window as any).__s1Unmount());
}

test('current storage retains a pre-cutover tracking capture for review without guessing its counter', async ({ page }) => {
  await load(page);
  const result = await page.evaluate(async () => {
    const storage = (window as any).__s1Storage;
    const name = 's2-browser-' + crypto.randomUUID();
    localStorage.setItem('goalflow_active_database_v2', name);
    const account = crypto.randomUUID();
    const tracking = { date: '2026-09-07', planViewCount: 27, dailyPostponeCount: 3, unknown: { preserved: true } };
    await storage.set('tracking', account, tracking, 'cloud');
    storage.stageLocalValue('tracking', account, tracking, { ...tracking, planViewCount: 28 });
    const key = Object.keys(localStorage).find(k => k.startsWith('goalflow_wal'))!;
    const legacy = JSON.parse(localStorage.getItem(key)!); delete legacy.captureProtocol;
    localStorage.setItem(key, JSON.stringify(legacy)); // Exact pre-upgrade capture shape.
    const wal = { [key]: localStorage.getItem(key)! };
    const db = await (window as any).__s1Fence(name);
    let error = '';
    try { await storage.flushPendingLocalChanges(account); } catch (e) { error = (e as Error).name + ': ' + (e as Error).message; }
    const after = Object.fromEntries(Object.keys(wal).map(k => [k, localStorage.getItem(k)]));
    let directWriteError = '';
    try { await db.put('tracking', tracking, account); } catch (e) { directWriteError = (e as Error).name; }
    const authority = await db.get('causal_actions', account);
    db.close();
    const meta = await storage.get('sync', account);
    return { error, directWriteError, wal, after, authority, tracking, meta, id: legacy.id };
  });
  expect(result.error).toBe('');
  expect(result.directWriteError).toBe('DataError');
  expect(Object.keys(result.wal)).toHaveLength(1);
  for (const [key, raw] of Object.entries(result.wal)) {
    expect(result.after[key]).toBeNull(); // Retired only after exact durable preservation.
    expect(result.authority.legacyWal[key]).toEqual([raw]);
  }
  expect(result.meta.localState.blocked[result.id]).toContain('CAUSAL_CAPTURE_REVIEW');
  expect(result.meta.outbox).toEqual([]);
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

test('business authority survives legacy deletes and restores a pending completion without changing its request', async ({ page, browser }) => {
  await load(page);
  const source = await page.evaluate(async () => {
    const api = window as any, storage = api.__s1Storage;
    const name = 's2-business-browser-' + crypto.randomUUID(), accountId = crypto.randomUUID(), sessionId = crypto.randomUUID(), epoch = crypto.randomUUID();
    localStorage.setItem('goalflow_active_database_v2', name);
    const tracking = { date: '2026-09-08', planViewCount: 27, dailyPostponeCount: 3,
      focusSession: { schemaVersion: 1, sessionId, taskId: 'task', phase: 'active', plannedDurationSeconds: 600,
        startedAt: '2026-09-08T00:00:00.000Z', updatedAt: '2026-09-08T00:00:00.000Z', elapsedSeconds: 0, pausedAt: null, endedAt: null } };
    const collections = { tracking, tasks: [{ id: 'task', completed: false, title: 'synthetic', description: 'original notes', dateAssigned: '2026-09-08' }],
      stats: {}, progress: { level: 1, xp: 0, xpToNextLevel: 100 }, goals: [], habits: [], task_events: [] };
    for (const [store, value] of Object.entries(collections)) await storage.set(store, accountId, value, 'cloud');
    (await api.__s1Fence(name)).close();
    const old = await api.__s2FenceBusiness(name); let oldPut = '';
    try { await old.put('tasks', [], accountId); } catch (error) { oldPut = (error as Error).name; }
    for (const store of ['tasks', 'sync', 'stats']) await old.clear(store); old.close();
    const retainedTask = await storage.get('tasks', accountId);
    await api.__s2BindCapability(name, accountId, { schemaVersion: 2, accountId, enrolled: true, epoch, projectionRevision: 0, rolloutReady: false });
    const capture = { focus: { schemaVersion: 1, accountId, actionId: crypto.randomUUID(), actorId: 'synthetic-browser', kind: 'complete',
      sessionId, taskId: 'task', epoch: sessionId, expectedCurrentSessionId: sessionId, capturedAt: '2026-09-08T00:05:00.000Z', durationSeconds: null },
      details: { day: '2026-09-08', timeZone: 'Atlantic/Canary', actualDuration: 5, flowState: 'flow', finalDescription: 'synthetic final 🧭 notes' }, deviceId: 'synthetic-browser' };
    await api.__s2AdmitCompletion(name, capture);
    const request = await api.__s2PrepareCompletion(name, accountId, capture.focus.actionId);
    const backup = JSON.parse(JSON.stringify(await storage.exportBackup(accountId)));
    return { backup, request, accountId, epoch, capture, oldPut, retainedTask };
  });
  // A fresh browser profile models a new device. Source localStorage, including
  // retained recovery copies, remains untouched and must not be cleared.
  const restoredContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
  const target = await restoredContext.newPage(); await load(target);
  const result = await target.evaluate(async ({ backup, request, accountId, epoch, capture, oldPut, retainedTask }) => {
    const api = window as any, storage = api.__s1Storage, restored = 's2-business-restored-' + crypto.randomUUID();
    localStorage.setItem('goalflow_active_database_v2', restored); await storage.importBackup(accountId, backup);
    const resumed = await api.__s2PrepareCompletion(restored, accountId, capture.focus.actionId);
    const operation = JSON.parse(request), projected = await storage.get('tracking', accountId);
    const receipt = { schemaVersion: 2, epoch, projectionRevision: 1, operation, accepted: true,
      outcome: { accepted: true, code: 'APPLIED', revision: capture.focus.actionId },
      record: { user_id: accountId, entity_type: 'tracking', entity_id: 'singleton', payload: projected, version: 2, server_version: 100,
        device_id: 'causal-completion-v2', updated_at: capture.focus.capturedAt, deleted_at: null },
      changes: operation.changes.map((member: any, index: number) => ({ mutationId: member.mutationId, accepted: true, serverVersion: 80 + index,
        record: { user_id: accountId, entity_type: member.entityType, entity_id: member.entityId, payload: member.payload, version: member.version,
          server_version: 80 + index, device_id: member.deviceId, updated_at: member.updatedAt, deleted_at: null } })) };
    const first = await api.__s2CommitCompletion(restored, accountId, capture.focus.actionId, receipt);
    const retry = await api.__s2CommitCompletion(restored, accountId, capture.focus.actionId, receipt);
    return { oldPut, retainedTask, schema: backup.schemaVersion, sameRequest: resumed === request, first, retry,
      tasks: await storage.get('tasks', accountId), events: await storage.get('task_events', accountId), tracking: projected,
      sync: await storage.get('sync', accountId) };
  }, source);
  await restoredContext.close();
  expect(result.oldPut).toBe('DataError'); expect(result.retainedTask[0].description).toBe('original notes');
  expect(result.schema).toBe(6); expect(result.sameRequest).toBe(true);
  expect(result.first.accepted).toBe(true); expect(result.retry.duplicate).toBe(true);
  expect(result.tasks[0]).toMatchObject({ completed: true, description: 'synthetic final 🧭 notes' });
  expect(result.events).toHaveLength(1); expect(result.tracking).toMatchObject({ planViewCount: 27, dailyPostponeCount: 3, focusSession: { phase: 'completed' } });
  expect(result.sync.cursor).toBe(0); expect(Object.keys(result.sync.localState.completionReservations)).toHaveLength(0);
});

test('business upgrade waits for an older tab and preserves its last committed note edit', async ({ page, context }) => {
  await load(page);
  const name = 's2-business-blocked-' + crypto.randomUUID();
  await page.evaluate(async name => {
    localStorage.setItem('goalflow_active_database_v2', name);
    await (window as any).__s1Storage.set('tracking', 'fixture', { planViewCount: 27 }, 'cloud');
    await (window as any).__s1Storage.set('tasks', 'fixture', [{ id: 'task', description: 'before upgrade' }], 'cloud');
    (await (window as any).__s1Fence(name)).close();
  }, name);
  const peer = await context.newPage(); await peer.goto('/');
  await peer.evaluate(async name => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(name); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    (window as any).__oldBusiness = db; db.onversionchange = () => { (window as any).__businessUpgradeSeen = true; };
  }, name);
  await page.evaluate(name => {
    (window as any).__businessPromise = (window as any).__s2FenceBusiness(name).then((db: any) => { (window as any).__businessFinished = true; return db; });
  }, name);
  await peer.waitForFunction(() => (window as any).__businessUpgradeSeen);
  expect(await page.evaluate(() => Boolean((window as any).__businessFinished))).toBe(false);
  await peer.evaluate(async () => {
    const db = (window as any).__oldBusiness as IDBDatabase, tx = db.transaction('tasks', 'readwrite');
    tx.objectStore('tasks').put([{ id: 'task', description: 'late synthetic final notes' }], 'fixture');
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); }); db.close();
  });
  const preserved = await page.evaluate(async () => {
    const db = await (window as any).__businessPromise, value = await db.get('causal_business', ['tasks', 'fixture']); db.close(); return value;
  });
  expect(preserved.value).toEqual([{ id: 'task', description: 'late synthetic final notes' }]);
  expect(preserved.cutover.value).toEqual(preserved.value);
});

test('offline day intent and unprojected increments survive a real browser restart', async ({ page }) => {
  await load(page);
  const saved = await page.evaluate(async () => {
    const api = window as any; const name = 's2-offline-day-' + crypto.randomUUID();
    localStorage.setItem('goalflow_active_database_v2', name);
    const accountId = crypto.randomUUID();
    const tracking = { date: '2026-09-07', planViewCount: 27, dailyPostponeCount: 3, focusSession: null, unknown: { retained: true } };
    await api.__s1Storage.set('tracking', accountId, tracking, 'cloud');
    const day = { schemaVersion: 1, actionId: crypto.randomUUID(), accountId, actorId: 'browser',
      kind: 'select', day: '2026-09-08', timeZone: 'UTC', capturedAt: '2026-09-08T00:00:00.000Z' };
    await api.__s2AdmitCounterDay(name, day);
    const event = { schemaVersion: 1, actionId: crypto.randomUUID(), accountId, actorId: 'browser',
      day: day.day, timeZone: day.timeZone, capturedAt: day.capturedAt, counter: 'planViewCount', delta: 1, businessActionId: null, correctionOf: null };
    const result = await api.__s1AdmitCounter(name, event);
    return { name, accountId, day, event, tracking, result };
  });
  expect(saved.result.baselinePending).toBe(true);
  expect(saved.result.tracking).toEqual(saved.tracking);
  await page.reload(); await page.waitForFunction(() => Boolean((window as any).__s2AdmitCounterDay));
  await page.evaluate(() => (window as any).__s1Unmount());
  const restored = await page.evaluate(async saved => {
    const api = window as any;
    const retry = await api.__s1AdmitCounter(saved.name, saved.event);
    const dayRetry = await api.__s2AdmitCounterDay(saved.name, saved.day);
    const db = await api.__s1Fence(saved.name);
    const state = await db.get('causal_actions', saved.accountId); db.close();
    return { retry, dayRetry, state };
  }, saved);
  expect(restored.retry.duplicate).toBe(true); expect(restored.dayRetry.duplicate).toBe(true);
  expect(restored.state.trackingValue).toEqual(saved.tracking);
  expect(restored.state.counterBaselines).toBeUndefined();
  expect(restored.state.counterOutbox).toEqual({ [saved.event.actionId]: saved.event });
  expect(restored.state.counterDaySelection).toEqual({ actionId: saved.day.actionId, requestedDay: saved.day.day, status: 'WAITING_BASELINE' });
});

async function fencedFocusApp(page: import('@playwright/test').Page) {
  await load(page);
  const account = crypto.randomUUID();
  await page.evaluate(account => (window as any).__s1RenderAccount(account), account);
  await expect(page.locator('header')).toBeVisible();
  await page.getByTitle('Add new task (a)').click();
  const form = page.getByRole('dialog', { name: 'New Task' });
  await form.getByPlaceholder('What is the next action?').fill('Synthetic causal focus control');
  await form.locator('[aria-label="Task schedule"]').getByRole('button', { name: 'Today', exact: true }).click();
  await form.getByRole('button', { name: 'Create Task', exact: true }).click();
  await expect(form).toBeHidden();
  await page.getByRole('button', { name: 'Plan', exact: true }).click();
  await page.getByRole('button', { name: 'Start focus', exact: true }).click();
  await page.getByTitle('Start Focus (Space)').click();
  await expect(page.getByTitle('Pause Timer (Space)')).toBeVisible();
  const before = await page.evaluate(async account => {
    const api = window as any; await api.__s1Storage.flushPendingLocalChanges(account);
    const tracking = await api.__s1Storage.get('tracking', account);
    const meta = await api.__s1Storage.get('sync', account);
    api.__s1Unmount();
    const name = localStorage.getItem('goalflow_active_database_v2') || 'GoalflowDB';
    (await api.__s1Fence(name)).close();
    const db = await api.__s2FenceBusiness(name); db.close();
    api.__s1RenderAccount(account);
    return { tracking, ordinaryIds: meta.outbox.map((m: any) => m.mutationId) };
  }, account);
  await expect(page.getByTitle('Pause Timer (Space)')).toBeVisible();
  return { account, before };
}

test('the rendered focus controls use causal admission after an existing account is fenced', async ({ page }) => {
  const { account, before } = await fencedFocusApp(page);
  await page.getByTitle('Pause Timer (Space)').click();
  await expect(page.getByTitle('Start Focus (Space)')).toBeVisible();
  await page.getByTitle('Edit Duration').click();
  await page.getByRole('button', { name: '+5m', exact: true }).click();
  await expect(page.getByTitle('Pause Timer (Space)')).toBeVisible();
  const after = await page.evaluate(async account => {
    const api = window as any; const snapshot = await api.__s1Storage.readCommittedSnapshot(account);
    const name = localStorage.getItem('goalflow_active_database_v2') || 'GoalflowDB';
    const db = await api.__s1Fence(name); const state = await db.get('causal_actions', account); db.close();
    return { snapshot, state };
  }, account);
  expect(after.snapshot.causal).toBeTruthy();
  expect(after.snapshot.meta.outbox.map((m: any) => m.mutationId)).toEqual(before.ordinaryIds);
  expect(after.snapshot.values.tracking.focusSession.sessionId).toBe(before.tracking.focusSession.sessionId);
  expect(after.snapshot.values.tracking.focusSession.plannedDurationSeconds).toBe(before.tracking.focusSession.plannedDurationSeconds + 300);
  expect(after.snapshot.values.tracking.planViewCount).toBe(before.tracking.planViewCount);
  expect(Object.values(after.state.focusAdmissions).map((a: any) => a.intent.uiControl.kind).sort()).toEqual(['addTime', 'pause']);
  expect(Object.values(after.state.focusOutbox).map((a: any) => a.kind).sort()).toEqual(['extendAndResume', 'pause']);
  expect(after.snapshot.pendingCount).toBe(2); // Ordinary requests remain separately counted in meta.outbox.
});

test('failed rendered completion keeps checkout and notes, then retries the same atomic action', async ({ page }) => {
  const { account } = await fencedFocusApp(page);
  await page.evaluate(async account => {
    const api = window as any, name = localStorage.getItem('goalflow_active_database_v2') || 'GoalflowDB';
    await api.__s2BindCapability(name, account, { schemaVersion: 2, accountId: account, enrolled: true,
      epoch: crypto.randomUUID(), projectionRevision: 0, rolloutReady: false });
    const original = api.__s1Storage.admitFocusCompletion;
    api.__completionCalls = [];
    api.__s1Storage.admitFocusCompletion = function (...args: any[]) {
      api.__completionCalls.push(structuredClone(args[1])); return original.apply(this, args);
    };
    const put = IDBObjectStore.prototype.put;
    api.__restoreCompletionWrites = () => { IDBObjectStore.prototype.put = put; };
    IDBObjectStore.prototype.put = function (...args: any[]) {
      if (this.name === 'tracking' && args[0]?.payload?.focusSession?.phase === 'completed') throw new Error('Synthetic terminal write failure');
      return put.apply(this, args as [any]);
    };
  }, account);
  await page.getByTitle('Toggle Notes (N)').click();
  const editor = page.getByPlaceholder('Add session notes...');
  await editor.fill('Synthetic final notes retained through failed completion.');
  await page.getByTitle('Done (D)').click();
  const checkout = page.getByRole('dialog', { name: 'Check Out', exact: true });
  await checkout.getByRole('button', { name: /Good Focus/ }).click();
  await expect(checkout.getByRole('alert')).toBeVisible();
  await expect(checkout).toBeVisible();
  const failed = await page.evaluate(async account => {
    const api = window as any; const snapshot = await api.__s1Storage.readCommittedSnapshot(account);
    const name = localStorage.getItem('goalflow_active_database_v2') || 'GoalflowDB';
    const db = await api.__s1Fence(name); const state = await db.get('causal_actions', account); db.close();
    api.__restoreCompletionWrites(); return { snapshot, state };
  }, account);
  expect(failed.snapshot.values.tasks[0].completed).toBe(false);
  expect(failed.snapshot.values.tasks[0].description).toBe('Synthetic final notes retained through failed completion.');
  expect(failed.snapshot.values.tracking.focusSession.phase).toBe('active');
  expect(failed.state.completionAdmissions).toBeUndefined();
  await checkout.getByRole('button', { name: /Good Focus/ }).click();
  await expect(checkout).toBeHidden();
  const saved = await page.evaluate(async account => {
    const api = window as any, name = localStorage.getItem('goalflow_active_database_v2') || 'GoalflowDB';
    const snapshot = await api.__s1Storage.readCommittedSnapshot(account);
    const db = await api.__s1Fence(name); const state = await db.get('causal_actions', account); db.close();
    return { snapshot, state, calls: api.__completionCalls };
  }, account);
  expect(saved.calls).toHaveLength(2); expect(saved.calls[1]).toEqual(saved.calls[0]);
  expect(saved.snapshot.values.tasks[0].completed).toBe(true);
  expect(saved.snapshot.values.tasks[0].description).toBe('Synthetic final notes retained through failed completion.');
  expect(saved.snapshot.values.tracking.focusSession.phase).toBe('completed');
  expect(Object.keys(saved.state.completionAdmissions)).toHaveLength(1);
  expect(Object.keys(saved.state.completionOutbox)).toHaveLength(1);
  expect(saved.snapshot.values.task_events).toHaveLength(1);
  expect(Object.values(saved.snapshot.values.stats).map((s: any) => s.tasksCompleted)).toEqual([1]);
});

test('rendered rescheduling retains a failed choice and retries one task-counter admission', async ({ page }) => {
  await load(page);
  const account = crypto.randomUUID();
  await page.evaluate(account => (window as any).__s1RenderAccount(account), account);
  await page.getByTitle('Add new task (a)').click();
  const form = page.getByRole('dialog', { name: 'New Task' });
  await form.getByPlaceholder('What is the next action?').fill('Synthetic causal reschedule');
  await form.locator('[aria-label="Task schedule"]').getByRole('button', { name: 'Today', exact: true }).click();
  await form.getByRole('button', { name: 'Create Task', exact: true }).click();
  await page.getByRole('button', { name: 'Plan', exact: true }).click();
  const drag = page.locator('[data-rfd-draggable-id]').first();
  await drag.focus(); await drag.press('Space'); await drag.press('ArrowRight'); await drag.press('Space');
  await expect(page.getByRole('dialog', { name: 'Reschedule Task', exact: true })).toBeVisible();
  await page.evaluate(async account => {
    const api = window as any; await api.__s1Storage.flushPendingLocalChanges(account);
    const name = localStorage.getItem('goalflow_active_database_v2') || 'GoalflowDB';
    (await api.__s1Fence(name)).close(); const db = await api.__s2FenceBusiness(name);
    const state = await db.get('causal_actions', account), t = state.trackingValue;
    state.counterBaselines = { [t.date]: { schemaVersion: 1, baselineId: crypto.randomUUID(), accountId: account,
      day: t.date, counts: { planViewCount: t.planViewCount, dailyPostponeCount: t.dailyPostponeCount }, evidenceIds: [] } };
    await db.put('causal_actions', state); db.close();
    const original = api.__s1Storage.admitReschedule; api.__rescheduleCalls = [];
    api.__s1Storage.admitReschedule = function (...args: any[]) { api.__rescheduleCalls.push(structuredClone(args[1])); return original.apply(this, args); };
    const put = IDBObjectStore.prototype.put;
    api.__restoreRescheduleWrites = () => { IDBObjectStore.prototype.put = put; };
    IDBObjectStore.prototype.put = function (...args: any[]) {
      if (this.name === 'causal_actions' && Object.keys(args[0]?.rescheduleAdmissions ?? {}).length) throw new Error('Synthetic reschedule write failure');
      return put.apply(this, args as [any]);
    };
    window.dispatchEvent(new CustomEvent('goalflow:peer-hint', { detail: { userKey: account } }));
  }, account);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const dialog = page.getByRole('dialog', { name: 'Reschedule Task', exact: true });
  await dialog.getByRole('button', { name: 'Tomorrow', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  const failed = await page.evaluate(async account => {
    const api = window as any; api.__restoreRescheduleWrites(); return api.__s1Storage.readCommittedSnapshot(account);
  }, account);
  expect(failed.values.tasks[0].rescheduleCount ?? 0).toBe(0);
  expect(failed.values.tracking.dailyPostponeCount).toBe(0);
  await dialog.getByRole('button', { name: 'Tomorrow', exact: true }).click();
  await expect(dialog).toBeHidden();
  const result = await page.evaluate(async account => {
    const api = window as any; const snapshot = await api.__s1Storage.readCommittedSnapshot(account);
    const name = localStorage.getItem('goalflow_active_database_v2') || 'GoalflowDB';
    const db = await api.__s1Fence(name); const state = await db.get('causal_actions', account); db.close();
    return { snapshot, state, calls: api.__rescheduleCalls };
  }, account);
  expect(result.calls).toHaveLength(2); expect(result.calls[0]).toEqual(result.calls[1]);
  expect(result.snapshot.values.tasks[0].rescheduleCount).toBe(1);
  expect(result.snapshot.values.tracking.dailyPostponeCount).toBe(1);
  expect(Object.keys(result.state.rescheduleAdmissions)).toHaveLength(1);
  expect(Object.keys(result.state.counterOutbox)).toHaveLength(1);
});
