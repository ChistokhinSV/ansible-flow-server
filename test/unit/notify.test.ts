// Notifications (AFS-29): the channels (webhook signed, email through a relay; which failures are
// tried again), and on both databases the server supports (PostgreSQL when AFS_TEST_POSTGRES_URL
// is set): who is told of what, the outbox with its tries, the administrators' API, and that a
// new master key keeps what is sealed (the relay's password, runs' inputs).
import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGrant } from '../../src/server/access/grants';
import { buildApp } from '../../src/server/app';
import { decideGate, openGate } from '../../src/server/approvals/gates';
import { listAudit } from '../../src/server/audit/store';
import { createToken } from '../../src/server/auth/tokens';
import { createGroup, createUser, setMembers } from '../../src/server/auth/users';
import type { Config } from '../../src/server/config';
import { type Database, openDatabase } from '../../src/server/db/database';
import { migrate } from '../../src/server/db/migrations';
import type { PreparedLaunch } from '../../src/server/launch/prepare';
import { createLogger } from '../../src/server/log';
import { emailChannel, type Message, webhookChannel } from '../../src/server/notify/channels';
import { Notifier } from '../../src/server/notify/notifier';
import { contactsOfNames, placesOf, unknownNames } from '../../src/server/notify/recipients';
import { setSmtp, smtpForSending, webhookKey } from '../../src/server/notify/settings';
import {
  enqueue,
  listDeliveries,
  MAX_ATTEMPTS,
  markFailed,
  retryNow,
  takeDue,
} from '../../src/server/notify/store';
import { createProject, createWorkspace } from '../../src/server/projects/store';
import { RunQueue } from '../../src/server/runs/queue';
import { rotate } from '../../src/server/secrets/credentials';
import { keyId, type MasterKey, newKey } from '../../src/server/secrets/masterKey';
import type { CertificateInfo } from '../../src/server/tls/certificates';
import { emptyPeople, emptyWorkspaces } from './helpers/clean';
import { type TestSmtp, testSmtp } from './helpers/smtp';

const PASSWORD = 'correct horse battery staple';
const keyOf = (): MasterKey => {
  const bytes = newKey();
  return { key: bytes, id: keyId(bytes), source: 'env' };
};
const key = keyOf();
const log = createLogger({ level: 'silent', format: 'json', write: () => undefined });
const MESSAGE: Message = {
  subject: 'Approval waits: Approve the change',
  text: 'Firewall upgrade, run 7 waits for a decision.',
  payload: { event: 'approval.waiting', run: { id: 'r1', number: 7 } },
};

