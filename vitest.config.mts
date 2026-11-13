import { readFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// As the build stamps it (scripts/build.mjs): the designer's canvas the pages carry.
const designerBundle = JSON.parse(
  readFileSync('node_modules/@ansible-flow/designer/package.json', 'utf8'),
).version;

export default defineConfig({
  define: { __AFS_DESIGNER_BUNDLE__: JSON.stringify(designerBundle) },
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
