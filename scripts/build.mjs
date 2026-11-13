// Builds the server into dist/server.js: one ES module for Node, with its dependencies left as
// imports (they are installed beside it; the designer's core must exist once, see ADR-0002).
// Then the web application into dist/web (vite.config.mts), which the server serves.
import { build } from 'esbuild';
import { build as buildWeb } from 'vite';

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
});
if (!process.argv.includes('--server-only'))
  await buildWeb({ configFile: 'vite.config.mts', logLevel: 'warn' });
