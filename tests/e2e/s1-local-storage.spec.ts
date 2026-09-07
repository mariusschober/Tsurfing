import { test, expect, type Page } from '@playwright/test';

const user = 'test@goalflow.local';
async function unlock(page: Page) {
  await page.goto('/');
  const gate = page.locator('#test-code');
  await expect(gate.or(page.locator('header'))).toBeVisible();
  if (await gate.isVisible()) {
    await gate.fill('123456');
    await page.getByRole('button', { name: 'Enter test app' }).click();
  }
  await expect(page.locator('header')).toBeVisible();
  await page.waitForFunction(() => Boolean((window as any).__s1Storage));
}
async function createTask(page: Page, title: string) {
  await page.getByTitle('Add new task (a)').click();
  const form = page.getByRole('dialog', { name: 'New Task' });
  await form.getByPlaceholder('What is the next action?').fill(title);
  await form.locator('[aria-label="Task schedule"]').getByRole('button', { name: 'Today', exact: true }).click();
  await form.getByRole('button', { name: 'Create Task', exact: true }).click();
  await expect(form).toBeHidden();
}

test('A/E: one profile, two real app tabs observe committed tasks without reload or cloud pull', async ({ page, context }) => {
  await unlock(page);
  const peer = await context.newPage();
  await unlock(peer);
  await createTask(page, 'S1 peer-visible task');
  await peer.getByRole('button', { name: 'Plan', exact: true }).click();
  await expect(peer.getByText('S1 peer-visible task', { exact: true })).toBeVisible();
  const meta = await page.evaluate(async user => (window as any).__s1Storage.get('sync', user), user);
  expect(meta.outbox.some((m: any) => m.payload?.title === 'S1 peer-visible task')).toBe(true);
  expect(context.pages()).toHaveLength(2);
});

test('C: releasing an obsolete React debounce after remote hydration creates no action', async ({ page }) => {
  await unlock(page);
  const clockStart = new Date();
  await page.clock.install({ time: clockStart });
  await page.clock.pauseAt(new Date(clockStart.getTime() + 1000));
  // Visiting Plan changes tracking in the actual hook. The baseline schedules
  // a 300ms captured snapshot callback; the repair only drains captured intent.
  await page.getByRole('button', { name: 'Plan', exact: true }).click();
  const before = await page.evaluate(async user => {
    const storage = (window as any).__s1Storage;
    await storage.flushPendingLocalChanges(user);
    const current = await storage.get('tracking', user);
    const meta = await storage.get('sync', user);
    const newer = { ...current, planViewCount: current.planViewCount + 10 };
    await storage.set('tracking', user, newer, 'cloud');
    return { ids: meta.outbox.map((m: any) => m.mutationId), newer };
  }, user);
  await page.clock.runFor(350);
  const after = await page.evaluate(async user => {
    const storage = (window as any).__s1Storage;
    await storage.flushPendingLocalChanges(user);
    return { meta: await storage.get('sync', user), tracking: await storage.get('tracking', user) };
  }, user);
  expect(after.meta.outbox.map((m: any) => m.mutationId)).toEqual(before.ids);
  expect(after.tracking).toEqual(before.newer);
});

