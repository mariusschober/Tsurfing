import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  // Hosted staging uses real accounts and has a separate fail-closed config.
  // Never let the local synthetic server accidentally collect that journey.
  testIgnore: ['**/hosted-staging.spec.ts', '**/hosted-cross-client.spec.ts'],
  timeout: 45_000,
  expect: { timeout: 7_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: process.env.CI ? 1 : 2,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
  ],
  webServer: {
    command: 'npm run build:client:test && npm run build:server && npm start',
    url: 'http://127.0.0.1:4173/api/v1/health/live',
    reuseExistingServer: !process.env.CI,
    timeout: 90_000,
    env: {
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: '4173',
      APP_ORIGIN: 'http://127.0.0.1:4173',
    },
  },
});
