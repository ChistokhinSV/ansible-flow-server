// The world the end-to-end suites share (AFS-38): the compose stack of test/e2e/stack started fresh,
// the first administrator, people and a group, a workspace with a hosted project holding
// test/e2e/repo, the lab's SSH key as a credential, SMTP to Mailpit and launch configurations.
// What it made is kept in a file under the temporary folder, so the browser suite can use the
// same world the lab suite made (or make one itself).
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Api, until } from './api';

const here = dirname(fileURLToPath(import.meta.url));
const composeFile = resolve(here, '../stack/compose.yaml');
const repoSource = resolve(here, '../repo');
const stateFile = join(tmpdir(), 'afs-e2e-world.json');

export const settings = {
  port: Number(process.env.AFS_E2E_PORT ?? 18443),
  mailPort: Number(process.env.AFS_E2E_MAIL_PORT ?? 18025),
  catcherPort: Number(process.env.AFS_E2E_CATCHER_PORT ?? 18090),
  /** The private key the lab's hosts accept for root (test/e2e/README.md). */
  labKey: process.env.AFS_E2E_LAB_KEY ?? '',
};
// 127.0.0.1, not localhost: an antivirus that re-signs loopback TLS may do it by name, and Norton's
// proxy for localhost re-chunked the MCP answers wrongly (a plain body sent as "chunked").
export const base = `https://127.0.0.1:${settings.port}`;
export const mailpit = `http://127.0.0.1:${settings.mailPort}`;
export const catcher = `http://127.0.0.1:${settings.catcherPort}`;

export interface World {
  passwords: Record<string, string>;
  users: Record<string, string>; // login -> id
  group: string;
  workspace: string;
  project: string;
  credential: string;
  envCredential: string;
  configs: { routing: string; approval: string; quick: string };
}

/** The people: an administrator, an operator who launches, an approver, and someone who only reads. */
export const people = {
  admin: { name: 'Avery Admin' },
  olga: { name: 'Olga Operator', email: 'olga@example.net' },
  andre: { name: 'Andre Approver', email: 'andre@example.net' },
  nina: { name: 'Nina Reader', email: 'nina@example.net' },
} as const;

