import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// Keep this UI worktree independent of concurrent protocol/browser test servers.
export default defineConfig({
  ...base,
  testMatch: ['**/navigation-responsive.spec.ts', '**/web-critical.spec.ts'],
  outputDir: 'test-results/navigation',
  reporter: [['list'], ['json', { outputFile: 'test-results/navigation-results.json' }]],
  use: { ...base.use, baseURL: 'http://127.0.0.1:4188' },
  webServer: {
    ...base.webServer,
    command: 'npm run build:client:test && npm run build:server && npm start',
    url: 'http://127.0.0.1:4188/api/v1/health/live',
    reuseExistingServer: !process.env.CI,
    timeout: 90_000,
    env: { NODE_ENV: 'production', HOST: '127.0.0.1', PORT: '4188', APP_ORIGIN: 'http://127.0.0.1:4188' },
  },
});
