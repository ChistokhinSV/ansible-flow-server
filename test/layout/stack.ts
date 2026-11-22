// AFS-138: a server for the layout check, as `just start` runs it but on SQLite in a temporary
// folder, over plain HTTP on loopback, with no container engine (runs wait in the queue, which is
// enough to show their pages). Then a small team's things, with names long enough to find the
// pages that grow sideways. Needs `node scripts/build.mjs` first (dist/server.js and dist/web).
//
// Also by hand, to look at the pages (prints the address and the administrator's password):
//   node test/layout/stack.ts
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export interface Stack {
  base: string;
  login: string;
  password: string;
  /** Paths of the pages to look at, by a short name. */
  pages: Record<string, string>;
  stop(): Promise<void>;
}

/** A long name without spaces, as people paste them: the pages must not grow with it. */
const LONG =
  'platform-network-automation-for-the-eastern-datacenter-edge-switches-and-firewalls-rollout';

export async function startStack(port = Number(process.env.AFS_LAYOUT_PORT ?? 18_438)) {
  if (!existsSync(join(root, 'dist/server.js')) || !existsSync(join(root, 'dist/web')))
    throw new Error('Build first: node scripts/build.mjs (or just build)');
  const taken = await fetch(`http://127.0.0.1:${port}/healthz`).then(
    () => true,
    () => false,
  );
  if (taken) throw new Error(`Port ${port} is taken: stop what runs there, or set AFS_LAYOUT_PORT`);
  const data = mkdtempSync(join(tmpdir(), 'afs-layout-'));
  const child = spawn(process.execPath, ['dist/server.js'], {
    cwd: root,
    env: {
      ...process.env,
      AFS_TLS: 'off',
      AFS_HOST: '127.0.0.1',
      AFS_PORT: String(port),
      AFS_CONTAINER_ENGINE: 'off',
      AFS_DATA_DIR: data,
      AFS_DATABASE_URL: '',
      AFS_PUBLIC_URL: '',
      AFS_MASTER_KEY: randomBytes(32).toString('base64'),
      AFS_LOG_LEVEL: 'info',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stop = async () => {
    await new Promise<void>((done) => {
      if (child.exitCode !== null) return done();
      child.once('exit', () => done());
      child.kill();
    });
    rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  try {
    const code = await setupCode(child);
    const base = `http://127.0.0.1:${port}`;
    const password = `${randomBytes(9).toString('base64url')}-Afs`;
    const pages = await seed(base, code, password);
    return { base, login: 'dana', password, pages, stop } satisfies Stack;
  } catch (e) {
    await stop();
    throw e;
  }
}

/** The setup code the server prints while it has no user, once it listens. */
function setupCode(child: ChildProcess): Promise<string> {
  return new Promise((done, fail) => {
    let log = '';
    let code = '';
    const timer = setTimeout(() => fail(new Error(`The server did not start:\n${log}`)), 180_000);
    const read = (chunk: Buffer) => {
      log += chunk.toString();
      code ||= /setup=([\w-]+)/.exec(log)?.[1] ?? '';
      if (code && /listening at/.test(log)) {
        clearTimeout(timer);
        done(code);
      }
    };
    child.stdout?.on('data', read);
    child.stderr?.on('data', read);
    child.once('exit', (status) => {
      clearTimeout(timer);
      fail(new Error(`The server stopped (${status}):\n${log}`));
    });
  });
}

async function seed(base: string, code: string, password: string): Promise<Record<string, string>> {
  let cookie = '';
  // biome-ignore lint/suspicious/noExplicitAny: the answers are read by the few fields used here
  const call = async (method: string, path: string, body?: unknown): Promise<any> => {
    const res = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0] ?? cookie;
    const text = await res.text();
    if (res.status >= 400)
      throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : undefined;
  };
  await call('POST', '/setup', {
    code,
    login: 'dana',
    name: 'Dana Whitfield',
    email: 'dana@example.net',
    password,
  });
  await call('POST', '/session', { login: 'dana', password });
  for (const [login, name] of [
    ['mia', 'Mia Ortega'],
    ['omar', 'Omar Haddad'],
    ['bartholomew.vandenberghe-longname', 'Bartholomew Vandenberghe-Kowalczyk'],
  ])
    await call('POST', '/users', {
      login,
      name,
      email: `${login}@example.net`,
      password: `${randomBytes(9).toString('base64url')}-Afs`,
    });
  await call('POST', '/workspaces', {
    key: 'network',
    name: 'Network team',
    description: 'Switches, firewalls and the edge',
  });
  for (const [key, name, sample] of [
    ['hello', 'Hello', 'hello'],
    ['edge', 'Edge switches', 'edge-baseline'],
  ])
    await call('POST', '/workspaces/network/projects', { key, name, sample });
  await call('POST', '/workspaces/network/projects', {
    key: 'long',
    name: LONG,
    sample: 'hello',
  });
  await call('POST', '/workspaces/network/credentials', {
    name: `${LONG}-ssh-key`.slice(0, 100),
    kind: 'login',
    fields: { username: `svc_${LONG.replaceAll('-', '_')}` },
    secret: { password: randomBytes(12).toString('base64url') },
  });
  await call('POST', '/tokens', { name: `ci-pipeline-${LONG}`.slice(0, 100), expiresInDays: 30 });
  // AFS-169: an environment whose spec is longer than a window, for its sticky Save and Build bar.
  const environment = await call('POST', '/workspaces/network/environments', {
    name: 'net-tools',
    kind: 'spec',
    spec: {
      ansibleCore: '2.19',
      collections: [
        { name: 'cisco.ios', version: '11.7.0' },
        { name: 'ansible.netcommon', version: '8.7.1' },
        { name: 'ansible.utils', version: '6.0.0' },
        { name: 'arista.eos', version: '12.0.0' },
        { name: 'junipernetworks.junos', version: '10.0.0' },
        { name: 'community.general', version: '11.4.0' },
      ],
      python: ['netaddr>=1.3', 'jmespath', 'paramiko', 'ncclient', 'textfsm', 'ttp'],
      system: ['iputils-ping', 'openssh-client', 'git'],
    },
  });

  const projects = await call('GET', '/workspaces/network/projects');
  const hello = (Array.isArray(projects) ? projects : projects.projects).find(
    (p: { key: string }) => p.key === 'hello',
  );
  const configs = await call('GET', `/projects/${hello.id}/launch-configs`);
  const config = (Array.isArray(configs) ? configs : configs.configs)[0];
  const flow = config.flowFile ?? config.flow;
  // AFS-123: a few commits after the first, for the History tab and a flow at a commit.
  const fileAt = async (commit: string, path: string) =>
    (
      await fetch(
        `${base}/api/v1/projects/${hello.id}/files/content?commit=${commit}&path=${encodeURIComponent(path)}`,
        { headers: { cookie } },
      )
    ).text();
  let tip: string = hello.commit;
  const save = async (message: string, changes: unknown[]) => {
    tip = (await call('POST', `/projects/${hello.id}/files`, { base: tip, message, changes }))
      .commit;
    return tip;
  };
  await save('Add a readme for the team', [
    { op: 'write', path: 'README.md', text: '# Hello\n\nThe smallest useful flow.\n' },
  ]);
  const text = await fileAt(tip, flow);
  const changed = await save(
    `Greet the team by name in ${flow.split('/').at(-1)}, and say where the facts come from`,
    [
      {
        op: 'write',
        path: flow,
        text: text
          .replace('title: Say hello\n', 'title: Say hello to the team\n')
          .replace('title: Read a few facts\n', 'title: Read the minimal facts\n'),
      },
    ],
  );
  // AFS-195: a flow deep in folders with long names: its breadcrumb must not push the page down.
  const deep =
    'flows/edge-baseline-for-the-branch-offices/edge-baseline-for-the-branch-offices.flow.yaml';
  await save('A copy deep in folders', [{ op: 'write', path: deep, text }]);
  await save('Tune the inventory', [
    { op: 'write', path: 'inventory.ini', text: '[all]\nlocalhost ansible_connection=local\n' },
  ]);
  const run = await call('POST', `/launch-configs/${config.id}/launch`, {});
  return {
    home: '/',
    workspace: '/w/network',
    project: '/w/network/hello',
    files: '/w/network/hello/files',
    flow: `/w/network/hello/flow/${flow}`,
    flowEdit: `/w/network/hello/flow/${flow}?edit=1`,
    flowDeep: `/w/network/hello/flow/${deep}`,
    // AFS-123: the project's history, and the flow as one commit left it.
    history: '/w/network/hello/history',
    flowAtCommit: `/w/network/hello/flow/${flow}?commit=${changed}`,
    longProject: '/w/network/long',
    launch: `/w/network/hello/launch/${config.id}`,
    run: `/runs/${run.id ?? run.run?.id}`,
    runs: '/runs',
    approvals: '/approvals',
    credentials: '/w/network/-/credentials',
    tokens: '/account/tokens',
    people: '/admin/people',
    audit: '/admin/audit',
    // AFS-154: the pages the round-2 exploration found wider or covered.
    access: '/w/network/-/access',
    edge: '/w/network/edge',
    newLaunch: '/w/network/hello/launch/new',
    missing: '/w/network/hello/flow/flows/gone.flow.yaml',
    help: '/help',
    // AFS-155: the guide the server serves, a page with a wide table.
    guide: '/help/guide/web-pages.md',
    // AFS-162: settings that end with a danger zone.
    projectSettings: '/w/network/hello/settings',
    launchSettings: `/w/network/hello/launch/${config.id}/settings`,
    // AFS-169: an environment, with its Save and Build bar.
    environment: `/w/network/environments/${environment.id}`,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const stack = await startStack();
  console.log(`${stack.base}  login ${stack.login}  password ${stack.password}`);
  for (const [name, path] of Object.entries(stack.pages))
    console.log(`${name}: ${stack.base}${path}`);
  const { stop: _, ...shown } = stack;
  console.log(`AFS_LAYOUT_STACK='${JSON.stringify(shown)}'`);
  console.log('Ctrl+C stops it');
  process.on('SIGINT', () => void stack.stop().then(() => process.exit(0)));
}
