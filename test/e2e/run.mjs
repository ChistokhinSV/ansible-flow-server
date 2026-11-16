// Runs the end-to-end suites (AFS-38) on any shell: `node test/e2e/run.mjs lab|browser|image|down`.
//   image    build the server's image the stack runs (ansible-flow-server:e2e)
//   lab      the lab suite (Vitest): a fresh stack, then runs against the GNS3 lab
//   browser  the browser smoke test (Playwright), on the stack the lab suite left, or a fresh one
//   down     stop the stack and remove its data
// AFS_E2E_LAB_KEY must name the lab's SSH private key (test/e2e/README.md).
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const [what, ...rest] = process.argv.slice(2);
const env = { ...process.env, AFS_E2E: '1' };
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, {
    cwd: root,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  process.exit(r.status ?? 1);
};

switch (what) {
  case 'image':
    run('docker', ['build', '-t', process.env.AFS_E2E_IMAGE ?? 'ansible-flow-server:e2e', '.']);
    break;
  case 'lab':
    run('npx', ['--no-install', 'vitest', 'run', '--project', 'e2e', ...rest]);
    break;
  case 'browser':
    run('npx', [
      '--no-install',
      'playwright',
      'test',
      '-c',
      'test/e2e/browser/playwright.config.ts',
      ...rest,
    ]);
    break;
  case 'down':
    run('docker', [
      'compose',
      '-f',
      'test/e2e/stack/compose.yaml',
      'down',
      '-v',
      '--remove-orphans',
    ]);
    break;
  default:
    console.error('Usage: node test/e2e/run.mjs image|lab|browser|down [args]');
    process.exit(2);
}
