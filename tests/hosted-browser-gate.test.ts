import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('hosted browser release gate', () => {
  const localConfig = fs.readFileSync('playwright.config.ts', 'utf8');
  const hostedConfig = fs.readFileSync('playwright.hosted.config.ts', 'utf8');
  const journey = fs.readFileSync('tests/e2e/hosted-staging.spec.ts', 'utf8');
  const hostedAuth = fs.readFileSync('tests/e2e/hosted-auth.ts', 'utf8');
  const protocolJourney = fs.readFileSync('scripts/test-hosted-staging.ts', 'utf8');
  const workflow = fs.readFileSync('.github/workflows/ci.yml', 'utf8');

  it('cannot run against the local synthetic Playwright server', () => {
    expect(localConfig).toContain("'**/hosted-staging.spec.ts'");
    expect(localConfig).toContain("'**/hosted-cross-client.spec.ts'");
    expect(hostedConfig).toContain("testMatch: '**/hosted-staging.spec.ts'");
    expect(hostedConfig).not.toContain('webServer:');
    expect(hostedConfig).toContain("GOALFLOW_HOSTED_TEST_CONFIRM !== 'staging'");
    expect(hostedConfig).toContain("configuredOrigin.protocol, 'https:'");
  });

  it('keeps real login credentials out of retained browser media', () => {
    expect(hostedConfig).toContain("trace: 'off'");
    expect(hostedConfig).toContain("screenshot: 'off'");
    expect(hostedConfig).toContain("video: 'off'");
    expect(hostedConfig).toContain("reporter: 'list'");
    expect(hostedConfig).not.toContain("['html'");
    expect(journey).toContain("testInfo.attach('redacted-browser-diagnostics'");
    expect(journey).toContain(".replace(/Bearer\\s+\\S+/gi, 'Bearer <redacted>')");
    expect(journey).toContain('installHostedTestSession');
    expect(journey).not.toContain("getByLabel('Password')");
    expect(hostedAuth).toContain('persistSession: false');
    expect(hostedAuth).toContain('window.localStorage.setItem(key, value)');
  });

  it('proves automatic warm convergence, foreground fallback, and account isolation', () => {
    expect(journey).toContain("'user-a-browser-1'");
    expect(journey).toContain("'user-a-browser-2'");
    expect(journey).toContain("'user-b-browser'");
    expect(journey).toContain("'user-a-browser-fallback'");
    expect(journey).toContain("getByRole('button', { name: 'Create Task'");
    expect(journey).toContain("getByRole('button', { name: 'Save'");
    expect(journey).toContain("getByTitle('Delete')");
    expect(journey).toContain('REALTIME_P95_BUDGET_MS = 2_000');
    expect(journey).toContain('FOREGROUND_FALLBACK_BUDGET_MS = 30_500');
    expect(journey).toContain('waitForAutomaticTaskCount');
    expect(journey).toContain('observeSyncPullDeliveringTitle');
    expect(journey).toContain('page.routeWebSocket');
    expect(journey).toContain('resolveTestTrackingConflictsWithCloud');
    expect(journey).toContain("labels.every(label => label === 'Conflicting tracking')");
    expect(journey).toContain('recoverTestTrackingConflicts: true');
    expect(journey).toContain('Serialize those intentional');
    expect(journey).toContain('realtimeWakeupLatenciesMs');
    expect(journey).toContain('foregroundFallbackPullStartMs');
    expect(journey).toContain("getByRole('dialog', { name: 'Decision Fatigue Warning', exact: true })");
    expect(journey).toContain("getByRole('button', { name: 'Close dialog', exact: true })");
    expect(journey).toContain('await signOutLocally(firstA.page)');
    expect(journey).toContain("await expect(secondA.page.locator('header')).toBeVisible()");
    expect(journey).toContain("window.dispatchEvent(new Event('goalflow:sync-retry'))");
  });

  it('runs after the hosted protocol proof and retains only redacted diagnostics', () => {
    const protocol = workflow.indexOf('npm run test:hosted:staging');
    const browser = workflow.indexOf('npm run test:hosted:browser');
    expect(protocol).toBeGreaterThan(0);
    expect(browser).toBeGreaterThan(protocol);
    expect(workflow).toContain('npx playwright install --with-deps chromium');
    expect(workflow).toContain('name: hosted-browser-diagnostics');
    expect(workflow).toContain("if: failure() && steps.preflight.outputs.run == 'true'");
    expect(workflow).toContain('path: test-results');
    expect(workflow).toContain('if-no-files-found: error');
  });

  it('waits for Railway to serve the exact commit under test', () => {
    expect(workflow).toContain('GOALFLOW_EXPECTED_RELEASE_SHA: ${{ github.event.pull_request.head.sha || github.sha }}');
    expect(protocolJourney).toContain("response.headers.get('x-tsurfing-revision')");
    expect(protocolJourney).toContain('await waitForExactDeployment()');
    expect(protocolJourney).toContain('response.releaseSha === expectedReleaseSha');
  });
});
