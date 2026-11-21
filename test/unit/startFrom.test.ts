// AFS-126: an empty flow in the pages starts from a sample, a playbook of the project's repository
// or an AWX template (a fake AWX here). Each is one edit of the draft, keeps the flow's key, and
// is refused once the flow has steps; what is offered lists the repository's playbooks and the
// workspace's AWX credentials, and someone with read access starts nothing.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { samplesDir } from '@ansible-flow/assets';
import { parseFlow } from '@ansible-flow/core/flow/document';
import type { FlowDocument } from '@ansible-flow/core/flow/types';
import type { SourceIO } from '@ansible-flow/core/import/read';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/server/app';
import { createToken } from '../../src/server/auth/tokens';
import { createUser } from '../../src/server/auth/users';
import { type Database, openDatabase } from '../../src/server/db/database';
import { migrate } from '../../src/server/db/migrations';
import { sampleBindings, sampleFlowText, stepCount } from '../../src/server/drafts/startFrom';
import { createLogger } from '../../src/server/log';
import { roleGaps } from '../../src/server/projects/flows';
import { Git } from '../../src/server/projects/git';
import { listSamples, sampleFiles } from '../../src/server/projects/start';
import { createProject, createWorkspace, type Project } from '../../src/server/projects/store';
import { ProjectSync } from '../../src/server/projects/sync';
import { createCredential } from '../../src/server/secrets/credentials';
import { keyId, type MasterKey, newKey } from '../../src/server/secrets/masterKey';
import { grant } from './helpers/grant';
import { type TestRepo, testRepo } from './helpers/repo';

const EMPTY = (key: string) => `schema_version: 2
flow:
  key: ${key}
  name: ${key}
  version: 1
nodes:
  - id: 01J00000000000000000000001
    key: start
    type: start
    title: Start
  - id: 01J00000000000000000000002
    key: done
    type: end
    title: Done
edges:
  - id: 01J00000000000000000000003
    from: { node: 01J00000000000000000000001, port: ok_hosts }
    to: { node: 01J00000000000000000000002, port: in }
`;

/** The sample playbooks (and their roles) laid out at the repository's top. */
function playbookFiles(): Record<string, string> {
  const dir = join(samplesDir, 'playbooks', 'edge-baseline');
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p).split('\\').join('/')] = readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}

const root = mkdtempSync(join(tmpdir(), 'afs-start-from-'));
const bytes = newKey();
const key: MasterKey = { key: bytes, id: keyId(bytes), source: 'env' };
let database: Database;
let app: FastifyInstance;
let sync: ProjectSync;
let source: TestRepo;
let project: Project;
/** AFS-173: a project without the sample's roles but one of its own named as one of them. */
let lab: Project;
let bareSource: TestRepo;
let git: Git;
let awx: Server;
let awxCredential = '';
type Loose = ReturnType<typeof JSON.parse>;
const tokens: Record<string, string> = {};
const seen: string[] = [];

