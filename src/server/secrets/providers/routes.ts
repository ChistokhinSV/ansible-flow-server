// Secret providers over HTTP (AFS-241). Administrators keep the list; a secret part goes in and
// does not come out. The credential form lists the providers open to a workspace and tests a
// reference (whether it can be read, never the value).
//   /api/v1/admin/secret-providers[/:id[/test]]
//   /api/v1/workspaces/:id/secret-providers        the choices for a credential form
//   /api/v1/workspaces/:id/secret-refs/test        Test read of a reference not saved yet
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { administrator, inSession } from '../../auth/guards';
import type { Schema } from '../../db/schema';
import { getWorkspace } from '../../projects/store';
import { testRef } from '../credentials';
import { SealError } from '../crypto';
import type { MasterKey } from '../masterKey';
import { clientOf } from './clients';
import { SecretReadError } from './http';
import {
  connectionOf,
  createSecretProvider,
  deleteSecretProvider,
  getSecretProvider,
  listSecretProviders,
  ProviderStoreError,
  providersFor,
  providerUses,
  updateSecretProvider,
} from './store';
import {
  PROVIDER_KINDS,
  type ProviderChoice,
  refProblem,
  type SecretProviderInput,
  type SecretRef,
} from './types';

const text = (max: number, min = 0) => ({ type: 'string', minLength: min, maxLength: max });
const ID = { params: { type: 'object', properties: { id: text(64, 1) }, required: ['id'] } };
const STATUS: Record<ProviderStoreError['code'], number> = {
  invalid: 400,
  not_found: 404,
  taken: 409,
  in_use: 409,
};
const SETTINGS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    address: text(500),
    ca: text(64 * 1024),
    timeoutS: { type: 'integer', minimum: 1, maximum: 120 },
    auth: { type: 'string', enum: ['approle', 'token'] },
    authMount: text(200),
    namespace: text(200),
    kvMount: text(200),
    account: text(200),
    login: text(300),
    appId: text(200),
    clientCert: text(64 * 1024),
    region: text(40),
  },
};
const SECRET = {
  type: 'object',
  maxProperties: 10,
  additionalProperties: { type: 'string', maxLength: 64 * 1024 },
};
const PROVIDER = {
  key: text(40, 1),
  name: text(100, 1),
  kind: { type: 'string', enum: [...PROVIDER_KINDS] },
  settings: SETTINGS,
  secret: SECRET,
  workspaces: { type: 'array', maxItems: 500, items: text(64, 1) },
};
/** A reference: its provider and the kind's parts (checked by kind). */
export const REF = {
  type: 'object',
  required: ['provider'],
  maxProperties: 10,
  properties: { provider: text(40, 1) },
  additionalProperties: { type: 'string', maxLength: 500 },
};
const BODY_LIMIT = 256 * 1024;

