// Builds the server into dist/server.js: one ES module for Node, with its dependencies left as
// imports (they are installed beside it; the designer's core must exist once, see ADR-0002).
import { build } from 'esbuild';

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