test('A: paused peer focus reaches rendered refs; ticks and empty peer hints create no actions', async ({ page, context }) => {
  await unlock(page);
  await createTask(page, 'S1 focus target');
  await page.getByRole('button', { name: 'Plan', exact: true }).click();
  await page.getByRole('button', { name: 'Start focus', exact: true }).click();
  await page.getByTitle('Start Focus (Space)').click();
  await expect(page.getByTitle('Pause Timer (Space)')).toBeVisible();
  const peer = await context.newPage();
  await unlock(peer);
  await expect(peer.getByTitle('Pause Timer (Space)')).toBeVisible();
  await peer.getByTitle('Pause Timer (Space)').click();
  await expect(page.getByTitle('Start Focus (Space)')).toBeVisible();
  const paused = await page.evaluate(async user => {
    const storage = (window as any).__s1Storage;
    await storage.flushPendingLocalChanges(user);
    return { tracking: await storage.get('tracking', user), meta: await storage.get('sync', user) };
  }, user);
  expect(paused.tracking.focusSession.phase).toBe('paused');
  // The next action uses the freshly rendered ref, not the earlier active F0.
  await page.getByTitle('Start Focus (Space)').click();
  await expect(peer.getByTitle('Pause Timer (Space)')).toBeVisible();
  const resumed = await page.evaluate(async user => {
    const storage = (window as any).__s1Storage;
    await storage.flushPendingLocalChanges(user);
    const meta = await storage.get('sync', user);
    const admissions = Object.values(meta.localState.journal) as any[];
    return { meta, admission: admissions.filter(a => a.admission?.kind === 'focus-transition').at(-1) };
  }, user);
  expect(resumed.admission.previousValue.focusSession).toEqual(paused.tracking.focusSession);
  expect(Object.keys(resumed.meta.localState.blocked ?? {})).toHaveLength(0);
  await page.evaluate(user => {
    for (let i = 0; i < 10; i++) window.dispatchEvent(new CustomEvent('goalflow:peer-hint', { detail: { userKey: user } }));
    window.dispatchEvent(new Event('focus'));
  }, user);
  await page.clock.install();
  await page.clock.runFor(2000);
  const after = await page.evaluate(async user => (window as any).__s1Storage.flushPendingLocalChanges(user), user);
  expect(after.outbox.map((m: any) => m.mutationId)).toEqual(resumed.meta.outbox.map((m: any) => m.mutationId));
});

test('capture failure preserves editable task input and reports the local failure', async ({ page }) => {
  await unlock(page);
  await page.getByTitle('Add new task (a)').click();
  const form = page.getByRole('dialog', { name: 'New Task' });
  await form.getByPlaceholder('What is the next action?').fill('S1 retained unsaved input');
  await form.locator('[aria-label="Task schedule"]').getByRole('button', { name: 'Today', exact: true }).click();
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('goalflow_wal_v2_')) throw new DOMException('Synthetic quota fault', 'QuotaExceededError');
      return original.call(this, key, value);
    };
  });
  await form.getByRole('button', { name: 'Create Task', exact: true }).click();
  await expect(form).toBeVisible();
  await expect(form.getByPlaceholder('What is the next action?')).toHaveValue('S1 retained unsaved input');
  await expect(form.getByText(/Durable browser storage rejected/)).toBeVisible();
});

test('dirty note text survives peer hydration and wrong-account success hints', async ({ page, context }) => {
  await unlock(page);
  await createTask(page, 'S1 note target');
  await page.getByRole('button', { name: 'Plan', exact: true }).click();
  await page.getByRole('button', { name: 'Start focus', exact: true }).click();
  await page.getByTitle('Toggle Notes (N)').click();
  const editor = page.getByPlaceholder('Add session notes...');
  await editor.fill('S1 draft text kept independently');
  const peer = await context.newPage();
  await unlock(peer);
  await peer.evaluate(async user => {
    const storage = (window as any).__s1Storage;
    const tasks = await storage.get('tasks', user);
    storage.stageLocalValue('tasks', user, tasks, tasks.map((task: any) => ({ ...task, title: 'S1 peer title' })));
    await storage.flushPendingLocalChanges(user);
  }, user);
  await expect(page.getByText('S1 peer title', { exact: true })).toBeVisible();
  await expect(editor).toHaveValue('S1 draft text kept independently');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('goalflow:sync-state', {
    detail: { userKey: 'different-account', state: 'synced' }
  })));
  await expect(page.getByText('Synced', { exact: true })).toHaveCount(0);
  await expect(editor).toHaveValue('S1 draft text kept independently');
});

