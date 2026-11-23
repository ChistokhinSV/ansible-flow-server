// Runs test/e2e/secretProviders.test.ts in a container on the GNS3 VM, next to the secret
// provider lab (~/spike-s9, network spike-s9): from there TLS is not intercepted, as it is on a
// Windows machine with Norton. Bundles the test with esbuild (Vitest replaced by node:test),
// copies it with the CCP certificates, adds the lab's values from ~/spike-s9/out, and runs it.
//   AFS_SECRETS_LAB_CERTS=<folder with ca.pem, client.pem, client.key> node test/e2e/secrets/on-vm.mjs
// Settings: AFS_SECRETS_VM (ssh host, default gns3), AFS_SECRETS_LAB_HOST (default 192.168.200.128).
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const certs = process.env.AFS_SECRETS_LAB_CERTS;
if (!certs) {
  console.error('Set AFS_SECRETS_LAB_CERTS to the folder of the CCP mock certificates');
  process.exit(2);
}
const vm = process.env.AFS_SECRETS_VM ?? 'gns3';
const labHost = process.env.AFS_SECRETS_LAB_HOST ?? '192.168.200.128';
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
  copyFileSync(join(certs, 'ca.pem'), join(out, 'ccp-ca.pem'));
  copyFileSync(join(certs, 'client.pem'), join(out, 'ccp-client.pem'));
  copyFileSync(join(certs, 'client.key'), join(out, 'ccp-client.key'));
  const run = (...args) => execFileSync(args[0], args.slice(1), { stdio: 'inherit' });
  run('ssh', vm, `rm -rf ${there} && mkdir -p ${there}`);
  run('scp', '-q', join(out, 'secrets.test.mjs'), join(out, 'ccp-ca.pem'), join(out, 'ccp-client.pem'), join(out, 'ccp-client.key'), `${vm}:${there}/`);
  run(
    'ssh',
    vm,
    [
      `cp ~/spike-s9/out/vault-ca.pem ~/spike-s9/out/vault-role-id ~/spike-s9/out/vault-secret-id`,
      `~/spike-s9/out/vault-token ~/spike-s9/out/conjur-host-key ${there}/ &&`,
      `docker run --rm --network spike-s9 -v ${there}:/t:ro -e AFS_SECRETS_LAB=/t`,
      `-e AFS_SECRETS_LAB_HOST=${labHost} node:24-bookworm node --test /t/secrets.test.mjs;`,
      `rc=$?; rm -rf ${there}; exit $rc`,
    ].join(' '),
  );
} finally {
  rmSync(out, { recursive: true, force: true });
}
