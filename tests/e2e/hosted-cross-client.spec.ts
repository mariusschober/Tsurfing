import { randomUUID } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { expect, test, type Browser, type BrowserContext, type Locator, type Page, type TestInfo } from '@playwright/test';
import { installHostedTestSession } from './hosted-auth';

const secretEnvironmentNames = [
  'GOALFLOW_STAGING_SUPABASE_PUBLISHABLE_KEY',
  'GOALFLOW_STAGING_USER_A_EMAIL',
  'GOALFLOW_STAGING_USER_A_PASSWORD',
  'GOALFLOW_STAGING_USER_B_EMAIL',
  'GOALFLOW_STAGING_USER_B_PASSWORD'
] as const;
type SecretEnvironmentName = typeof secretEnvironmentNames[number];
type CrossClientPhase = 'seed' | 'verify-android' | 'verify-macos' | 'cleanup';
interface CrossClientState {
  schemaVersion: 1;
  taskId: string;
  browserTitle: string;
  androidTitle: string;
  macosTitle: string;
}

const setting = (name: SecretEnvironmentName): string => {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`Missing required hosted browser setting: ${name}`);
  return value;
};
const phase = process.env.GOALFLOW_CROSS_CLIENT_PHASE as CrossClientPhase;
const stateFile = process.env.GOALFLOW_CROSS_CLIENT_STATE_FILE!;
const secrets = secretEnvironmentNames.map(setting).sort((left, right) => right.length - left.length);
const diagnosticsByTest = new Map<string, string[]>();
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
    if (response.status() >= 400) diagnostics.push(`${label} response: ${response.status()} ${safeUrl(response.url())}`);
  });
};

const createAccountPage = async (
  browser: Browser,
  testInfo: TestInfo,
  label: string,
  email: string,
  password: string,
  expectedUserId: string
): Promise<{ context: BrowserContext; page: Page }> => {
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
  observePage(page, testInfo, label);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('header')).toBeVisible();
  return { context, page };
};