for (const phase of ['paused', 'completed']) test(`A: empty production pull after peer ${phase} refreshes the next focus baseline`, async ({ page, context }) => {
  await unlock(page);
  await createTask(page, 'S1 consumed cursor');
  await page.getByRole('button', { name: 'Plan', exact: true }).click();
  await page.getByRole('button', { name: 'Start focus', exact: true }).click();
  await page.getByTitle('Start Focus (Space)').click();
  const peer = await context.newPage();
  await unlock(peer);
  await expect(peer.getByTitle('Pause Timer (Space)')).toBeVisible();
  const result = await peer.evaluate(async ({ user, phase }) => {
    const storage = (window as any).__s1Storage;
    let batch;
    let accepted = 0;
    while ((batch = await storage.preparePushBatch(user)).length) {
      await storage.commitPushResults(user, batch, batch.map((m: any) => {
        const serverVersion = ++accepted;
        return { mutationId: m.mutationId, accepted: true, serverVersion, record: { ...m, serverVersion } };
      }));
    }
    const tracking = await storage.get('tracking', user);
    const time = new Date(Date.parse(tracking.focusSession.updatedAt) + 1000).toISOString();
    const next = { ...tracking, focusSession: { ...tracking.focusSession, phase, elapsedSeconds: 1,
      pausedAt: phase === 'paused' ? time : null, endedAt: phase === 'completed' ? time : null, updatedAt: time } };
    const meta = await storage.get('sync', user);
    const version = (meta.versions['tracking:singleton']?.local ?? 0) + 1;
    await storage.applyRemotePage(user, [{ entityType: 'tracking', entityId: 'singleton', payload: next, version,
      serverVersion: 100, deviceId: 'synthetic-remote', updatedAt: time, deletedAt: null }], 100, 'local');
    return next;
  }, { user, phase });
  const paths = await page.evaluate(async user => {
    const paths: string[] = [];
    await (window as any).__s1Sync(user, {
      deviceId: () => 'synthetic-reader', isOnline: () => true, now: () => new Date(), maxAttempts: 1,
      fetch: async (input: any) => {
        paths.push(String(input));
        if (String(input).includes('/pull')) return Response.json({ records: [], nextCursor: 100, hasMore: false });
        if (String(input).endsWith('/conflicts')) return Response.json({ conflicts: [] });
        throw new Error('Unexpected synthetic request');
      }
    }, { seedLocalData: false });
    window.dispatchEvent(new CustomEvent('goalflow:peer-hint', { detail: { userKey: user } }));
    return paths;
  }, user);
  expect(paths.some(path => path.includes('cursor=100'))).toBe(true);
  await expect(page.getByTitle('Start Focus (Space)')).toBeVisible();
  await page.getByTitle('Start Focus (Space)').click();
  const evidence = await page.evaluate(async user => {
    const meta = await (window as any).__s1Storage.flushPendingLocalChanges(user);
    return { blocked: meta.localState.blocked ?? {}, intent: (Object.values(meta.localState.journal) as any[])
      .filter(a => a.admission?.kind === 'focus-transition').at(-1) };
  }, user);
  expect(evidence.intent.previousValue.focusSession).toEqual(result.focusSession);
  expect(evidence.blocked).toEqual({});
});

test('C: account switch and unmount retire old React callbacks without creating actions', async ({ page }) => {
  await unlock(page);
  await page.clock.install();
  await page.getByRole('button', { name: 'Plan', exact: true }).click();
  const before = await page.evaluate(async user => {
    const meta = await (window as any).__s1Storage.flushPendingLocalChanges(user);
    (window as any).__s1RenderAccount('s1-new-account');
    return meta.outbox;
  }, user);
  await expect(page.locator('header')).toBeVisible();
  await page.clock.runFor(1000);
  await page.evaluate(() => (window as any).__s1Unmount());
  await page.clock.runFor(1000);
  expect(await page.evaluate(async user => (await (window as any).__s1Storage.get('sync', user)).outbox, user)).toEqual(before);
  expect(await page.evaluate(async () => (await (window as any).__s1Storage.get('sync', 's1-new-account')).outbox)).toEqual([]);
});

test('visibility: missed hints and absent BroadcastChannel recover on resume', async ({ page, context }) => {
  await page.addInitScript(() => { Object.defineProperty(window, 'BroadcastChannel', { value: undefined }); });
  await unlock(page);
  await page.getByRole('button', { name: 'Plan', exact: true }).click();
  const peer = await context.newPage();
  await unlock(peer);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    const block = (event: Event) => event.stopImmediatePropagation();
    window.addEventListener('storage', block, { capture: true });
    (window as any).__s1Unblock = () => window.removeEventListener('storage', block, { capture: true });
  });
  await createTask(peer, 'S1 missed event');
  await page.evaluate(() => {
    (window as any).__s1Unblock();
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    window.dispatchEvent(new Event('focus'));
  });
  await page.bringToFront();
  await expect(page.getByText('S1 missed event', { exact: true })).toBeVisible();
});

