import { test, expect } from '@playwright/test';

async function unlock(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.locator('#test-code').fill('123456');
  await page.getByRole('button', { name: 'Enter test app' }).click();
  await expect(page.locator('header')).toBeVisible();
}

test('reload recovers a divergent pending task without overwriting either edit', async ({ page }) => {
  await unlock(page);
  const fixture = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(localStorage.getItem('goalflow_active_database_v2') || 'GoalflowDB');
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const key = 'test@goalflow.local';
    const now = Date.now();
    const task = { id: crypto.randomUUID(), title: 'Recovered task stays visible', createdAt: now, updatedAt: now,
      completed: false, dateAssigned: new Date().toLocaleDateString('en-CA'), priority: 'medium', session: 'morning',
      schedulePrecision: 'day', lifecycleStatus: 'open', plannedOrder: 0 };
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('tasks', 'readwrite'); tx.objectStore('tasks').put([task], key);
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
    });
    db.close();
    const before = { ...task, title: 'Earlier task' }, after = { ...task, title: 'Preserved pending task' };
    const id = crypto.randomUUID(), mutationId = crypto.randomUUID(), updatedAt = new Date(now - 1000).toISOString();
    return { walKey: `goalflow_wal_v2_${encodeURIComponent(key)}_${id}`, mutationId, transaction: {
      id, userKey: key, storageKey: key, storeName: 'tasks', previousValue: [before], hasPreviousValue: true,
      value: [after], order: now, createdAt: updatedAt,
      changes: [{ mutationId, entityType: 'tasks', entityId: task.id, payload: after, updatedAt, deletedAt: null }]
    }};
  });
  await page.addInitScript(fixture => localStorage.setItem(fixture.walKey, JSON.stringify(fixture.transaction)), fixture);
  await page.reload();
  await expect(page.locator('header')).toBeVisible();
  await expect(page.getByText('Loading your tasks...')).toHaveCount(0);
  const history = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>(resolve => { const request = indexedDB.open('GoalflowDB'); request.onsuccess = () => resolve(request.result); });
    const meta = await new Promise<any>(resolve => { const request = db.transaction('sync').objectStore('sync').get('test@goalflow.local'); request.onsuccess = () => resolve(request.result); });
    db.close(); return meta.conflicts.flatMap((item: any) => item.localHistory);
  });
  expect(history).toContainEqual(expect.objectContaining({mutationId: fixture.mutationId, updatedAt: fixture.transaction.changes[0].updatedAt}));
});

test('unreadable saved data shows a retry screen instead of an endless spinner', async ({ page }) => {
  await unlock(page);
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>(resolve => { const request = indexedDB.open('GoalflowDB'); request.onsuccess = () => resolve(request.result); });
    await new Promise<void>(resolve => { const tx = db.transaction('daily_plans', 'readwrite'); tx.objectStore('daily_plans').put('invalid fixture', 'test@goalflow.local'); tx.oncomplete = () => resolve(); });
    db.close();
  });
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('Your saved data couldn’t be opened');
  await expect(page.getByText('Loading your tasks...')).toHaveCount(0);
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>(resolve => { const request = indexedDB.open('GoalflowDB'); request.onsuccess = () => resolve(request.result); });
    await new Promise<void>(resolve => { const tx = db.transaction('daily_plans', 'readwrite'); tx.objectStore('daily_plans').put([], 'test@goalflow.local'); tx.oncomplete = () => resolve(); });
    db.close();
  });
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.locator('header')).toBeVisible();
});
