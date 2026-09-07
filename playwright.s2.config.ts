import { defineConfig } from '@playwright/test';
import base from './playwright.s1.config';
export default defineConfig({ ...base, testMatch: '**/s2-storage-fence.spec.ts' });
