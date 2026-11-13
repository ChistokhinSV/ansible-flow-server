// Approval gates (AFS-28), with Ansible played by the test: a run of a flow with an approval
// waits at it holding no worker; only someone allowed decides it (the approve grant, the
// approval's approvers, not who launched it); the run goes on with the segment the decision
// picks, also after a restart; a gate whose time ran out times out; a stopped run asks nobody.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunView } from '@ansible-flow/core/protocol';
import { runsDir } from '@ansible-flow/node/run/pastRuns';
import type { RunFlowRequest } from '@ansible-flow/node/run/runFlow';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGrant } from '../../src/server/access/grants';
import { buildApp } from '../../src/server/app';
import { gatesOf, timeOutDue } from '../../src/server/approvals/gates';
import { listAudit } from '../../src/server/audit/store';
import { createToken } from '../../src/server/auth/tokens';
import { createGroup, createUser, setMembers } from '../../src/server/auth/users';
import { type Database, openDatabase } from '../../src/server/db/database';
import { migrate } from '../../src/server/db/migrations';
import { LaunchConfigs } from '../../src/server/launch/configs';
import { prepareLaunch, withoutSecrets } from '../../src/server/launch/prepare';
import { createLogger } from '../../src/server/log';
import { Git } from '../../src/server/projects/git';
import {
  createProject,
  createWorkspace,
  type Project,
  updateWorkspace,
} from '../../src/server/projects/store';
import { ProjectSync } from '../../src/server/projects/sync';
import { Executor } from '../../src/server/runs/executor';
import { RunQueue } from '../../src/server/runs/queue';
import { keyId, type MasterKey, newKey } from '../../src/server/secrets/masterKey';
import { type TestRepo, testRepo } from './helpers/repo';

const bytes = newKey();
const key: MasterKey = { key: bytes, id: keyId(bytes), source: 'env' };
const FLOW = readFileSync(join(__dirname, '../fixtures/approval.flow.yaml'), 'utf8');
const TWO_GATES = readFileSync(join(__dirname, '../fixtures/two-gates.flow.yaml'), 'utf8');
const GATE = '01JCRBN0000000000000000003';
const root = mkdtempSync(join(tmpdir(), 'afs-approvals-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const carried = { afd_hostsets: { flow_gate_waiting: ['fw-edge-01'] }, afd_gate_empty: false };
const stats = (custom: Record<string, unknown>) =>
  `${JSON.stringify({ event: 'stats', hosts: {}, custom })}\n`;

let database: Database;
let git: Git;
let sync: ProjectSync;
let queue: RunQueue;
let app: FastifyInstance;
let source: TestRepo;
let project: Project;
let config: string;
let twoGates: string;
const token: Record<string, string> = {};
const ids: Record<string, string> = {};
/** The playbooks Ansible was asked to run, with their inputs. */
const ran: { playbook: string; inputs: Record<string, unknown> }[] = [];

beforeAll(async () => {
  database = openDatabase({ kind: 'sqlite', file: ':memory:' });
  await migrate(database.db as never);
  const db = database.db;
  const log = createLogger({ level: 'error', format: 'json', write: () => undefined });
  git = new Git({ reposDir: join(root, 'repos'), allowLocal: true });
  sync = new ProjectSync(db, git, log);
  queue = new RunQueue(db, 'sqlite', key, { maxRuns: 4, perProject: 4 });
  source = testRepo({
    'flows/change.flow.yaml': FLOW,
    'flows/two-gates.flow.yaml': TWO_GATES,
    'inventory/hosts.yaml': 'all:\n  hosts:\n    fw-edge-01: {}\n',
  });
  const workspace = await createWorkspace(db, { key: 'net', name: 'Network' });
  project = (await sync.sync(
    (
      await createProject(
        db,
        workspace.id,
        { key: 'edge', name: 'Edge', gitUrl: source.dir, pollSeconds: 0 },
        true,
      )
    ).id,
  )) as Project;
  config = (
    await new LaunchConfigs(db, git).create(project.id, {
      name: 'Change',
      flowFile: 'flows/change.flow.yaml',
      inventory: 'inventory/hosts.yaml',
      inputs: { devices: ['fw-edge-01'] },
    })
  ).id;
  twoGates = (
    await new LaunchConfigs(db, git).create(project.id, {
      name: 'Two gates',
      flowFile: 'flows/two-gates.flow.yaml',
      inventory: 'inventory/hosts.yaml',
      inputs: { devices: ['fw-edge-01'] },
    })
  ).id;
  // dana launches (an administrator); omar approves for the change board; gary may approve,
  // but is not on the board; rita only reads.
  for (const [login, admin] of [
    ['dana', true],
    ['omar', false],
    ['gary', false],
    ['rita', false],
  ] as const) {
    ids[login] = (await createUser(db, { login, name: login, password: 'x'.repeat(12), admin })).id;
    token[login] = (await createToken(db, ids[login] as string, { name: 't' })).token;
  }
  const board = await createGroup(db, { name: 'change-board' });
  await setMembers(db, board.id, [ids.omar as string]);
  for (const [who, level] of [
    [{ group: 'change-board' }, 'approve'],
    [{ user: 'gary' }, 'approve'],
    [{ user: 'rita' }, 'ro'],
  ] as const)
    await createGrant(db, workspace.id, { ...who, level }, 'dana');
  app = buildApp({ log, database, instance: 'test', runs: queue });
});
afterAll(async () => {
  await app?.close();
  await sync.stop();
  await database.close();
  source.remove();
});

/** Ansible: the start segment carries the hosts waiting at the gate; the others end. */
function executor(dataDir: string) {
  return new Executor(
    {
      db: database.db,
      git,
      sync,
      queue,
      key,
      log: createLogger({ level: 'error', format: 'json', write: () => undefined }),
    },
    {
      dataDir,
      engine: 'docker',
      image: 'afd-ee:2.19',
      worker: 'test-worker',
      slots: 2,
      timeoutMs: 60_000,
      heartbeatMs: 30,
      pollMs: 20,
      runner: async (request: RunFlowRequest) => {
        ran.push({ playbook: request.playbook, inputs: request.inputs });
        const dir = join(runsDir(request.storage, request.doc.flow.id), request.id);
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, 'events.jsonl'),
          request.playbook.endsWith('seg_start.yml') ? stats(carried) : stats({}),
        );
        return {
          id: request.id,
          mode: request.mode,
          startedAt: request.startedAt,
          state: 'done',
          rc: 0,
        } as RunView;
      },
    },
  );
}

