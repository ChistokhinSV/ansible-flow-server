import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // With PostgreSQL the test files share one database (AFS_TEST_POSTGRES_URL): one file at a
    // time, so one file's fresh start is not another's missing table.
    fileParallelism: !process.env.AFS_TEST_POSTGRES_URL,
    projects: [
      {
        extends: true,
        test: { name: 'server', environment: 'node', include: ['test/unit/**/*.test.ts'] },
      },
      {
        extends: true,
        plugins: [react()],
        test: { name: 'web', environment: 'jsdom', include: ['test/web/**/*.test.tsx'] },
      },
    ],
  },
});
