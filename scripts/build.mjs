// Builds the server into dist/server.js: one ES module for Node, with its dependencies left as
// imports (they are installed beside it; the designer's core must exist once, see ADR-0002).
// Then the web application into dist/web (vite.config.mts), which the server serves.
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { build as buildWeb } from 'vite';

// AFS-25: the designer's canvas the pages carry is a build-time dependency, not installed beside
// the server: its version is stamped into the server for /api/v1/meta.
const designerBundle = JSON.parse(
  readFileSync('node_modules/@ansible-flow/designer/package.json', 'utf8'),
).version;

await build({
  entryPoints: { server: 'src/server/main.ts' },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  packages: 'external',
  sourcemap: true,
  logLevel: 'info',
  define: { __AFS_DESIGNER_BUNDLE__: JSON.stringify(designerBundle) },
});
if (!process.argv.includes('--server-only'))
  await buildWeb({ configFile: 'vite.config.mts', logLevel: 'warn' });
