// AFS-176 (ADR-0037): links to actions from NetBox and Zabbix. What a link gives (ready to
// confirm, or a short form; unknown names refused), that a GET never runs, an action that runs as
// its link opens, a host list narrowed to a group, signed links for systems with no person (scope,
// audit, revoke), and the result written back to a fake NetBox and a fake Zabbix.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGrant } from '../../src/server/access/grants';
import { groupHosts, outsideGroup } from '../../src/server/actions/store';
import { replyObject } from '../../src/server/actions/types';
import { buildApp } from '../../src/server/app';
import { safeReturn } from '../../src/server/auth/oidc/flow';
import { createToken } from '../../src/server/auth/tokens';
import { createUser } from '../../src/server/auth/users';
import { type Database, openDatabase } from '../../src/server/db/database';
import { migrate } from '../../src/server/db/migrations';
import { LaunchConfigs } from '../../src/server/launch/configs';
import { createLogger } from '../../src/server/log';
import { Notifier } from '../../src/server/notify/notifier';
import { netboxChannel, zabbixChannel } from '../../src/server/notify/replies';
import { Git } from '../../src/server/projects/git';
import { createProject, createWorkspace, type Project } from '../../src/server/projects/store';
import { ProjectSync } from '../../src/server/projects/sync';
import { RunQueue } from '../../src/server/runs/queue';
import { createCredential, reveal } from '../../src/server/secrets/credentials';
import { keyId, type MasterKey, newKey } from '../../src/server/secrets/masterKey';
import { emptyPeople, emptyWorkspaces } from './helpers/clean';
import { type TestRepo, testRepo } from './helpers/repo';

const PASSWORD = 'correct horse battery staple';
const fixture = (name: string) => readFileSync(join(__dirname, '../fixtures', name), 'utf8');
// Hello with a device name, a count, and a host list the action narrows to the edge group.
const LB = fixture('hello.flow.yaml').replace(
  '    devices:',
  '    device:\n      type: string\n      required: true\n    count:\n      type: integer\n      default: 1\n    devices:',
);
const bytes = newKey();
const key: MasterKey = { key: bytes, id: keyId(bytes), source: 'env' };
const root = mkdtempSync(join(tmpdir(), 'afs-links-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('the parts of a link', () => {
  it('a reply names a NetBox object or a Zabbix event, nothing else', () => {
    expect(replyObject('netbox', 'dcim.device:1')).toEqual({ type: 'dcim.device', id: '1' });
    expect(replyObject('netbox', 'event:1')).toBeUndefined();
    expect(replyObject('zabbix', 'event:2048')).toEqual({ type: 'event', id: '2048' });
    expect(replyObject('zabbix', '{EVENT.ID}')).toBeUndefined();
  });
  it('a group offers its hosts and its children’s; a name outside it is refused', () => {
    const groups = {
      edge: { parents: [], hosts: ['sw-1'] },
      far: { parents: ['edge'], hosts: ['sw-9'] },
      core: { parents: [], hosts: ['sw-c'] },
    };
    expect(groupHosts(groups, 'edge')).toEqual(['sw-1', 'sw-9']);
    expect(groupHosts(groups, 'nope')).toBeUndefined();
    const field = { name: 'devices', label: 'Switch', group: 'edge' };
    expect(outsideGroup(field, 'sw-1, edge', ['sw-1', 'sw-9'])).toBeUndefined();
    expect(outsideGroup(field, 'sw-c', ['sw-1', 'sw-9'])?.message).toBe(
      'Switch: sw-c is not in edge',
    );
  });
  it('sign-in comes back to the link with its query', () => {
    expect(safeReturn('/a/abc?device=bigip-edge-01&ip=192.0.2.10')).toBe(
      '/a/abc?device=bigip-edge-01&ip=192.0.2.10',
    );
    expect(safeReturn('//evil.example/a')).toBe('/');
  });
});

/** A fake NetBox and Zabbix: what they were sent. */
function fakeSystem(answer: (path: string, body: string) => { status: number; body: unknown }) {
  const got: { path: string; auth: string; body: Record<string, unknown> }[] = [];
  const server: Server = createServer((req: IncomingMessage, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      got.push({
        path: req.url ?? '',
        auth: String(req.headers.authorization ?? ''),
        body: body ? (JSON.parse(body) as Record<string, unknown>) : {},
      });
      const a = answer(req.url ?? '', body);
      res.writeHead(a.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(a.body));
    });
  });
  return {
    got,
    server,
    start: () =>
      new Promise<string>((done) =>
        server.listen(0, '127.0.0.1', () =>
          done(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
        ),
      ),
  };
}