export function registerSecretProviders(
  app: FastifyInstance,
  deps: { db: Kysely<Schema>; key: MasterKey },
): void {
  const { db, key } = deps;
  const answering =
    <R extends FastifyRequest>(handler: (request: R, reply: FastifyReply) => Promise<unknown>) =>
    async (request: R, reply: FastifyReply) => {
      try {
        return await handler(request, reply);
      } catch (e) {
        if (e instanceof ProviderStoreError)
          return reply
            .code(STATUS[e.code])
            .send({ error: e.code, message: e.message, ...(e.field ? { field: e.field } : {}) });
        if (e instanceof SealError) {
          request.log.error({ why: e.message }, 'A stored secret could not be opened');
          return reply.code(500).send({
            error: 'sealed',
            message: 'The stored secret cannot be opened with the server’s master key',
          });
        }
        throw e;
      }
    };
  type WithId = { Params: { id: string } };

  app.get('/api/v1/admin/secret-providers', async (request, reply) => {
    if (!administrator(request, reply)) return reply;
    return listSecretProviders(db);
  });

  app.post<{ Body: SecretProviderInput }>(
    '/api/v1/admin/secret-providers',
    {
      bodyLimit: BODY_LIMIT,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['key', 'name', 'kind', 'settings'],
          properties: PROVIDER,
        },
      },
    },
    answering(async (request, reply) => {
      const me = inSession(request, reply, true);
      if (!me) return reply;
      const made = await createSecretProvider(db, key, {
        ...request.body,
        workspaces: request.body.workspaces ?? [],
      });
      request.log.info(
        { by: me.login, provider: made.key, kind: made.kind },
        'Secret provider added',
      );
      return reply.code(201).send(made);
    }),
  );

  app.get<WithId>('/api/v1/admin/secret-providers/:id', { schema: ID }, async (request, reply) => {
    if (!administrator(request, reply)) return reply;
    const found = await getSecretProvider(db, request.params.id);
    if (!found)
      return reply.code(404).send({ error: 'not_found', message: 'No such secret provider' });
    // Which credentials read from it, by name (an administrator fixes them before a change).
    return { ...found, uses: await providerUses(db, found.key) };
  });

  app.patch<WithId & { Body: Partial<SecretProviderInput> }>(
    '/api/v1/admin/secret-providers/:id',
    {
      bodyLimit: BODY_LIMIT,
      schema: {
        ...ID,
        body: { type: 'object', additionalProperties: false, properties: PROVIDER },
      },
    },
    answering(async (request, reply) => {
      const me = inSession(request, reply, true);
      if (!me) return reply;
      const before = await getSecretProvider(db, request.params.id);
      if (!before)
        return reply.code(404).send({ error: 'not_found', message: 'No such secret provider' });
      const changed = await updateSecretProvider(db, key, before.id, request.body);
      const { secret, ...open } = request.body;
      request.auditDetail = {
        // What was changed, never to what: a new secret part is only said to be new.
        changed: [...Object.keys(open), ...(secret ? ['secret'] : [])],
      };
      request.log.info(
        { by: me.login, provider: changed.key, changed: Object.keys(request.body) },
        'Secret provider changed',
      );
      return changed;
    }),
  );

  app.delete<WithId>(
    '/api/v1/admin/secret-providers/:id',
    { schema: ID },
    answering(async (request, reply) => {
      const me = inSession(request, reply, true);
      if (!me) return reply;
      const gone = await deleteSecretProvider(db, request.params.id);
      request.log.info({ by: me.login, provider: gone.key }, 'Secret provider removed');
      return reply.code(204).send();
    }),
  );

  // Signs in (Vault, Conjur, AWS) or reaches the provider (CCP); with `ref`, reads it too. The
  // value is never in the answer.
  app.post<WithId & { Body: { ref?: Omit<SecretRef, 'provider'> } }>(
    '/api/v1/admin/secret-providers/:id/test',
    {
      schema: {
        ...ID,
        body: {
          type: ['object', 'null'],
          additionalProperties: false,
          properties: {
            ref: { type: 'object', maxProperties: 10, additionalProperties: text(500) },
          },
        },
      },
    },
    answering(async (request, reply) => {
      if (!administrator(request, reply)) return reply;
      const conn = await connectionOf(db, key, request.params.id);
      if (!conn)
        return reply.code(404).send({ error: 'not_found', message: 'No such secret provider' });
      const ref = request.body?.ref;
      const client = clientOf(conn);
      try {
        if (ref && Object.keys(ref).length) {
          // An administrator's test reads as the provider, whatever workspaces it is open to.
          const full = { ...ref, provider: conn.key } as SecretRef;
          const problem = refProblem(conn.kind, full);
          if (problem) return { ok: false, message: problem };
          await client.read(full);
          return { ok: true, message: 'Signed in and read the secret (the value is not shown)' };
        }
        return { ok: true, message: await client.test() };
      } catch (e) {
        if (!(e instanceof SecretReadError)) throw e;
        request.log.warn(
          {
            provider: conn.key,
            code: e.code,
            status: e.status,
            ...(e.detail ? { detail: e.detail } : {}),
          },
          'A secret provider test failed',
        );
        return { ok: false, message: e.message };
      } finally {
        await client.close();
      }
    }),
  );

  // The providers a workspace's credentials may read from: what the credential form offers.
  app.get<WithId>(
    '/api/v1/workspaces/:id/secret-providers',
    { schema: ID },
    async (request, reply) => {
      if (!administrator(request, reply)) return reply;
      const workspace = await getWorkspace(db, request.params.id);
      if (!workspace)
        return reply.code(404).send({ error: 'not_found', message: 'No such workspace' });
      const list: ProviderChoice[] = (await providersFor(db, workspace.id)).map((p) => ({
        key: p.key,
        name: p.name,
        kind: p.kind,
      }));
      return list;
    },
  );

  // Test read of a reference as a credential form holds it: whether it reads, never the value.
  app.post<WithId & { Body: { ref: SecretRef } }>(
    '/api/v1/workspaces/:id/secret-refs/test',
    {
      schema: {
        ...ID,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['ref'],
          properties: { ref: REF },
        },
      },
    },
    answering(async (request, reply) => {
      // Whoever may change credentials: administrators.
      if (!administrator(request, reply)) return reply;
      const workspace = await getWorkspace(db, request.params.id);
      if (!workspace)
        return reply.code(404).send({ error: 'not_found', message: 'No such workspace' });
      const tested = await testRef(db, key, workspace.id, request.body.ref, request.log);
      // Which provider and whether it read; never the path or the value.
      request.auditDetail = { provider: request.body.ref.provider, read: tested.ok };
      return tested;
    }),
  );
}
