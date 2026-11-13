// The MCP endpoint (AFS-24), with the official MCP client over HTTP, on both databases the server
// supports (PostgreSQL when AFS_TEST_POSTGRES_URL is set): only a token signs in; an agent sees
// and reads the flows its token's owner may; it launches, follows and stops runs as they may, with
// the same refusals as the API; approvals stay with people unless the token allows deciding them;
// what an agent changes is in the audit log as the agent's.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGrant } from '../../src/server/access/grants';
import { buildApp } from '../../src/server/app';
import { openGate } from '../../src/server/approvals/gates';
import { listAudit } from '../../src/server/audit/store';
import { createToken } from '../../src/server/auth/tokens';
import { createUser } from '../../src/server/auth/users';
import type { Config } from '../../src/server/config';
import { type Database, openDatabase } from '../../src/server/db/database';
import { migrate } from '../../src/server/db/migrations';
import { LaunchConfigs } from '../../src/server/launch/configs';
import { createLogger } from '../../src/server/log';
import { Git } from '../../src/server/projects/git';
import { createProject, createWorkspace, type Project } from '../../src/server/projects/store';
import { ProjectSync } from '../../src/server/projects/sync';
import { RunQueue } from '../../src/server/runs/queue';
import { keyId, type MasterKey, newKey } from '../../src/server/secrets/masterKey';
import { emptyPeople, emptyWorkspaces } from './helpers/clean';
import { type TestRepo, testRepo } from './helpers/repo';

const bytes = newKey();
const key: MasterKey = { key: bytes, id: keyId(bytes), source: 'env' };
const FLOW = readFileSync(join(__dirname, '../fixtures/approval.flow.yaml'), 'utf8');
const OTHER = FLOW.replace('id: 01JCRBF0000000000000000000', 'id: 01JCRBF0000000000000000009')
  .replace('key: approval-segments', 'key: other-change')
  .replace('name: Engine test · approval segments', 'name: Other change');
