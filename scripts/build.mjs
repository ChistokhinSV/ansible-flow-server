// Builds the server into dist/server.js: one ES module for Node, with its dependencies left as
// imports (they are installed beside it; the designer's core must exist once, see ADR-0002).
// Then the web application into dist/web (vite.config.mts), which the server serves.
import { cpSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
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
// AFS-116: the Ansible collection the server mounts into every run (dist/collection), as it is
// published: its plugins, meta and description, not its tests.
const collection = 'collection/ansible_collections/chistokhinsv/ansible_flow';
const into = `dist/${collection}`;
rmSync(into, { recursive: true, force: true });
for (const part of ['galaxy.yml', 'README.md', 'meta', 'plugins'])
  cpSync(join(collection, part), join(into, part), {
    recursive: true,
    filter: (path) => !/__pycache__|\.pyc$/.test(path),
  });
if (!process.argv.includes('--server-only'))
  await buildWeb({ configFile: 'vite.config.mts', logLevel: 'warn' });
