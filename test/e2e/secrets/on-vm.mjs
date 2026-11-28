// Runs test/e2e/secretProviders.test.ts in a container on the Docker host of the secret provider
// lab (test/e2e/labs/secrets, network spike-s9): from there TLS is not intercepted, as it is on a
// Windows machine with Norton. Bundles the test with esbuild (Vitest replaced by node:test),
// copies it there, adds the lab's values and the CCP client certificates from the lab's out
// folder, and runs it.
//   AFS_SECRETS_LAB_HOST=<the lab's address> node test/e2e/secrets/on-vm.mjs
// Settings: AFS_SECRETS_VM (ssh host, default gns3), AFS_SECRETS_LAB_DIR (on that host, default
// afs-labs/secrets).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const labHost = process.env.AFS_SECRETS_LAB_HOST;
if (!labHost) {
  console.error("Set AFS_SECRETS_LAB_HOST to the address of the lab's ports");
  process.exit(2);
}
const vm = process.env.AFS_SECRETS_VM ?? 'gns3';
const lab = `~/${process.env.AFS_SECRETS_LAB_DIR ?? 'afs-labs/secrets'}/out`;
const out = mkdtempSync(join(tmpdir(), 'afs-secrets-lab-'));
const there = '/tmp/afs-secrets-lab';
try {
  await build({
    entryPoints: [resolve(here, '../secretProviders.test.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    outfile: join(out, 'secrets.test.mjs'),
    alias: { vitest: resolve(here, 'vitest-shim.mjs') },
    logLevel: 'warning',
  });
  const run = (...args) => execFileSync(args[0], args.slice(1), { stdio: 'inherit' });
  run('ssh', vm, `rm -rf ${there} && mkdir -m 700 -p ${there}`);
  run('scp', '-q', join(out, 'secrets.test.mjs'), `${vm}:${there}/`);
  run(
    'ssh',
    vm,
    [
      `cp ${lab}/vault-ca.pem ${lab}/vault-role-id ${lab}/vault-secret-id`,
      `${lab}/vault-token ${lab}/conjur-host-key ${there}/ &&`,
      `cp ${lab}/ccp-client/ca.pem ${there}/ccp-ca.pem &&`,
      `cp ${lab}/ccp-client/client.pem ${there}/ccp-client.pem &&`,
      `cp ${lab}/ccp-client/client.key ${there}/ccp-client.key &&`,
      `docker run --rm --network spike-s9 -v ${there}:/t:ro -e AFS_SECRETS_LAB=/t`,
      `-e AFS_SECRETS_LAB_HOST=${labHost} node:24-bookworm node --test /t/secrets.test.mjs;`,
      `rc=$?; rm -rf ${there}; exit $rc`,
    ].join(' '),
  );
} finally {
  rmSync(out, { recursive: true, force: true });
}
