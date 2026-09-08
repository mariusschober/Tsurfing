import { test, expect, type Locator, type Page } from '@playwright/test';

const widths = [320, 360, 375, 390, 430, 640, 768, 870, 1023, 1024, 1280, 1440, 1535, 1536, 1920];
const destinations = ['Current', 'Plan', 'Habits', 'Goals', 'Insights'];
const user = 'test@goalflow.local';

async function unlock(page: Page) {
  await page.goto('/');
  const gate = page.locator('#test-code');
  await expect(gate.or(page.locator('header'))).toBeVisible({ timeout: 20_000 });
  if (await gate.isVisible()) {
    await gate.fill('123456');
    await page.getByRole('button', { name: 'Enter test app' }).click();
  }
  await expect(page.locator('header')).toBeVisible();
  await page.waitForFunction(() => Boolean((window as any).__navigationStorage));
  await page.evaluate(() => document.fonts.ready);
}

async function fitsDocument(page: Page) {
  const sizes = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(sizes.document, JSON.stringify(sizes)).toBeLessThanOrEqual(sizes.viewport + 1);
  expect(sizes.body, JSON.stringify(sizes)).toBeLessThanOrEqual(sizes.viewport + 1);
}

async function fitsViewport(page: Page, element: Locator, margin = 0) {
  const rect = await element.boundingBox();
  expect(rect).not.toBeNull();
  const viewport = page.viewportSize()!;
  expect(rect!.x).toBeGreaterThanOrEqual(margin - 1);
  expect(rect!.x + rect!.width).toBeLessThanOrEqual(viewport.width - margin + 1);
  expect(rect!.y).toBeGreaterThanOrEqual(margin - 1);
  expect(rect!.y + rect!.height).toBeLessThanOrEqual(viewport.height - margin + 1);
}

async function usableControls(scope: Locator) {
  const failures = await scope.locator('button, input[type="range"]').evaluateAll(elements => elements.flatMap(element => {
    if (!element.getClientRects().length) return [];
    const rect = element.getBoundingClientRect();
    const owner = element.closest('[role="dialog"], header')!.getBoundingClientRect();
    return rect.width < 43.9 || rect.height < 43.9 || rect.left < owner.left - 1 || rect.right > owner.right + 1
      ? [{ name: element.getAttribute('aria-label') || element.textContent, width: rect.width, height: rect.height, left: rect.left, right: rect.right }]
      : [];
  }));
  expect(failures).toEqual([]);
}

async function openMenu(page: Page) {
  await page.getByRole('button', { name: 'Open menu', exact: true }).click();
  const menu = page.getByRole('dialog', { name: 'Menu', exact: true });
  await expect(menu).toBeVisible();
  return menu;
}

