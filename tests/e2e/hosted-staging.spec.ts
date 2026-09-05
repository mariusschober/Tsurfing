import { randomUUID } from 'node:crypto';
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
  type Request,
  type Response,
  type TestInfo
} from '@playwright/test';
import { installHostedTestSession } from './hosted-auth';

const REALTIME_P95_BUDGET_MS = 2_000;
const REALTIME_SAMPLE_COUNT = 20;
const FOREGROUND_FALLBACK_BUDGET_MS = 30_500;

const secretEnvironmentNames = [
  'GOALFLOW_STAGING_SUPABASE_PUBLISHABLE_KEY',
  'GOALFLOW_STAGING_USER_A_EMAIL',
  'GOALFLOW_STAGING_USER_A_PASSWORD',
  'GOALFLOW_STAGING_USER_B_EMAIL',
  'GOALFLOW_STAGING_USER_B_PASSWORD'
] as const;

const setting = (name: typeof secretEnvironmentNames[number]): string => {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`Missing required hosted browser setting: ${name}`);
  return value;
};

const secrets = secretEnvironmentNames.map(setting).sort((left, right) => right.length - left.length);
const diagnosticsByTest = new Map<string, string[]>();

const safeUrl = (raw: string): string => {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return '<invalid-url>';
  }
};

const redactDiagnostic = (raw: string): string => {
  let value = raw
    .replace(/Bearer\s+\S+/gi, 'Bearer <redacted>')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '<redacted-jwt>');
  for (const secret of secrets) value = value.split(secret).join('<redacted>');
  return value.slice(0, 2_000);
};

const observePage = (page: Page, testInfo: TestInfo, label: string) => {
  const diagnostics = diagnosticsByTest.get(testInfo.testId) ?? [];
  diagnosticsByTest.set(testInfo.testId, diagnostics);
  page.on('console', message => {
    if (message.type() === 'error' || message.type() === 'warning') {
      diagnostics.push(`${label} console.${message.type()}: ${redactDiagnostic(message.text())}`);
    }
  });
  page.on('pageerror', error => diagnostics.push(`${label} pageerror: ${redactDiagnostic(error.message)}`));
  page.on('requestfailed', request => diagnostics.push(
    `${label} requestfailed: ${request.method()} ${safeUrl(request.url())} — ${redactDiagnostic(request.failure()?.errorText ?? 'unknown')}`
  ));
  page.on('response', response => {
    if (response.status() >= 400) {
      diagnostics.push(`${label} response: ${response.status()} ${safeUrl(response.url())}`);
    }
  });
};

const createAccountPage = async (
  browser: Browser,
  testInfo: TestInfo,
  label: string,
  email: string,
  password: string,
  expectedUserId: string,
  options: { blockRealtime?: boolean } = {}
): Promise<{ context: BrowserContext; page: Page; blockedRealtimeAttempts: () => number }> => {
  const context = await browser.newContext();
  await installHostedTestSession(
    context,
    process.env.GOALFLOW_STAGING_SUPABASE_URL!,
    setting('GOALFLOW_STAGING_SUPABASE_PUBLISHABLE_KEY'),
    email,
    password,
    expectedUserId
  );
  const page = await context.newPage();
  let blockedRealtimeAttempts = 0;
  if (options.blockRealtime) {
    await page.routeWebSocket(/\/realtime\/v1\/websocket/, socket => {
      blockedRealtimeAttempts += 1;
      socket.close({ code: 1008, reason: 'Hosted fallback gate intentionally blocks Realtime.' });
    });
  }
  observePage(page, testInfo, label);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('header')).toBeVisible();
  return { context, page, blockedRealtimeAttempts: () => blockedRealtimeAttempts };
};

const runFreshDurableSync = async (page: Page): Promise<string> =>
  page.evaluate(() => new Promise<string>((resolve, reject) => {
    let sawSyncing = false;
    const timeout = window.setTimeout(() => finish(new Error('A fresh sync cycle did not finish.')), 30_000);
    const retry = window.setInterval(() => window.dispatchEvent(new Event('goalflow:sync-retry')), 1_000);
    const finish = (error?: Error, result?: string) => {
      window.clearTimeout(timeout);
      window.clearInterval(retry);
      window.removeEventListener('goalflow:sync-state', onState);
      if (error) reject(error);
      else resolve(result ?? 'unknown');
    };
    const onState = (event: Event) => {
      const next = (event as CustomEvent<{ state?: string }>).detail?.state;
      if (next === 'syncing') {
        sawSyncing = true;
        return;
      }
      if (sawSyncing && ['synced', 'error', 'offline', 'conflict'].includes(String(next))) finish(undefined, next);
    };
    window.addEventListener('goalflow:sync-state', onState);
    window.dispatchEvent(new Event('goalflow:sync-retry'));
  }));

