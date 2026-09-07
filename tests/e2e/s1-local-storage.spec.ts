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