const waitForFreshDurableSync = async (page: Page) => {
  const state = await page.evaluate(() => new Promise<string>((resolve, reject) => {
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
  expect(state, 'A fresh synchronization cycle must end in durable success').toBe('synced');
  await expect(page.getByRole('button', { name: 'Synced', exact: true })).toBeVisible();
};

const captureTodayTask = async (page: Page, title: string) => {
  await page.goto(`/?capture=task&title=${encodeURIComponent(title)}`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('header')).toBeVisible();
  const dialog = page.getByRole('dialog', { name: 'New Task' });
  await expect(dialog).toBeVisible();
  await dialog.locator('[aria-label="Task schedule"]').getByRole('button', { name: 'Today', exact: true }).click();
  await dialog.getByRole('button', { name: 'Create Task', exact: true }).click();
  await expect(dialog).toBeHidden();
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

const cardByTitle = (page: Page, title: string) =>
  page.locator('[data-rfd-draggable-id]').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
const cardById = (page: Page, taskId: string) => page.locator(`[data-rfd-draggable-id="${taskId}"]`);

const signOutLocally = async (page: Page) => {
  await dismissDecisionFatigueWarning(page);
  await page.getByRole('button', { name: 'Open account menu', exact: true }).click();
  await page.getByRole('button', { name: 'Logout', exact: true }).click();
  await expect(page.getByLabel('Email')).toBeVisible();
};

const readState = (requireTaskId = true): CrossClientState => {
  if (!existsSync(stateFile)) throw new Error('Cross-client state was not created by the browser seed phase.');
  if (statSync(stateFile).size > 16 * 1024) throw new Error('Cross-client state exceeds its safe size.');
  const value = JSON.parse(readFileSync(stateFile, 'utf8')) as Partial<CrossClientState>;
  if (value.schemaVersion !== 1 || typeof value.taskId !== 'string' ||
      (requireTaskId && !value.taskId.match(uuidPattern)) ||
      (!requireTaskId && value.taskId !== '' && !value.taskId.match(uuidPattern))) {
    throw new Error('Cross-client state has an invalid schema or durable task ID.');
  }
  for (const key of ['browserTitle', 'androidTitle', 'macosTitle'] as const) {
    if (typeof value[key] !== 'string' || value[key]!.length < 1 || value[key]!.length > 200) {
      throw new Error(`Cross-client state has an invalid ${key}.`);
    }
  }
  return value as CrossClientState;
};

const writeState = (state: CrossClientState) => {
  const temporary = `${stateFile}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, stateFile);
};

test.afterEach(async ({}, testInfo) => {
  const diagnostics = diagnosticsByTest.get(testInfo.testId) ?? [];
  await testInfo.attach('redacted-cross-client-diagnostics', {
    body: Buffer.from(diagnostics.length > 0 ? diagnostics.join('\n') : 'No browser warnings or errors captured.'),
    contentType: 'text/plain'
  });
  diagnosticsByTest.delete(testInfo.testId);
});

test(`hosted browser cross-client phase: ${phase}`, async ({ browser }, testInfo) => {
  diagnosticsByTest.set(testInfo.testId, []);
  const contexts: BrowserContext[] = [];
  if (phase === 'cleanup' && !existsSync(stateFile)) {
    testInfo.annotations.push({ type: 'cleanup', description: 'No fixture state existed after a failed seed.' });
    return;
  }
  const state = phase === 'seed' ? undefined : readState(phase !== 'cleanup');

  try {
    const userA = await createAccountPage(
      browser, testInfo, `user-a-${phase}`,
      setting('GOALFLOW_STAGING_USER_A_EMAIL'), setting('GOALFLOW_STAGING_USER_A_PASSWORD'),
      process.env.GOALFLOW_STAGING_USER_A_ID!
    );
    contexts.push(userA.context);
    await waitForFreshDurableSync(userA.page);

    if (phase === 'seed') {
      const suffix = `${Date.now()}-${randomUUID().slice(0, 8)}`;
      const seeded: CrossClientState = {
        schemaVersion: 1,
        taskId: '',
        browserTitle: `Hosted handoff ${suffix}`,
        androidTitle: `Hosted handoff ${suffix} — Android`,
        macosTitle: `Hosted handoff ${suffix} — macOS`,
      };
      // Persist the titles before creating remote state so the always-run
      // cleanup phase can recover even if durable-ID discovery later fails.
      writeState(seeded);
      await captureTodayTask(userA.page, seeded.browserTitle);
      await waitForFreshDurableSync(userA.page);
      await openPlan(userA.page);
      const browserCard = cardByTitle(userA.page, seeded.browserTitle);
      await expect(browserCard).toHaveCount(1);
      seeded.taskId = (await browserCard.getAttribute('data-rfd-draggable-id')) ?? '';
      expect(seeded.taskId).toMatch(uuidPattern);
      writeState(seeded);

      const userB = await createAccountPage(
        browser, testInfo, 'user-b-seed-isolation',
        setting('GOALFLOW_STAGING_USER_B_EMAIL'), setting('GOALFLOW_STAGING_USER_B_PASSWORD'),
        process.env.GOALFLOW_STAGING_USER_B_ID!
      );
      contexts.push(userB.context);
      await waitForFreshDurableSync(userB.page);
      await openPlan(userB.page);
      await expect(cardById(userB.page, seeded.taskId)).toHaveCount(0);
      await signOutLocally(userA.page);
      await signOutLocally(userB.page);
      return;
    }

    await openPlan(userA.page);
    if (phase === 'verify-android' || phase === 'verify-macos') {
      const expectedTitle = phase === 'verify-android' ? state!.androidTitle : state!.macosTitle;
      const expectedCard = cardById(userA.page, state!.taskId);
      await expect(expectedCard).toHaveCount(1);
      await expect(expectedCard.getByRole('heading', { name: expectedTitle, exact: true })).toBeVisible();

      const userB = await createAccountPage(
        browser, testInfo, `user-b-${phase}-isolation`,
        setting('GOALFLOW_STAGING_USER_B_EMAIL'), setting('GOALFLOW_STAGING_USER_B_PASSWORD'),
        process.env.GOALFLOW_STAGING_USER_B_ID!
      );
      contexts.push(userB.context);
      await waitForFreshDurableSync(userB.page);
      await openPlan(userB.page);
      await expect(cardById(userB.page, state!.taskId)).toHaveCount(0);
      await signOutLocally(userA.page);
      await signOutLocally(userB.page);
      return;
    }

    const cleanupCards = state!.taskId.match(uuidPattern)
      ? [cardById(userA.page, state!.taskId)]
      : [state!.browserTitle, state!.androidTitle, state!.macosTitle].map(title => cardByTitle(userA.page, title));
    const presentCards: Locator[] = [];
    for (const candidate of cleanupCards) {
      if (await candidate.count() === 1) presentCards.push(candidate);
    }
    expect(presentCards.length, 'Cleanup found more than one fixture for one intended capture').toBeLessThanOrEqual(1);
    if (presentCards.length === 1) {
      await presentCards[0].hover();
      await presentCards[0].getByTitle('Delete').click();
      await expect(presentCards[0]).toHaveCount(0);
      await waitForFreshDurableSync(userA.page);
    }

    const secondA = await createAccountPage(
      browser, testInfo, 'user-a-cleanup-verification',
      setting('GOALFLOW_STAGING_USER_A_EMAIL'), setting('GOALFLOW_STAGING_USER_A_PASSWORD'),
      process.env.GOALFLOW_STAGING_USER_A_ID!
    );
    contexts.push(secondA.context);
    await waitForFreshDurableSync(secondA.page);
    await openPlan(secondA.page);
    for (const title of [state!.browserTitle, state!.androidTitle, state!.macosTitle]) {
      await expect(cardByTitle(secondA.page, title)).toHaveCount(0);
    }

    const userB = await createAccountPage(
      browser, testInfo, 'user-b-cleanup-isolation',
      setting('GOALFLOW_STAGING_USER_B_EMAIL'), setting('GOALFLOW_STAGING_USER_B_PASSWORD'),
      process.env.GOALFLOW_STAGING_USER_B_ID!
    );
    contexts.push(userB.context);
    await waitForFreshDurableSync(userB.page);
    await openPlan(userB.page);
    for (const title of [state!.browserTitle, state!.androidTitle, state!.macosTitle]) {
      await expect(cardByTitle(userB.page, title)).toHaveCount(0);
    }
    await signOutLocally(userA.page);
    await signOutLocally(secondA.page);
    await signOutLocally(userB.page);
    unlinkSync(stateFile);
  } finally {
    await Promise.all(contexts.map(context => context.close()));
  }
});
