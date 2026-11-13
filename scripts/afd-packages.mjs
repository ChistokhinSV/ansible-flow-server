// Until the Ansible Flow Designer packages (@ansible-flow/*) are on npm, this server installs them
// from tarballs: packed in a checkout of the designer, copied to vendor/ (not in git) and named in
// package.json as file: dependencies. Run it again after the designer changes.
//
//   AFD_REPO  the designer's checkout (default: ../123.Ansible_Studio_VSCODE)
//   --no-pack use the tarballs already in <AFD_REPO>/out/npm
import { execFileSync, execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const designer = resolve(process.env.AFD_REPO ?? join('..', '123.Ansible_Studio_VSCODE'));
const packed = join(designer, 'out', 'npm');
if (!existsSync(join(designer, 'scripts', 'packages.mjs'))) {
  console.error(`No Ansible Flow Designer checkout at ${designer}: set AFD_REPO`);
  process.exit(1);
}
if (!process.argv.includes('--no-pack'))
  execFileSync(process.execPath, ['scripts/packages.mjs', '--check', '--pack'], {
    cwd: designer,
    stdio: 'inherit',
  });

// order.txt: "<name>@<version> <tarball>" per line.
const tarballs = new Map(
  readFileSync(join(packed, 'order.txt'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => {
      const [spec, file] = line.split(' ');
      return [spec.slice(0, spec.lastIndexOf('@')), file];
    }),
);
const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
mkdirSync('vendor', { recursive: true });
// The designer itself is a build-time dependency: Vite bundles it into the pages.
for (const [name, group] of ['dependencies', 'devDependencies'].flatMap((g) =>
  Object.keys(manifest[g] ?? {}).map((n) => [n, g]),
)) {
  if (!name.startsWith('@ansible-flow/')) continue;
  const file = tarballs.get(name);
  if (!file) {
    console.error(`${name} is not among the designer's packages`);
    process.exit(1);
  }
  copyFileSync(join(packed, file), join('vendor', file));
  manifest[group][name] = `file:vendor/${file}`;
  console.log(`${name}: vendor/${file}`);
}
writeFileSync('package.json', `${JSON.stringify(manifest, null, 2)}\n`);
execSync('npm install --no-fund --no-audit', { stdio: 'inherit' });