describe('links to actions on SQLite', () => {
  let database: Database;
  let app: FastifyInstance;
  let source: TestRepo;
  let core: Project;
  let lb: string;
  let other: string;
  let netboxCred: string;
  let zabbixCred: string;
  const token: Record<string, string> = {};
  const ids: Record<string, string> = {};
  let wandaCookie = '';
  const db = () => database.db;
  const netbox = fakeSystem(() => ({ status: 201, body: { id: 7 } }));
  const zabbix = fakeSystem((_p, body) =>
    JSON.parse(body).params?.eventids?.[0] === '404'
      ? {
          status: 200,
          body: { jsonrpc: '2.0', error: { message: 'No permissions', data: 'x' }, id: 1 },
        }
      : { status: 200, body: { jsonrpc: '2.0', result: { eventids: ['2048'] }, id: 1 } },
  );
  let netboxUrl = '';
  let zabbixUrl = '';

  beforeAll(async () => {
    database = openDatabase({ kind: 'sqlite', file: ':memory:' });
    await migrate(database.db as never);
    await emptyWorkspaces(db());
    await emptyPeople(db());
    netboxUrl = await netbox.start();
    zabbixUrl = await zabbix.start();
    source = testRepo({
      'lb.flow.yaml': LB,
      'inventory/hosts.ini': '[edge]\nsw-edge-01\nsw-edge-02\n\n[core]\nsw-core-01\n',
    });
    const log = createLogger({ level: 'error', format: 'json', write: () => undefined });
    const git = new Git({ reposDir: join(root, 'repos'), allowLocal: true });
    const sync = new ProjectSync(db(), git, log);
    const queue = new RunQueue(db(), database.kind, key);
    app = buildApp({
      log,
      database,
      instance: 'test',
      masterKey: key,
      runs: queue,
      projects: { git, sync, allowLocal: true },
    });
    const net = await createWorkspace(db(), { key: 'net', name: 'Network' });
    const made = await createProject(
      db(),
      net.id,
      { key: 'core', name: 'Core', gitUrl: source.dir, pollSeconds: 0 },
      true,
    );
    core = (await sync.sync(made.id)) as Project;
    const configs = new LaunchConfigs(db(), git);
    const base = { inventory: 'inventory/hosts.ini', mode: 'real' as const };
    lb = (
      await configs.create(core.id, {
        name: 'Provision',
        flowFile: 'lb.flow.yaml',
        ...base,
        inputs: { devices: ['sw-edge-01'], count: 3 },
      })
    ).id;
    other = (
      await configs.create(core.id, {
        name: 'Other',
        flowFile: 'lb.flow.yaml',
        ...base,
        inputs: { devices: ['sw-edge-01'], device: 'x' },
      })
    ).id;
    for (const login of ['dana', 'wanda', 'mia', 'nobody'])
      await createUser(db(), { login, name: login, password: PASSWORD, admin: login === 'dana' });
    for (const u of await db().selectFrom('user_account').select(['id', 'login']).execute())
      ids[u.login] = u.id;
    for (const login of ['dana', 'wanda', 'mia', 'nobody'])
      token[login] = (await createToken(db(), ids[login] as string, { name: 't' })).token;
    await createGrant(db(), net.id, { user: 'wanda', level: 'rw' }, 'dana');
    netboxCred = (
      await createCredential(db(), key, net.id, {
        name: 'lab netbox',
        kind: 'netbox',
        fields: { address: netboxUrl },
        secret: { token: 'nbt_abc.def' },
      })
    ).id;
    zabbixCred = (
      await createCredential(db(), key, net.id, {
        name: 'lab zabbix',
        kind: 'zabbix',
        fields: { address: zabbixUrl },
        secret: { token: 'zbx-token' },
      })
    ).id;
    const signIn = await app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { login: 'wanda', password: PASSWORD },
    });
    wandaCookie =
      /afs_session=[^;]*/.exec([signIn.headers['set-cookie']].flat().join('; '))?.[0] ?? '';
  });
  afterAll(async () => {
    await app?.close();
    await database?.close();
    source?.remove();
    netbox.server.close();
    zabbix.server.close();
  });

  const call = async (
    who: string,
    method: string,
    url: string,
    payload?: object,
    headers: Record<string, string> = {},
  ) => {
    const reply = await app.inject({
      method: method as 'GET',
      url,
      headers: who === 'none' ? headers : { authorization: `Bearer ${token[who]}`, ...headers },
      ...(payload ? { payload } : {}),
    });
    return {
      status: reply.statusCode,
      body: reply.body ? (JSON.parse(reply.body) as Record<string, unknown>) : {},
    };
  };
  const withCookie = async (method: string, url: string, payload?: object) => {
    const reply = await app.inject({
      method: method as 'GET',
      url,
      headers: { cookie: wandaCookie },
      ...(payload ? { payload } : {}),
    });
    return { status: reply.statusCode, body: reply.body ? JSON.parse(reply.body) : {} };
  };
  const SETTINGS = {
    title: 'Provision the load balancer',
    summary: 'Provisions a load balancer from its NetBox record.',
    asked: [
      { name: 'device', label: 'Device' },
      { name: 'count', label: 'How many' },
      { name: 'devices', label: 'Switch', group: 'edge' },
    ],
    mode: 'check',
    confirm: true,
  };

  it('sets the link options: run on open, a group, the result back with a credential of its kind', async () => {
    const wrongKind = await call('wanda', 'PUT', `/api/v1/launch-configs/${lb}/action`, {
      ...SETTINGS,
      reply: { system: 'netbox', credential: zabbixCred, when: 'ended' },
    });
    expect(wrongKind.status).toBe(400);
    expect(wrongKind.body.message).toMatch(/not a NetBox token/);
    const notList = await call('wanda', 'PUT', `/api/v1/launch-configs/${lb}/action`, {
      ...SETTINGS,
      asked: [{ name: 'device', label: 'Device', group: 'edge' }],
    });
    expect(notList.status).toBe(400);
    const set = await call('wanda', 'PUT', `/api/v1/launch-configs/${lb}/action`, {
      ...SETTINGS,
      reply: { system: 'netbox', credential: netboxCred, when: 'ended' },
    });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({
      runOnOpen: false,
      reply: { system: 'netbox', credential: netboxCred },
    });
    expect(
      (await call('wanda', 'POST', `/api/v1/launch-configs/${lb}/action/grants`, { user: 'mia' }))
        .status,
    ).toBe(201);
  });

  it('a link with every value is ready to confirm; with some missing, a short form', async () => {
    const ready = await call(
      'mia',
      'GET',
      `/api/v1/actions/${lb}/link?device=bigip-edge-01&devices=sw-edge-02&_reply=dcim.device:1`,
    );
    expect(ready.status).toBe(200);
    expect(ready.body).toMatchObject({
      ready: true,
      missing: [],
      problems: [],
      given: ['device', 'devices'],
      values: { device: 'bigip-edge-01', count: '3', devices: 'sw-edge-02' },
      reply: 'dcim.device:1',
    });
    // The fixed values are not listed by their variable names (AFS-175's note).
    const happens = ((ready.body.form as { happens: string[] }).happens ?? []).join(' ');
    expect(happens).not.toMatch(/Set by the action/);
    expect(happens).toMatch(/NetBox is told how it ended/);
    const form = await call('mia', 'GET', `/api/v1/actions/${lb}/link?devices=sw-edge-01`);
    expect(form.body).toMatchObject({ ready: false, missing: ['device'] });
    // Values checked as the form checks them: a number, the group.
    const wrong = await call(
      'mia',
      'GET',
      `/api/v1/actions/${lb}/link?device=x&count=many&devices=sw-core-01&_reply=nope`,
    );
    expect(wrong.body.ready).toBe(false);
    expect((wrong.body.problems as { field: string }[]).map((p) => p.field).sort()).toEqual([
      'count',
      'devices',
    ]);
    expect(wrong.body.replyNote).toMatch(/not written back/);
    // A name the action does not ask: refused in words, nothing to fill.
    const unknown = await call('mia', 'GET', `/api/v1/actions/${lb}/link?device=x&retries=9`);
    expect(unknown.body.ready).toBe(false);
    expect(unknown.body.refused).toMatch(
      /retries, which "Provision the load balancer" does not ask/,
    );
    // Who may not run it learns nothing.
    expect((await call('nobody', 'GET', `/api/v1/actions/${lb}/link?device=x`)).status).toBe(404);
    expect((await call('none', 'GET', `/api/v1/actions/${lb}/link?device=x`)).status).toBe(401);
  });

  it('a GET never runs: only the page’s POST does', async () => {
    const before = await db().selectFrom('run').select('id').execute();
    await call('mia', 'GET', `/api/v1/actions/${lb}/link?device=x&devices=sw-edge-01`);
    expect((await call('mia', 'GET', `/api/v1/actions/${lb}/run`)).status).toBe(404);
    expect(await db().selectFrom('run').select('id').execute()).toHaveLength(before.length);
    // The page's POST from another site is refused (as every change is).
    const cross = await app.inject({
      method: 'POST',
      url: `/api/v1/actions/${lb}/run`,
      headers: { cookie: wandaCookie, origin: 'https://evil.example', host: 'localhost' },
      payload: { inputs: { device: 'x' } },
    });
    expect(cross.statusCode).toBe(403);
  });

  let run: string;
  it('runs from the link: the group is kept, the reply noted, the audit says it came by a link', async () => {
    const outside = await call('mia', 'POST', `/api/v1/actions/${lb}/run`, {
      inputs: { device: 'bigip-edge-01', devices: 'sw-core-01' },
    });
    expect(outside.status).toBe(400);
    expect(outside.body.field).toBe('devices');
    const ran = await call('mia', 'POST', `/api/v1/actions/${lb}/run`, {
      inputs: { device: 'bigip-edge-01', devices: 'sw-edge-02' },
      reply: 'dcim.device:1',
      link: true,
    });
    expect(ran.status).toBe(201);
    run = ran.body.id as string;
    expect(
      await db()
        .selectFrom('action_reply')
        .select(['system', 'object'])
        .where('run_id', '=', run)
        .execute(),
    ).toEqual([{ system: 'netbox', object: 'dcim.device:1' }]);
    const entry = await db()
      .selectFrom('audit_entry')
      .select('detail_json')
      .where('action', '=', 'action.run')
      .where('result', '=', 'ok')
      .orderBy('at', 'desc')
      .executeTakeFirstOrThrow();
    expect(JSON.parse(entry.detail_json ?? '{}')).toMatchObject({
      via: 'link',
      reply: 'netbox dcim.device:1',
    });
  });

  it('writes the result back: a NetBox journal entry, a Zabbix message, and says why one failed', async () => {
    await db().updateTable('run').set({ state: 'succeeded' }).where('id', '=', run).execute();
    const log = createLogger({ level: 'error', format: 'json', write: () => undefined });
    const credential = async (id: string) => {
      const c = await reveal(db(), key, id);
      return c?.fields.address && c.secret.token
        ? { address: c.fields.address, token: c.secret.token }
        : undefined;
    };
    const notifier = new Notifier(
      db(),
      [netboxChannel(credential, 'test'), zabbixChannel(credential, 'test')],
      log,
      { keepDays: 1, publicUrl: 'https://afs.example.net' },
    );
    notifier.runEnded(run);
    await notifier.idle();
    expect(netbox.got).toHaveLength(1);
    expect(netbox.got[0]).toMatchObject({
      path: '/api/extras/journal-entries/',
      auth: 'Bearer nbt_abc.def',
      body: { assigned_object_type: 'dcim.device', assigned_object_id: 1, kind: 'success' },
    });
    expect(String(netbox.got[0]?.body.comments)).toMatch(
      new RegExp(
        `"Provision the load balancer" went well[\\s\\S]*https://afs.example.net/actions/runs/${run}`,
      ),
    );
    // Told once, even if the end is told again.
    notifier.runEnded(run);
    await notifier.idle();
    expect(netbox.got).toHaveLength(1);

    // Zabbix: a message on the problem; a refusal is said in its words and not tried again.
    expect(
      (
        await call('wanda', 'PUT', `/api/v1/launch-configs/${lb}/action`, {
          ...SETTINGS,
          reply: { system: 'zabbix', credential: zabbixCred, when: 'ended' },
        })
      ).status,
    ).toBe(200);
    const zrun = await call('mia', 'POST', `/api/v1/actions/${lb}/run`, {
      inputs: { device: 'bigip-edge-01', devices: 'sw-edge-01' },
      reply: 'event:2048',
    });
    const bad = await call('mia', 'POST', `/api/v1/actions/${lb}/run`, {
      inputs: { device: 'bigip-edge-01', devices: 'sw-edge-01' },
      reply: 'event:404',
    });
    for (const id of [zrun.body.id, bad.body.id] as string[]) {
      await db()
        .updateTable('run')
        .set({ state: 'failed', error: 'The host did not answer' })
        .where('id', '=', id)
        .execute();
      notifier.runEnded(id);
    }
    await notifier.idle();
    expect(zabbix.got.map((g) => g.body.params)).toEqual([
      expect.objectContaining({
        eventids: ['2048'],
        action: 4,
        message: expect.stringMatching(/did not go well[\s\S]*Why: The host did not answer/),
      }),
      expect.objectContaining({ eventids: ['404'] }),
    ]);
    expect(zabbix.got[0]?.auth).toBe('Bearer zbx-token');
    const failed = await db()
      .selectFrom('notification')
      .select(['status', 'last_error', 'target'])
      .where('channel', '=', 'zabbix')
      .where('status', '=', 'failed')
      .execute();
    expect(failed).toEqual([
      expect.objectContaining({ last_error: expect.stringMatching(/Zabbix: No permissions/) }),
    ]);
    await notifier.stop();
  });

  let signed = '';
  let signedId = '';
  it('a signed link is made in a session only, shown once, listed by name', async () => {
    expect(
      (
        await call('wanda', 'POST', `/api/v1/launch-configs/${lb}/action/tokens`, {
          name: 'zabbix',
        })
      ).status,
    ).toBe(403);
    expect(
      (await call('mia', 'POST', `/api/v1/launch-configs/${lb}/action/tokens`, { name: 'zabbix' }))
        .status,
    ).toBe(404);
    const made = await withCookie('POST', `/api/v1/launch-configs/${lb}/action/tokens`, {
      name: 'Zabbix action',
    });
    expect(made.status).toBe(201);
    signed = made.body.token;
    signedId = made.body.id;
    expect(signed).toMatch(/^afsl_/);
    const listed = await call('wanda', 'GET', `/api/v1/launch-configs/${lb}/action`);
    expect(listed.body.tokens).toEqual([
      expect.objectContaining({
        name: 'Zabbix action',
        hint: signed.slice(-4),
        createdBy: 'wanda',
      }),
    ]);
    expect(JSON.stringify(listed.body)).not.toContain(signed);
  });

  it('a signed link runs its action only, by POST with a bearer header, and is audited', async () => {
    const auth = { authorization: `Bearer ${signed}` };
    const ran = await call(
      'none',
      'POST',
      `/api/v1/actions/${lb}/run`,
      { inputs: { device: 'bigip-edge-01', devices: 'sw-edge-01' } },
      auth,
    );
    expect(ran.status).toBe(201);
    const record = await db()
      .selectFrom('run')
      .selectAll()
      .where('id', '=', ran.body.id as string)
      .executeTakeFirstOrThrow();
    expect(record.requested_login).toBe('wanda');
    // Not another action, not another route, not in the query.
    expect(
      (await call('none', 'POST', `/api/v1/actions/${other}/run`, { inputs: {} }, auth)).status,
    ).toBe(401);
    expect((await call('none', 'GET', `/api/v1/actions/${lb}`, undefined, auth)).status).toBe(401);
    expect(
      (await call('none', 'GET', `/api/v1/actions/${lb}/link?device=x`, undefined, auth)).status,
    ).toBe(401);
    expect(
      (await call('none', 'POST', `/api/v1/actions/${lb}/run?token=${signed}`, { inputs: {} }))
        .status,
    ).toBe(401);
    const entry = await db()
      .selectFrom('audit_entry')
      .select(['actor_login', 'source', 'detail_json'])
      .where('action', '=', 'action.run')
      .where('result', '=', 'ok')
      .orderBy('at', 'desc')
      .executeTakeFirstOrThrow();
    expect(entry.actor_login).toBe('wanda');
    expect(entry.source).toBe('api');
    expect(JSON.parse(entry.detail_json ?? '{}')).toMatchObject({
      via: 'signed link',
      token: 'signed link Zabbix action',
    });
  });

  it('a revoked signed link stops at once; making and revoking are audited', async () => {
    expect(
      (await call('wanda', 'DELETE', `/api/v1/launch-configs/${lb}/action/tokens/${signedId}`))
        .status,
    ).toBe(204);
    expect(
      (
        await call(
          'none',
          'POST',
          `/api/v1/actions/${lb}/run`,
          { inputs: { device: 'x', devices: 'sw-edge-01' } },
          {
            authorization: `Bearer ${signed}`,
          },
        )
      ).status,
    ).toBe(401);
    const rows = await db()
      .selectFrom('audit_entry')
      .select(['action', 'result'])
      .where('action', 'like', 'action.link-%')
      .execute();
    expect(
      rows
        .filter((r) => r.result === 'ok')
        .map((r) => r.action)
        .sort(),
    ).toEqual(['action.link-create', 'action.link-revoke']);
  });

  it('an action that runs on open says so in its form', async () => {
    await call('wanda', 'PUT', `/api/v1/launch-configs/${lb}/action`, {
      ...SETTINGS,
      runOnOpen: true,
    });
    const form = await call('mia', 'GET', `/api/v1/actions/${lb}`);
    expect(form.body.runOnOpen).toBe(true);
    const hosts = await call('mia', 'GET', `/api/v1/actions/${lb}/hosts`);
    expect(hosts.body.inGroup).toEqual({ edge: ['sw-edge-01', 'sw-edge-02'] });
  });
});
