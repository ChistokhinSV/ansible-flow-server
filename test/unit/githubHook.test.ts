// AFS-61: a push hook from GitHub, which signs the request's body with the hook's secret
// (X-Hub-Signature-256) instead of sending a token: the secret is kept sealed with the master key,
// the signature is checked over the body's bytes, and a wrong one gets the same answer as a wrong
// token, a project without a hook and no project.
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/server/app';
import { createUser } from '../../src/server/auth/users';
import { type Database, openDatabase } from '../../src/server/db/database';
import { migrate } from '../../src/server/db/migrations';
import { createLogger } from '../../src/server/log';
import { Git } from '../../src/server/projects/git';
import { getProject, hookSignatureMatches } from '../../src/server/projects/store';
import { ProjectSync } from '../../src/server/projects/sync';
import { rotate } from '../../src/server/secrets/credentials';
import { seal } from '../../src/server/secrets/crypto';
import { keyId, type MasterKey, newKey } from '../../src/server/secrets/masterKey';

const root = mkdtempSync(join(tmpdir(), 'afs-ghhook-'));
const PASSWORD = 'correct horse battery staple';
const make = (): MasterKey => {
  const bytes = newKey();
  return { key: bytes, id: keyId(bytes), source: 'env' };
};
const key = make();

let database: Database;
let app: FastifyInstance;
let sync: ProjectSync;
let cookie: string;
let projectId: string;
let secret: string;

const sign = (body: string | Buffer, with_ = secret) =>
  `sha256=${createHmac('sha256', with_).update(body).digest('hex')}`;
const hook = (
  id: string,
  body: string,
  headers: Record<string, string>,
  type = 'application/json',
) =>
  app.inject({
    method: 'POST',
    url: `/api/v1/hooks/projects/${id}/push`,
    headers: { 'content-type': type, ...headers },
    payload: body,
  });

beforeAll(async () => {
  database = openDatabase({ kind: 'sqlite', file: ':memory:' });
  await migrate(database.db as never);
  const log = createLogger({ level: 'error', format: 'json', write: () => undefined });
  const git = new Git({ reposDir: join(root, 'repos'), allowLocal: true });
  sync = new ProjectSync(database.db, git, log);
  app = buildApp({
    log,
    database,
    instance: 'test',
    masterKey: key,
    projects: { git, sync, allowLocal: true },
  });
  await createUser(database.db, { login: 'dana', name: 'Dana', password: PASSWORD, admin: true });
  const reply = await app.inject({
    method: 'POST',
    url: '/api/v1/session',
    payload: { login: 'dana', password: PASSWORD },
  });
  cookie = /afs_session=[^;]*/.exec([reply.headers['set-cookie']].flat().join(';'))?.[0] ?? '';
  await app.inject({
    method: 'POST',
    url: '/api/v1/workspaces',
    headers: { cookie },
    payload: { key: 'net', name: 'Network' },
  });
  projectId = (
    await app.inject({
      method: 'POST',
      url: '/api/v1/workspaces/net/projects',
      headers: { cookie },
      payload: { key: 'flows', name: 'Flows' },
    })
  ).json().id;
  const made = await app.inject({
    method: 'POST',
    url: `/api/v1/projects/${projectId}/hook`,
    headers: { cookie },
  });
  expect(made.json()).toMatchObject({ signature: 'X-Hub-Signature-256' });
  secret = made.json().token;
});
afterAll(async () => {
  // A hook starts a look at the repository; one may still be running.
  await sync.stop();
  await app.close();
  await database.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('GitHub push hooks', () => {
  // A body as GitHub sends it, its spacing kept: the signature is over these bytes.
  const body = '{"ref":"refs/heads/main",  "after":"9f2c1e7ab3d45c60e8a1f2b3c4d5e6f708192a3b"}';

  it('accepts a body signed with the hook secret, and answers the ping', async () => {
    expect((await getProject(database.db, projectId))?.hookSigned).toBe(true);
    const pushed = await hook(projectId, body, {
      'x-github-event': 'push',
      'x-hub-signature-256': sign(body),
    });
    expect(pushed.statusCode).toBe(202);
    const ping = await hook(projectId, '{"zen":"Keep it logically awesome."}', {
      'x-github-event': 'ping',
      'x-hub-signature-256': sign('{"zen":"Keep it logically awesome."}'),
    });
    expect(ping.json()).toEqual({ status: 'pong' });
    // A form-encoded hook is signed the same way.
    const form = 'payload=%7B%22ref%22%3A%22refs%2Fheads%2Fmain%22%7D';
    expect(
      (
        await hook(
          projectId,
          form,
          { 'x-hub-signature-256': sign(form) },
          'application/x-www-form-urlencoded',
        )
      ).statusCode,
    ).toBe(202);
    // A token in a header still works.
    expect((await hook(projectId, body, { 'x-gitlab-token': secret })).statusCode).toBe(202);
  });

  it('one answer for a wrong signature, another body, no hook and no project', async () => {
    const wrong = [
      await hook(projectId, body, { 'x-hub-signature-256': sign(body, 'not the secret') }),
      await hook(projectId, `${body} `, { 'x-hub-signature-256': sign(body) }),
      await hook(projectId, body, { 'x-hub-signature-256': 'sha256=short' }),
      await hook(projectId, body, { 'x-hub-signature-256': sign(body).replace('sha256', 'sha1') }),
      await hook('no-such-project', body, { 'x-hub-signature-256': sign(body) }),
      await hook(projectId, body, {}),
    ];
    for (const r of wrong) {
      expect(r.statusCode).toBe(401);
      expect(r.json()).toEqual({ error: 'unauthorized', message: 'The hook token is wrong' });
    }
  });

  it('keeps working after the master key is rotated; removing the hook ends it', async () => {
    const next = make();
    await rotate(database.db, key, next);
    expect(
      await hookSignatureMatches(database.db, next, projectId, Buffer.from(body), sign(body)),
    ).toBe(true);
    expect(
      await hookSignatureMatches(database.db, key, projectId, Buffer.from(body), sign(body)),
    ).toBe(false);
    await app.inject({
      method: 'DELETE',
      url: `/api/v1/projects/${projectId}/hook`,
      headers: { cookie },
    });
    expect(await getProject(database.db, projectId)).toMatchObject({
      hook: false,
      hookSigned: false,
    });
  });
});

describe("GitHub's own example", () => {
  it('checks the signature GitHub documents for its example secret and body', async () => {
    // From GitHub's "Validating webhook deliveries": secret "It's a Secret to Everybody", body
    // "Hello, World!".
    const db = database.db;
    await db
      .updateTable('project')
      .set({
        hook_secret_enc: seal(key, "It's a Secret to Everybody", `project-hook:${projectId}`),
      })
      .where('id', '=', projectId)
      .execute();
    expect(
      await hookSignatureMatches(
        db,
        key,
        projectId,
        Buffer.from('Hello, World!'),
        'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17',
      ),
    ).toBe(true);
  });
});
