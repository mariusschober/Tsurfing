import { test, expect, type Page } from '@playwright/test';
const account = 'test@goalflow.local';
const nav = (page: Page, name: string) => page.locator('header').getByRole('button', { name, exact: true }).click();
async function setup(page: Page, targetAccount = account) {
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.goto('/');
  await expect(page.locator('#test-code').or(page.locator('header'))).toBeVisible();
  if (await page.locator('#test-code').isVisible()) {
    await page.locator('#test-code').fill('123456'); await page.getByRole('button', { name: 'Enter test app' }).click();
  }
  await expect(page.locator('header')).toBeVisible();
  await page.evaluate(async account => {
    const now = new Date(), date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const tasks = ['First task', 'Second task'].map((title, i) => ({ id: `daily-${i}`, title, createdAt: i + 1, duration: 10,
      dateAssigned: date, scheduledFor: date, schedulePrecision: 'day', completed: false, isFrog: false, hashtags: [], plannedOrder: i }));
    await (window as any).__navigationStorage.set('tasks', account, tasks, 'cloud');
    (window as any).__navigationRenderAccount(account);
  }, targetAccount);
  await expect(page.locator('header')).toBeVisible();
  await nav(page, 'Plan');
  await expect(page.getByRole('button', { name: 'Lock & focus', exact: true })).toBeEnabled();
}
async function swap(page: Page) {
  const item = page.locator('[data-rfd-draggable-id]').first();
  await item.focus(); await page.keyboard.press('Space'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Space');
}
async function durableOrder(page: Page) {
  return page.evaluate(async account => (await (window as any).__navigationStorage.get('tasks', account))
    .sort((a: any, b: any) => a.plannedOrder - b.plannedOrder).map((task: any) => task.title), account);
}
test('daily order locks, drafts stay private, cancellation and reload preserve the correct state', async ({ page }) => {
  await setup(page);
  await page.getByRole('button', { name: 'Lock & focus', exact: true }).click();
  await expect(page.getByTitle('Start Focus (Space)')).toBeVisible();
  await nav(page, 'Plan');
  await expect(page.getByText('Order locked · 3 free replans left', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Prioritize', exact: true })).toBeDisabled();
  await expect(page.locator('[data-rfd-drag-handle-draggable-id]')).toHaveCount(0);
  for (let i = 0; i < 8; i++) { await nav(page, 'Habits'); await nav(page, 'Plan'); }
  await expect(page.getByText('Order locked · 3 free replans left', { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Decision Fatigue Warning' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Replan', exact: true }).click();
  await swap(page);
  await expect(page.locator('.planning-task__title').first()).toHaveText('Second task');
  expect(await durableOrder(page)).toEqual(['First task', 'Second task']);
  await nav(page, 'Habits'); await nav(page, 'Plan');
  await expect(page.getByText('Unconfirmed order changes', { exact: true })).toBeVisible();
  await page.reload(); await nav(page, 'Plan');
  await expect(page.getByText('Unconfirmed order changes', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(page.locator('.planning-task__title').first()).toHaveText('Second task');
  await page.getByRole('button', { name: 'Cancel changes', exact: true }).click();
  await expect(page.locator('.planning-task__title').first()).toHaveText('First task');
  await page.getByRole('button', { name: 'Replan', exact: true }).click(); await swap(page);
  await page.getByRole('button', { name: 'Save order & focus', exact: true }).click();
  await expect(page.getByTitle('Start Focus (Space)')).toBeVisible();
  await nav(page, 'Plan');
  await expect(page.getByText('Order locked · 2 free replans left', { exact: true })).toBeVisible();
  expect(await durableOrder(page)).toEqual(['Second task', 'First task']);
  await expect(page.getByText('Pending sync · allowance provisional.', { exact: true })).toBeVisible();
});


test('a stale saved draft requires review against the current revision before confirmation', async ({ page }) => {
  await setup(page);
  await page.getByRole('button', { name: 'Lock & focus', exact: true }).click();
  await expect(page.getByTitle('Start Focus (Space)')).toBeVisible();
  await nav(page, 'Plan');
  await page.getByRole('button', { name: 'Replan', exact: true }).click();
  await swap(page);
  await nav(page, 'Habits');
  await page.evaluate(async account => {
    const api = (window as any).__navigationStorage;
    const now = new Date(), date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const original = await api.readDailyPlanning(account, date);
    await api.confirmPlanningOrder({ schemaVersion: 1, operationId: crypto.randomUUID(), accountId: account,
      localDate: date, baselineRevision: original.policy.revision, proposedOrder: ['daily-0', 'daily-1'],
      ratings: [], maximumAcceptedXp: 0, capturedAt: new Date().toISOString() });
    await api.savePlanningDraft(original.draft);
  }, account);
  await page.reload(); await nav(page, 'Plan');
  await expect(page.getByText('The confirmed order changed while this draft was saved.', { exact: true })).toBeVisible();
  expect(await durableOrder(page)).toEqual(['First task', 'Second task']);
  await page.getByRole('button', { name: 'Review saved order', exact: true }).click();
  await expect(page.locator('.planning-task__title').first()).toHaveText('Second task');
  expect(await durableOrder(page)).toEqual(['First task', 'Second task']);
  await page.getByRole('button', { name: 'Save order & focus', exact: true }).click();
  await expect(page.getByTitle('Start Focus (Space)')).toBeVisible();
  await nav(page, 'Plan');
  await expect(page.getByText('Order locked · 2 free replans left', { exact: true })).toBeVisible();
  expect(await durableOrder(page)).toEqual(['Second task', 'First task']);
});

test('a rejected offline confirmation can reopen its proposal without confirming or charging it', async ({ page }) => {
  const user = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  await setup(page, user);
  await page.getByRole('button', { name: 'Lock & focus', exact: true }).click();
  await expect(page.getByTitle('Start Focus (Space)')).toBeVisible();
  await page.evaluate(async user => {
    for (const info of await indexedDB.databases()) {
      if (!info.name) continue;
      const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open(info.name!); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      if (!db.objectStoreNames.contains('planning_state')) { db.close(); continue; }
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('planning_state', 'readwrite'), store = tx.objectStore('planning_state'), read = store.get(user);
        read.onsuccess = () => {
          const state = read.result; if (!state) return;
          const pending = Object.values(state.planning.pending)[0] as any;
          const command = pending.command;
          const receipt = { ...pending.provisional, code: 'STALE_REVISION', revision: null, order: [], actualDebit: 0, acceptedReplans: 0 };
          const policy = { schemaVersion: 1, accountId: user, localDate: command.localDate, revision: null, confirmedOrder: [], acceptedReplans: 0, history: [receipt] };
          const response = { schemaVersion: 1, accountId: user, receipt, policy, records: [] };
          pending.request = JSON.stringify(command); pending.response = response; pending.review = 'STALE_REVISION';
          pending.reviewSnapshots = [{ schemaVersion: 1, accountId: user, operationId: command.operationId, response, policy, missingTaskIds: [],
            records: pending.members.map((member: any, index: number) => ({ user_id: user, entity_type: member.entityType, entity_id: member.entityId,
              version: 1, server_version: index + 1, device_id: 'other-device', payload: member.payload, updated_at: command.capturedAt, deleted_at: null })) }];
          store.put(state);
        };
        tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
      }); db.close();
    }
    window.dispatchEvent(new CustomEvent('goalflow:planning-change', { detail: { userKey: user } }));
  }, user);
  await nav(page, 'Plan');
  await expect(page.getByText('Your offline order needs review.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Review my order', exact: true }).click();
  await expect(page.getByText('Your offline order needs review.', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Lock & focus', exact: true })).toBeEnabled();
  const state = await page.evaluate(async user => {
    const now = new Date(), date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    return (window as any).__navigationStorage.readDailyPlanning(user, date);
  }, user);
  expect(state.pending).toHaveLength(0); expect(state.draft.proposedOrder).toEqual(['daily-0', 'daily-1']);
  expect(state.policy.revision).toBeNull(); expect(state.policy.acceptedReplans).toBe(0);
});

test('an older saved order stays accessible and never becomes today’s draft', async ({ page }) => {
  await setup(page);
  const date = await page.evaluate(async account => {
    const old = new Date(); old.setDate(old.getDate() - 1);
    const date = `${old.getFullYear()}-${String(old.getMonth() + 1).padStart(2, '0')}-${String(old.getDate()).padStart(2, '0')}`;
    await (window as any).__navigationStorage.savePlanningDraft({ schemaVersion: 1, accountId: account,
      localDate: date, baselineRevision: null, proposedOrder: ['daily-1', 'daily-0'], ratings: [],
      maximumAcceptedXp: 0, updatedAt: old.toISOString() });
    return date;
  }, account);
  await page.getByRole('button', { name: date, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: `Saved order · ${date}`, exact: true });
  await dialog.getByRole('button', { name: 'Review saved order', exact: true }).click();
  await expect(dialog.getByText('No open tasks remain on this date.', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: `Confirm order for ${date}`, exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Discard saved changes', exact: true }).click();
  await expect(dialog.getByText('No unresolved order changes remain for this date.', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Lock & focus', exact: true })).toBeEnabled();
  expect(await durableOrder(page)).toEqual(['First task', 'Second task']);
});
