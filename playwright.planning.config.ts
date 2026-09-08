import { defineConfig } from '@playwright/test';
import base from './playwright.config';

export default defineConfig({
  ...base,
  testMatch: ['**/planned-task-browser.spec.ts', '**/deliberate-planning.spec.ts', '**/plan-experience.spec.ts', '**/navigation-responsive.spec.ts'],
  outputDir: 'test-results/planning',
  reporter: [['list'], ['json', { outputFile: 'test-results/planning-results.json' }]],
  use: { ...base.use, baseURL: 'http://127.0.0.1:4191' },
  webServer: {
    ...base.webServer,
    command: 'npm run build:client:test && npm run build:server && npm start',
    url: 'http://127.0.0.1:4191/api/v1/health/live', reuseExistingServer: false, timeout: 90_000,
    env: { NODE_ENV: 'production', HOST: '127.0.0.1', PORT: '4191', APP_ORIGIN: 'http://127.0.0.1:4191' },
  },
});
