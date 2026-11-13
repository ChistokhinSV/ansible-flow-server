// Every request that changes something leaves an entry in the audit log, done here once for all
// routes: the route says nothing, this file's list of actions names what each one does. A
// changing route missing from the list is found by a test (test/unit/audit.test.ts), so a new
// endpoint cannot go unrecorded. And the log is read here: a page of it, or an export.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { administrator } from '../auth/guards';
import type { Schema } from '../db/schema';
import {
  type AuditEntry,
  type AuditFilter,
  type AuditResult,
  type AuditSource,
  auditCsv,
  listAudit,
  RESULTS,
  recordAudit,
  SOURCES,
} from './store';

interface Action {
  action: string;
  /** Where the object's id is: a parameter of the route, the reply (a thing made), or the actor. */
  id: { param: string } | 'reply' | 'actor' | 'none';
  /** The route's `:id` names the parent of a thing made (a project's workspace). */
  parent?: string;
  /** The route records what it did itself (it knows more); here only its refusals. */
  self?: boolean;
}

const at = (param = 'id') => ({ param });
/** What each changing route does, by method and route. */
export const ACTIONS: Record<string, Action> = {
  'POST /api/v1/setup': { action: 'user.setup', id: 'reply' },
  'POST /api/v1/session': { action: 'session.sign-in', id: 'reply' },
  'DELETE /api/v1/session': { action: 'session.sign-out', id: 'actor' },
  'PUT /api/v1/session/password': { action: 'user.password-change', id: 'actor' },
  'POST /api/v1/tokens': { action: 'token.create', id: 'reply' },
  'DELETE /api/v1/tokens/:id': { action: 'token.revoke', id: at() },
  'DELETE /api/v1/users/:id/tokens/:token': { action: 'token.revoke', id: at('token') },
  'POST /api/v1/users': { action: 'user.create', id: 'reply' },
  'PATCH /api/v1/users/:id': { action: 'user.change', id: at() },
  'PUT /api/v1/users/:id/password': { action: 'user.password-set', id: at() },
  'DELETE /api/v1/users/:id': { action: 'user.delete', id: at() },
  'POST /api/v1/groups': { action: 'group.create', id: 'reply' },
  'PATCH /api/v1/groups/:id': { action: 'group.change', id: at() },
  'PUT /api/v1/groups/:id/members': { action: 'group.members', id: at() },
  'DELETE /api/v1/groups/:id': { action: 'group.delete', id: at() },
  'POST /api/v1/workspaces': { action: 'workspace.create', id: 'reply' },
  'PATCH /api/v1/workspaces/:id': { action: 'workspace.change', id: at() },
  'DELETE /api/v1/workspaces/:id': { action: 'workspace.delete', id: at() },
  'POST /api/v1/workspaces/:id/projects': {
    action: 'project.create',
    id: 'reply',
    parent: 'workspace',
  },
  'PATCH /api/v1/projects/:id': { action: 'project.change', id: at() },
  'DELETE /api/v1/projects/:id': { action: 'project.delete', id: at() },
  'POST /api/v1/projects/:id/sync': { action: 'project.sync', id: at() },
  'POST /api/v1/projects/:id/hook': { action: 'project.hook-set', id: at() },
  'DELETE /api/v1/projects/:id/hook': { action: 'project.hook-remove', id: at() },
  'POST /api/v1/hooks/projects/:id/push': { action: 'project.hook-push', id: at() },
  'POST /api/v1/workspaces/:id/credentials': {
    action: 'credential.create',
    id: 'reply',
    parent: 'workspace',
  },
  'PATCH /api/v1/credentials/:id': { action: 'credential.change', id: at() },
  'DELETE /api/v1/credentials/:id': { action: 'credential.delete', id: at() },
  'POST /api/v1/projects/:id/launch-configs': {
    action: 'launch-config.create',
    id: 'reply',
    parent: 'project',
  },
  'PATCH /api/v1/launch-configs/:id': { action: 'launch-config.change', id: at() },
  'DELETE /api/v1/launch-configs/:id': { action: 'launch-config.delete', id: at() },
  'POST /api/v1/launch-configs/:id/launch': {
    action: 'run.launch',
    id: 'reply',
    parent: 'launch-config',
  },
  'POST /api/v1/runs/:id/cancel': { action: 'run.stop', id: at() },
  'POST /api/v1/runs/:id/relaunch': { action: 'run.relaunch', id: at() },
  'POST /git/:workspace/:repo/git-receive-pack': { action: 'git.push', id: 'none', self: true },
};

