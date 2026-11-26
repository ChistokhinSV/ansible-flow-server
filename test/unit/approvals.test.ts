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
import { approvedPath, gatesOf, PATH_STEPS, timeOutDue } from '../../src/server/approvals/gates';
import { listAudit } from '../../src/server/audit/store';
import { createRunToken, createToken, listTokens } from '../../src/server/auth/tokens';
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
let workspaceId: string;
/** The playbooks Ansible was asked to run, with their inputs. */
const ran: {
  playbook: string;
  inputs: Record<string, unknown>;
  options: string[];
  runTokens: number;
}[] = [];

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
  workspaceId = workspace.id;
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
      // AFS-111: real runs wait for a person; check runs approve by themselves.
      mode: 'real',
    })
  ).id;
  twoGates = (
    await new LaunchConfigs(db, git).create(project.id, {
      name: 'Two gates',
      flowFile: 'flows/two-gates.flow.yaml',
      inventory: 'inventory/hosts.yaml',
      inputs: { devices: ['fw-edge-01'] },
      // AFS-111: real runs wait for a person; check runs approve by themselves.
      mode: 'real',
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
      server: () => ({ url: 'https://afs.example.net', verifyTls: false }),
      runner: async (request: RunFlowRequest) => {
        // AFS-116: what the run's container gets to reach the server, and its token meanwhile.
        const env = request.env as { options?: string[] };
        const tokens = await database.db
          .selectFrom('api_token')
          .select('id')
          .where('run_id', 'is not', null)
          .execute();
        ran.push({
          playbook: request.playbook,
          inputs: request.inputs,
          options: env.options ?? [],
          runTokens: tokens.length,
        });
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

async function launch(which = config, by = 'dana') {
  const c = (await new LaunchConfigs(database.db, git).get(which)) as NonNullable<
    Awaited<ReturnType<LaunchConfigs['get']>>
  >;
  const prepared = await prepareLaunch({ db: database.db, git, sync }, c, {});
  if (!prepared.ok) throw new Error(JSON.stringify(prepared.problems));
  return queue.enqueue(
    prepared.launch,
    withoutSecrets(prepared.launch, prepared.form.fields).inputs,
    { id: ids[by] as string, login: by },
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

describe("a run's own token (AFS-116)", () => {
  it('reaches the server from the run, ends with each turn, and is in no list of tokens', async () => {
    const ex = executor(join(root, 'data-token'));
    ran.length = 0;
    const run = await launch();
    await ex.start();
    await stateIs(run.id, 'waiting');
    await ex.stop();
    const [first] = ran;
    // The container gets the address, a token and whether to check the certificate, by name.
    for (const name of ['AFS_URL', 'AFS_TOKEN', 'AFS_VALIDATE_CERTS'])
      expect(first?.options.join(' ')).toContain(`-e ${name}`);
    // The token existed while the run ran, and is gone now it waits for a person.
    expect(first?.runTokens).toBe(1);
    expect(
      await database.db.selectFrom('api_token').select('id').where('run_id', '=', run.id).execute(),
    ).toEqual([]);
    expect(await listTokens(database.db, ids.dana as string)).not.toContainEqual(
      expect.objectContaining({ name: `Run ${run.number}` }),
    );
    expect((await call('dana', 'POST', `/api/v1/runs/${run.id}/cancel`)).statusCode).toBe(202);
  });

  it('decides no approval, even for someone who may', async () => {
    const ex = executor(join(root, 'data-token-2'));
    const run = await launch();
    await ex.start();
    await stateIs(run.id, 'waiting');
    await ex.stop();
    // omar may decide; a token of a run he launched may not.
    const token = await createRunToken(
      database.db,
      { id: run.id, number: run.number, by: ids.omar as string, workspace: workspaceId },
      new Date(Date.now() + 60_000),
    );
    const reply = await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${run.id}/approvals/${GATE}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { decision: 'approved', comment: 'from a flow' },
    });
    expect(reply.statusCode).toBe(403);
    expect(reply.json().message).toContain("A run's token does not decide approvals");
    expect((await gatesOf(database.db, run.id))[0]?.status).toBe('waiting');
    expect((await call('dana', 'POST', `/api/v1/runs/${run.id}/cancel`)).statusCode).toBe(202);
  });
});

describe('a run of a flow with an approval', () => {
  it('in check mode approves by itself, as a skeleton run in VS Code does (AFS-111)', async () => {
    const ex = executor(join(root, 'data-check'));
    ran.length = 0;
    const c = (await new LaunchConfigs(database.db, git).get(config)) as NonNullable<
      Awaited<ReturnType<LaunchConfigs['get']>>
    >;
    const prepared = await prepareLaunch({ db: database.db, git, sync }, c, { mode: 'check' });
    if (!prepared.ok) throw new Error(JSON.stringify(prepared.problems));
    const run = await queue.enqueue(
      prepared.launch,
      withoutSecrets(prepared.launch, prepared.form.fields).inputs,
      { id: ids.dana as string, login: 'dana' },
      'Change',
    );
    await ex.start();
    await stateIs(run.id, 'succeeded');
    await ex.stop();
    // The whole playbook, once: no segment, no gate, nobody asked.
    expect(ran.map((r) => segmentOf(r.playbook))).toEqual([undefined]);
    expect(await gatesOf(database.db, run.id)).toEqual([]);
  });

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
      why: 'You launched this run, so others decide its approvals (only an administrator can change that)',
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
      gate: { node: { key: 'gate' }, hosts: ['fw-edge-01'] },
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
      // AFS-133: the approval by its title, and the comment it was decided with.
      detail: {
        decision: 'approved',
        approval: inbox[0].gate.node.title,
        comment: 'Window confirmed with the NOC',
      },
    });
    expect((await call('omar', 'GET', '/api/v1/approvals')).json()).toEqual([]);
    // AFS-133: decided ones are listed apart, newest first, with who and why.
    const history = (await call('gary', 'GET', '/api/v1/approvals?decided=1')).json();
    expect(history[0]).toMatchObject({
      run: { id: run.id },
      mayDecide: false,
      gate: { status: 'approved', decidedBy: 'omar', comment: 'Window confirmed with the NOC' },
    });
  });

  it('refuses a rejection without a comment, names who may decide and people by name (AFS-146)', async () => {
    await database.db
      .updateTable('user_account')
      .set({ name: 'Omar Haddad' })
      .where('login', '=', 'omar')
      .execute();
    await database.db
      .updateTable('user_account')
      .set({ name: 'Dana Ruiz' })
      .where('login', '=', 'dana')
      .execute();
    try {
      const ex = executor(join(root, 'data-146'));
      const run = await launch();
      await ex.start();
      await stateIs(run.id, 'waiting');
      // Whatever asks (the pages, the canvas, the API): no comment, no rejection.
      for (const comment of [undefined, '   ']) {
        const refused = await call('omar', 'POST', `/api/v1/runs/${run.id}/approvals/${GATE}`, {
          decision: 'rejected',
          ...(comment !== undefined ? { comment } : {}),
        });
        expect(refused.statusCode).toBe(400);
        expect(refused.json()).toMatchObject({ error: 'comment_required' });
      }
      expect((await gatesOf(database.db, run.id))[0]?.status).toBe('waiting');
      // The refused try names the approval by its title in the audit log, not by its key, and
      // the run by its flow and number.
      const refusedEntry = (
        await listAudit(database.db, { action: 'approval.decide', result: 'refused' })
      ).entries.find((e) => e.object.id === run.id);
      expect(refusedEntry?.detail?.approval).toBe('Approve the change');
      expect(refusedEntry?.object.name).toBe(`Engine test · approval segments #${run.number}`);

      // Who may decide, by name; what the approver needs; who launched it, by name.
      const [mine] = (await call('dana', 'GET', `/api/v1/runs/${run.id}/approvals`)).json();
      expect(mine.deciders).toEqual(['change-board']);
      const [inbox] = (await call('omar', 'GET', '/api/v1/approvals')).json();
      expect(inbox).toMatchObject({
        requestedBy: 'dana',
        requestedByName: 'Dana Ruiz',
        run: { mode: 'real', projectName: 'Edge', inputs: { devices: ['fw-edge-01'] } },
        gate: { deciders: ['change-board'] },
      });

      const rejected = await call('omar', 'POST', `/api/v1/runs/${run.id}/approvals/${GATE}`, {
        decision: 'rejected',
        comment: 'Window not confirmed',
      });
      expect(rejected.statusCode).toBe(200);
      expect(rejected.json()).toMatchObject({ decidedBy: 'omar', decidedByName: 'Omar Haddad' });
      await stateIs(run.id, 'succeeded');
      await ex.stop();
      expect(((await queue.view(run.id)) as RunView).approvals?.[GATE]).toMatchObject({
        status: 'rejected',
        by: 'Omar Haddad',
      });
      // AFS-193: the host's own output has the approval it waited at and how it was decided.
      const host = (await call('rita', 'GET', `/api/v1/runs/${run.id}/hosts/fw-edge-01`)).json();
      expect(host.steps).toContainEqual({
        node: GATE,
        step: 'Approve the change',
        entries: [{ task: 'by Omar Haddad', status: 'rejected', msg: 'Window not confirmed' }],
      });
      // A run that failed because its approval was rejected is filtered as rejected, not failed.
      await database.db
        .updateTable('run')
        .set({ state: 'failed' })
        .where('id', '=', run.id)
        .execute();
      const listed = async (state: string) =>
        ((await call('dana', 'GET', `/api/v1/runs?state=${state}`)).json() as { id: string }[]).map(
          (r) => r.id,
        );
      expect(await listed('rejected')).toContain(run.id);
      expect(await listed('failed')).not.toContain(run.id);
    } finally {
      await database.db
        .updateTable('user_account')
        .set({ name: 'omar' })
        .where('login', '=', 'omar')
        .execute();
      await database.db
        .updateTable('user_account')
        .set({ name: 'dana' })
        .where('login', '=', 'dana')
        .execute();
    }
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
    // AFS-110: what the canvas shows ends too: no longer waiting, said who stopped it.
    const view = (await queue.view(run.id)) as RunView;
    expect(view.state).toBe('error');
    expect(view.errorCode).toBe('cancelled');
    expect(view.error).toBe('Stopped by dana before it went on');
    // No exit code (an exit 0 read as success), and the gate says who cancelled it.
    expect(view.rc).toBeUndefined();
    const gate = await database.db
      .selectFrom('run_gate')
      .select('decided_by')
      .where('run_id', '=', run.id)
      .executeTakeFirst();
    expect(gate?.decided_by).toBe('dana');
    expect(view.approvals?.[GATE]).toBeUndefined();
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

  it('AFS-211: a launcher in the deciding group is told who else decides, by the API too', async () => {
    const board = await database.db
      .selectFrom('user_group')
      .select('id')
      .where('name', '=', 'change-board')
      .executeTakeFirstOrThrow();
    await setMembers(database.db, board.id, [ids.omar as string, ids.gary as string]);
    try {
      const ex = executor(join(root, 'data-211'));
      const run = await launch(config, 'omar');
      await ex.start();
      await stateIs(run.id, 'waiting');
      const [mine] = (await call('omar', 'GET', `/api/v1/runs/${run.id}/approvals`)).json();
      expect(mine).toMatchObject({ mayDecide: false, deciders: ['gary (change-board)'] });
      const refused = await call('omar', 'POST', `/api/v1/runs/${run.id}/approvals/${GATE}`, {
        decision: 'approved',
      });
      expect(refused.statusCode).toBe(403);
      expect(refused.json().message).toBe(
        'You launched this run, so others decide its approvals (only an administrator can change that). gary (change-board) decides it',
      );
      // The same names for everyone: the launcher does not decide it, whoever reads.
      const [theirs] = (await call('gary', 'GET', `/api/v1/runs/${run.id}/approvals`)).json();
      expect(theirs).toMatchObject({ mayDecide: true, deciders: ['gary (change-board)'] });
      expect(
        (
          await call('gary', 'POST', `/api/v1/runs/${run.id}/approvals/${GATE}`, {
            decision: 'approved',
          })
        ).statusCode,
      ).toBe(200);
      await stateIs(run.id, 'succeeded');
      await ex.stop();
    } finally {
      await setMembers(database.db, board.id, [ids.omar as string]);
    }
  });

  it('AFS-224: who an approval with no approvers asks, for the Approvers field', async () => {
    const asked = await call(
      'rita',
      'GET',
      `/api/v1/projects/${project.id}/approvers?path=flows/change.flow.yaml`,
    );
    expect(asked.statusCode).toBe(200);
    expect(asked.json()).toEqual({ approvers: ['change-board', 'gary'], selfApprove: false });
    expect((await call('rita', 'GET', `/api/v1/projects/${project.id}/approvers`)).statusCode).toBe(
      400,
    );
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

  it('AFS-271: says the steps an approval lets happen, and the last check run of its configuration', async () => {
    // An earlier check run of the same configuration that went well; a later check run of
    // another configuration, which is not evidence for this one.
    const earlier = await launch();
    const endedAt = new Date(Date.now() - 60_000).toISOString();
    await database.db
      .updateTable('run')
      .set({
        mode: 'check',
        state: 'succeeded',
        ended_at: endedAt,
        // The newest check run of this configuration (an earlier test ran one too).
        created_at: new Date().toISOString(),
      })
      .where('id', '=', earlier.id)
      .execute();
    const other = await launch(twoGates);
    await database.db
      .updateTable('run')
      .set({ mode: 'check', state: 'failed', ended_at: new Date().toISOString() })
      .where('id', '=', other.id)
      .execute();

    await new Promise((done) => setTimeout(done, 5));
    const ex = executor(join(root, 'data-271'));
    const run = await launch();
    await ex.start();
    await stateIs(run.id, 'waiting');
    const [mine] = (await call('omar', 'GET', `/api/v1/runs/${run.id}/approvals`)).json();
    expect(mine.after).toEqual(['Apply the change', 'Done']);
    expect(mine.next).toMatchObject({ approved: 'Apply the change', rejected: 'Notify on-call' });
    expect(mine.evidence).toEqual({
      checkRun: {
        id: earlier.id,
        number: earlier.number,
        state: 'succeeded',
        endedAt,
        sameCommit: true,
      },
    });
    // The inbox carries the same, for the same gate.
    const listed = (
      (await call('omar', 'GET', '/api/v1/approvals')).json() as {
        run: { id: string };
        gate: { evidence?: unknown; after?: string[] };
      }[]
    ).find((a) => a.run.id === run.id);
    expect(listed?.gate).toMatchObject({
      after: ['Apply the change', 'Done'],
      evidence: { checkRun: { id: earlier.id, sameCommit: true } },
    });

    // A check run at another commit is said to be so.
    await database.db
      .updateTable('run')
      .set({ commit_id: '0'.repeat(40) })
      .where('id', '=', earlier.id)
      .execute();
    const [again] = (await call('omar', 'GET', `/api/v1/runs/${run.id}/approvals`)).json();
    expect(again.evidence.checkRun.sameCommit).toBe(false);

    // Decided, it says what was decided, not what to weigh.
    expect(
      (
        await call('omar', 'POST', `/api/v1/runs/${run.id}/approvals/${GATE}`, {
          decision: 'approved',
          comment: 'Check run went well',
        })
      ).statusCode,
    ).toBe(200);
    await stateIs(run.id, 'succeeded');
    await ex.stop();
    const [decided] = (await call('omar', 'GET', `/api/v1/runs/${run.id}/approvals`)).json();
    expect(decided.evidence).toBeUndefined();
  });
});

describe('AFS-271: the steps an approval lets happen', () => {
  const node = (id: string, type = 'task') => ({ id, title: id.toUpperCase(), type });
  const edge = (from: string, port: string, to: string) => ({
    from: { node: from, port },
    to: { node: to },
  });

  it('goes by the ok port of each step to an end', () => {
    const doc = {
      nodes: [
        node('g', 'approval'),
        node('a'),
        node('b', 'subflow'),
        node('done', 'end'),
        node('r'),
      ],
      edges: [
        edge('g', 'approved', 'a'),
        edge('g', 'rejected', 'r'),
        edge('a', 'failed_hosts', 'r'),
        edge('a', 'ok_hosts', 'b'),
        edge('b', 'ok_hosts', 'done'),
      ],
    };
    expect(approvedPath(doc, 'g')).toEqual(['A', 'B', 'DONE']);
  });

  it('stops at a step that branches, at a loop, and after a few steps', () => {
    const branching = {
      nodes: [node('g', 'approval'), node('a'), node('d', 'decision'), node('x')],
      edges: [edge('g', 'approved', 'a'), edge('a', 'ok_hosts', 'd'), edge('d', 'true', 'x')],
    };
    expect(approvedPath(branching, 'g')).toEqual(['A', 'D']);
    const loop = {
      nodes: [node('g', 'approval'), node('a'), node('b')],
      edges: [edge('g', 'approved', 'a'), edge('a', 'ok_hosts', 'b'), edge('b', 'ok_hosts', 'a')],
    };
    expect(approvedPath(loop, 'g')).toEqual(['A', 'B']);
    const ids = Array.from({ length: 20 }, (_, i) => `s${i}`);
    const long = {
      nodes: [node('g', 'approval'), ...ids.map((id) => node(id))],
      edges: [
        edge('g', 'approved', 's0'),
        ...ids.slice(1).map((id, i) => edge(`s${i}`, 'ok_hosts', id)),
      ],
    };
    expect(approvedPath(long, 'g')).toHaveLength(PATH_STEPS);
    expect(approvedPath({ nodes: [node('g', 'approval')], edges: [] }, 'g')).toEqual([]);
  });
});
