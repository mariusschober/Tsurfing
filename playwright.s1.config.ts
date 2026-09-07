import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// Isolated local browser/storage integration: no hosted account or API writes.
export default defineConfig({
  ...base,
  testMatch: process.env.S1_INCLUDE_EXISTING === '1' ? '**/*.spec.ts' : '**/s1-local-storage.spec.ts',
  use: { ...base.use, baseURL: 'http://127.0.0.1:4175' },
  webServer: {
    command: 'npm run build:client:test && npx vite preview --host 127.0.0.1 --port 4175 --strictPort',
    url: 'http://127.0.0.1:4175',
    reuseExistingServer: false,
    timeout: 90_000
  }
});