/** Routes that are POSTs but change nothing. */
export const READS = new Set([
  'POST /api/v1/launch-configs/:id/check',
  'POST /git/:workspace/:repo/git-upload-pack',
]);

const CHANGES = ['POST', 'PUT', 'PATCH', 'DELETE'];
const typeOf = (action: string) => action.slice(0, action.indexOf('.'));

/** Where an object's name is, to name it in the entry: what is deleted cannot be asked later. */
async function nameOf(db: Kysely<Schema>, type: string, id: string): Promise<string | undefined> {
  const one = async (query: Promise<{ n: string | number } | undefined>) =>
    (await query.catch(() => undefined))?.n?.toString();
  switch (type) {
    case 'user':
      return one(
        db.selectFrom('user_account').select('login as n').where('id', '=', id).executeTakeFirst(),
      );
    case 'group':
      return one(
        db.selectFrom('user_group').select('name as n').where('id', '=', id).executeTakeFirst(),
      );
    case 'token':
      return one(
        db.selectFrom('api_token').select('name as n').where('id', '=', id).executeTakeFirst(),
      );
    case 'workspace':
      return one(
        db
          .selectFrom('workspace')
          .select('key as n')
          .where((eb) => eb.or([eb('id', '=', id), eb('key', '=', id)]))
          .executeTakeFirst(),
      );
    case 'project': {
      const project = await db
        .selectFrom('project')
        .innerJoin('workspace', 'workspace.id', 'project.workspace_id')
        .select(['workspace.key as workspace', 'project.key as project'])
        .where('project.id', '=', id)
        .executeTakeFirst()
        .catch(() => undefined);
      return project ? `${project.workspace}/${project.project}` : undefined;
    }
    case 'credential':
      return one(
        db.selectFrom('credential').select('name as n').where('id', '=', id).executeTakeFirst(),
      );
    case 'launch-config':
      return one(
        db.selectFrom('launch_config').select('name as n').where('id', '=', id).executeTakeFirst(),
      );
    case 'run': {
      const run = await db
        .selectFrom('run')
        .select('number')
        .where('id', '=', id)
        .executeTakeFirst()
        .catch(() => undefined);
      return run ? `#${run.number}` : undefined;
    }
    default:
      return undefined;
  }
}

/** The name a thing made goes by, from the reply that made it. */
function nameInReply(reply: Record<string, unknown>): string | undefined {
  for (const key of ['login', 'key', 'name'])
    if (typeof reply[key] === 'string') return reply[key] as string;
  return typeof reply.number === 'number' ? `#${reply.number}` : undefined;
}

/**
 * What a request said, without what it said it with: the fields a change named, and the yes/no
 * and number values (a flag, a count of days), never text, which may be a secret.
 */
function detailOfBody(method: string, body: unknown): Record<string, unknown> {
  // Only a JSON object: a git push's body is a stream.
  if (!body || typeof body !== 'object' || Object.getPrototypeOf(body) !== Object.prototype)
    return {};
  const detail: Record<string, unknown> = {};
  if (method === 'PATCH' || method === 'PUT') detail.changed = Object.keys(body);
  for (const [key, value] of Object.entries(body))
    if (typeof value === 'boolean' || typeof value === 'number') detail[key] = value;
  return detail;
}

/** Where a request came from: the pages, a script or tool with a token, or git. */
function sourceOf(request: FastifyRequest): AuditSource {
  if (request.url.startsWith('/git/')) return 'git';
  if (request.user?.token) return 'api';
  if (request.user) return 'ui';
  // Nobody signed in yet (a sign-in): browsers say where a request comes from; scripts do not
  // (Node's fetch says its mode, but not its site).
  return request.headers['sec-fetch-site'] ? 'ui' : 'api';
}