const resolveTestTrackingConflictsWithCloud = async (page: Page): Promise<number> => {
  await page.getByRole('button', { name: 'Review sync conflict', exact: true }).click();
  const conflictLabels = page.locator('p').filter({ hasText: /^Conflicting / });
  await expect(conflictLabels.first()).toBeVisible();
  const labels = (await conflictLabels.allTextContents()).map(label => label.trim());
  expect(labels.length, 'The staging test account exposed no reviewable conflict').toBeGreaterThan(0);
  expect(
    labels.every(label => label === 'Conflicting tracking'),
    `Refusing to auto-resolve a non-test tracking conflict: ${labels.join(', ')}`
  ).toBe(true);

  const useCloud = page.getByRole('button', { name: 'Use cloud', exact: true });
  let remaining = await useCloud.count();
  expect(remaining).toBe(labels.length);
  while (remaining > 0) {
    await useCloud.first().click();
    await expect.poll(() => useCloud.count()).toBeLessThan(remaining);
    remaining = await useCloud.count();
  }
  return labels.length;
};

const waitForFreshDurableSync = async (
  page: Page,
  options: { recoverTestTrackingConflicts?: boolean } = {}
): Promise<number> => {
  let state = await runFreshDurableSync(page);
  let recoveredTrackingConflicts = 0;
  if (state === 'conflict' && options.recoverTestTrackingConflicts) {
    recoveredTrackingConflicts = await resolveTestTrackingConflictsWithCloud(page);
    state = await runFreshDurableSync(page);
  }
  expect(state, 'A fresh synchronization cycle must end in durable success').toBe('synced');
  await expect(page.getByRole('button', { name: 'Synced', exact: true })).toBeVisible();
  return recoveredTrackingConflicts;
};

