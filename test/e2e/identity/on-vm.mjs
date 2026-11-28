// Runs signin.test.mjs in a container on the Docker host of the identity lab (test/e2e/labs), where
// TLS is not intercepted as it is on a Windows machine with Norton. The server must trust the lab
// CA (AFS_CA_FILE) and its AFS_PUBLIC_URL must be among the lab's AFS_URLS.
//   AFS_URL=<server> AFS_SESSION=<administrator's session cookie> AFS_SERVER_CA=<server's certificate>
//     node test/e2e/identity/on-vm.mjs
// Settings: AFS_IDENTITY_VM (ssh host, default gns3), AFS_IDENTITY_LAB_DIR (on that host, default
// afs-labs/identity), AFS_IDENTITY_LAB_HOST (default: the host of AFS_URL).
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const need = (k) => {
  const v = process.env[k];
  if (!v) {
    console.error(`Set ${k}`);
    process.exit(2);
  }
  return v;
};
const url = need('AFS_URL');
const session = need('AFS_SESSION');
const serverCa = need('AFS_SERVER_CA');
const vm = process.env.AFS_IDENTITY_VM ?? 'gns3';
const labDir = process.env.AFS_IDENTITY_LAB_DIR ?? 'afs-labs/identity';
const labHost = process.env.AFS_IDENTITY_LAB_HOST ?? new URL(url).hostname;
const here = dirname(fileURLToPath(import.meta.url));
const out = mkdtempSync(join(tmpdir(), 'afs-identity-lab-'));
const there = '/tmp/afs-identity-e2e';
try {
  copyFileSync(join(here, 'signin.test.mjs'), join(out, 'signin.test.mjs'));
  copyFileSync(serverCa, join(out, 'server-ca.pem'));
  // The session goes in a file for --env-file, not on a command line others can read.
  writeFileSync(
    join(out, 'env'),
    `AFS_URL=${url}\nAFS_SESSION=${session}\nAFS_IDENTITY_LAB=/lab\nAFS_IDENTITY_LAB_HOST=${labHost}\nNODE_EXTRA_CA_CERTS=/t/ca.pem\n`,
    { mode: 0o600 },
  );
  const run = (...args) => execFileSync(args[0], args.slice(1), { stdio: 'inherit' });
  run('ssh', vm, `rm -rf ${there} && mkdir -m 700 -p ${there}`);
  run(
    'scp',
    '-q',
    join(out, 'signin.test.mjs'),
    join(out, 'server-ca.pem'),
    join(out, 'env'),
    `${vm}:${there}/`,
  );
  run(
    'ssh',
    vm,
    [
      `cat ${there}/server-ca.pem ~/${labDir}/out/certs/ca.pem > ${there}/ca.pem &&`,
      `docker run --rm --network host -v ${there}:/t:ro -v ~/${labDir}/out:/lab:ro`,
      `--env-file ${there}/env node:24-bookworm node --test /t/signin.test.mjs;`,
      `rc=$?; rm -rf ${there}; exit $rc`,
    ].join(' '),
  );
} finally {
  rmSync(out, { recursive: true, force: true });
}
