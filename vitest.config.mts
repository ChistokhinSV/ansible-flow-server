import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/unit/**/*.test.ts'],
    // With PostgreSQL the test files share one database (AFS_TEST_POSTGRES_URL): one file at a
    // time, so one file's fresh start is not another's missing table.
    fileParallelism: !process.env.AFS_TEST_POSTGRES_URL,
  },
});
