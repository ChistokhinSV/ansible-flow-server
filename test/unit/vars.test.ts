// AFS-183: where a value comes from, on the pages: the designer's variable index of a project's
// repository at a commit (POST /api/v1/projects/:id/vars), kept per commit, read with the access
// of the Files tab and never holding a secret value; and the launch form's line per input (which
// steps read it, its default, what it wins over).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { samplesDir } from '@ansible-flow/assets';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/server/app';
import { createUser } from '../../src/server/auth/users';
import { type Database, openDatabase } from '../../src/server/db/database';
import { migrate } from '../../src/server/db/migrations';
import { createLogger } from '../../src/server/log';
import { Git } from '../../src/server/projects/git';
import { ProjectSync } from '../../src/server/projects/sync';
import { VarIndexes } from '../../src/server/projects/vars';
import { grant } from './helpers/grant';

const root = mkdtempSync(join(tmpdir(), 'afs-vars-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const PASSWORD = 'correct horse battery staple';

let database: Database;
let app: FastifyInstance;
let git: Git;
let dana: string;
let lina: string;
let finn: string;
let nobody: string;
let project: { id: string; commit: string };
let commit: string;

/** The sample flow with an input a step reads, and a step input that the input wins over. */
const FLOW = readFileSync(join(samplesDir, 'hello.flow.yaml'), 'utf8')
  .replace(
    '      targets: true\n',
    '      targets: true\n    ntp_server:\n      type: string\n      default: 192.0.2.1\n',
  )
  .replace(
    '  intent: Print a hello message with the name of each host.\n',
    '  intent: Print a hello message with the name of each host.\n  inputs:\n    server:\n      type: string\n      from: flow.ntp_server\n',
  )
  .replace('msg: Hello from {{ inventory_hostname }}', 'msg: Hello {{ server }}');

const REPO = {
  'ansible.cfg': '[defaults]\ninventory = inventory/hosts.yml\n',
  'inventory/hosts.yml':
    'all:\n  children:\n    edge:\n      hosts:\n        sw-01:\n        sw-02:\n',
  'inventory/lab.yml': 'all:\n  hosts:\n    lab-01:\n',
  'inventory/group_vars/all.yml': 'ntp_server: 192.0.2.3\n',
  'inventory/group_vars/edge.yml': [
    'ntp_server: 192.0.2.4',
    'api_password: s3cr3t-value-123',
    'snmp_community: !vault |',
    '  $ANSIBLE_VAULT;1.1;AES256',
    '  6162636465',
    '',
  ].join('\n'),
  'flows/ntp.flow.yaml': FLOW,
};

beforeAll(async () => {
  database = openDatabase({ kind: 'sqlite', file: ':memory:' });
  await migrate(database.db as never);
  const log = createLogger({ level: 'error', format: 'json', write: () => undefined });
  git = new Git({ reposDir: join(root, 'repos'), allowLocal: true });
  const sync = new ProjectSync(database.db, git, log);
  app = buildApp({ log, database, instance: 'test', projects: { git, sync, allowLocal: true } });
  const signIn = async (login: string, admin: boolean) => {
    await createUser(database.db, { login, name: login, password: PASSWORD, admin });
    const reply = await app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { login, password: PASSWORD },
    });
    return /afs_session=[^;]*/.exec([reply.headers['set-cookie']].flat().join(';'))?.[0] ?? '';
  };
  dana = await signIn('dana', true);
  lina = await signIn('lina', false);
  finn = await signIn('finn', false);
  nobody = await signIn('nobody', false);
  await call(dana, 'POST', '/api/v1/workspaces', { key: 'net', name: 'Network' });
  await grant(database.db, 'net', 'lina', 'ro');
  project = (
    await call(dana, 'POST', '/api/v1/workspaces/net/projects', {
      key: 'flows',
      name: 'Flows',
      sample: 'hello',
    })
  ).json();
  // finn may read one flow, not the project's files.
  await grant(database.db, 'net', 'finn', 'ro', {
    project: project.id,
    file: 'flows/ntp.flow.yaml',
  });
  const saved = await call(dana, 'POST', `/api/v1/projects/${project.id}/files`, {
    base: project.commit,
    message: 'Inventory and the NTP flow',
    changes: Object.entries(REPO).map(([path, text]) => ({ op: 'write', path, text })),
  });
  expect(saved.statusCode).toBe(201);
  commit = saved.json().commit;
});
afterAll(async () => {
  await app.close();
  await database.close();
});