const captureTodayTask = async (page: Page, title: string): Promise<number> => {
  await page.goto(`/?capture=task&title=${encodeURIComponent(title)}`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('header')).toBeVisible();
  const dialog = page.getByRole('dialog', { name: 'New Task' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByPlaceholder('What is the next action?')).toHaveValue(title);
  await dialog.locator('[aria-label="Task schedule"]').getByRole('button', { name: 'Today', exact: true }).click();
  const mutationStartedAt = Date.now();
  await dialog.getByRole('button', { name: 'Create Task', exact: true }).click();
  await expect(dialog).toBeHidden();
  return mutationStartedAt;
};

const dismissDecisionFatigueWarning = async (page: Page) => {
  const warning = page.getByRole('dialog', { name: 'Decision Fatigue Warning', exact: true });
  if (!(await warning.isVisible())) return;
  await warning.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(warning).toBeHidden();
};

const openPlan = async (page: Page) => {
  await page.getByRole('button', { name: 'Plan', exact: true }).click();
  await expect(page.getByRole('heading', { name: "Today's Flow", exact: true })).toBeVisible();
  await dismissDecisionFatigueWarning(page);
};

const taskCard = (page: Page, title: string) =>
  page.locator('[data-rfd-draggable-id]').filter({ has: page.getByRole('heading', { name: title, exact: true }) });

const waitForAutomaticTaskCount = async (
  page: Page,
  title: string,
  expectedCount: number,
  timeout = 10_000
): Promise<void> => {
  await expect.poll(
    () => taskCard(page, title).count(),
    { timeout, intervals: [50, 100, 100, 100] }
  ).toBe(expectedCount);
};

const isSyncPull = (url: string): boolean => {
  try {
    return new URL(url).pathname === '/api/v1/sync/pull';
  } catch {
    return false;
  }
};

/** Observe the exact cursor pull that delivered a named record without retaining credentials or payloads. */
const observeSyncPullDeliveringTitle = (
  page: Page,
  title: string
): { delivered: Promise<number>; stop: () => void } => {
  const requestStartedAt = new WeakMap<Request, number>();
  let resolveDelivered: (startedAt: number) => void = () => undefined;
  const delivered = new Promise<number>(resolve => { resolveDelivered = resolve; });
  let stopped = false;

  const onRequest = (request: Request) => {
    if (request.method() === 'GET' && isSyncPull(request.url())) requestStartedAt.set(request, Date.now());
  };
  const onResponse = async (response: Response) => {
    if (stopped || response.request().method() !== 'GET' || !isSyncPull(response.url()) || !response.ok()) return;
    try {
      const body = await response.json() as { records?: Array<{ payload?: { title?: unknown } }> };
      if (!body.records?.some(record => record.payload?.title === title)) return;
      stopped = true;
      resolveDelivered(requestStartedAt.get(response.request()) ?? Date.now());
    } catch {
      // A malformed response is already a synchronization failure; let the
      // visible-state assertion time out with the retained redacted diagnostics.
    }
  };

  page.on('request', onRequest);
  page.on('response', onResponse);
  return {
    delivered,
    stop: () => {
      stopped = true;
      page.off('request', onRequest);
      page.off('response', onResponse);
    }
  };
};

const signOutLocally = async (page: Page) => {
  await dismissDecisionFatigueWarning(page);
  await page.getByRole('button', { name: 'Open account menu', exact: true }).click();
  await page.getByRole('button', { name: 'Logout', exact: true }).click();
  await expect(page.getByLabel('Email')).toBeVisible();
};

test.afterEach(async ({}, testInfo) => {
  const diagnostics = diagnosticsByTest.get(testInfo.testId) ?? [];
  await testInfo.attach('redacted-browser-diagnostics', {
    body: Buffer.from(diagnostics.length > 0 ? diagnostics.join('\n') : 'No browser warnings or errors captured.'),
    contentType: 'text/plain'
  });
  diagnosticsByTest.delete(testInfo.testId);
});

test('real browsers converge within one account and isolate a second account', async ({ browser }, testInfo) => {
  diagnosticsByTest.set(testInfo.testId, []);
  const contexts: BrowserContext[] = [];
  const originalTitle = `Hosted browser ${Date.now()} ${randomUUID().slice(0, 8)}`;
  const fallbackTitle = `Hosted fallback ${Date.now()} ${randomUUID().slice(0, 8)}`;
  const realtimeLatenciesMs: number[] = [];
  let recoveredTrackingConflicts = 0;
  let fallbackPullObservation: ReturnType<typeof observeSyncPullDeliveringTitle> | undefined;

  try {
    const firstA = await createAccountPage(
      browser, testInfo, 'user-a-browser-1',
      setting('GOALFLOW_STAGING_USER_A_EMAIL'), setting('GOALFLOW_STAGING_USER_A_PASSWORD'),
      process.env.GOALFLOW_STAGING_USER_A_ID!
    );
    contexts.push(firstA.context);
    recoveredTrackingConflicts = await waitForFreshDurableSync(firstA.page, {
      recoverTestTrackingConflicts: true
    });

    const secondA = await createAccountPage(
      browser, testInfo, 'user-a-browser-2',
      setting('GOALFLOW_STAGING_USER_A_EMAIL'), setting('GOALFLOW_STAGING_USER_A_PASSWORD'),
      process.env.GOALFLOW_STAGING_USER_A_ID!
    );
    contexts.push(secondA.context);
    await waitForFreshDurableSync(secondA.page);

    const userB = await createAccountPage(
      browser, testInfo, 'user-b-browser',
      setting('GOALFLOW_STAGING_USER_B_EMAIL'), setting('GOALFLOW_STAGING_USER_B_PASSWORD'),
      process.env.GOALFLOW_STAGING_USER_B_ID!
    );
    contexts.push(userB.context);
    await waitForFreshDurableSync(userB.page);

    const fallbackA = await createAccountPage(
      browser, testInfo, 'user-a-browser-fallback',
      setting('GOALFLOW_STAGING_USER_A_EMAIL'), setting('GOALFLOW_STAGING_USER_A_PASSWORD'),
      process.env.GOALFLOW_STAGING_USER_A_ID!,
      { blockRealtime: true }
    );
    contexts.push(fallbackA.context);
    await waitForFreshDurableSync(fallbackA.page);

    // Plan visits update one durable singleton. Serialize those intentional
    // writes and let every same-user browser pull between them so the latency
    // measurement itself never manufactures a conflict.
    await openPlan(secondA.page);
    await waitForFreshDurableSync(secondA.page);
    await Promise.all([waitForFreshDurableSync(firstA.page), waitForFreshDurableSync(fallbackA.page)]);
    await openPlan(fallbackA.page);
    await waitForFreshDurableSync(fallbackA.page);
    await Promise.all([waitForFreshDurableSync(firstA.page), waitForFreshDurableSync(secondA.page)]);
    await openPlan(userB.page);
    await waitForFreshDurableSync(userB.page);
    await expect.poll(fallbackA.blockedRealtimeAttempts).toBeGreaterThan(0);

    const createStartedAt = await captureTodayTask(firstA.page, originalTitle);
    await waitForAutomaticTaskCount(secondA.page, originalTitle, 1);
    realtimeLatenciesMs.push(Date.now() - createStartedAt);
    await expect(userB.page.getByRole('heading', { name: originalTitle, exact: true })).toHaveCount(0);
    await openPlan(firstA.page);
    // Opening Plan updates the durable tracking singleton. Finish and
    // propagate that unrelated write before measuring task-edit convergence.
    await waitForFreshDurableSync(firstA.page);
    await waitForFreshDurableSync(secondA.page);

    let currentTitle = originalTitle;
    for (let sample = 1; sample <= REALTIME_SAMPLE_COUNT - 2; sample += 1) {
      const nextTitle = `${originalTitle} edit ${sample}`;
      const card = taskCard(secondA.page, currentTitle);
      await card.hover();
      await card.getByTitle('Edit').click();
      const editDialog = secondA.page.getByRole('dialog', { name: 'Edit Task' });
      await editDialog.getByPlaceholder('What is the next action?').fill(nextTitle);
      const editStartedAt = Date.now();
      await editDialog.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(editDialog).toBeHidden();
      await waitForAutomaticTaskCount(firstA.page, nextTitle, 1);
      realtimeLatenciesMs.push(Date.now() - editStartedAt);
      await expect(firstA.page.getByRole('heading', { name: currentTitle, exact: true })).toHaveCount(0);
      currentTitle = nextTitle;
    }

    const editedCard = taskCard(secondA.page, currentTitle);
    await editedCard.hover();
    const deleteStartedAt = Date.now();
    await editedCard.getByTitle('Delete').click();
    await expect(secondA.page.getByRole('heading', { name: currentTitle, exact: true })).toHaveCount(0);
    await waitForAutomaticTaskCount(firstA.page, currentTitle, 0);
    realtimeLatenciesMs.push(Date.now() - deleteStartedAt);
    await expect(userB.page.getByRole('heading', { name: currentTitle, exact: true })).toHaveCount(0);

    expect(realtimeLatenciesMs).toHaveLength(REALTIME_SAMPLE_COUNT);
    const sortedLatencies = [...realtimeLatenciesMs].sort((left, right) => left - right);
    const realtimeP95Ms = sortedLatencies[Math.ceil(sortedLatencies.length * 0.95) - 1];
    expect(
      realtimeP95Ms,
      `Warm Realtime p95 exceeded ${REALTIME_P95_BUDGET_MS} ms; observed ${realtimeLatenciesMs.join(', ')} ms`
    ).toBeLessThan(REALTIME_P95_BUDGET_MS);

    fallbackPullObservation = observeSyncPullDeliveringTitle(fallbackA.page, fallbackTitle);
    const fallbackMutationStartedAt = await captureTodayTask(firstA.page, fallbackTitle);
    const [fallbackPullStartedAt] = await Promise.all([
      fallbackPullObservation.delivered,
      waitForAutomaticTaskCount(fallbackA.page, fallbackTitle, 1, FOREGROUND_FALLBACK_BUDGET_MS + 5_000)
    ]);
    const fallbackPullStartMs = fallbackPullStartedAt - fallbackMutationStartedAt;
    expect(
      fallbackPullStartMs,
      `Foreground fallback pull began after ${FOREGROUND_FALLBACK_BUDGET_MS} ms`
    ).toBeLessThanOrEqual(FOREGROUND_FALLBACK_BUDGET_MS);
    await expect(userB.page.getByRole('heading', { name: fallbackTitle, exact: true })).toHaveCount(0);

    const fallbackCard = taskCard(fallbackA.page, fallbackTitle);
    await fallbackCard.hover();
    await fallbackCard.getByTitle('Delete').click();
    await waitForFreshDurableSync(fallbackA.page);

    console.log(JSON.stringify({
      status: 'PASS',
      realtimeWakeupLatenciesMs: realtimeLatenciesMs,
      realtimeP95Ms,
      foregroundFallbackPullStartMs: fallbackPullStartMs,
      recoveredTrackingConflicts,
      crossUserVisibility: 'DENIED'
    }));

    await signOutLocally(firstA.page);
    await expect(secondA.page.locator('header')).toBeVisible();
    await waitForFreshDurableSync(secondA.page);
    await signOutLocally(secondA.page);
    await signOutLocally(userB.page);
    await signOutLocally(fallbackA.page);
  } finally {
    fallbackPullObservation?.stop();
    await Promise.all(contexts.map(context => context.close()));
  }
});