async function launch(which = config) {
  const c = (await new LaunchConfigs(database.db, git).get(which)) as NonNullable<
    Awaited<ReturnType<LaunchConfigs['get']>>
  >;
  const prepared = await prepareLaunch({ db: database.db, git, sync }, c, {});
  if (!prepared.ok) throw new Error(JSON.stringify(prepared.problems));
  return queue.enqueue(
    prepared.launch,
    withoutSecrets(prepared.launch, prepared.form.fields).inputs,
    { id: ids.dana as string, login: 'dana' },
    'Change',
  );
}
const until = async (check: () => Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('Waited too long');
};
const stateIs = (id: string, state: string) =>
  until(async () => (await queue.get(id))?.state === state);
const call = (who: string, method: string, url: string, payload?: object) =>
  app.inject({
    method: method as 'GET',
    url,
    headers: { authorization: `Bearer ${token[who]}` },
    ...(payload ? { payload } : {}),
  });
const segmentOf = (playbook: string) => /seg_([a-z-]+)\.yml$/.exec(playbook)?.[1];

describe('a run of a flow with an approval', () => {
  it('waits at it, holding no worker; the right person approves, and it goes on', async () => {
    const ex = executor(join(root, 'data-1'));
    ran.length = 0;
    const run = await launch();
    await ex.start();
    await stateIs(run.id, 'waiting');
    expect(ran.map((r) => segmentOf(r.playbook))).toEqual(['start']);
    const view = (await queue.view(run.id)) as RunView;
    expect(view.approvals?.[GATE]).toMatchObject({ status: 'waiting' });
    const [gate] = await gatesOf(database.db, run.id);
    expect(gate).toMatchObject({
      status: 'waiting',
      approvers: ['change-board'],
      message: 'Check the change ticket first',
    });
    // 30 minutes from now.
    expect(Date.parse(gate?.deadline ?? '') - Date.now()).toBeGreaterThan(29 * 60_000);

    // Who may decide it.
    const mine = async (who: string) =>
      (await call(who, 'GET', `/api/v1/runs/${run.id}/approvals`)).json()[0];
    expect(await mine('omar')).toMatchObject({ mayDecide: true });
    expect(await mine('gary')).toMatchObject({
      mayDecide: false,
      why: 'Only change-board may decide this approval',
    });
    expect(await mine('rita')).toMatchObject({ mayDecide: false });
    expect(await mine('dana')).toMatchObject({
      mayDecide: false,
      why: 'Who launched the run does not decide its approvals here',
    });
    const decide = (who: string, decision: string, comment?: string) =>
      call(who, 'POST', `/api/v1/runs/${run.id}/approvals/${GATE}`, {
        decision,
        ...(comment ? { comment } : {}),
      });
    expect((await decide('rita', 'approved')).statusCode).toBe(403);
    expect((await decide('gary', 'approved')).statusCode).toBe(403);
    expect((await decide('dana', 'approved')).statusCode).toBe(403);
    // The inbox: omar's to decide, gary sees it and why not.
    const inbox = (await call('omar', 'GET', '/api/v1/approvals')).json();
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({
      run: { id: run.id, flow: { file: 'flows/change.flow.yaml' } },
      requestedBy: 'dana',
      mayDecide: true,
      gate: { node: { key: 'gate' } },
    });
    expect((await call('gary', 'GET', '/api/v1/approvals')).json()[0]).toMatchObject({
      mayDecide: false,
    });

    const decided = await decide('omar', 'approved', 'Window confirmed with the NOC');
    expect(decided.statusCode).toBe(200);
    expect((await decide('omar', 'rejected')).statusCode).toBe(409);
    await stateIs(run.id, 'succeeded');
    await ex.stop();
    expect(ran.map((r) => segmentOf(r.playbook))).toEqual(['start', 'gate-approved']);
    expect(ran[1]?.inputs).toMatchObject({ afd_hostsets: carried.afd_hostsets });
    expect(ran[1]?.inputs.afd_gate_outcome).toBe('approved');
    expect(((await queue.view(run.id)) as RunView).approvals?.[GATE]).toMatchObject({
      status: 'approved',
      by: 'omar',
      comment: 'Window confirmed with the NOC',
    });
    expect((await queue.segments(run.id)).map((s) => s.name)).toEqual(['start', 'gate-approved']);
    const audit = (await listAudit(database.db, { action: 'approval.decide', result: 'ok' }))
      .entries;
    expect(audit[0]).toMatchObject({
      actor: { login: 'omar' },
      detail: { decision: 'approved', approval: GATE },
    });
    expect((await call('omar', 'GET', '/api/v1/approvals')).json()).toEqual([]);
  });

  it('waits across a restart; a gate whose time ran out times out, through the timeout port', async () => {
    ran.length = 0;
    const first = executor(join(root, 'data-2'));
    const run = await launch();
    await first.start();
    await stateIs(run.id, 'waiting');
    // The server stops while the run waits: the run keeps waiting.
    await first.stop();
    expect((await queue.get(run.id))?.state).toBe('waiting');

    const second = executor(join(root, 'data-2'));
    await second.start();
    await database.db
      .updateTable('run_gate')
      .set({ deadline: new Date(Date.now() - 1000).toISOString() })
      .where('run_id', '=', run.id)
      .execute();
    expect(await timeOutDue(database.db, (id) => queue.resume(id))).toEqual([run.id]);
    await stateIs(run.id, 'succeeded');
    await second.stop();
    expect(ran.map((r) => segmentOf(r.playbook))).toEqual(['start', 'gate-rejected']);
    expect(ran[1]?.inputs.afd_gate_outcome).toBe('timeout');
    expect(((await queue.view(run.id)) as RunView).approvals?.[GATE]).toMatchObject({
      status: 'timed out',
      by: 'the server',
    });
  });

  it('a run stopped while it waits asks nobody any more', async () => {
    const ex = executor(join(root, 'data-3'));
    const run = await launch();
    await ex.start();
    await stateIs(run.id, 'waiting');
    await ex.stop();
    expect((await call('dana', 'POST', `/api/v1/runs/${run.id}/cancel`)).statusCode).toBe(202);
    expect((await gatesOf(database.db, run.id))[0]?.status).toBe('cancelled');
    expect((await call('omar', 'GET', '/api/v1/approvals')).json()).toEqual([]);
    const late = await call('omar', 'POST', `/api/v1/runs/${run.id}/approvals/${GATE}`, {
      decision: 'approved',
    });
    expect(late.statusCode).toBe(409);
  });

  it('the workspace may let who launched a run decide it', async () => {
    const ex = executor(join(root, 'data-4'));
    const run = await launch();
    await ex.start();
    await stateIs(run.id, 'waiting');
    // (This app has no workspace routes: the switch is set as PATCH /workspaces/:id sets it.)
    await updateWorkspace(database.db, project.workspace, { selfApprove: true });
    const decided = await call('dana', 'POST', `/api/v1/runs/${run.id}/approvals/gate`, {
      decision: 'rejected',
      comment: 'Not this week',
    });
    expect(decided.statusCode).toBe(200);
    await stateIs(run.id, 'succeeded');
    await ex.stop();
    await updateWorkspace(database.db, project.workspace, { selfApprove: false });
  });

  it('a flow whose approvals cannot wait for a person does not run: nothing is approved by itself', async () => {
    ran.length = 0;
    const ex = executor(join(root, 'data-5'));
    const run = await launch(twoGates);
    await ex.start();
    await stateIs(run.id, 'failed');
    await ex.stop();
    expect(ran).toEqual([]);
    expect((await queue.get(run.id))?.error).toMatch(/approvals cannot wait for a person/);
  });
});
