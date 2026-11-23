// Credentials over HTTP. A secret goes in and does not come out: every answer is the
// credential without its secret part. Until access levels exist (AFS-27): everyone signed in
// sees which credentials a workspace has, administrators make and change them.
//   /api/v1/workspaces/:id/credentials     :id is the workspace's id or its key
//   /api/v1/credentials/:id
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { accessOf } from '../access/grants';
import { changedKeys } from '../audit/changes';
import { administrator, signedIn } from '../auth/guards';
import type { Schema } from '../db/schema';
import { getWorkspace } from '../projects/store';
import {
  type CredentialChange,
  CredentialError,
  type CredentialInput,
  createCredential,
  credentialUses,
  deleteCredential,
  getCredential,
  KINDS,
  listCredentials,
  shownRefs,
  updateCredential,
} from './credentials';
import { SealError } from './crypto';
import type { MasterKey } from './masterKey';
import { REF } from './providers/routes';

export interface SecretDeps {
  db: Kysely<Schema>;
  key: MasterKey;
}

const STATUS: Record<CredentialError['code'], number> = {
  invalid: 400,
  not_found: 404,
  taken: 409,
  in_use: 409,
};
const text = (max: number, min = 0) => ({ type: 'string', minLength: min, maxLength: max });
/** Text by name: the names are checked by the store, which knows the kind. */
const map = (max: number) => ({
  type: 'object',
  maxProperties: 120,
  additionalProperties: { type: 'string', maxLength: max },
});
const ID = { params: { type: 'object', properties: { id: text(64, 1) }, required: ['id'] } };
const NONE = { error: 'not_found', message: 'No such credential' };
/** AFS-241: the secret parts taken from a provider, by name. */
const REFS = { type: 'object', maxProperties: 120, additionalProperties: REF };
/** A request with a secret in it is small: the largest is a private key. */
const BODY_LIMIT = 256 * 1024;

export function registerCredentials(app: FastifyInstance, deps: SecretDeps): void {
  const { db, key } = deps;
  const answering =
    <R extends FastifyRequest>(handler: (request: R, reply: FastifyReply) => Promise<unknown>) =>
    async (request: R, reply: FastifyReply) => {
      try {
        return await handler(request, reply);
      } catch (e) {
        if (e instanceof CredentialError)
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

  app.get<WithId>('/api/v1/workspaces/:id/credentials', { schema: ID }, async (request, reply) => {
    const me = signedIn(request, reply);
    if (!me) return reply;
    const workspace = await getWorkspace(db, request.params.id);
    if (!workspace)
      return reply.code(404).send({ error: 'not_found', message: 'No such workspace' });
    // AFS-241: a reference's path is for the workspace's administrators, who fix a broken one.
    const paths = me.admin || (await accessOf(db, request))?.onWorkspace(workspace.id) === 'rw';
    const list = await shownRefs(db, await listCredentials(db, workspace.id), paths);
    if (!me.admin) return list;
    // AFS-150: an administrator (who may delete one) is told what uses each, by name.
    const uses = await credentialUses(db, workspace.id);
    return list.map((c) => (uses.has(c.id) ? { ...c, uses: uses.get(c.id) } : c));
  });

  app.post<WithId & { Body: CredentialInput }>(
    '/api/v1/workspaces/:id/credentials',
    {
      bodyLimit: BODY_LIMIT,
      schema: {
        ...ID,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'kind', 'secret'],
          properties: {
            name: text(100, 1),
            kind: { type: 'string', enum: [...KINDS] },
            description: text(1000),
            fields: map(500),
            secret: map(64 * 1024),
            refs: REFS,
          },
        },
      },
    },
    answering(async (request, reply) => {
      const me = administrator(request, reply);
      if (!me) return reply;
      const workspace = await getWorkspace(db, request.params.id);
      if (!workspace)
        return reply.code(404).send({ error: 'not_found', message: 'No such workspace' });
      const made = (
        await shownRefs(db, [await createCredential(db, key, workspace.id, request.body)], true)
      )[0] as NonNullable<Awaited<ReturnType<typeof getCredential>>>;
      request.log.info(
        { by: me.login, workspace: workspace.key, credential: made.name, kind: made.kind },
        'Credential added',
      );
      return reply.code(201).send(made);
    }),
  );

  app.get<WithId>('/api/v1/credentials/:id', { schema: ID }, async (request, reply) => {
    const me = signedIn(request, reply);
    if (!me) return reply;
    const found = await getCredential(db, request.params.id);
    if (!found) return reply.code(404).send(NONE);
    const paths = me.admin || (await accessOf(db, request))?.onWorkspace(found.workspace) === 'rw';
    return (await shownRefs(db, [found], paths))[0];
  });

  app.patch<WithId & { Body: CredentialChange }>(
    '/api/v1/credentials/:id',
    {
      bodyLimit: BODY_LIMIT,
      schema: {
        ...ID,
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: text(100, 1),
            description: { type: ['string', 'null'], maxLength: 1000 },
            fields: map(500),
            secret: map(64 * 1024),
            refs: { ...REFS, type: ['object', 'null'] },
          },
        },
      },
    },
    answering(async (request, reply) => {
      const me = administrator(request, reply);
      if (!me) return reply;
      const before = await getCredential(db, request.params.id);
      const changed = (
        await shownRefs(
          db,
          [await updateCredential(db, key, request.params.id, request.body)],
          true,
        )
      )[0] as NonNullable<Awaited<ReturnType<typeof getCredential>>>;
      // AFS-153: the fields whose values changed; a secret sent is a new secret (it is never
      // read back to compare).
      const { secret, refs, ...open } = request.body;
      request.auditDetail = {
        changed: [
          ...changedKeys(open, before, changed),
          ...(secret && Object.keys(secret).length ? ['secret'] : []),
          // AFS-241: that its references changed, not where they point.
          ...(refs !== undefined ? ['refs'] : []),
        ],
      };
      request.log.info(
        {
          by: me.login,
          credential: changed.name,
          // What was changed, never to what.
          changed: Object.keys(request.body),
        },
        'Credential changed',
      );
      return changed;
    }),
  );

  app.delete<WithId>(
    '/api/v1/credentials/:id',
    { schema: ID },
    answering(async (request, reply) => {
      const me = administrator(request, reply);
      if (!me) return reply;
      const credential = await getCredential(db, request.params.id);
      if (!credential) return reply.code(404).send(NONE);
      await deleteCredential(db, credential.id);
      request.log.info({ by: me.login, credential: credential.name }, 'Credential deleted');
      return reply.code(204).send();
    }),
  );
}
