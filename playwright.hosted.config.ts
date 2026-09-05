import assert from 'node:assert/strict';
import { defineConfig, devices } from '@playwright/test';

const requiredEnvironment = [
  'GOALFLOW_STAGING_APP_ORIGIN',
  'GOALFLOW_STAGING_SUPABASE_URL',
  'GOALFLOW_STAGING_SUPABASE_PUBLISHABLE_KEY',
  'GOALFLOW_STAGING_USER_A_EMAIL',
  'GOALFLOW_STAGING_USER_A_PASSWORD',
  'GOALFLOW_STAGING_USER_A_ID',
  'GOALFLOW_STAGING_USER_B_EMAIL',
  'GOALFLOW_STAGING_USER_B_PASSWORD',
  'GOALFLOW_STAGING_USER_B_ID'
] as const;

if (process.env.GOALFLOW_HOSTED_TEST_CONFIRM !== 'staging') {
  throw new Error('Hosted browser tests require GOALFLOW_HOSTED_TEST_CONFIRM=staging.');
}
for (const name of requiredEnvironment) {
  if (!process.env[name]?.trim()) throw new Error(`Missing required hosted staging setting: ${name}`);
}

const configuredOrigin = new URL(process.env.GOALFLOW_STAGING_APP_ORIGIN!);
assert.equal(configuredOrigin.protocol, 'https:', 'Hosted browser tests require an HTTPS application origin');
assert.notEqual(configuredOrigin.hostname, 'localhost', 'Hosted browser tests refuse a local application origin');
assert.equal(configuredOrigin.username, '', 'Hosted browser origin must not contain credentials');
assert.equal(configuredOrigin.password, '', 'Hosted browser origin must not contain credentials');
assert.equal(configuredOrigin.search, '', 'Hosted browser origin must not contain a query string');
assert.equal(configuredOrigin.hash, '', 'Hosted browser origin must not contain a fragment');
assert.equal(configuredOrigin.pathname.replace(/\/$/, ''), '', 'Hosted browser origin must not contain a path');

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/hosted-staging.spec.ts',
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  // HTML reports can retain action parameters. Keep only the explicit,
  // redacted attachment produced by the hosted journey.
  reporter: 'list',
  use: {
    baseURL: configuredOrigin.origin,
    // Traces, videos, and screenshots can retain credentials entered into the
    // real login form. The test attaches redacted text diagnostics instead.
    trace: 'off',
    screenshot: 'off',
    video: 'off',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [{
    name: 'hosted-chromium',
    use: { ...devices['Desktop Chrome'] },
  }],
});