test('status: an obsolete async commit read cannot overwrite a newer permanent error', async ({ page }) => {
  await unlock(page);
  await page.evaluate(async user => {
    const storage = (window as any).__s1Storage;
    const snapshot = await storage.readCommittedSnapshot(user);
    const original = storage.readCommittedSnapshot.bind(storage);
    let release!: (value: any) => void;
    storage.readCommittedSnapshot = () => new Promise(resolve => { release = resolve; });
    window.dispatchEvent(new CustomEvent('goalflow:committed', { detail: { userKey: user } }));
    window.dispatchEvent(new CustomEvent('goalflow:sync-state', { detail: { userKey: user, state: 'error', message: 'Synthetic permanent block' } }));
    snapshot.meta.localState.blocked = { obsolete: 'obsolete blocked reason' };
    storage.readCommittedSnapshot = original;
    release(snapshot);
  }, user);
  await expect(page.getByTitle('Synthetic permanent block')).toBeVisible();
  await page.evaluate(user => window.dispatchEvent(new CustomEvent('goalflow:peer-hint', { detail: { userKey: user } })), user);
  await expect(page.getByTitle('Synthetic permanent block')).toBeVisible();
});

test('E: real grouped completion and an independent note edit remain queued', async ({ page }) => {
  await unlock(page);
  await createTask(page, 'S1 first complete');
  await createTask(page, 'S1 second note');
  await page.getByRole('button', { name: 'Plan', exact: true }).click();
  await page.getByRole('button', { name: 'Start focus', exact: true }).click();
  await page.getByTitle('Toggle Notes (N)').click();
  await page.getByPlaceholder('Add session notes...').fill('S1 completion note');
  await page.clock.setFixedTime(new Date());
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('dialog', { name: 'Check Out' }).getByRole('button', { name: /Good Focus/ }).click();
  const sessionComplete = page.getByRole('dialog', { name: 'Session Complete' });
  await expect(sessionComplete).toBeVisible();
  await sessionComplete.getByRole('button', { name: /Continue Flowing/ }).click();
  const editor = page.getByPlaceholder('Add session notes...');
  if (!await editor.isVisible()) await page.getByTitle('Toggle Notes (N)').click();
  await editor.fill('S1 independent second note');
  await editor.blur();
  const evidence = await page.evaluate(async user => {
    const meta = await (window as any).__s1Storage.flushPendingLocalChanges(user);
    const tasks = await (window as any).__s1Storage.get('tasks', user);
    return { tasks, meta };
  }, user);
  expect(evidence.tasks.find((task: any) => task.completed)?.description).toBe('S1 completion note');
  expect(evidence.tasks.find((task: any) => !task.completed)?.description).toBe('S1 independent second note');
  expect(Object.values(evidence.meta.localState.groups ?? {}).some((raw: any) => JSON.parse(raw).transactions.length >= 3)).toBe(true);
  expect(evidence.meta.outbox.some((m: any) => m.entityType === 'stats')).toBe(true);
  expect(evidence.meta.outbox.some((m: any) => m.payload?.description === 'S1 independent second note')).toBe(true);
  const group = Object.values(evidence.meta.localState.groups).map((raw: any) => JSON.parse(raw)).find((g: any) => g.transactions.length >= 3) as any;
  const note = Object.values(evidence.meta.localState.journal).find((a: any) => a.changes.some((m: any) => m.payload?.description === 'S1 independent second note')) as any;
  expect(Math.abs(Date.parse(note.createdAt) - Date.parse(group.transactions[0].createdAt))).toBeLessThan(300);
});