beforeAll(async () => {
  source = testRepo({
    ...playbookFiles(),
    'flows/one/one.flow.yaml': EMPTY('one'),
    'flows/two/two.flow.yaml': EMPTY('two'),
    'flows/three/three.flow.yaml': EMPTY('three'),
    'flows/four/four.flow.yaml': EMPTY('four'),
    'flows/five/five.flow.yaml': EMPTY('five'),
    'flows/six/six.flow.yaml': EMPTY('six'),
  });
  const bare = join(root, 'source.git');
  execFileSync('git', ['clone', '--quiet', '--bare', source.dir, bare]);
  database = openDatabase({ kind: 'sqlite', file: ':memory:' });
  await migrate(database.db as never);
  const log = createLogger({ level: 'error', format: 'json', write: () => undefined });
  git = new Git({ reposDir: join(root, 'repos'), allowLocal: true });
  sync = new ProjectSync(database.db, git, log);
  app = buildApp({
    log,
    database,
    instance: 'test',
    masterKey: key,
    projects: { git, sync, allowLocal: true },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const workspace = await createWorkspace(database.db, { key: 'net', name: 'Network' });
  const made = await createProject(
    database.db,
    workspace.id,
    { key: 'edge', name: 'Edge', gitUrl: bare, pollSeconds: 0 },
    true,
  );
  project = (await sync.sync(made.id)) as Project;
  bareSource = testRepo({
    'flows/a/a.flow.yaml': EMPTY('a'),
    'flows/b/b.flow.yaml': EMPTY('b'),
    'roles/push_baseline/tasks/main.yml': '- name: Our own\n  ansible.builtin.debug: {}\n',
  });
  const bare2 = join(root, 'source2.git');
  execFileSync('git', ['clone', '--quiet', '--bare', bareSource.dir, bare2]);
  const made2 = await createProject(
    database.db,
    workspace.id,
    { key: 'lab', name: 'Lab', gitUrl: bare2, pollSeconds: 0 },
    true,
  );
  lab = (await sync.sync(made2.id)) as Project;
  for (const [login, level] of [
    ['mia', 'rw'],
    ['lena', 'ro'],
  ] as const) {
    const u = await createUser(database.db, {
      login,
      name: login,
      email: `${login}@example.net`,
    });
    await grant(database.db, 'net', login, level);
    tokens[login] = (await createToken(database.db, u.id, { name: 't' })).token;
  }
  // A fake AWX: one job template running the repository's baseline.yml, one workflow.
  awx = createServer((req, res) => {
    seen.push(`${req.headers.authorization} ${req.url}`);
    const json = (body: unknown) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    };
    const url = req.url ?? '';
    if (url.startsWith('/api/v2/workflow_job_templates/'))
      return json({ results: [{ id: 7, name: 'Nightly', description: 'All of it' }], next: null });
    if (url.startsWith('/api/v2/job_templates/?') || url === '/api/v2/job_templates/')
      return json({ results: [{ id: 3, name: 'Edge baseline' }], next: null });
    if (url === '/api/v2/job_templates/3/')
      return json({ id: 3, name: 'Edge baseline', playbook: 'prechecks.yml', extra_vars: '' });
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((done) => awx.listen(0, '127.0.0.1', done));
  awxCredential = (
    await createCredential(database.db, key, workspace.id, {
      name: 'lab awx',
      kind: 'awx' as never,
      fields: { url: `http://127.0.0.1:${(awx.address() as AddressInfo).port}` },
      secret: { token: 'awx-token-1' },
    })
  ).id;
});
afterAll(async () => {
  await sync.stop();
  await app.close();
  await database.close();
  await new Promise((done) => awx.close(done));
  source.remove();
  bareSource.remove();
  rmSync(root, { recursive: true, force: true });
});

const api = () => `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/v1`;
const call = async (who: string, method: string, path: string, body?: unknown) => {
  const reply = await fetch(`${api()}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${tokens[who]}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: reply.status, json: (await reply.json().catch(() => undefined)) as Loose };
};
const draftOf = async (key: string, of: Project = project) =>
  (
    await call(
      'mia',
      'POST',
      `/projects/${of.id}/drafts?path=${encodeURIComponent(`flows/${key}/${key}.flow.yaml`)}`,
    )
  ).json.id as string;
const textOf = async (id: string) => {
  const d = await call('mia', 'GET', `/drafts/${id}`);
  return d.json.snapshot.doc as {
    flow: { key: string; id?: string };
    nodes: { type: string; title: string }[];
  };
};

describe('an empty flow starts from something', () => {
  it('offers the samples, the playbooks of the repository and the AWX credentials', async () => {
    const id = await draftOf('one');
    const offered = await call('mia', 'GET', `/drafts/${id}/start-from`);
    expect(offered.status).toBe(200);
    expect(offered.json.samples.map((s: { key: string }) => s.key)).toContain('hello');
    expect(offered.json.playbooks).toEqual(
      expect.arrayContaining(['site.yml', 'prechecks.yml', 'baseline.yml', 'rollback.yml']),
    );
    // Roles' task files are not playbooks.
    expect(offered.json.playbooks.some((p: string) => p.startsWith('roles/'))).toBe(false);
    expect(offered.json.awx).toEqual([
      { id: awxCredential, name: 'lab awx', url: expect.stringMatching(/^http:\/\/127/) },
    ]);
    // Read access starts nothing, and is not shown what to start from.
    expect((await call('lena', 'GET', `/drafts/${id}/start-from`)).status).toBe(403);
    expect(
      (await call('lena', 'POST', `/drafts/${id}/start-from`, { sample: 'hello' })).status,
    ).toBe(403);
  });

  it("a sample keeps the flow's version and owner; the count and the undo are the steps (AFS-151)", async () => {
    const id = await draftOf('five');
    const done = await call('mia', 'POST', `/drafts/${id}/start-from`, { sample: 'edge-baseline' });
    expect(done.status).toBe(200);
    const d = await call('mia', 'GET', `/drafts/${id}`);
    const flow = d.json.snapshot.doc.flow as { version: number; owner?: string };
    expect(flow.version).toBe(1);
    expect(flow.owner).toBeUndefined();
    // Every step on every level, as Readiness counts them.
    const all = stepCount(sampleFlowText('edge-baseline'));
    expect(done.json.steps).toBe(all);
    const undo = await call('mia', 'POST', `/drafts/${id}/undo`);
    expect(undo.json.started).toEqual({ what: 'the sample flow', steps: all });
  });

  it('the undo of an import names the playbook (AFS-151)', async () => {
    const id = await draftOf('six');
    const done = await call('mia', 'POST', `/drafts/${id}/start-from`, { playbook: 'site.yml' });
    expect(done.status).toBe(200);
    const undo = await call('mia', 'POST', `/drafts/${id}/undo`);
    expect(undo.json.started).toEqual({ what: 'the import of site.yml', steps: done.json.steps });
    // AFS-172: its redo brings the import back, as one thing again (Ctrl+Z takes it back again).
    const redo = await call('mia', 'POST', `/drafts/${id}/redo`);
    expect(redo.json.started).toEqual({ what: 'the import of site.yml', steps: done.json.steps });
    const again = await call('mia', 'POST', `/drafts/${id}/undo`);
    expect(again.json.started).toEqual({ what: 'the import of site.yml', steps: done.json.steps });
  });

  it('a step bound to a role the repository lacks gets a role-missing warning (AFS-151)', async () => {
    const doc = parseFlow(sampleFlowText('edge-baseline')).doc as FlowDocument;
    const none = await roleGaps(doc, 'flows/x/x.flow.yaml', async () => false);
    expect(none.map((f) => [f.code, f.subject])).toEqual(
      expect.arrayContaining([
        ['role-missing', 'netops_backup'],
        ['role-missing', 'push_baseline'],
      ]),
    );
    expect(none.every((f) => f.node && f.severity === 'warning')).toBe(true);
    // Beside the flow counts too; a check that fails is no warning.
    const beside = await roleGaps(doc, 'flows/x/x.flow.yaml', async (p) =>
      p.startsWith('flows/x/'),
    );
    expect(beside).toEqual([]);
    const broken = await roleGaps(doc, 'f.flow.yaml', async () => {
      throw new Error('git');
    });
    expect(broken).toEqual([]);
  });

  it('a sample brings the roles its flow binds; a role the project has is kept (AFS-173)', async () => {
    // This repository has the Edge baseline roles: each is kept, and the note says so.
    const done = await call('mia', 'POST', `/drafts/${await draftOf('four')}/start-from`, {
      sample: 'edge-baseline',
    });
    expect(done.status).toBe(200);
    // AFS-192: one sentence for both roles, not one per role.
    expect(done.json.notes.join(' ')).toMatch(
      /The project has the roles netops_backup and push_baseline already: it keeps its own, the sample's are not added\./,
    );
    expect(done.json.notes.join(' ').match(/The project has/g)).toHaveLength(1);
    expect(done.json.notes.join(' ')).not.toMatch(/Save adds/);
    // One without them: each role's whole folder, from the sample, nothing else of it.
    const doc = parseFlow(sampleFlowText('edge-baseline')).doc as FlowDocument;
    const empty = {
      read: async () => undefined,
      list: async () => [],
      exists: async () => false,
    } as unknown as SourceIO;
    const bound = await sampleBindings('edge-baseline', doc, empty, 'flows/x/x.flow.yaml');
    const paths = bound.files.map((f) => f.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        'roles/netops_backup/tasks/main.yml',
        'roles/push_baseline/tasks/main.yml',
        'roles/push_baseline/templates/aaa.j2',
      ]),
    );
    expect(paths.every((p) => p.startsWith('roles/'))).toBe(true);
    expect(bound.notes[0]).toMatch(
      /^Save adds the sample's roles\/netops_backup, roles\/push_baseline to the repository/,
    );
  });

  it('a start from a sample taken back takes its roles back too (AFS-173)', async () => {
    const id = await draftOf('b', lab);
    await call('mia', 'POST', `/drafts/${id}/start-from`, { sample: 'edge-baseline' });
    expect((await call('mia', 'POST', `/drafts/${id}/undo`)).status).toBe(200);
    // The project still lacks netops_backup, but the start that brought it is taken back.
    const saved = await call('mia', 'POST', `/drafts/${id}/save`, {});
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);
    expect(saved.json.added).toBeUndefined();
    const head = (await sync.refresh(lab.id))?.commit as string;
    expect(await git.exists(lab.id, head, 'roles/netops_backup')).toBe(false);
  });

  it('the roles come in the commit of the flow, never over a file the project has (AFS-173)', async () => {
    const id = await draftOf('a', lab);
    const done = await call('mia', 'POST', `/drafts/${id}/start-from`, { sample: 'edge-baseline' });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    const notes = done.json.notes.join(' ');
    expect(notes).toMatch(/Save adds the sample's roles\/netops_backup to the repository/);
    expect(notes).toMatch(
      /has the role push_baseline already: it keeps its own, the sample's is not/,
    );
    // The draft counts the role it brings as there: no role-missing warning for it.
    const shown = await call('mia', 'GET', `/drafts/${id}`);
    const gaps = (shown.json.snapshot.findings as { code: string; subject?: string }[]).filter(
      (f) => f.code === 'role-missing',
    );
    expect(gaps).toEqual([]);
    const saved = await call('mia', 'POST', `/drafts/${id}/save`, {});
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);
    expect(saved.json.added).toEqual(
      expect.arrayContaining(['roles/netops_backup/tasks/main.yml']),
    );
    const commit = saved.json.commit as string;
    const files = await git.files(lab.id, commit);
    expect(files).toEqual(
      expect.arrayContaining(['flows/a/a.flow.yaml', 'roles/netops_backup/tasks/main.yml']),
    );
    // The project's own role is as it was, and nothing else of the sample came.
    expect((await git.read(lab.id, commit, 'roles/push_baseline/tasks/main.yml'))?.toString()).toBe(
      '- name: Our own\n  ansible.builtin.debug: {}\n',
    );
    expect(files).not.toContain('roles/push_baseline/tasks/ntp.yml');
    expect(files).not.toContain('site.yml');
  });

  it('a start from a sample brought back by redo brings its roles back too (AFS-172, AFS-173)', async () => {
    const id = await draftOf('b', lab);
    await call('mia', 'POST', `/drafts/${id}/start-from`, { sample: 'edge-baseline' });
    expect((await call('mia', 'POST', `/drafts/${id}/undo`)).status).toBe(200);
    expect((await call('mia', 'POST', `/drafts/${id}/redo`)).status).toBe(200);
    const saved = await call('mia', 'POST', `/drafts/${id}/save`, {});
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);
    const head = (await sync.refresh(lab.id))?.commit as string;
    expect(await git.exists(lab.id, head, 'roles/netops_backup')).toBe(true);
  });

  it('a project started from a sample has every role its flow binds (AFS-173)', async () => {
    for (const { key: sample } of listSamples()) {
      const files = sampleFiles(sample);
      for (const [path, f] of files) {
        if (!path.endsWith('.flow.yaml')) continue;
        const doc = parseFlow(f.bytes.toString('utf8')).doc as FlowDocument;
        const has = async (p: string) =>
          [...files.keys()].some((k) => k === p || k.startsWith(`${p}/`));
        expect(await roleGaps(doc, path, has), `${sample}: ${path}`).toEqual([]);
      }
    }
  });

  it('a sample: its steps in the flow, the flow keeps its key; then refused, the flow has steps', async () => {
    const id = await draftOf('one');
    const done = await call('mia', 'POST', `/drafts/${id}/start-from`, { sample: 'hello' });
    expect(done.status).toBe(200);
    expect(done.json.steps).toBeGreaterThan(0);
    const doc = await textOf(id);
    expect(doc.flow.key).toBe('one');
    expect(doc.nodes.some((n) => n.title === 'Say hello')).toBe(true);
    const again = await call('mia', 'POST', `/drafts/${id}/start-from`, { sample: 'hello' });
    expect(again.status).toBe(422);
    expect(again.json.message).toMatch(/steps already/);
    // One edit: Ctrl+Z takes it back to the empty flow.
    expect((await call('mia', 'POST', `/drafts/${id}/undo`)).status).toBe(200);
    expect((await textOf(id)).nodes.every((n) => n.type === 'start' || n.type === 'end')).toBe(
      true,
    );
  });

  it("a playbook of the repository: a step per task, with the repository's roles", async () => {
    const id = await draftOf('two');
    const done = await call('mia', 'POST', `/drafts/${id}/start-from`, { playbook: 'site.yml' });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    expect(done.json.steps).toBeGreaterThan(5);
    const doc = await textOf(id);
    expect(doc.flow.key).toBe('two');
    // The flow keeps the name it was made with, not the playbook's.
    expect((doc.flow as { name?: string }).name).toBe('two');
    const missing = await call('mia', 'POST', `/drafts/${id}/start-from`, {
      playbook: 'nowhere.yml',
    });
    expect(missing.status).toBe(422);
  });

  it('an AWX template, read from AWX with the credential; the job playbook the repository has', async () => {
    const id = await draftOf('three');
    const listed = await call(
      'mia',
      'GET',
      `/drafts/${id}/start-from/awx?credential=${awxCredential}`,
    );
    expect(listed.status, JSON.stringify(listed.json)).toBe(200);
    expect(listed.json.templates).toEqual([
      { kind: 'workflow', id: 7, name: 'Nightly', description: 'All of it' },
      { kind: 'job', id: 3, name: 'Edge baseline' },
    ]);
    // The token went to AWX, and only there.
    expect(seen.every((s) => s.startsWith('Bearer awx-token-1 '))).toBe(true);
    const done = await call('mia', 'POST', `/drafts/${id}/start-from`, {
      awx: { credential: awxCredential, kind: 'job', id: 3 },
    });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    const doc = await textOf(id);
    expect(doc.flow.key).toBe('three');
    expect(doc.nodes.filter((n) => n.type !== 'start' && n.type !== 'end').length).toBeGreaterThan(
      0,
    );
    // Another workspace's (or a made-up) credential is not this project's.
    const wrong = await call('mia', 'GET', `/drafts/${id}/start-from/awx?credential=nope`);
    expect(wrong.status).toBe(404);
  });
});
