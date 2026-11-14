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
const workers = Math.max(2, Math.min(8, Math.floor(availableParallelism() / 2)));

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
        test: { name: 'web', environment: 'jsdom', include: ['test/web/**/*.test.tsx'] },
      },
    ],
  },
});
