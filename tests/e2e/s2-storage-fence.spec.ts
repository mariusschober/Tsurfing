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
