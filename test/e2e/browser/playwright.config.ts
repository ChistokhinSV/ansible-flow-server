// Playwright for the browser smoke test (AFS-38); see test/e2e/README.md.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  workers: 1,
  timeout: 600_000,
  reporter: [['list']],
  outputDir: '../../../.e2e-results',
  use: {
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