async function navigate(page: Page, name: string) {
  const headerButton = page.locator('header').getByRole('button', { name, exact: true });
  if (await headerButton.isVisible()) await headerButton.click();
  else await (await openMenu(page)).getByRole('button', { name, exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Menu', exact: true })).toBeHidden();
}

async function mockRadio(page: Page) {
  // Only the external media device is replaced; the real React player and UI run unchanged.
  await page.addInitScript(() => {
    const instances: any[] = [];
    class RadioAudio extends EventTarget {
      src = ''; preload = ''; volume = 1; paused = true; loads = 0; plays = 0; pauses = 0;
      constructor() { super(); instances.push(this); }
      load() { this.loads++; }
      play() { this.plays++; this.paused = false; this.dispatchEvent(new Event('playing')); return Promise.resolve(); }
      pause() { this.pauses++; this.paused = true; this.dispatchEvent(new Event('pause')); }
    }
    Object.assign(window, { Audio: RadioAudio, __navigationAudio: instances });
  });
}

const radioState = (page: Page) => page.evaluate(() => (window as any).__navigationAudio.map((audio: any) => ({
  src: audio.src, volume: audio.volume, paused: audio.paused, loads: audio.loads, plays: audio.plays, pauses: audio.pauses,
})));

for (const theme of ['light', 'dark'] as const) test(`${theme}: all 15 widths fit with labelled navigation, targets and unclipped panels`, async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
  await unlock(page);
  await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /dark/ : /^$/);
  for (const width of widths) await test.step(`${width}px`, async () => {
    await page.setViewportSize({ width, height: 900 });
    const layout = width < 1024 ? 'compact' : width < 1536 ? 'standard' : 'wide';
    await expect(page.locator('header')).toHaveAttribute('data-layout', layout);
    await fitsDocument(page);
    await fitsViewport(page, page.locator('header'));
    await usableControls(page.locator('header'));
    expect(await page.locator('html').evaluate(element => getComputedStyle(element).overflowX)).not.toMatch(/hidden|clip/);
    await expect(page.locator('header').getByText('Manual', { exact: true })).toHaveCount(0);
    await expect(page.locator('header').getByText('Bio-Adaptive', { exact: true })).toHaveCount(0);
    for (const name of destinations) {
      const button = page.locator('header').getByRole('button', { name, exact: true });
      if (layout === 'compact') await expect(button).toBeHidden();
      else await expect(button).toBeVisible();
    }
    if ([320, 390, 1024, 1440, 1920].includes(width)) await page.screenshot({ path: testInfo.outputPath(`${theme}-${width}-closed.png`) });
    const menu = await openMenu(page);
    await expect(page.getByRole('button', { name: 'Open menu', includeHidden: true })).toHaveAttribute('aria-expanded', 'true');
    await fitsViewport(page, menu, 12);
    await fitsDocument(page);
    await usableControls(menu);
    expect(await menu.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await expect(menu.getByRole('button', { name: 'Manual', exact: true })).toHaveCount(0);
    await expect(menu.getByRole('button', { name: 'Bio-Adaptive', exact: true })).toHaveCount(0);
    if (layout === 'compact') for (const name of destinations) await expect(menu.getByRole('button', { name, exact: true })).toBeVisible();
    else await expect(menu.getByRole('navigation')).toHaveCount(0);
    if (layout === 'wide') await expect(menu.getByRole('button', { name: 'Select station' })).toHaveCount(0);
    else await expect(menu.getByRole('button', { name: 'Select station' })).toBeVisible();
    await expect(menu.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
    await expect(menu.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
    if ([320, 390, 1024, 1440, 1920].includes(width)) await page.screenshot({ path: testInfo.outputPath(`${theme}-${width}-menu.png`) });
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(page.getByRole('button', { name: 'Open menu' })).toBeFocused();
    const sync = page.getByRole('button', { name: /^Sync status:/ });
    await sync.click();
    const panel = page.getByRole('dialog', { name: 'Sync status', exact: true });
    await fitsViewport(page, panel, 12);
    await usableControls(panel);
    await fitsDocument(page);
    await panel.getByRole('button', { name: 'Close Sync status' }).click();
    await expect(sync).toBeFocused();
  });
});

test('keyboard containment, dismissal, Search and Settings transfer and restore focus', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 700 });
  await unlock(page);
  const trigger = page.getByRole('button', { name: 'Open menu' });
  await trigger.focus();
  await page.keyboard.press('Enter');
  const menu = page.getByRole('dialog', { name: 'Menu', exact: true });
  await expect(menu.getByRole('button', { name: 'Close Menu' })).toBeFocused();
  expect(await page.locator('#root').evaluate(element => (element as HTMLElement).inert)).toBe(true);
  await page.keyboard.press('Shift+Tab');
  await expect(menu.getByRole('button', { name: 'Sign out' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(menu.getByRole('button', { name: 'Close Menu' })).toBeFocused();
  for (const key of ['p', 'g', 'h', 's', '/', 'm', 'a']) await page.keyboard.press(key);
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await expect(menu.getByRole('button', { name: 'Current', exact: true })).toHaveAttribute('aria-current', 'page');
  await page.mouse.click(2, 2);
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();
  expect(await page.locator('#root').evaluate(element => (element as HTMLElement).inert)).toBe(false);
  await (await openMenu(page)).getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(settings).toBeVisible();
  await expect(menu).toBeHidden();
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await expect.poll(() => settings.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await fitsViewport(page, settings);
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();
  await expect(trigger).toBeFocused();
  const searchTrigger = page.getByRole('button', { name: 'Search', exact: true });
  await searchTrigger.click();
  const search = page.getByRole('dialog', { name: /Search/ });
  await expect(search.getByRole('textbox')).toBeFocused();
  await fitsViewport(page, search);
  await page.keyboard.press('Escape');
  await expect(searchTrigger).toBeFocused();
  await (await openMenu(page)).getByRole('button', { name: 'Plan', exact: true }).click();
  await page.getByRole('button', { name: 'Tsurfing — go to Current' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Mode: Manual' })).toBeVisible();
});

test('open panels reflow during rotation and dismiss when their header layout changes', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await unlock(page);
  const menu = await openMenu(page);
  await page.setViewportSize({ width: 870, height: 390 });
  await expect(menu).toBeVisible();
  await fitsViewport(page, menu, 12);
  await fitsDocument(page);
  await page.setViewportSize({ width: 1024, height: 700 });
  await expect(menu).toBeHidden();
  await expect(page.getByRole('button', { name: 'Open menu' })).toBeFocused();
  await page.getByRole('button', { name: /^Sync status:/ }).click();
  const sync = page.getByRole('dialog', { name: 'Sync status', exact: true });
  await page.setViewportSize({ width: 1440, height: 320 });
  await expect(sync).toBeVisible();
  await fitsViewport(page, sync, 12);
  await page.setViewportSize({ width: 1536, height: 700 });
  await expect(sync).toBeHidden();
  await expect(page.getByRole('button', { name: /^Sync status:/ })).toBeFocused();
  await page.getByRole('button', { name: 'Select station' }).click();
  const music = page.getByRole('dialog', { name: 'Focus music', exact: true });
  await page.setViewportSize({ width: 1920, height: 320 });
  await expect(music).toBeVisible();
  await fitsViewport(page, music, 12);
  await music.getByRole('button', { name: /^Groove Salad Classic/ }).scrollIntoViewIfNeeded();
  await fitsViewport(page, music.getByRole('button', { name: /^Groove Salad Classic/ }), 12);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Select station' })).toBeFocused();
});

test('radio playback, station and volume survive Menu, resizing and the hidden header', async ({ page }) => {
  await mockRadio(page);
  await page.setViewportSize({ width: 1920, height: 900 });
  await unlock(page);
  await page.getByRole('button', { name: 'Play focus music' }).click();
  await page.getByRole('button', { name: 'Select station' }).click();
  const picker = page.getByRole('dialog', { name: 'Focus music', exact: true });
  await picker.getByRole('slider', { name: 'Music volume' }).fill('0.25');
  await picker.getByRole('button', { name: /^Groove Salad A nicely/ }).click();
  await expect(picker).toBeHidden();
  await expect(page.getByRole('button', { name: 'Select station' })).toBeFocused();
  const baseline = await radioState(page);
  expect(baseline).toHaveLength(1);
  expect(baseline[0]).toMatchObject({ paused: false, volume: 0.25, src: 'https://ice1.somafm.com/groovesalad-128-mp3' });
  await page.getByRole('button', { name: 'Select station' }).click();
  await page.setViewportSize({ width: 390, height: 650 });
  await expect(picker).toBeHidden();
  await expect(page.getByRole('button', { name: 'Open menu' })).toBeFocused();
  for (const width of [390, 1024, 1536, 320, 1920, 768]) {
    await page.setViewportSize({ width, height: 650 });
    const menu = await openMenu(page);
    if (width < 1536) {
      await expect(menu.getByRole('button', { name: 'Pause focus music' })).toBeVisible();
      await menu.getByRole('button', { name: 'Select station' }).click();
      await expect(menu.getByRole('slider', { name: 'Music volume' })).toHaveValue('0.25');
      await expect(menu.getByRole('button', { name: /^Groove Salad A nicely/ })).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByRole('dialog')).toHaveCount(1);
      await usableControls(menu);
      await fitsDocument(page);
    }
    await page.keyboard.press('Escape');
    expect(await radioState(page)).toEqual(baseline);
  }
  const menu = await openMenu(page);
  await menu.locator('.navigation-progress button').click();
  await expect(page.locator('header')).toBeHidden();
  expect(await radioState(page)).toEqual(baseline);
});

test('short landscapes, long text, enlarged text and reduced motion keep panels usable', async ({ page }) => {
  test.setTimeout(90_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await unlock(page);
  const longAccount = `${'long-account-name-'.repeat(12)}@example.test`;
  await page.evaluate(account => (window as any).__navigationRenderAccount(account), longAccount);
  for (const width of [320, 870, 1024, 1920]) {
    await page.setViewportSize({ width, height: 320 });
    const menu = await openMenu(page);
    await expect(menu.getByText(longAccount, { exact: true })).toBeVisible();
    await fitsViewport(page, menu, 12);
    await fitsDocument(page);
    await usableControls(menu);
    await menu.getByRole('button', { name: 'Sign out' }).scrollIntoViewIfNeeded();
    await fitsViewport(page, menu.getByRole('button', { name: 'Sign out' }), 12);
    await fitsViewport(page, menu.getByRole('button', { name: 'Close Menu' }), 12);
    await page.keyboard.press('Escape');
    await page.evaluate(account => window.dispatchEvent(new CustomEvent('goalflow:sync-state', { detail: {
      userKey: account, state: 'error', message: 'A long connection diagnostic '.repeat(24) + 'unbroken'.repeat(24),
    } })), longAccount);
    await page.getByRole('button', { name: 'Sync status: Sync error' }).click();
    const sync = page.getByRole('dialog', { name: 'Sync status', exact: true });
    await fitsViewport(page, sync, 12);
    await fitsDocument(page);
    await sync.getByRole('button', { name: 'Retry sync' }).scrollIntoViewIfNeeded();
    await fitsViewport(page, sync.getByRole('button', { name: 'Retry sync' }), 12);
    await page.keyboard.press('Escape');
  }
  // Text-only enlargement adds stress beyond the separate 320 CSS px reflow matrix.
  await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
  for (const width of [320, 640, 1024, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    await fitsViewport(page, page.locator('header'));
    await usableControls(page.locator('header'));
    const menu = await openMenu(page);
    await fitsViewport(page, menu, 12);
    await usableControls(menu);
    expect(await menu.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await page.keyboard.press('Escape');
  }
});

test('primary destinations, Insights/Done and overdue navigation restrictions remain intact', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 850 });
  await unlock(page);
  for (const name of ['Plan', 'Habits', 'Goals', 'Insights']) {
    await navigate(page, name);
    const menu = await openMenu(page);
    await expect(menu.getByRole('button', { name, exact: true })).toHaveAttribute('aria-current', 'page');
    await page.keyboard.press('n');
    await expect(page.getByRole('dialog')).toHaveCount(1);
    await page.keyboard.press('Escape');
  }
  await page.getByRole('button', { name: 'View All', exact: true }).click();
  await expect((await openMenu(page)).getByRole('button', { name: 'Insights', exact: true })).toHaveAttribute('aria-current', 'page');
  await page.keyboard.press('Escape');
  await page.evaluate(async () => {
    const account = 'navigation-overdue@example.test';
    const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
    const dateAssigned = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;
    await (window as any).__navigationStorage.set('tasks', account, [{ id: 'overdue-navigation', title: 'Overdue task', completed: false, isFrog: false, createdAt: Date.now(), hashtags: [], dateAssigned }], 'cloud');
    (window as any).__navigationRenderAccount(account);
  });
  await expect(page.getByRole('button', { name: 'Mode: Manual' })).toBeHidden();
  const menu = await openMenu(page);
  await expect(menu.getByText('Complete overdue tasks in Plan to unlock the other views.')).toBeVisible();
  for (const name of destinations.filter(name => name !== 'Plan')) await expect(menu.getByRole('button', { name, exact: true })).toBeDisabled();
  await expect(menu.getByRole('button', { name: 'Plan', exact: true })).toBeEnabled();
});

test('Plan mode is independent; Current check-in and cancellation retain existing behavior', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 850 });
  await unlock(page);
  await page.getByRole('button', { name: 'Mode: Manual' }).click();
  const selector = page.getByRole('dialog', { name: 'Planning mode', exact: true });
  await selector.getByRole('button', { name: 'Bio-Adaptive', exact: true }).click();
  await page.getByRole('button', { name: 'Exit', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Mode: Manual' })).toBeVisible();
  await page.evaluate(async () => {
    const account = 'navigation-mode@example.test';
    const today = new Date();
    const lastCheckIn = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    await (window as any).__navigationStorage.set('circadian', account, { lastCheckIn, score: 90, mode: 'apex', metrics: { sunrise: false, sleepHours: 8, energy: 90, clarity: 90, interest: 90 } }, 'cloud');
    (window as any).__navigationRenderAccount(account);
  });
  await expect(page.getByRole('button', { name: 'Mode: Bio-Adaptive' })).toBeVisible();
  await page.getByRole('button', { name: 'Mode: Bio-Adaptive' }).click();
  await expect(selector.getByRole('button', { name: 'Bio-Adaptive' })).toHaveAttribute('aria-pressed', 'true');
  await expect(selector.getByText('Apex', { exact: true })).toBeVisible();
  await selector.getByRole('button', { name: 'Bio-Adaptive' }).click();
  await page.getByRole('button', { name: 'Exit', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Mode: Bio-Adaptive' })).toBeVisible();
  await navigate(page, 'Plan');
  await expect(page.getByRole('button', { name: 'Manual', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('Apex', { exact: true })).toBeHidden();
  await page.getByRole('button', { name: 'Manual', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Manual', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await navigate(page, 'Current');
  await expect(page.getByRole('button', { name: 'Mode: Bio-Adaptive' })).toBeVisible();
});

test('opening Menu and crossing breakpoints preserve the active task and focus session', async ({ page }, testInfo) => {
  await unlock(page);
  await page.getByTitle('Add new task (a)').click();
  const form = page.getByRole('dialog', { name: 'New Task' });
  await form.getByPlaceholder('What is the next action?').fill('Responsive navigation focus session');
  await form.locator('[aria-label="Task schedule"]').getByRole('button', { name: 'Today', exact: true }).click();
  await form.getByRole('button', { name: 'Create Task', exact: true }).click();
  await navigate(page, 'Plan');
  await page.getByRole('button', { name: 'Start focus', exact: true }).click();
  await page.getByTitle('Start Focus (Space)').click();
  await expect(page.getByTitle('Pause Timer (Space)')).toBeVisible();
  const focus = () => page.evaluate(async account => {
    await (window as any).__navigationStorage.flushPendingLocalChanges(account);
    return (await (window as any).__navigationStorage.get('tracking', account)).focusSession;
  }, user);
  const before = await focus();
  const contentMeasurements = [];
  for (const width of [390, 320, 1024, 1536, 870]) {
    await page.setViewportSize({ width, height: 900 });
    await fitsViewport(page, page.locator('header'));
    const menu = await openMenu(page);
    for (const key of ['n', 'e', 'd']) await page.keyboard.press(key);
    await expect(page.getByRole('dialog')).toHaveCount(1);
    if (width < 1536) {
      await menu.getByRole('button', { name: 'Select station' }).focus();
      await page.keyboard.press('Space');
      await expect(menu.getByRole('button', { name: 'Select station' })).toHaveAttribute('aria-expanded', 'true');
      expect(await focus()).toEqual(before);
    }
    await page.keyboard.press('Escape');
    await expect(page.getByRole('heading', { name: 'Responsive navigation focus session', exact: true })).toBeVisible();
    await expect(page.getByTitle('Pause Timer (Space)')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Mode: Manual' })).toBeVisible();
    expect(await focus()).toEqual(before);
    contentMeasurements.push(await page.evaluate(() => ({ width: document.documentElement.clientWidth, document: document.documentElement.scrollWidth })));
  }
  // Main-view layout is outside this header change; preserve evidence separately.
  await testInfo.attach('active-task-content-widths', { body: JSON.stringify(contentMeasurements, null, 2), contentType: 'application/json' });
});

test.describe('touch input', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
  test('tap navigation, inline stations, theme and account actions', async ({ page }) => {
    await mockRadio(page);
    await unlock(page);
    await page.getByRole('button', { name: 'Open menu' }).tap();
    const menu = page.getByRole('dialog', { name: 'Menu', exact: true });
    await menu.getByRole('button', { name: 'Plan', exact: true }).tap();
    await expect(page.getByRole('heading', { name: "Today's Flow", exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Open menu' }).tap();
    await menu.getByRole('button', { name: 'Select station' }).tap();
    await expect(menu.getByRole('slider', { name: 'Music volume' })).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(1);
    await menu.getByRole('button', { name: /^Groove Salad A nicely/ }).tap();
    await expect(menu.getByRole('button', { name: 'Select station' })).toBeFocused();
    await expect(menu.getByRole('button', { name: 'Select station' })).toHaveAttribute('aria-expanded', 'false');
    await menu.getByRole('button', { name: /Switch to .* theme/ }).tap();
    await fitsDocument(page);
    await menu.getByRole('button', { name: 'Settings', exact: true }).tap();
    await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Close dialog', exact: true }).tap();
    await page.getByRole('button', { name: 'Open menu' }).tap();
    await menu.getByRole('button', { name: 'Sign out', exact: true }).tap();
    await expect(page.locator('header')).toBeHidden();
  });
});
