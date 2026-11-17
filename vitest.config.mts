import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// As the build stamps it (scripts/build.mjs): the designer's canvas the pages carry.
const designerBundle = JSON.parse(
  readFileSync('node_modules/@ansible-flow/designer/package.json', 'utf8'),
).version;

// AFS-70: the server's tests start real git processes, HTTP servers and databases. With a worker
// per core (19 on a 20-core machine) they fought over process starts and sockets, and tests that
// pass alone in 2 to 4 seconds went past the 5-second default. Half the cores, at most 8, ran the
// whole suite faster and with no timeout (three runs each way, 2026-11-14).
// AFS-81: at 8 the server suite still failed now and then on Windows: tests that talk HTTP to
// their own servers (git, webhooks, MCP, run events) got no answer for 10 to 30 s, 2 runs of 4
// (2026-11-17); loopback alone answered 2400 requests in under 0.1 s each. At 4: 3 of 3 clean,
// about 100 s instead of 80 to 98.
const workers = Math.max(2, Math.min(4, Math.floor(availableParallelism() / 2)));

export default defineConfig({
  define: { __AFS_DESIGNER_BUNDLE__: JSON.stringify(designerBundle) },
  test: {
    // With PostgreSQL the test files share one database (AFS_TEST_POSTGRES_URL): one file at a
    // time, so one file's fresh start is not another's missing table.
    fileParallelism: !process.env.AFS_TEST_POSTGRES_URL,
    maxWorkers: workers,
    projects: [
      {
        extends: true,
        test: {
          name: 'server',
          environment: 'node',
          include: ['test/unit/**/*.test.ts'],
          // AFS-70: a test here clones, pushes and syncs repositories, each a few git processes;
          // on Windows a process start alone can take a tenth of a second. The pages keep 5 s.
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
      {
        extends: true,
        plugins: [react()],
        test: {
          name: 'web',
          environment: 'jsdom',
          include: ['test/web/**/*.test.tsx'],
          // AFS-81: findBy/waitFor wait 5 s (setup.ts), so a test may take longer than 5 s.
          setupFiles: ['test/web/setup.ts'],
          testTimeout: 20_000,
        },
      },
      {
        // AFS-38: against the compose stack and the GNS3 lab; skipped unless AFS_E2E=1.
        extends: true,
        test: {
          name: 'e2e',
          environment: 'node',
          include: ['test/e2e/**/*.test.ts'],
          testTimeout: 600_000,
          hookTimeout: 900_000,
        },
      },
    ],
  },
});
