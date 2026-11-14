// LDAP and Active Directory directories over HTTP (AFS-31), for administrators:
//   /api/v1/admin/ldap-directories[/:id]    list, add, change, remove
//   POST /api/v1/admin/ldap-directories/:id/test  {login?}: binds, and what it finds for a login
//   POST /api/v1/admin/ldap-directories/:id/sync  brings its people in step now
// Signing in is the password sign-in (auth/routes.ts): a login with no password here is tried
// against the directories.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import type { Schema } from '../../db/schema';
import type { MasterKey } from '../../secrets/masterKey';
import { administrator, inSession } from '../guards';
import {
  createDirectory,
  DirectoryError,
  type DirectoryInput,
  deleteDirectory,
  getDirectory,
  listDirectories,
  updateDirectory,
} from './directories';
import type { LdapSignIn } from './ldap';

const text = (max: number, min = 0) => ({ type: 'string', minLength: min, maxLength: max });
const orNull = (max: number) => ({ type: ['string', 'null'], maxLength: max });
const MAPPING = {
  type: 'object',
  additionalProperties: false,
  required: ['value'],
  properties: { value: text(500, 1), group: text(64, 1), admin: { type: 'boolean' } },
};
const DIRECTORY = {
  key: text(40, 1),
  name: text(100, 1),
  url: text(500, 1),
  startTls: { type: 'boolean' },
  bindDn: orNull(500),
  bindPassword: orNull(1000),
  userBase: text(500, 1),
  userFilter: text(1000, 1),
  idAttr: text(64, 1),
  loginAttr: text(64, 1),
  nameAttr: text(64, 1),
  emailAttr: text(64, 1),
  groupMode: { type: 'string', enum: ['memberof', 'search'] },
  groupBase: orNull(500),
  groupFilter: orNull(1000),
  adDisabled: { type: 'boolean' },
  syncMinutes: { type: 'integer', minimum: 0, maximum: 10080 },
  enabled: { type: 'boolean' },
  position: { type: 'integer', minimum: 0, maximum: 1000 },
  mappings: { type: 'array', maxItems: 200, items: MAPPING },
};
const ID = { params: { type: 'object', properties: { id: text(64, 1) }, required: ['id'] } };
const STATUS: Record<DirectoryError['code'], number> = { invalid: 400, not_found: 404, taken: 409 };

export function registerLdap(
  app: FastifyInstance,
  deps: { db: Kysely<Schema>; key: MasterKey; ldap: LdapSignIn },
): void {
  const { db } = deps;
  const answering =
    <R extends FastifyRequest>(handler: (request: R, reply: FastifyReply) => Promise<unknown>) =>
    async (request: R, reply: FastifyReply) => {
      try {
        return await handler(request, reply);
      } catch (e) {
        if (e instanceof DirectoryError)
          return reply
            .code(STATUS[e.code])
            .send({ error: e.code, message: e.message, ...(e.field ? { field: e.field } : {}) });
        throw e;
      }
    };

  app.get('/api/v1/admin/ldap-directories', async (request, reply) =>
    administrator(request, reply) ? listDirectories(db) : reply,
  );

  app.get<{ Params: { id: string } }>(
    '/api/v1/admin/ldap-directories/:id',
    { schema: ID },
    async (request, reply) => {
      if (!administrator(request, reply)) return reply;
      return (
        (await getDirectory(db, request.params.id)) ??
        reply.code(404).send({ error: 'not_found', message: 'No such directory' })
      );
    },
  );

  // Who may sign in, and who becomes an administrator, is decided here: a session, not a token.
  app.post<{ Body: DirectoryInput }>(
    '/api/v1/admin/ldap-directories',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['key', 'name', 'url', 'userBase'],
          properties: DIRECTORY,
        },
      },
    },
    answering(async (request, reply) => {
      if (!inSession(request, reply, true)) return reply;
      return reply.code(201).send(await createDirectory(db, deps.key, request.body));
    }),
  );

  app.patch<{ Params: { id: string }; Body: Partial<DirectoryInput> }>(
    '/api/v1/admin/ldap-directories/:id',
    {
      schema: {
        ...ID,
        body: { type: 'object', additionalProperties: false, properties: DIRECTORY },
      },
    },
    answering(async (request, reply) => {
      if (!inSession(request, reply, true)) return reply;
      return updateDirectory(db, deps.key, request.params.id, request.body);
    }),
  );

  app.delete<{ Params: { id: string } }>(
    '/api/v1/admin/ldap-directories/:id',
    { schema: ID },
    answering(async (request, reply) => {
      if (!inSession(request, reply, true)) return reply;
      await deleteDirectory(db, request.params.id);
      return reply.code(204).send();
    }),
  );

  app.post<{ Params: { id: string }; Body: { login?: string } }>(
    '/api/v1/admin/ldap-directories/:id/test',
    {
      schema: {
        ...ID,
        body: { type: 'object', additionalProperties: false, properties: { login: text(256, 1) } },
      },
    },
    async (request, reply) => {
      if (!administrator(request, reply)) return reply;
      return deps.ldap.test(request.params.id, request.body?.login);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/v1/admin/ldap-directories/:id/sync',
    { schema: ID },
    async (request, reply) => {
      if (!inSession(request, reply, true)) return reply;
      if (!(await getDirectory(db, request.params.id)))
        return reply.code(404).send({ error: 'not_found', message: 'No such directory' });
      return deps.ldap.sync(request.params.id);
    },
  );
}