for (const operation of ['inbound', 'reconciliation']) test(`D: real IndexedDB ${operation} retains before/during/after intent`, async ({ page }) => {
  await unlock(page);
  const results = await page.evaluate(async operation => {
    const storage = (window as any).__s1Storage;
    const rows = [];
    for (const timing of ['before', 'during', 'after']) {
      const account = `s1-${operation}-${timing}`;
      const previous = [{ id: 'a', title: 'old' }];
      await storage.set('tasks', account, previous, 'cloud');
      const cloud = [{ id: 'a', title: 'remote' }];
      const record = { entityType: 'tasks', entityId: 'a', payload: cloud[0], version: 1, serverVersion: 1, deviceId: 'peer', deletedAt: null };
      let candidate: any;
      if (operation === 'reconciliation') {
        storage.stageLocalValue('tasks', account, previous, [{ id: 'a', title: 'first local' }]);
        const initial = await storage.applyRemotePage(account, [record], 1, 'local');
        candidate = (window as any).__s1Candidate(initial.meta.conflicts[0]);
      }
      const base = await storage.get('tasks', account);
      let captured: string | null = null;
      let original: any;
      const capture = () => {
        captured = storage.stageLocalValue('tasks', account, base, [{ id: 'a', title: 'new action' }]);
        original = JSON.parse(localStorage.getItem(`goalflow_wal_v2_${encodeURIComponent(account)}_${captured}`)!);
      };
      if (timing === 'before') capture();
      const get = IDBObjectStore.prototype.get;
      IDBObjectStore.prototype.get = function (key) {
        const request = get.call(this, key);
        if (timing === 'during' && this.name === 'tasks' && key === account && !captured) request.addEventListener('success', capture, { once: true });
        return request;
      };
      try {
        if (operation === 'inbound') await storage.applyRemotePage(account, [record], 1, 'local');
        else await storage.commitAutomaticReconciliation(account, candidate, { reconciled: true, candidate, receiptId: crypto.randomUUID(), serverMissing: false,
          record: { entity_type: 'tasks', entity_id: 'a', payload: cloud[0], version: 1, server_version: 1, device_id: 'peer', deleted_at: null, updated_at: new Date().toISOString() } });
      } finally { IDBObjectStore.prototype.get = get; }
      if (timing === 'after') capture();
      const meta = await storage.flushPendingLocalChanges(account);
      const represented = [...meta.outbox.map((m: any) => m.mutationId), ...meta.conflicts.flatMap((c: any) => c.localHistory.map((h: any) => h.mutationId))];
      rows.push({ timing, preserved: JSON.stringify(meta.localState.journal[captured!]) === JSON.stringify(original), represented: represented.includes(original.changes[0].mutationId),
        idempotent: JSON.stringify((await storage.flushPendingLocalChanges(account)).outbox) === JSON.stringify(meta.outbox) });
    }
    return rows;
  }, operation);
  for (const result of results) expect(result).toMatchObject({ preserved: true, represented: true, idempotent: true });
});

