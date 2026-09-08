import { test, expect, type Page } from '@playwright/test';

async function seed(page: Page) {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.clock.install({ time: new Date('2028-02-27T12:00:00Z') });
  await page.goto('/');
  await expect(page.locator('#test-code').or(page.locator('header'))).toBeVisible();
  if (await page.locator('#test-code').isVisible()) {
    await page.locator('#test-code').fill('123456');
    await page.getByRole('button', { name: 'Enter test app' }).click();
  }
  await expect(page.locator('header')).toBeVisible();
  await page.evaluate(async () => {
    const tasks = Array.from({ length: 370 }, (_, i) => ({
      id: `future-${i}`, title: `Future example ${i}`, duration: 10, dateAssigned: i < 20 ? '2028-02-28' : '2028-02-29',
      scheduledFor: i < 20 ? '2028-02-28' : '2028-02-29', schedulePrecision: 'day', completed: false, wontDo: false,
      isFrog: false, hashtags: [], createdAt: i + 1, plannedOrder: i,
    }));
    tasks.push({ ...tasks[0], id: 'month-only', title: 'Undated March task', dateAssigned: '2028-03-01', scheduledFor: '2028-03', schedulePrecision: 'month' });
    await (window as any).__navigationStorage.set('tasks', 'test@goalflow.local', tasks, 'cloud');
    (window as any).__navigationRenderAccount('test@goalflow.local');
  });
  const plan = page.locator('header').getByRole('button', { name: 'Plan', exact: true });
  await expect(plan).toBeVisible();
  await plan.click();
  await expect(page.getByRole('heading', { name: "Plan today's flow", exact: true })).toBeVisible();
}

test('Horizon keeps all tomorrow tasks, then three; list renders every future task incrementally', async ({ page }) => {
  await seed(page);
  for (let i = 0; i < 23; i++) await expect(page.getByText(`Future example ${i}`, { exact: true })).toBeVisible();
  await expect(page.getByText('Future example 23', { exact: true })).toHaveCount(0);
  const open = page.getByRole('button', { name: 'View planned tasks (371)' });
  await open.click();
  const dialog = page.getByRole('dialog', { name: 'Planned tasks', exact: true });
  await expect(dialog).toBeVisible();
  while (await dialog.getByRole('button', { name: 'Show more tasks' }).count()) {
    const count = await dialog.getByText(/^Future example \d+$/).count();
    await dialog.locator('.planned-browser-scroll').first().evaluate(element => { element.scrollTop = element.scrollHeight; });
    await expect.poll(async () => await dialog.getByText(/^Future example \d+$/).count()).toBeGreaterThan(count);
  }
  await expect(dialog.getByText('Future example 369', { exact: true })).toBeVisible();
  await expect(dialog.getByText('March 2028 · No day assigned', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(open).toBeFocused();
});

for (const theme of ['light', 'dark'] as const) test(`Calendar ${theme}: leap-day add, nested cancellation, month-only tasks and small screens`, async ({ page }, info) => {
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
  await seed(page);
  await page.getByRole('button', { name: 'View planned tasks (371)' }).click();
  const dialog = page.getByRole('dialog', { name: 'Planned tasks', exact: true });
  await dialog.getByRole('button', { name: 'Calendar', exact: true }).click();
  const leap = dialog.getByRole('button', { name: /Tuesday, February 29, 2028, 350 tasks/ });
  await leap.click();
  await expect(dialog.getByText('+347 more', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Future example 369', { exact: true })).toHaveCount(1);
  const add = dialog.getByRole('button', { name: /Add task on Tuesday, February 29, 2028/ });
  await add.focus(); await add.click();
  const form = page.getByRole('dialog').filter({ has: page.locator('textarea') });
  await expect(form).toBeVisible();
  await expect(form.getByText('2028-02-29', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(form).toBeHidden();
  await expect(dialog).toBeVisible();
  await expect(add).toBeFocused();
  await add.click();
  await form.getByPlaceholder('What is the next action?').fill('Leap-day appointment');
  await form.getByRole('button', { name: 'Create Task', exact: true }).click();
  await expect(form).toBeHidden();
  await expect(dialog.getByRole('button', { name: /Tuesday, February 29, 2028, 351 tasks/ })).toHaveAttribute('aria-pressed', 'true');
  const saved = await page.evaluate(async () => {
    const storage = (window as any).__navigationStorage;
    await storage.flushPendingLocalChanges('test@goalflow.local');
    return (await storage.get('tasks', 'test@goalflow.local')).find((task: any) => task.title === 'Leap-day appointment');
  });
  expect(saved).toMatchObject({ scheduledFor: '2028-02-29', dateAssigned: '2028-02-29', schedulePrecision: 'day' });
  await dialog.getByRole('button', { name: 'Next month', exact: true }).click();
  await expect(dialog.getByText('March 2028 · No day assigned', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: /Wednesday, March 1, 2028, 0 tasks/ })).toBeVisible();
  for (const [width, height] of [[1366, 768], [390, 844], [320, 568]]) {
    await page.setViewportSize({ width, height });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await expect(dialog.getByRole('button', { name: 'Close Planned tasks' })).toBeVisible();
    await page.screenshot({ path: info.outputPath(`calendar-${theme}-${width}.png`) });
  }
});