const resultOf = (status: number): AuditResult =>
  status < 400 ? 'ok' : [401, 403, 429].includes(status) ? 'refused' : 'failed';

declare module 'fastify' {
  interface FastifyRequest {
    /** The name of the object a change is about, read before the change. */
    auditName?: string;
  }
}

export interface AuditDeps {
  db: Kysely<Schema>;
}

export function registerAudit(app: FastifyInstance, deps: AuditDeps): void {
  const { db } = deps;
  // A route that changes something and is not in the list cannot be added: the server would
  // do it without a word in the log.
  app.addHook('onRoute', (route) => {
    for (const method of [route.method].flat()) {
      const key = `${method} ${route.url}`;
      const own = route.url.startsWith('/api/') || route.url.startsWith('/git/');
      if (own && CHANGES.includes(method) && !ACTIONS[key] && !READS.has(key))
        throw new Error(`${key} changes something, and audit/routes.ts names no action for it`);
    }
  });
  const actionOf = (request: FastifyRequest): Action | undefined => {
    const route = request.routeOptions.url;
    // git asks whether it may push before it sends anything: a refusal comes at that question.
    if (
      route === '/git/:workspace/:repo/info/refs' &&
      (request.query as { service?: string }).service === 'git-receive-pack'
    )
      return ACTIONS['POST /git/:workspace/:repo/git-receive-pack'];
    if (!route || !CHANGES.includes(request.method)) return undefined;
    return ACTIONS[`${request.method} ${route}`];
  };

  app.addHook('preHandler', async (request) => {
    const spec = actionOf(request);
    if (!spec || typeof spec.id !== 'object') return;
    const id = (request.params as Record<string, string>)[spec.id.param];
    if (id) request.auditName = await nameOf(db, typeOf(spec.action), id);
  });

  app.addHook('onSend', async (request, reply, payload) => {
    const spec = actionOf(request);
    if (!spec) return payload;
    const status = reply.statusCode;
    if (spec.self && status < 400) return payload;
    // Someone who did not even say who they are and was told to: not worth an entry each
    // time (git asks so before every push). A sign-in's credentials are in its body.
    const credentials = !!request.user || !!request.headers.authorization;
    const signingIn = spec.action === 'session.sign-in' || spec.action === 'user.setup';
    if (status === 401 && !credentials && !signingIn) return payload;

    let answer: Record<string, unknown> = {};
    if (typeof payload === 'string' && payload.startsWith('{'))
      try {
        answer = JSON.parse(payload);
      } catch {}
    const params = request.params as Record<string, string>;
    const type = typeOf(spec.action);
    const result = resultOf(status);
    const detail = detailOfBody(request.method, request.body);
    if (spec.parent && params.id) detail[spec.parent] = params.id;
    if (result !== 'ok' && typeof answer.error === 'string') detail.error = answer.error;

    let actor: AuditEntry['actor'] = request.user
      ? { id: request.user.id, login: request.user.login }
      : null;
    let object: AuditEntry['object'] = { type };
    if (spec.id === 'reply' && status < 400 && typeof answer.id === 'string')
      // Named as it will be on its later changes (a project with its workspace).
      object = {
        type,
        id: answer.id,
        ...withName((await nameOf(db, type, answer.id)) ?? nameInReply(answer)),
      };
    else if (typeof spec.id === 'object' && params[spec.id.param])
      object = { type, id: params[spec.id.param], ...withName(request.auditName) };
    else if (spec.id === 'actor' && actor)
      object = { type, id: actor.id ?? undefined, name: actor.login };
    if (signingIn) {
      // The one who signed in, from the reply; a refused one only by the login tried.
      if (status < 400 && typeof answer.id === 'string' && typeof answer.login === 'string')
        actor = { id: answer.id, login: answer.login };
      else {
        const tried = (request.body as { login?: unknown } | undefined)?.login;
        if (typeof tried === 'string') detail.login = tried.slice(0, 64).toLowerCase();
      }
    }
    if (spec.action === 'run.relaunch' && typeof answer.id === 'string') detail.run = answer.id;
    if (spec.self)
      object = {
        type: 'project',
        name: `${params.workspace}/${params.repo?.replace(/\.git$/, '')}`,
      };

    try {
      await recordAudit(db, {
        actor,
        ...(request.user?.token ? { token: request.user.token.id } : {}),
        source: sourceOf(request),
        action: spec.action,
        object,
        result,
        status,
        ip: request.ip,
        request: request.id,
        detail,
      });
    } catch (e) {
      // What was done is done; the missing entry is said loudly in the server's log.
      request.log.error({ err: e, action: spec.action }, 'The audit entry was not written');
    }
    return payload;
  });

  // --- reading the log

  const FILTER = {
    type: 'object',
    additionalProperties: false,
    properties: {
      actor: { type: 'string', maxLength: 64 },
      action: { type: 'string', maxLength: 64, pattern: '^[a-z][a-z.-]*$' },
      objectType: { type: 'string', maxLength: 32 },
      objectId: { type: 'string', maxLength: 64 },
      result: { type: 'string', enum: [...RESULTS] },
      source: { type: 'string', enum: [...SOURCES] },
      from: { type: 'string', maxLength: 40 },
      to: { type: 'string', maxLength: 40 },
      before: { type: 'string', maxLength: 120 },
      limit: { type: 'integer', minimum: 1, maximum: 1000 },
    },
  } as const;
  type Query = Omit<AuditFilter, 'limit'> & { limit?: number; format?: 'csv' | 'json' };

  /** The filter of a request; a time that is not one is refused, with which. */
  const filterOf = (query: Query, reply: FastifyReply): AuditFilter | undefined => {
    const filter: AuditFilter = { ...query };
    for (const key of ['from', 'to'] as const) {
      const text = query[key];
      if (!text) continue;
      const time = Date.parse(text);
      if (Number.isNaN(time)) {
        reply.code(400).send({ error: 'invalid', message: `${key} is not a time: ${text}` });
        return undefined;
      }
      filter[key] = new Date(time).toISOString();
    }
    return filter;
  };

  app.get<{ Querystring: Query }>(
    '/api/v1/audit',
    { schema: { querystring: FILTER } },
    async (request, reply) => {
      if (!administrator(request, reply)) return reply;
      const filter = filterOf(request.query, reply);
      return filter ? listAudit(db, filter) : reply;
    },
  );

  app.get<{ Querystring: Query }>(
    '/api/v1/audit/export',
    {
      schema: {
        querystring: {
          ...FILTER,
          properties: {
            ...FILTER.properties,
            format: { type: 'string', enum: ['csv', 'json'] },
            limit: { type: 'integer', minimum: 1, maximum: 50_000 },
          },
        },
      },
    },
    async (request, reply) => {
      const me = administrator(request, reply);
      if (!me) return reply;
      const { format = 'csv', ...query } = request.query;
      const filter = filterOf(query, reply);
      if (!filter) return reply;
      const { entries } = await listAudit(db, { ...filter, limit: filter.limit ?? 50_000 });
      // Who took a copy of the log is in the log.
      await recordAudit(db, {
        actor: { id: me.id, login: me.login },
        ...(me.token ? { token: me.token.id } : {}),
        source: sourceOf(request),
        action: 'audit.export',
        object: { type: 'audit' },
        result: 'ok',
        status: 200,
        ip: request.ip,
        request: request.id,
        detail: { format, entries: entries.length, ...without(query, ['limit']) },
      });
      const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
      reply.header('content-disposition', `attachment; filename="audit-${stamp}.${format}"`);
      if (format === 'json') return reply.type('application/json').send(JSON.stringify(entries));
      return reply.type('text/csv; charset=utf-8').send(auditCsv(entries));
    },
  );
}

const withName = (name: string | undefined) => (name ? { name } : {});
const without = (o: Record<string, unknown>, keys: string[]) =>
  Object.fromEntries(Object.entries(o).filter(([k, v]) => !keys.includes(k) && v !== undefined));