test('B: real IndexedDB metadata writers preserve a queued independent transaction and exact receipts', async ({ page }) => {
  await unlock(page);
  const results = await page.evaluate(async () => {
    const storage = (window as any).__s1Storage;
    const rows = [];
    for (const method of ['markSyncSuccessful', 'commitPushResults', 'metadataImport', 'preparePushBatch', 'resolveConflictLocally', 'resolveConflictWithCloud']) {
      const account = `s1-writer-${method}`;
      await storage.set('tasks', account, [], 'cloud');
      storage.stageLocalValue('tasks', account, [], [{ id: 'a', title: 'A' }]);
      let batch: any[] = [];
      let conflictId = '';
      if (method === 'commitPushResults') batch = await storage.preparePushBatch(account);
      if (method.startsWith('resolveConflict')) {
        const applied = await storage.applyRemotePage(account, [{ entityType: 'tasks', entityId: 'a', payload: { id: 'a', title: 'remote' }, version: 1, serverVersion: 1, deviceId: 'remote', deletedAt: null }], 1, 'local');
        conflictId = applied.meta.conflicts[0].id;
      }
      const db: IDBDatabase = await new Promise((resolve, reject) => {
        const request = indexedDB.open('GoalflowDB'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      let peerDone: Promise<void> = Promise.resolve();
      const mutationId = crypto.randomUUID();
      let injected = false;
      const get = IDBObjectStore.prototype.get;
      IDBObjectStore.prototype.get = function (key) {
        const request = get.call(this, key);
        if (this.name === 'sync' && key === account && !injected) {
          injected = true;
          request.addEventListener('success', () => {
            const tx = db.transaction(['tasks', 'sync'], 'readwrite');
            peerDone = new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
            const latest = tx.objectStore('sync').get(account);
            latest.onsuccess = () => {
              const meta = latest.result;
              meta.outbox.push({ mutationId, entityType: 'tasks', entityId: 'b', payload: { id: 'b', title: 'B' },
                version: 1, baseServerVersion: null, deviceId: 'peer', updatedAt: new Date().toISOString(), deletedAt: null });
              meta.versions['tasks:b'] = { local: 1, server: null };
              tx.objectStore('sync').put(meta, account);
              const tasks = tx.objectStore('tasks').get(account);
              tasks.onsuccess = () => tx.objectStore('tasks').put([...tasks.result, { id: 'b', title: 'B' }], account);
            };
          }, { once: true });
        }
        return request;
      };
      try {
        if (method === 'commitPushResults') await storage.commitPushResults(account, batch, batch.map(m => ({ mutationId: m.mutationId, accepted: true, serverVersion: 1, record: { ...m, serverVersion: 1 } })));
        else if (method === 'metadataImport') await storage.set('sync', account, { schemaVersion: 2, cursor: 0, versions: {}, outbox: [], conflicts: [] });
        else if (method.startsWith('resolveConflict')) await storage[method](account, conflictId);
        else await storage[method](account);
        await peerDone;
      } finally { IDBObjectStore.prototype.get = get; db.close(); }
      const meta = await storage.get('sync', account);
      rows.push({ method, injected, retained: meta.outbox.some((m: any) => m.mutationId === mutationId),
        receipt: !batch.length || JSON.stringify(meta.localState.receipts[batch[0].mutationId].request) === JSON.stringify(batch[0]) });
    }
    return rows;
  });
  for (const result of results) expect(result).toMatchObject({ injected: true, retained: true, receipt: true });
});

for (const mirrorFails of [false, true]) test(`F: real browser unavailable IndexedDB preserves cursor and WAL, mirror fault=${mirrorFails}`, async ({ page }) => {
  await page.addInitScript(mirrorFails => {
    IDBFactory.prototype.open = () => { throw new DOMException('Synthetic unavailability', 'UnknownError'); };
    if (mirrorFails) {
      const set = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key.startsWith('goalflow_dr_')) throw new DOMException('Synthetic mirror quota', 'QuotaExceededError');
        return set.call(this, key, value);
      };
    }
  }, mirrorFails);
  await page.goto('/');
  await page.waitForFunction(() => Boolean((window as any).__s1Storage));
  const result = await page.evaluate(async () => {
    const storage = (window as any).__s1Storage;
    const account = 'synthetic-unavailable';
    const meta = JSON.stringify({ schemaVersion: 2, cursor: 7, outbox: [], conflicts: [], versions: {} });
    localStorage.setItem(`goalflow_fallback_sync_${account}`, meta);
    const id = storage.stageLocalValue('amalgam', account, undefined, 'retained action');
    const key = `goalflow_wal_v2_${account}_${id}`;
    const original = localStorage.getItem(key);
    let failed = false;
    try { await storage.applyRemotePage(account, [], 7, 'local'); } catch (_) { failed = true; }
    return { failed, wal: original === localStorage.getItem(key), cursor: meta === localStorage.getItem(`goalflow_fallback_sync_${account}`) };
  });
  expect(result).toEqual({ failed: true, wal: true, cursor: true });
});

test('G: equal-count WAL replacement in another page invalidates content and stays idempotent', async ({ page, context }) => {
  await unlock(page);
  const peer = await context.newPage();
  await unlock(peer);
  const account = 'synthetic-wal-cache';
  await page.evaluate(account => (window as any).__s1Storage.stageLocalValue('tasks', account, [], [{ id: 'a', title: 'first' }]), account);
  expect(await page.evaluate(account => (window as any).__s1Storage.get('tasks', account), account)).toEqual([{ id: 'a', title: 'first' }]);
  const counts = await peer.evaluate(account => {
    const before = localStorage.length;
    const key = Object.keys(localStorage).find(key => key.startsWith(`goalflow_wal_v2_${account}_`))!;
    // Synthetic removal/addition models equal-count cache invalidation only.
    localStorage.removeItem(key);
    (window as any).__s1Storage.stageLocalValue('tasks', account, [], [{ id: 'b', title: 'replacement' }]);
    return [before, localStorage.length];
  }, account);
  expect(counts[0]).toBe(counts[1]);
  expect(await page.evaluate(account => (window as any).__s1Storage.get('tasks', account), account)).toEqual([{ id: 'b', title: 'replacement' }]);
  const stable = await page.evaluate(async account => {
    const storage = (window as any).__s1Storage;
    const first = await storage.flushPendingLocalChanges(account);
    for (let i = 0; i < 5; i++) await storage.flushPendingLocalChanges(account);
    return { first: first.outbox, after: (await storage.get('sync', account)).outbox };
  }, account);
  expect(stable.after).toEqual(stable.first);
});

test('note capture failure preserves editable text and exposes the failure at the editor', async ({ page }) => {
  await unlock(page);
  await createTask(page, 'S1 note quota');
  await page.getByRole('button', { name: 'Plan', exact: true }).click();
  await page.getByRole('button', { name: 'Start focus', exact: true }).click();
  await page.getByTitle('Toggle Notes (N)').click();
  const editor = page.getByPlaceholder('Add session notes...');
  await editor.fill('S1 retained failed note');
  await page.evaluate(() => {
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('goalflow_wal_v2_')) throw new DOMException('Synthetic quota', 'QuotaExceededError');
      return set.call(this, key, value);
    };
  });
  await editor.blur();
  await expect(editor).toHaveValue('S1 retained failed note');
  await expect(page.getByRole('alert').filter({ hasText: /Durable browser storage rejected/ })).toBeVisible();
});

