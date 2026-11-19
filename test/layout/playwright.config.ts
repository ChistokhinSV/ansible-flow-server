// AFS-138: the layout check (layout.spec.ts). A server of its own on SQLite (stack.ts), no lab, no
// container engine: `just layout` (it builds first), and the CI job "layout".
import { defineConfig } from '@playwright/test';
import { STATES } from './setup';

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  globalSetup: './setup.ts',
  // One server for every browser. On a busy machine pages can take seconds: two browsers, long
  // waits, and in CI one more try for a page that did not load.
  workers: 2,
  fullyParallel: true,
  timeout: 120_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['github']] : [['list']],
  outputDir: '../../.layout-results',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'dark', use: { colorScheme: 'dark', storageState: `${STATES}/dark.json` } },
    { name: 'light', use: { colorScheme: 'light', storageState: `${STATES}/light.json` } },
  ],
});
