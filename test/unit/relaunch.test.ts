// Run again (AFS-214, AFS-240, AFS-238): the hosts that did not go well, another mode, step by
// step with pause points, the same or the newest commit, through the launch's checks; the offer
// a run's page reads (its host sets, outcome line, risks); and the MCP tool. The project is a real
// repository in a folder of this machine.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGrant } from '../../src/server/access/grants';
import { buildApp } from '../../src/server/app';
import { listAudit } from '../../src/server/audit/store';
import { createToken } from '../../src/server/auth/tokens';
import { createUser } from '../../src/server/auth/users';
import { type Database, openDatabase } from '../../src/server/db/database';
import { migrate } from '../../src/server/db/migrations';
import { LaunchConfigs } from '../../src/server/launch/configs';
import type { PreparedLaunch } from '../../src/server/launch/prepare';
import { createLogger } from '../../src/server/log';
import { Git } from '../../src/server/projects/git';
import { createProject, createWorkspace, type Project } from '../../src/server/projects/store';
import { ProjectSync } from '../../src/server/projects/sync';
import { RunQueue } from '../../src/server/runs/queue';
import { createCredential } from '../../src/server/secrets/credentials';
import { keyId, type MasterKey, newKey } from '../../src/server/secrets/masterKey';
import { emptyPeople, emptyWorkspaces } from './helpers/clean';
import { type TestRepo, testRepo } from './helpers/repo';