test('bootstrap: two simultaneous real app hydrations import one legacy plan without duplicate actions', async ({ page, context }) => {
  await page.addInitScript(user => {
    if (!localStorage.getItem(`goalflow-daily-plan:${user}`)) localStorage.setItem(`goalflow-daily-plan:${user}`, JSON.stringify({ localDate: '2026-09-07', taskIds: [] }));
  }, user);
  const peer = await context.newPage();
  await Promise.all([unlock(page), unlock(peer)]);
  const first = await page.evaluate(async user => {
    const storage = (window as any).__s1Storage;
    const meta = await storage.flushPendingLocalChanges(user);
    return { meta, plans: await storage.get('daily_plans', user), original: localStorage.getItem(`goalflow-daily-plan:${user}`) };
  }, user);
  expect(first.plans).toHaveLength(1);
  expect(first.meta.outbox.filter((m: any) => m.entityType === 'daily_plans')).toHaveLength(1);
  await Promise.all([page.reload(), peer.reload()]);
  await expect(page.locator('header')).toBeVisible();
  await expect(peer.locator('header')).toBeVisible();
  const after = await page.evaluate(async user => {
    const storage = (window as any).__s1Storage;
    return { meta: await storage.flushPendingLocalChanges(user), original: localStorage.getItem(`goalflow-daily-plan:${user}`) };
  }, user);
  expect(after.meta.outbox).toEqual(first.meta.outbox);
  expect(after.original).toBe(first.original);
});

test('local retry: a captured action commits after storage recovery without a cloud client', async ({ page }) => {
  await unlock(page);
  await page.evaluate(() => {
    const storage = (window as any).__s1Storage;
    const flush = storage.flushPendingLocalChanges.bind(storage);
    storage.flushPendingLocalChanges = () => Promise.reject(new Error('Synthetic local commit interruption'));
    (window as any).__s1RestoreFlush = () => { storage.flushPendingLocalChanges = flush; };
  });
  await createTask(page, 'S1 retry retained action');
  await expect(page.getByTitle('Synthetic local commit interruption')).toBeVisible();
  await page.evaluate(() => (window as any).__s1RestoreFlush());
  await page.getByTitle('Synthetic local commit interruption').click();
  await page.getByRole('button', { name: 'Retry sync', exact: true }).click();
  await expect.poll(() => page.evaluate(async user => {
    const meta = await (window as any).__s1Storage.get('sync', user);
    return meta.outbox.some((m: any) => m.payload?.title === 'S1 retry retained action');
  }, user)).toBe(true);
  await expect(page.getByTitle('Synthetic local commit interruption')).toHaveCount(0);
});