const root = mkdtempSync(join(tmpdir(), 'afs-mcp-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const postgres = process.env.AFS_TEST_POSTGRES_URL;
const databases: [string, Config['database'] | undefined][] = [
  ['SQLite', { kind: 'sqlite', file: ':memory:' }],
  ['PostgreSQL', postgres ? { kind: 'postgres', url: postgres } : undefined],
];

type Text = { content: { type: string; text: string }[]; isError?: boolean };

for (const [name, config] of databases) {
  describe.skipIf(!config)(`the MCP endpoint on ${name}`, () => {
    let database: Database;
    let app: FastifyInstance;
    let url: string;
    let source: TestRepo;
    let project: Project;
    let sync: ProjectSync;
    let queue: RunQueue;
    let configId: string;
    const tokens: Record<string, string> = {};
    const ids: Record<string, string> = {};
    const db = () => database.db;
    const clients: Client[] = [];

    /** An agent connected with a token. */
    const agent = async (token: string) => {
      const client = new Client({ name: 'test-agent', version: '1.0.0' });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
          requestInit: { headers: { authorization: `Bearer ${token}` } },
        }),
      );
      clients.push(client);
      return client;
    };
    const call = async (client: Client, tool: string, args: Record<string, unknown> = {}) => {
      const r = (await client.callTool({ name: tool, arguments: args })) as Text;
      return { text: r.content.map((c) => c.text).join('\n'), isError: !!r.isError };
    };
    const json = async (client: Client, tool: string, args: Record<string, unknown> = {}) => {
      const r = await call(client, tool, args);
      if (r.isError) throw new Error(r.text);
      return JSON.parse(r.text);
    };

    beforeAll(async () => {
      if (!config) return;
      database = openDatabase(config);
      await migrate(database.db as never);
      await emptyWorkspaces(db());
      await emptyPeople(db());
      const log = createLogger({ level: 'silent', format: 'json', write: () => undefined });
      const git = new Git({ reposDir: join(root, `repos-${name}`), allowLocal: true });
      sync = new ProjectSync(db(), git, log);
      queue = new RunQueue(db(), database.kind, key, { maxRuns: 4, perProject: 4 });
      source = testRepo({
        'flows/change.flow.yaml': FLOW,
        'flows/other.flow.yaml': OTHER,
        'inventory/hosts.yaml': 'all:\n  hosts:\n    fw-edge-01: {}\n',
      });
      const net = await createWorkspace(db(), { key: 'net', name: 'Network' });
      const lab = await createWorkspace(db(), { key: 'lab', name: 'Lab' });
      ids.net = net.id;
      project = (await sync.sync(
        (
          await createProject(
            db(),
            net.id,
            { key: 'edge', name: 'Edge', gitUrl: source.dir, pollSeconds: 0 },
            true,
          )
        ).id,
      )) as Project;
      configId = (
        await new LaunchConfigs(db(), git).create(project.id, {
          name: 'Change',
          flowFile: 'flows/change.flow.yaml',
          inventory: 'inventory/hosts.yaml',
          inputs: { devices: ['fw-edge-01'] },
        })
      ).id;
      // dana administers; omar operates and approves the change flow; rita reads net.
      for (const [login, admin] of [
        ['dana', true],
        ['omar', false],
        ['rita', false],
      ] as const)
        ids[login] = (
          await createUser(db(), { login, name: login, password: 'x'.repeat(12), admin })
        ).id;
      const change = { project: project.id, flow: 'flows/change.flow.yaml' };
      await createGrant(db(), net.id, { user: 'omar', level: 'operator', ...change }, 'dana');
      await createGrant(db(), net.id, { user: 'omar', level: 'approve', ...change }, 'dana');
      await createGrant(db(), net.id, { user: 'rita', level: 'ro' }, 'dana');
      const make = async (who: string, extra: object = {}) =>
        (await createToken(db(), ids[who] as string, { name: 't', ...extra })).token;
      tokens.dana = await make('dana');
      tokens.omar = await make('omar');
      tokens.omarDecides = await make('omar', { mcpApprovals: true });
      tokens.omarReads = await make('omar', { readOnly: true });
      tokens.rita = await make('rita');
      tokens.ritaLab = await make('rita', { workspace: lab.id });
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
      for (const c of clients) await c.close().catch(() => undefined);
      await app?.close();
      await sync?.stop();
      await database?.close();
      source?.remove();
    });

    it('signs in with an access token only', async () => {
      const none = await fetch(`${url}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(none.status).toBe(401);
      expect(none.headers.get('www-authenticate')).toMatch(/^Bearer/);
      expect(
        (await fetch(`${url}/mcp`, { headers: { authorization: `Bearer ${tokens.dana}` } })).status,
      ).toBe(405);
    });

    it('lists the read-only flow tools and the run tools; deciding approvals only with a token that allows it', async () => {
      const names = (t: { tools: { name: string }[] }) => t.tools.map((x) => x.name);
      const plain = names(await (await agent(tokens.omar as string)).listTools());
      expect(plain).toEqual(
        expect.arrayContaining([
          'flow_list',
          'flow_describe',
          'run_launch',
          'run_status',
          'approval_list',
        ]),
      );
      expect(plain).not.toContain('flow_edit');
      expect(plain).not.toContain('approval_decide');
      expect(names(await (await agent(tokens.omarDecides as string)).listTools())).toContain(
        'approval_decide',
      );
    });

    it("reads the flows its owner may: by workspace/project/file, within the token's workspace", async () => {
      const omar = await agent(tokens.omar as string);
      expect((await call(omar, 'flow_list')).text).toContain('net/edge/flows/change.flow.yaml');
      expect((await call(omar, 'flow_list')).text).not.toContain('other.flow.yaml');
      const described = await call(omar, 'flow_describe', {
        path: 'net/edge/flows/change.flow.yaml',
      });
      expect(described.isError).toBe(false);
      expect(described.text).toContain('approval');
      const hidden = await call(omar, 'flow_describe', { path: 'net/edge/flows/other.flow.yaml' });
      expect(hidden).toMatchObject({ isError: true });
      expect(hidden.text).toContain('No flow net/edge/flows/other.flow.yaml');
      const rita = await agent(tokens.rita as string);
      expect((await call(rita, 'flow_list')).text).toContain('other.flow.yaml');
      // A token for the lab workspace reaches nothing in net.
      const ritaLab = await agent(tokens.ritaLab as string);
      expect((await call(ritaLab, 'flow_list')).text).not.toContain('net/edge');
      expect(await json(ritaLab, 'project_list')).toEqual([]);
      expect((await call(omar, 'flow_edit', { path: 'x', ops: [] })).text).toContain(
        'No tool flow_edit',
      );
    });

    it("launches, follows and stops a run as its owner may; refusals are the API's", async () => {
      const omar = await agent(tokens.omar as string);
      expect(await json(omar, 'project_list')).toEqual([
        expect.objectContaining({ project: 'net/edge', branch: 'main' }),
      ]);
      expect(await json(omar, 'launch_config_list', { project: 'net/edge' })).toEqual([
        expect.objectContaining({ name: 'Change', flow: 'flows/change.flow.yaml' }),
      ]);
      const check = await json(omar, 'run_check', { config: 'net/edge/Change', mode: 'check' });
      expect(check).toMatchObject({
        flow: { file: 'flows/change.flow.yaml' },
        targets: ['fw-edge-01'],
      });

      // rita reads only: the API refuses, and the agent says so.
      const refused = await call(await agent(tokens.rita as string), 'run_launch', {
        config: configId,
      });
      expect(refused).toMatchObject({ isError: true });
      expect(refused.text).toMatch(/^Refused \(403\)/);
      // A read-only token launches nothing either.
      expect(
        (await call(await agent(tokens.omarReads as string), 'run_launch', { config: configId }))
          .isError,
      ).toBe(true);

      const launched = await json(omar, 'run_launch', { config: 'net/edge/Change' });
      expect(launched).toMatchObject({ state: 'queued', flow: 'Engine test · approval segments' });
      const status = await json(omar, 'run_status', { run: launched.run });
      expect(status).toMatchObject({ id: launched.run, state: 'queued', approvals: [] });
      expect((await json(omar, 'run_list', { project: 'net/edge' }))[0]).toMatchObject({
        id: launched.run,
        by: 'omar',
      });
      expect((await call(omar, 'run_stop', { run: launched.run })).text).toMatch(/is stopped$/);
      const entry = (await listAudit(db(), { action: 'run.launch' })).entries.find(
        (e) => e.object.id === launched.run,
      );
      expect(entry).toMatchObject({ source: 'mcp', actor: { login: 'omar' }, result: 'ok' });
    });

    it('approvals stay with people unless the token allows deciding them', async () => {
      // dana's run waits at its approval.
      const dana = await agent(tokens.dana as string);
      const { run } = await json(dana, 'run_launch', { config: configId });
      let job = await queue.claim('w');
      while (job && job.run.id !== run) job = await queue.claim('w');
      await queue.wait(run, job?.token as string);
      await openGate(db(), {
        run,
        node: {
          id: '01JCRBN0000000000000000003',
          key: 'change-approval',
          title: 'Approve the change',
        },
        segment: 'start',
        carried: {},
        approval: { message: 'Check the change ticket first' },
      });
      const omar = await agent(tokens.omar as string);
      expect(await json(omar, 'approval_list')).toEqual([
        expect.objectContaining({ run, node: 'change-approval', mayDecide: true }),
      ]);
      const no = await call(omar, 'approval_decide', {
        run,
        node: 'change-approval',
        decision: 'approved',
      });
      expect(no).toMatchObject({ isError: true });
      expect(no.text).toContain('approvals stay with people');

      const decides = await agent(tokens.omarDecides as string);
      const yes = await call(decides, 'approval_decide', {
        run,
        node: 'change-approval',
        decision: 'approved',
        comment: 'Asked to by the change manager',
      });
      expect(yes).toEqual({ isError: false, text: 'The approval is approved; the run goes on' });
      const status = await json(dana, 'run_status', { run });
      expect(status.approvals[0]).toMatchObject({ status: 'approved', decidedBy: 'omar' });
      const entry = (await listAudit(db(), { action: 'approval.decide' })).entries[0];
      expect(entry).toMatchObject({ source: 'mcp', actor: { login: 'omar' } });
    });

    it('a request from outside cannot pass for the MCP tools', async () => {
      await fetch(`${url}/api/v1/runs?limit=1`, {
        headers: { authorization: `Bearer ${tokens.dana}`, 'x-afs-mcp': 'guessed' },
      });
      const sources = (await listAudit(db(), {})).entries.map((e) => e.source);
      expect(sources).not.toContain(undefined);
      const r = await app.inject({
        method: 'POST',
        url: `/api/v1/runs/nothing/cancel`,
        headers: { authorization: `Bearer ${tokens.dana}`, 'x-afs-mcp': 'guessed' },
      });
      expect(r.statusCode).toBe(404);
      expect((await listAudit(db(), { action: 'run.stop' })).entries[0]?.source).toBe('api');
    });
  });
}