const bytes = newKey();
const key: MasterKey = { key: bytes, id: keyId(bytes), source: 'env' };
const FLOW = readFileSync(join(__dirname, '../fixtures/hello.flow.yaml'), 'utf8').replace(
  '      targets: true',
  '      targets: true\n    api_password:\n      type: string',
);
const FILE = 'flows/hello.flow.yaml';
const PING = '01M6GPM979RJPCDJ0XFF22GBSV';
const DONE = '01M6GPM95RHBYFR7H44Z8GD2HC';
const STOPPED = '01M6GPM9CA039FX7GVNYTH6JEP';
const SSH = `-----BEGIN OPENSSH PRIVATE KEY-----\n${'QUFB'.repeat(12)}\n-----END OPENSSH PRIVATE KEY-----`;
const root = mkdtempSync(join(tmpdir(), 'afs-relaunch-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** fw-a failed at the ping step, fw-b could not be reached, fw-c and the odd names went well. */
const VIEW = {
  id: 'r',
  mode: 'real',
  state: 'done',
  rc: 2,
  startedAt: '2026-11-23T10:00:00Z',
  summary: {
    hosts: ['fw-a', 'fw-b', 'fw-c', '!odd'],
    nodes: {
      [PING]: { ok_hosts: ['fw-c', '!odd'], failed_hosts: ['fw-a'] },
      [DONE]: { in: ['fw-c', '!odd'] },
      [STOPPED]: { in: ['fw-a'] },
    },
    outcome: { 'fw-a': 'Ended at Stopped' },
    failures: [],
    unreachable: ['fw-b'],
    stoppedEarly: false,
    timings: { [PING]: { start: 1, end: 2 } },
    problems: {
      [PING]: {
        'fw-a': { task: '[ping] Ping', status: 'failed', msg: 'no answer' },
        'fw-b': { task: '[ping] Ping', status: 'unreachable', msg: 'ssh timeout' },
      },
    },
  },
};

describe('run again', () => {
  let database: Database;
  let app: FastifyInstance;
  let url: string;
  let source: TestRepo;
  let project: Project;
  let sync: ProjectSync;
  let queue: RunQueue;
  let configs: LaunchConfigs;
  let configId: string;
  let first: string;
  let workspace: string;
  const cred: Record<string, string> = {};
  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const db = () => database.db;

  const launchOf = (extra: Partial<PreparedLaunch> = {}): PreparedLaunch => ({
    config: configId,
    project: project.id,
    commit: first,
    ref: 'main',
    flow: { file: FILE, key: 'hello', name: 'Hello, Ansible', version: 1 },
    mode: 'real',
    inputs: { devices: ['fw-a', 'fw-b', 'fw-c', '!odd'], api_password: 'S3CR3T' },
    targets: ['fw-a', 'fw-b', 'fw-c', '!odd'],
    credentials: [cred.x as string],
    ...extra,
  });
  /** A run that ended as `view` says, started by omar. */
  const ended = async (
    view: unknown = VIEW,
    extra: Partial<PreparedLaunch> = {},
    outcome: 'failed' | 'succeeded' | 'cancelled' = 'failed',
  ) => {
    const run = await queue.enqueue(
      launchOf(extra),
      { devices: ['fw-a', 'fw-b', 'fw-c', '!odd'], api_password: '***' },
      { id: ids.omar as string, login: 'omar' },
      'Hello',
    );
    let job = await queue.claim('w');
    while (job && job.run.id !== run.id) {
      await queue.finish(job.run.id, job.token, 'failed');
      job = await queue.claim('w');
    }
    await queue.finish(run.id, job?.token as string, outcome, 'x', new Date(), view);
    return run;
  };
  const post = (id: string, body: unknown, token = tokens.omar) =>
    fetch(`${url}/api/v1/runs/${id}/relaunch`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  /** Claims the next run and gives its job; the others queued before it are ended. */
  const jobOf = async (id: string) => {
    let job = await queue.claim('w');
    while (job && job.run.id !== id) {
      await queue.finish(job.run.id, job.token, 'failed');
      job = await queue.claim('w');
    }
    if (job) await queue.finish(job.run.id, job.token, 'failed');
    return job;
  };

  beforeAll(async () => {
    database = openDatabase({ kind: 'sqlite', file: ':memory:' });
    await migrate(database.db as never);
    await emptyWorkspaces(db());
    await emptyPeople(db());
    const log = createLogger({ level: 'silent', format: 'json', write: () => undefined });
    const git = new Git({ reposDir: join(root, 'repos'), allowLocal: true });
    sync = new ProjectSync(db(), git, log);
    queue = new RunQueue(db(), database.kind, key, { maxRuns: 50, perProject: 50 });
    source = testRepo({ [FILE]: FLOW, 'inventory/hosts.yaml': 'all:\n  hosts:\n    fw-a: {}\n' });
    workspace = (await createWorkspace(db(), { key: 'net', name: 'Network' })).id;
    project = (await sync.sync(
      (
        await createProject(
          db(),
          workspace,
          { key: 'edge', name: 'Edge', gitUrl: source.dir, pollSeconds: 0 },
          true,
        )
      ).id,
    )) as Project;
    first = project.commit as string;
    for (const name of ['x', 'y'])
      cred[name] = (
        await createCredential(db(), key, workspace, {
          name: `key-${name}`,
          kind: 'ssh_key',
          secret: { privateKey: SSH },
        })
      ).id;
    configs = new LaunchConfigs(db(), git);
    configId = (
      await configs.create(project.id, {
        name: 'Hello',
        flowFile: FILE,
        mode: 'real',
        inputs: { devices: ['fw-a'] },
        credentials: [cred.x as string],
      })
    ).id;
    for (const [login, admin] of [
      ['dana', true],
      ['omar', false],
      ['rita', false],
    ] as const)
      ids[login] = (
        await createUser(db(), { login, name: login, password: 'x'.repeat(12), admin })
      ).id;
    const flow = { project: project.id, flow: FILE };
    await createGrant(db(), workspace, { user: 'omar', level: 'operator', ...flow }, 'dana');
    await createGrant(db(), workspace, { user: 'rita', level: 'rw', ...flow }, 'dana');
    for (const login of ['dana', 'omar', 'rita'])
      tokens[login] = (await createToken(db(), ids[login] as string, { name: 't' })).token;
    app = buildApp({
      log,
      database,
      instance: 'test',
      masterKey: key,
      runs: queue,
      projects: { git, sync, allowLocal: true },
    });
    url = await app.listen({ host: '127.0.0.1', port: 0 });
  });
  afterAll(async () => {
    await app?.close();
    await sync?.stop();
    await database?.close();
    source?.remove();
  });

  it('offers the host sets, the outcome line and what a limit changes', async () => {
    const run = await ended();
    const offer = (await (
      await fetch(`${url}/api/v1/runs/${run.id}/relaunch`, {
        headers: { authorization: `Bearer ${tokens.omar}` },
      })
    ).json()) as { line: string; sets: { notOk: string[]; failed: { title: string }[] } };
    expect(offer.line).toBe(
      '2 of 4 hosts did not go well: 1 failed at Check the host answers, 1 unreachable',
    );
    expect(offer.sets.notOk).toEqual(['fw-a', 'fw-b']);
    expect(offer.sets.failed[0]?.title).toBe('Check the host answers');
  });

  it('AFS-247: a run whose hosts reached Done went well; a stopped run counts its hosts', async () => {
    const offerOf = async (id: string) =>
      (await (
        await fetch(`${url}/api/v1/runs/${id}/relaunch`, {
          headers: { authorization: `Bearer ${tokens.omar}` },
        })
      ).json()) as { line?: string; sets?: { notOk: string[]; stopped: { host: string }[] } };
    // As the designer's summary says it: the ports hosts left by; nothing leaves an end.
    const facts = '01M6GPM99KC9TX091MCH61REQV';
    const hello = '01M6GPM9B1D563X8PKD5041JHV';
    const well = {
      ...VIEW,
      rc: 0,
      summary: {
        hosts: ['fw-a', 'fw-c'],
        nodes: {
          [PING]: { ok_hosts: ['fw-a', 'fw-c'] },
          [facts]: { ok_hosts: ['fw-a', 'fw-c'] },
          [hello]: { ok_hosts: ['fw-a', 'fw-c'] },
        },
        outcome: {},
        failures: [],
        unreachable: [],
        stoppedEarly: false,
      },
    };
    const good = await ended(well, {}, 'succeeded');
    const offer = await offerOf(good.id);
    expect(offer.line).toBe('All 2 hosts went well');
    expect(offer.sets?.notOk).toEqual([]);
    expect((await post(good.id, { hosts: 'not-ok' })).status).toBe(422);
    // Stopped at a pause after Read a few facts: fw-c had reached Done, fw-a had not.
    const stopped = {
      ...well,
      summary: {
        ...well.summary,
        nodes: { [PING]: { ok_hosts: ['fw-a', 'fw-c'] }, [facts]: { ok_hosts: ['fw-c'] } },
      },
    };
    const part = {
      ...stopped,
      summary: {
        ...stopped.summary,
        nodes: { ...stopped.summary.nodes, [hello]: { ok_hosts: ['fw-c'] } },
      },
      step: { stopped: { node: facts, hosts: ['fw-a'] } },
    };
    const halfway = await offerOf((await ended(part, {}, 'cancelled')).id);
    expect(halfway.sets?.notOk).toEqual(['fw-a']);
    expect(halfway.line).toBe(
      '1 of 2 hosts did not go well: 1 stopped before the end (before Read a few facts)',
    );
    // Stopped at the pause before the first step: no host in the summary, all waiting there.
    const first = await ended(
      {
        ...VIEW,
        summary: { hosts: [], nodes: {}, outcome: {}, failures: [], unreachable: [] },
        step: { stopped: { node: PING, hosts: ['fw-a', 'fw-b', 'fw-c', '!odd'] } },
      },
      {},
      'cancelled',
    );
    const before = await offerOf(first.id);
    expect(before.line).toBe(
      'All 4 hosts did not go well: 4 stopped before the end (before Check the host answers)',
    );
    const only = await post(first.id, { hosts: 'not-ok' });
    expect(only.status).toBe(201);
    expect(((await only.json()) as { relaunchOf: unknown }).relaunchOf).toMatchObject({
      hosts: 'not-ok',
      count: 4,
    });
  });

  it('runs a run again as before with {}, with the credentials its configuration has now (AFS-238)', async () => {
    const run = await ended();
    await configs.update(configId, { credentials: [cred.y as string] });
    try {
      const reply = await post(run.id, undefined);
      expect(reply.status).toBe(201);
      const again = (await reply.json()) as { id: string; credentials: string[] };
      expect(again).toMatchObject({
        commit: first,
        mode: 'real',
        inputs: { api_password: '***' },
        requestedBy: { login: 'omar' },
        relaunchOf: { id: run.id, number: run.number, hosts: 'all' },
      });
      // Not the credential the old run had, which its configuration no longer gives.
      expect(again.credentials).toEqual([cred.y]);
      const job = await jobOf(again.id);
      expect(job?.inputs).toEqual({
        devices: ['fw-a', 'fw-b', 'fw-c', '!odd'],
        api_password: 'S3CR3T',
      });
      expect(job?.limitHosts).toBeUndefined();
    } finally {
      await configs.update(configId, { credentials: [cred.x as string] });
    }
  });

  it('runs only the hosts that did not go well, through a limit of their own; audited', async () => {
    const run = await ended();
    const reply = await post(run.id, { hosts: 'not-ok', mode: 'check' });
    expect(reply.status).toBe(201);
    const again = (await reply.json()) as { id: string; mode: string; limit?: string };
    expect(again).toMatchObject({
      mode: 'check',
      relaunchOf: { id: run.id, hosts: 'not-ok', count: 2 },
    });
    expect(again.limit).toBeUndefined();
    // AFS-251: its page says the hosts it is limited to, not "Limit none".
    const page = (await (
      await fetch(`${url}/api/v1/runs/${again.id}`, {
        headers: { authorization: `Bearer ${tokens.omar}` },
      })
    ).json()) as { hostLimit?: unknown };
    expect(page.hostLimit).toEqual({ count: 2, hosts: ['fw-a', 'fw-b'] });
    // A run again of that run again keeps to those hosts.
    const job = await jobOf(again.id);
    expect(job?.limitHosts).toEqual(['fw-a', 'fw-b']);
    const entry = (await listAudit(db(), { action: 'run.relaunch' })).entries.find(
      (e) => (e.detail as { run?: string }).run === again.id,
    );
    expect(entry?.detail).toMatchObject({
      hosts: 'not-ok',
      count: '2',
      names: ['fw-a', 'fw-b'],
      commit: 'same',
      mode: 'check',
    });
    // Named hosts, the odd one too; and a host that was not the run's is refused.
    const named = await post(run.id, { hosts: ['!odd', 'fw-c'] });
    expect(named.status).toBe(201);
    const chosen = (await named.json()) as { id: string; relaunchOf: unknown };
    expect(chosen.relaunchOf).toMatchObject({ hosts: 'chosen', count: 2 });
    expect((await jobOf(chosen.id))?.limitHosts).toEqual(['!odd', 'fw-c']);
    const unknown = await post(run.id, { hosts: ['fw-z'] });
    expect(unknown.status).toBe(422);
    expect(((await unknown.json()) as { message: string }).message).toBe(
      `fw-z was not a host of run #${run.number}`,
    );
  });

  it('refuses an empty set, a run that reached no host, and a run still going', async () => {
    const run = await ended();
    const none = await post(run.id, { hosts: 'stopped' });
    expect(none.status).toBe(422);
    expect(((await none.json()) as { message: string }).message).toBe(
      `No host of run #${run.number} stopped before the end`,
    );
    const empty = await ended({ ...VIEW, summary: { ...VIEW.summary, hosts: [] } });
    expect((await post(empty.id, { hosts: 'not-ok' })).status).toBe(422);
    const going = await queue.enqueue(launchOf(), {}, { id: ids.omar as string, login: 'omar' });
    expect((await post(going.id, {})).status).toBe(409);
    await queue.cancel(going.id, 'omar');
    expect((await post('nothing', {})).status).toBe(404);
  });

  it('steps with pause points that are steps of the flow; a debug run is rw', async () => {
    const run = await ended();
    const step = { every: false, points: [PING], debug: true, pauseOnFailure: true };
    // operator may not start a debug run; rw may.
    expect((await post(run.id, { hosts: 'failed', mode: 'check', step })).status).toBe(403);
    const reply = await post(run.id, { hosts: 'failed', mode: 'check', step }, tokens.rita);
    expect(reply.status).toBe(201);
    const again = (await reply.json()) as { id: string; step: unknown };
    expect(again.step).toEqual({
      every: false,
      points: [PING],
      timeoutS: 3600,
      debug: true,
      pauseOnFailure: true,
      // AFS-179: the failure filters the engine gets.
      failures: { failed: true },
    });
    await jobOf(again.id);
    const missing = await post(run.id, { step: { points: ['01JZNOSUCHSTEP0000000000000'] } });
    expect(missing.status).toBe(422);
    // null: not step by step.
    const plain = await post(run.id, { step: null });
    expect(((await plain.json()) as { step?: unknown }).step).toBeUndefined();
  });

  it('asks rw for a run of another branch than its configuration names; newest is the newest', async () => {
    const other = await ended(VIEW, { ref: 'feature' });
    const refused = await post(other.id, {});
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { message: string }).message).toContain('needs rw');
    expect((await post(other.id, {}, tokens.rita)).status).toBe(201);

    const run = await ended();
    const next = source.commit({ 'README.md': 'Newer\n' });
    const reply = await post(run.id, { commit: 'newest' });
    expect(reply.status).toBe(201);
    expect(await reply.json()).toMatchObject({ commit: next, ref: 'main' });
  });

  it('refuses a run whose configuration is gone, and newest for a dev run', async () => {
    const dev = await ended();
    await db().updateTable('run').set({ dev_bundle: 'b-1' }).where('id', '=', dev.id).execute();
    const newest = await post(dev.id, { commit: 'newest' }, tokens.rita);
    expect(newest.status).toBe(422);
    expect(((await newest.json()) as { field: string }).field).toBe('commit');
    const orphan = await ended();
    await db().updateTable('run').set({ config_id: 'gone' }).where('id', '=', orphan.id).execute();
    expect((await post(orphan.id, {})).status).toBe(422);
  });

  it('MCP: run_relaunch takes the same options', async () => {
    const run = await ended();
    const client = new Client({ name: 'test-agent', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${tokens.omar}` } },
      }),
    );
    try {
      const r = (await client.callTool({
        name: 'run_relaunch',
        arguments: { run: run.id, hosts: 'unreachable', mode: 'check', step: false },
      })) as { content: { text: string }[]; isError?: boolean };
      expect(r.isError).toBeFalsy();
      expect(JSON.parse(r.content[0]?.text ?? '{}')).toMatchObject({ mode: 'check', hosts: 1 });
      const bad = (await client.callTool({
        name: 'run_relaunch',
        arguments: { run: run.id, hosts: 'stopped' },
      })) as { content: { text: string }[]; isError?: boolean };
      expect(bad.isError).toBe(true);
      expect(bad.content[0]?.text).toContain('stopped before the end');
      // AFS-251: a step argument of the wrong type is refused, not dropped into a plain run.
      const odd = (await client.callTool({
        name: 'run_relaunch',
        arguments: { run: run.id, hosts: 'all', step: { debug: true } },
      })) as { content: { text: string }[]; isError?: boolean };
      expect(odd.isError).toBe(true);
      expect(odd.content[0]?.text).toBe('step must be true or false');
    } finally {
      await client.close();
    }
  });
});