/** A receiver of webhooks: what each path answers, and what it was sent. */
interface Hooks {
  url: string;
  got: { path: string; headers: IncomingMessage['headers']; body: string }[];
  close(): Promise<void>;
}
async function hooks(): Promise<Hooks> {
  const got: Hooks['got'] = [];
  const server: Server = createServer((request, reply) => {
    let body = '';
    request.on('data', (c) => {
      body += c;
    });
    request.on('end', () => {
      const path = request.url ?? '/';
      got.push({ path, headers: request.headers, body });
      if (path.startsWith('/busy')) reply.writeHead(503).end();
      else if (path.startsWith('/gone')) reply.writeHead(404).end();
      else if (path.startsWith('/moved')) reply.writeHead(302, { location: '/ok/elsewhere' }).end();
      else reply.writeHead(204).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    got,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

let receiver: Hooks;
let smtp: TestSmtp;
beforeAll(async () => {
  receiver = await hooks();
  smtp = await testSmtp();
});
afterAll(async () => {
  await receiver.close();
  await smtp.close();
});

describe('the channels', () => {
  const delivery = { id: 'd1', event: 'approval.waiting' };

  it('a webhook gets the event as JSON with a text line, signed with the shared key', async () => {
    const channel = webhookChannel(async () => 'afs_whk_test-key', 'ansible-flow-server/test');
    const sent = await channel.send(`${receiver.url}/ok/hook-secret`, MESSAGE, delivery);
    expect(sent).toEqual({ ok: true });
    const hit = receiver.got.at(-1);
    expect(hit?.headers['x-afs-event']).toBe('approval.waiting');
    expect(hit?.headers['x-afs-delivery']).toBe('d1');
    const body = JSON.parse(hit?.body ?? '{}');
    expect(body).toMatchObject({
      text: MESSAGE.text,
      event: 'approval.waiting',
      run: { number: 7 },
    });
    // The receiver checks the signature over the timestamp and the body, with the key.
    const timestamp = String(hit?.headers['x-afs-timestamp']);
    const expected = createHmac('sha256', 'afs_whk_test-key')
      .update(`${timestamp}.${hit?.body}`)
      .digest('hex');
    expect(hit?.headers['x-afs-signature']).toBe(`sha256=${expected}`);
  });

  it('a webhook without a key goes unsigned', async () => {
    const channel = webhookChannel(async () => undefined, 'ansible-flow-server/test');
    await channel.send(`${receiver.url}/ok/unsigned`, MESSAGE, delivery);
    expect(receiver.got.at(-1)?.headers['x-afs-signature']).toBeUndefined();
  });

  it('a busy receiver is tried again; a refusal or a redirect is not, and a redirect is not followed', async () => {
    const channel = webhookChannel(async () => undefined, 'test');
    expect(await channel.send(`${receiver.url}/busy`, MESSAGE, delivery)).toMatchObject({
      ok: false,
      retry: true,
      error: 'HTTP 503: Service Unavailable',
    });
    expect(await channel.send(`${receiver.url}/gone`, MESSAGE, delivery)).toMatchObject({
      ok: false,
      retry: false,
    });
    const before = receiver.got.length;
    const moved = await channel.send(`${receiver.url}/moved`, MESSAGE, delivery);
    expect(moved).toMatchObject({ ok: false, retry: false });
    expect(receiver.got.length).toBe(before + 1);
  });

  it('a receiver that is not there is tried again, and the error never names the address', async () => {
    const channel = webhookChannel(async () => undefined, 'test', 2000);
    const sent = await channel.send(
      'http://127.0.0.1:9/hooks/T000/B000/secret-part',
      MESSAGE,
      delivery,
    );
    expect(sent).toMatchObject({ ok: false, retry: true });
    expect(JSON.stringify(sent)).not.toContain('secret-part');
  });

  it('email goes through the relay; a refused mailbox is not tried again; no relay: not set up', async () => {
    const relay = {
      host: '127.0.0.1',
      port: smtp.port,
      security: 'none' as const,
      from: 'Flow Server <flows@example.net>',
    };
    const channel = emailChannel(async () => relay);
    expect(await channel.send('omar@example.net', MESSAGE, delivery)).toEqual({ ok: true });
    const mail = smtp.received.at(-1);
    expect(mail?.to).toEqual(['omar@example.net']);
    expect(mail?.from).toBe('flows@example.net');
    expect(mail?.data).toContain('Subject: Approval waits: Approve the change');
    expect(mail?.data).toContain('run 7 waits for a decision');

    smtp.refuse.add('nobody@example.net');
    expect(await channel.send('nobody@example.net', MESSAGE, delivery)).toMatchObject({
      ok: false,
      retry: false,
    });
    expect(
      await emailChannel(async () => undefined).send('a@example.net', MESSAGE, delivery),
    ).toMatchObject({
      ok: false,
      retry: false,
      error: expect.stringContaining('Email is not set up'),
    });
  });
});

const postgres = process.env.AFS_TEST_POSTGRES_URL;
const databases: [string, Config['database'] | undefined][] = [
  ['SQLite', { kind: 'sqlite', file: ':memory:' }],
  ['PostgreSQL', postgres ? { kind: 'postgres', url: postgres } : undefined],
];

const launchOf = (project: string, inputs: Record<string, unknown> = {}): PreparedLaunch => ({
  config: 'c-notify',
  project,
  commit: 'a'.repeat(40),
  ref: 'main',
  flow: { file: 'flows/upgrade.flow.yaml', key: 'upgrade', name: 'Firewall upgrade', version: 1 },
  mode: 'real',
  inputs,
  targets: ['fw-edge-01'],
  credentials: [],
});

for (const [name, config] of databases) {
  describe.skipIf(!config)(`notifications on ${name}`, () => {
    let database: Database;
    let notifier: Notifier;
    let queue: RunQueue;
    let app: FastifyInstance;
    let project: string;
    const ids: Record<string, string> = {};
    const db = () => database.db;
    const sentTo = (since: number) => smtp.received.slice(since).flatMap((m) => m.to);
    const hooksSince = (since: number) =>
      receiver.got.slice(since).map((h) => ({ path: h.path, body: JSON.parse(h.body) }));

    beforeAll(async () => {
      if (!config) return;
      database = openDatabase(config);
      await migrate(database.db as never);
      await emptyWorkspaces(db());
      await emptyPeople(db());
      await db().deleteFrom('setting').where('name', 'like', 'notify.%').execute();
      // dana launches and administers; the change board approves (omar and gary, the group has
      // no address of its own); the NOC is told through its list; rita may approve, but is gone.
      for (const [login, extra] of [
        ['dana', { admin: true, email: 'dana@example.net' }],
        ['omar', { email: 'omar@example.net', webhookUrl: `${receiver.url}/ok/omar-secret` }],
        ['gary', {}],
        ['rita', { email: 'rita@example.net' }],
      ] as const)
        ids[login] = (
          await createUser(db(), { login, name: login, password: PASSWORD, ...extra })
        ).id;
      await db()
        .updateTable('user_account')
        .set({ disabled: 1 })
        .where('login', '=', 'rita')
        .execute();
      const board = await createGroup(db(), { name: 'change-board' });
      await setMembers(db(), board.id, [ids.omar as string, ids.gary as string]);
      await createGroup(db(), { name: 'NOC', email: 'noc@example.net' });
      const workspace = await createWorkspace(db(), { key: 'net', name: 'Network' });
      ids.workspace = workspace.id;
      project = (await createProject(db(), workspace.id, { key: 'edge', name: 'Edge' }, false)).id;
      for (const who of [{ group: 'change-board' }, { user: 'rita' }])
        await createGrant(db(), workspace.id, { ...who, level: 'approve' }, 'dana');
      await setSmtp(db(), key, {
        host: '127.0.0.1',
        port: smtp.port,
        security: 'none',
        user: 'relay',
        password: 'relay-password-1',
        from: 'Flow Server <flows@example.net>',
      });
      notifier = new Notifier(
        db(),
        [
          emailChannel(() => smtpForSending(db(), key)),
          webhookChannel(() => webhookKey(db(), key), 'ansible-flow-server/test'),
        ],
        log,
        { keepDays: 30, publicUrl: 'https://flows.example.net' },
      );
      queue = new RunQueue(db(), database.kind, key, { maxRuns: 8, perProject: 8 });
      queue.onEnded = (id) => notifier.runEnded(id);
      app = buildApp({ log, database, instance: 'test', masterKey: key, notifier });
    });
    afterAll(async () => {
      await app?.close();
      await notifier?.stop();
      await db()?.deleteFrom('setting').where('name', 'like', 'notify.%').execute();
      await database?.close();
    });

    const launch = (by: 'dana' | 'omar', inputs: Record<string, unknown> = {}) =>
      queue.enqueue(launchOf(project, inputs), {}, { id: ids[by] as string, login: by }, 'Upgrade');
    const gate = (run: string, approval: object = {}) =>
      openGate(db(), {
        run,
        node: { id: 'N-approve', key: 'change-approval', title: 'Approve the change' },
        segment: 'start',
        carried: {},
        approval,
      });

    it('names are people and groups: a group without an address is told through its members; the disabled are not', async () => {
      const places = placesOf(await contactsOfNames(db(), ['change-board', 'noc', 'rita', 'omar']));
      expect(places.map((p) => `${p.channel}:${p.recipient}`).sort()).toEqual([
        'email:NOC',
        'email:omar',
        'webhook:omar',
      ]);
      expect(await unknownNames(db(), ['omar', 'NOC', 'nobody'])).toEqual(['nobody']);
    });

    it('a waiting approval asks who holds approve (not who launched it) and whom it names to tell', async () => {
      const mails = smtp.received.length;
      const calls = receiver.got.length;
      const run = await launch('dana', { api_password: 'hunter2-never-sent' });
      const g = await gate(run.id, { notify: ['NOC'], message: 'Check the change ticket first' });
      notifier.approvalWaiting(run.id, g.id);
      await notifier.idle();
      expect(sentTo(mails).sort()).toEqual(['noc@example.net', 'omar@example.net']);
      const mail = smtp.received.at(-1)?.data ?? '';
      expect(mail).toContain('Check the change ticket first');
      expect(mail).toContain(`https://flows.example.net/runs/${run.id}`);
      const [hook] = hooksSince(calls);
      expect(hook?.path).toBe('/ok/omar-secret');
      expect(hook?.body).toMatchObject({
        event: 'approval.waiting',
        server: 'https://flows.example.net',
        run: { id: run.id, number: run.number, requestedBy: 'dana' },
        approval: { node: { key: 'change-approval' }, status: 'waiting' },
      });
      // A run's inputs are never in a message.
      expect(JSON.stringify(receiver.got.slice(calls))).not.toContain('hunter2');

      // omar launches: he may not decide his own run, so he is not asked; nobody else may.
      const own = await launch('omar');
      const before = (await listDeliveries(db(), { run: own.id })).length;
      notifier.approvalWaiting(own.id, (await gate(own.id)).id);
      await notifier.idle();
      expect((await listDeliveries(db(), { run: own.id })).length).toBe(before);
    });

    it('a decision tells who launched the run, with the comment', async () => {
      const mails = smtp.received.length;
      const run = await launch('dana');
      const g = await gate(run.id, { notify: ['NOC'] });
      await decideGate(db(), g.id, {
        status: 'rejected',
        by: 'omar',
        comment: 'Not during the freeze',
      });
      notifier.approvalDecided(run.id, g.id);
      await notifier.idle();
      expect(sentTo(mails).sort()).toEqual(['dana@example.net', 'noc@example.net']);
      expect(smtp.received.at(-1)?.data).toContain('Not during the freeze');
    });

    it("a launch configuration's runs tell as it says: only failures, or every end", async () => {
      await db().deleteFrom('launch_config').where('id', '=', 'c-notify').execute();
      const now = new Date().toISOString();
      await db()
        .insertInto('launch_config')
        .values({
          id: 'c-notify',
          project_id: project,
          name: 'Upgrade',
          description: null,
          flow_file: 'flows/upgrade.flow.yaml',
          git_ref: null,
          commit_id: null,
          inventory: null,
          ee_image: null,
          mode: 'real',
          run_limit: null,
          inputs_json: '{}',
          notify_json: JSON.stringify({ when: 'failed', to: ['NOC'] }),
          created_at: now,
          updated_at: now,
        })
        .execute();
      const finishOne = async (outcome: 'succeeded' | 'failed') => {
        const run = await launch('dana');
        let job = await queue.claim('w1');
        while (job && job.run.id !== run.id) job = await queue.claim('w1');
        if (!job) throw new Error('not claimed');
        await queue.finish(
          run.id,
          job.token,
          outcome,
          outcome === 'failed' ? 'fw-edge-01 failed' : undefined,
        );
        await notifier.idle();
        return run;
      };
      const mails = smtp.received.length;
      await finishOne('succeeded');
      expect(sentTo(mails)).toEqual([]);
      await finishOne('failed');
      expect(sentTo(mails)).toEqual(['noc@example.net']);
      expect(smtp.received.at(-1)?.data).toContain('fw-edge-01 failed');

      // Every end: a run stopped while queued tells too.
      await db()
        .updateTable('launch_config')
        .set({ notify_json: JSON.stringify({ when: 'ended', to: ['dana'] }) })
        .where('id', '=', 'c-notify')
        .execute();
      const stopped = await launch('dana');
      await queue.cancel(stopped.id, 'dana');
      await notifier.idle();
      expect(sentTo(mails)).toEqual(['noc@example.net', 'dana@example.net']);
      expect(smtp.received.at(-1)?.data).toContain('cancelled');
    });

    it('the certificate: administrators are told at each step once, whatever restarts between', async () => {
      const info = (daysLeft: number): CertificateInfo => ({
        subject: 'CN=flows.example.net',
        issuer: 'CN=flows.example.net',
        names: ['flows.example.net'],
        notBefore: '2026-01-01T00:00:00.000Z',
        notAfter: '2026-12-03T00:00:00.000Z',
        daysLeft,
        selfSigned: true,
        fingerprint: `AB:CD:${name}`,
        chain: 0,
      });
      const mails = smtp.received.length;
      notifier.certificate(info(45));
      notifier.certificate(info(20));
      notifier.certificate(info(19));
      await notifier.idle();
      expect(sentTo(mails)).toEqual(['dana@example.net']);
      notifier.certificate(info(6));
      await notifier.idle();
      expect(sentTo(mails)).toEqual(['dana@example.net', 'dana@example.net']);
      expect(smtp.received.at(-1)?.data).toContain('expires in 6 days');
    });

    it('the outbox: one server takes a message; failures are tried again later, then given up on', async () => {
      const [id] = await enqueue(db(), { kind: 'test', message: MESSAGE }, [
        { channel: 'webhook', recipient: 'x', target: `${receiver.url}/busy` },
      ]);
      const t0 = new Date(Date.now() + 1000);
      const [first, second] = await Promise.all([takeDue(db(), 20, t0), takeDue(db(), 20, t0)]);
      const takers = [first, second].filter((t) => t?.some((x) => x.id === id));
      expect(takers.length).toBe(1);
      const taken = takers[0]?.find((x) => x.id === id) as { id: string; attempts: number };
      expect(await markFailed(db(), taken, 'HTTP 503', true, t0)).toBe('retry');
      const pending = (await listDeliveries(db(), { status: 'pending' })).find((d) => d.id === id);
      expect(Date.parse(pending?.nextAt ?? '') - t0.getTime()).toBe(60_000);
      expect(
        await markFailed(db(), { id: taken.id, attempts: MAX_ATTEMPTS }, 'HTTP 503', true, t0),
      ).toBe('failed');
      expect(await retryNow(db(), id as string)).toBe(true);
      expect((await listDeliveries(db(), { status: 'pending' })).some((d) => d.id === id)).toBe(
        true,
      );
      await db()
        .deleteFrom('notification')
        .where('id', '=', id as string)
        .execute();
    });

    describe('over HTTP', () => {
      let admin: string;
      let member: string;
      let adminToken: string;
      beforeAll(async () => {
        const signIn = async (login: string) => {
          const reply = await app.inject({
            method: 'POST',
            url: '/api/v1/session',
            payload: { login, password: PASSWORD },
          });
          return (
            /afs_session=[^;]*/.exec([reply.headers['set-cookie']].flat().join(';'))?.[0] ?? ''
          );
        };
        admin = await signIn('dana');
        member = await signIn('omar');
        adminToken = (await createToken(db(), ids.dana as string, { name: 't' })).token;
      });

      it('administrators only: the settings never show the password; changing them needs a session', async () => {
        expect(
          (await app.inject({ url: '/api/v1/notifications', headers: { cookie: member } }))
            .statusCode,
        ).toBe(403);
        const set = await app.inject({
          method: 'PUT',
          url: '/api/v1/notifications/smtp',
          headers: { cookie: admin },
          payload: {
            host: '127.0.0.1',
            port: smtp.port,
            security: 'none',
            user: 'relay',
            password: 'relay-password-2',
            from: 'flows@example.net',
          },
        });
        expect(set.statusCode).toBe(200);
        expect(set.json().smtp).toMatchObject({ host: '127.0.0.1', hasPassword: true });
        expect(set.body).not.toContain('relay-password');
        const entry = (await listAudit(db(), { action: 'notification' })).entries[0];
        expect(entry?.action).toBe('notification.smtp-set');
        expect(JSON.stringify(entry)).not.toContain('relay-password');
        expect(
          (
            await app.inject({
              method: 'PUT',
              url: '/api/v1/notifications/smtp',
              headers: { authorization: `Bearer ${adminToken}` },
              payload: { host: 'mail.example.net', from: 'flows@example.net' },
            })
          ).statusCode,
        ).toBe(403);
        const bad = await app.inject({
          method: 'PUT',
          url: '/api/v1/notifications/smtp',
          headers: { cookie: admin },
          payload: { host: 'mail.example.net', from: 'not an address' },
        });
        expect(bad.json()).toMatchObject({ error: 'invalid', field: 'from' });
      });

      it('a webhook key is shown once; a test goes out at once and says how it went', async () => {
        const made = await app.inject({
          method: 'POST',
          url: '/api/v1/notifications/webhook-key',
          headers: { cookie: admin },
        });
        expect(made.statusCode).toBe(201);
        const shared = made.json().key as string;
        expect(shared).toMatch(/^afs_whk_/);
        const settings = await app.inject({
          url: '/api/v1/notifications/settings',
          headers: { cookie: admin },
        });
        expect(settings.json()).toMatchObject({ webhookKey: true });
        expect(settings.body).not.toContain(shared);

        const calls = receiver.got.length;
        const test = await app.inject({
          method: 'POST',
          url: '/api/v1/notifications/test',
          headers: { cookie: admin },
          payload: { channel: 'webhook', to: `${receiver.url}/ok/test-secret` },
        });
        expect(test.json()).toMatchObject({ status: 'sent', event: 'test' });
        // The log shows the address without its path: it can be the webhook's secret.
        expect(test.json().target).toBe(`${receiver.url}/…`);
        const hit = receiver.got[calls];
        const expected = createHmac('sha256', shared)
          .update(`${hit?.headers['x-afs-timestamp']}.${hit?.body}`)
          .digest('hex');
        expect(hit?.headers['x-afs-signature']).toBe(`sha256=${expected}`);

        // To the administrator's own address when none is given.
        const mails = smtp.received.length;
        const mine = await app.inject({
          method: 'POST',
          url: '/api/v1/notifications/test',
          headers: { cookie: admin },
          payload: { channel: 'email' },
        });
        expect(mine.json()).toMatchObject({ status: 'sent', target: 'dana@example.net' });
        expect(sentTo(mails)).toEqual(['dana@example.net']);

        const log = await app.inject({
          url: '/api/v1/notifications?event=test',
          headers: { cookie: admin },
        });
        expect(log.json().length).toBeGreaterThanOrEqual(2);
        expect(log.body).not.toContain('test-secret');
      });
    });

    it('a new master key seals again what was sealed: the relay password, runs, the webhook key', async () => {
      const run = await launch('dana', { api_password: 'hunter2-sealed' });
      const next = keyOf();
      const before = await webhookKey(db(), key);
      await rotate(db(), key, next);
      expect((await smtpForSending(db(), next))?.password).toBe('relay-password-2');
      expect(await webhookKey(db(), next)).toBe(before);
      const again = await new RunQueue(db(), database.kind, next).relaunch(run.id, {
        id: ids.dana as string,
        login: 'dana',
      });
      expect(again?.state).toBe('queued');
      await rotate(db(), next, key);
    });
  });
}
