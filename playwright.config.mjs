import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e', timeout: 30_000, workers: 1,
  use: { headless: true, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
});
