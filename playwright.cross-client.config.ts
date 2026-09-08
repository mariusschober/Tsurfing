import assert from 'node:assert/strict';
import path from 'node:path';
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
  'GOALFLOW_STAGING_USER_B_ID',
  'GOALFLOW_CROSS_CLIENT_STATE_FILE',
  'GOALFLOW_CROSS_CLIENT_PHASE'
] as const;

if (process.env.GOALFLOW_HOSTED_TEST_CONFIRM !== 'staging') {
  throw new Error('Cross-client browser tests require GOALFLOW_HOSTED_TEST_CONFIRM=staging.');
}
for (const name of requiredEnvironment) {
  if (!process.env[name]?.trim()) throw new Error(`Missing required cross-client setting: ${name}`);
}

const configuredOrigin = new URL(process.env.GOALFLOW_STAGING_APP_ORIGIN!);
assert.equal(configuredOrigin.protocol, 'https:', 'Cross-client tests require an HTTPS application origin');
assert.notEqual(configuredOrigin.hostname, 'localhost', 'Cross-client tests refuse a local application origin');
assert.equal(configuredOrigin.username, '', 'Application origin must not contain credentials');
assert.equal(configuredOrigin.password, '', 'Application origin must not contain credentials');
assert.equal(configuredOrigin.search, '', 'Application origin must not contain a query string');
assert.equal(configuredOrigin.hash, '', 'Application origin must not contain a fragment');
assert.equal(configuredOrigin.pathname.replace(/\/$/, ''), '', 'Application origin must not contain a path');
assert(path.isAbsolute(process.env.GOALFLOW_CROSS_CLIENT_STATE_FILE!), 'Cross-client state must use an absolute path');
assert([
  'seed', 'verify-android', 'verify-macos', 'cleanup'
].includes(process.env.GOALFLOW_CROSS_CLIENT_PHASE!), 'Unknown cross-client browser phase');

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/hosted-cross-client.spec.ts',
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: configuredOrigin.origin,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [{
    name: 'hosted-cross-client-chromium',
    use: { ...devices['Desktop Chrome'] },
  }],
});