function compose(...args: string[]): string {
  return execFileSync('docker', ['compose', '-f', composeFile, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** The world made before, while its server still knows its administrator; else undefined. */
export async function existingWorld(): Promise<World | undefined> {
  if (!existsSync(stateFile)) return undefined;
  const world = JSON.parse(readFileSync(stateFile, 'utf8')) as World;
  try {
    await Api.signIn(base, 'admin', world.passwords.admin ?? '');
    return world;
  } catch {
    return undefined;
  }
}

export async function signIn(world: World, login: keyof typeof people): Promise<Api> {
  return Api.signIn(base, login, world.passwords[login] ?? '');
}

/** Starts the stack from nothing and makes the world in it. */
export async function freshWorld(): Promise<World> {
  if (!settings.labKey || !existsSync(settings.labKey))
    throw new Error('AFS_E2E_LAB_KEY must name the lab SSH private key file');
  compose('down', '-v', '--remove-orphans');
  compose('up', '-d', '--wait');
  await until('the server to answer', async () => {
    const res = await new Api(base).call('GET', '/healthz');
    return res.status === 200;
  });
  const setup = await until('the setup code in the log', async () => {
    const log = compose('logs', 'server');
    return /setup=(\S+)/.exec(log)?.[1];
  });

  const passwords: Record<string, string> = {};
  for (const login of Object.keys(people))
    passwords[login] = `e2e-${randomBytes(9).toString('base64url')}`;

  const admin = new Api(base);
  await admin.ok('POST', '/api/v1/setup', {
    code: setup,
    login: 'admin',
    password: passwords.admin,
    name: people.admin.name,
  });
  const users: Record<string, string> = {};
  for (const [login, who] of Object.entries(people)) {
    if (login === 'admin') continue;
    const user = await admin.post('/api/v1/users', {
      login,
      name: who.name,
      password: passwords[login],
      email: 'email' in who ? who.email : undefined,
    });
    users[login] = user.id;
  }
  // The change board is told on its webhook; its members are not told one by one.
  const group = await admin.post('/api/v1/groups', {
    name: 'change-board',
    webhookUrl: 'http://catcher:8080/change-board',
  });
  await admin.put(`/api/v1/groups/${group.id}/members`, { users: [users.andre] });
  await admin.put('/api/v1/notifications/smtp', {
    host: 'mailpit',
    port: 1025,
    security: 'none',
    from: 'flows@example.net',
  });

  const ws = await admin.post('/api/v1/workspaces', { key: 'lab', name: 'Lab' });
  await admin.post(`/api/v1/workspaces/${ws.id}/grants`, { user: 'olga', level: 'operator' });
  await admin.post(`/api/v1/workspaces/${ws.id}/grants`, { user: 'nina', level: 'ro' });
  await admin.post(`/api/v1/workspaces/${ws.id}/grants`, {
    group: 'change-board',
    level: 'approve',
  });
  const project = await admin.post(`/api/v1/workspaces/${ws.id}/projects`, {
    key: 'infra',
    name: 'Infrastructure',
  });
  await pushRepo(admin, project.gitPath);
  await admin.post(`/api/v1/projects/${project.id}/sync`);

  const credential = await admin.post(`/api/v1/workspaces/${ws.id}/credentials`, {
    name: 'lab root key',
    kind: 'ssh_key',
    fields: { username: 'root' },
    secret: { privateKey: readFileSync(settings.labKey, 'utf8') },
  });
  const envCredential = await admin.post(`/api/v1/workspaces/${ws.id}/credentials`, {
    name: 'lab ansible settings',
    kind: 'env',
    secret: { ANSIBLE_TIMEOUT: '10' },
  });
  const configBody = (name: string, flowFile: string) => ({
    name,
    flowFile,
    inventory: 'inventory.ini',
    mode: 'real',
    inputs: { devices: ['all'] },
    credentials: [credential.id, envCredential.id],
    notify: { when: 'ended', to: ['olga'] },
  });
  const routing = await admin.post(
    `/api/v1/projects/${project.id}/launch-configs`,
    configBody('Route by role', 'flows/lab-routing.flow.yaml'),
  );
  const approval = await admin.post(`/api/v1/projects/${project.id}/launch-configs`, {
    ...configBody('Change after approval', 'flows/lab-approval.flow.yaml'),
    inputs: { devices: ['web'] },
  });
  // The web hosts only: every host reachable, so the run goes well (and quickly).
  const quick = await admin.post(`/api/v1/projects/${project.id}/launch-configs`, {
    ...configBody('Web hosts only', 'flows/lab-routing.flow.yaml'),
    inputs: { devices: ['web'] },
    notify: null,
  });

  const world: World = {
    passwords,
    users,
    group: group.id,
    workspace: ws.id,
    project: project.id,
    credential: credential.id,
    envCredential: envCredential.id,
    configs: { routing: routing.id, approval: approval.id, quick: quick.id },
  };
  writeFileSync(stateFile, JSON.stringify(world, null, 2));
  return world;
}

/** Pushes test/e2e/repo as the first commit of a hosted project, with a token of the administrator. */
async function pushRepo(admin: Api, gitPath: string): Promise<void> {
  const token = await admin.post('/api/v1/tokens', { name: 'e2e push', expiresInDays: 1 });
  const work = mkdtempSync(join(tmpdir(), 'afs-e2e-repo-'));
  try {
    cpSync(repoSource, work, { recursive: true });
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: work, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('add', '-A');
    git(
      '-c',
      'user.name=E2E',
      '-c',
      'user.email=e2e@example.net',
      'commit',
      '-q',
      '-m',
      'Lab flows',
    );
    const url = gitPath.startsWith('http') ? gitPath : `${base}${gitPath}`;
    git(
      '-c',
      'http.sslVerify=false',
      '-c',
      `http.extraHeader=Authorization: Bearer ${token.token}`,
      'push',
      '-q',
      url,
      'main',
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