function call(cookie: string, method: 'GET' | 'POST', url: string, body?: unknown) {
  return app.inject({
    method,
    url,
    headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });
}
const vars = (who: string, body: Record<string, unknown>) =>
  call(who, 'POST', `/api/v1/projects/${project.id}/vars`, { commit, ...body });

describe('the repository’s variables for the canvas', () => {
  it('reads the inventory ansible.cfg names, with file, line and rank, never a secret value', async () => {
    const reply = await vars(lina, {});
    expect(reply.statusCode).toBe(200);
    const { index } = reply.json();
    expect(index.hosts).toEqual(['sw-01', 'sw-02']);
    expect(index.defs.ntp_server).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: 'inventory/group_vars/edge.yml',
          line: 0,
          value: '192.0.2.4',
        }),
        expect.objectContaining({ file: 'inventory/group_vars/all.yml', value: '192.0.2.3' }),
      ]),
    );
    expect(index.defs.api_password?.[0]).toMatchObject({ secret: true });
    expect(index.defs.snmp_community?.[0]).toMatchObject({ secret: true });
    const text = reply.body;
    expect(text).not.toContain('s3cr3t');
    expect(text).not.toContain('6162636465');
    expect(text).not.toContain('ANSIBLE_VAULT');
  });

  it('the inventory a launch names, instead of ansible.cfg’s', async () => {
    const { index } = (await vars(lina, { inventory: 'inventory/lab.yml' })).json();
    expect(index.hosts).toEqual(['lab-01']);
    expect((await vars(lina, { inventory: '../etc/hosts' })).statusCode).toBe(422);
  });

  it('asks what the Files tab asks: ro on the project', async () => {
    // As the Files tab answers each of them: nothing for who sees nothing, nor for who may read
    // one flow only (that is not the project's files).
    const filesOf = (who: string) =>
      call(
        who,
        'GET',
        `/api/v1/projects/${project.id}/files/content?commit=${commit}&path=ansible.cfg`,
      );
    for (const who of [nobody, finn]) {
      const status = (await vars(who, {})).statusCode;
      expect(status).toBeGreaterThanOrEqual(403);
      expect(status).toBe((await filesOf(who)).statusCode);
    }
    expect((await filesOf(lina)).statusCode).toBe(200);
    expect(
      (await call(lina, 'POST', `/api/v1/projects/${project.id}/vars`, { commit: 'f'.repeat(40) }))
        .statusCode,
    ).toBe(404);
  });

  it('keeps an index per commit and request, a bounded number of them', async () => {
    const indexes = new VarIndexes(git, { kept: 2 });
    const a = indexes.index(project.id, commit, { roles: ['b', 'a'] });
    // The same request in another order is the same index.
    expect(indexes.index(project.id, commit, { roles: ['a', 'b'] })).toBe(a);
    expect(indexes.size).toBe(1);
    indexes.index(project.id, commit, { inventory: 'inventory/lab.yml' });
    indexes.index(project.id, project.commit, {});
    expect(indexes.size).toBe(2);
    // The oldest went.
    expect(indexes.index(project.id, commit, { roles: ['a', 'b'] })).not.toBe(a);
    await a;
  });

  it('stops at its limits: the index says it was cut', async () => {
    const indexes = new VarIndexes(git, { maxFiles: 1 });
    const index = await indexes.index(project.id, commit, {});
    expect(index.cut).toBe('files');
  });
});

describe('the launch form says where each input goes', () => {
  let config: string;
  beforeAll(async () => {
    const made = await call(dana, 'POST', `/api/v1/projects/${project.id}/launch-configs`, {
      name: 'NTP',
      flowFile: 'flows/ntp.flow.yaml',
    });
    expect(made.statusCode).toBe(201);
    config = made.json().id;
  });

  it('the steps that read it, its default and the repository’s definitions it wins over', async () => {
    const form = (await call(lina, 'GET', `/api/v1/launch-configs/${config}/form`)).json();
    expect(form.origins.ntp_server).toBe(
      'Read by Say hello (as server); default 192.0.2.1; wins over group_vars of edge (inventory/group_vars/edge.yml:1), group_vars of all (inventory/group_vars/all.yml:1).',
    );
    expect(form.origins.devices).toBe('The hosts the run starts on.');
  });

  it('without the project’s files, only what the flow says', async () => {
    const form = (await call(finn, 'GET', `/api/v1/launch-configs/${config}/form`)).json();
    expect(form.origins.ntp_server).toBe('Read by Say hello (as server); default 192.0.2.1.');
  });
});
