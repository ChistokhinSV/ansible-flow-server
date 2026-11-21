// Every request that changes something leaves an entry in the audit log, done here once for all
// routes: the route says nothing, this file's list of actions names what each one does. A
// changing route missing from the list is found by a test (test/unit/audit.test.ts), so a new
// endpoint cannot go unrecorded. And the log is read here: a page of it, or an export.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { administrator } from '../auth/guards';
import type { Schema } from '../db/schema';
import { viaMcp } from '../mcp/mark';
import { auditRefs } from './refs';
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
  'PATCH /api/v1/session': { action: 'user.profile-change', id: 'actor' },
  'PUT /api/v1/session/password': { action: 'user.password-change', id: 'actor' },
  'POST /api/v1/tokens': { action: 'token.create', id: 'reply' },
  'DELETE /api/v1/tokens/:id': { action: 'token.revoke', id: at() },
  'DELETE /api/v1/users/:id/tokens/:token': { action: 'token.revoke', id: at('token') },
  'POST /api/v1/users/:id/tokens': { action: 'token.create', id: 'reply', parent: 'user' },
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
  'POST /api/v1/projects/:id/host-key/forget': { action: 'project.host-key-forget', id: at() },
  'POST /api/v1/projects/:id/start': { action: 'project.start', id: at() },
  'POST /api/v1/projects/:id/files': { action: 'project.files-save', id: at() },
  'POST /api/v1/drafts/:id/save': { action: 'draft.save', id: at() },
  'DELETE /api/v1/drafts/:id': { action: 'draft.discard', id: at() },
  'POST /api/v1/drafts/:id/start-from': { action: 'draft.start', id: at() },
  'POST /api/v1/projects/:id/branches': { action: 'project.branch-create', id: at() },
  'DELETE /api/v1/projects/:id/branches': { action: 'project.branch-delete', id: at() },
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
  'POST /api/v1/workspaces/:id/grants': {
    action: 'grant.create',
    id: 'reply',
    parent: 'workspace',
  },
  'DELETE /api/v1/grants/:id': { action: 'grant.delete', id: at() },
  'POST /api/v1/runs/:id/approvals/:node': { action: 'approval.decide', id: at() },
  'POST /api/v1/runs/:id/cancel': { action: 'run.stop', id: at() },
  'POST /api/v1/runs/:id/relaunch': { action: 'run.relaunch', id: at() },
  'POST /git/:workspace/:repo/git-receive-pack': { action: 'git.push', id: 'none', self: true },
  'POST /api/v1/projects/:id/dev-bundles': {
    action: 'dev-bundle.upload',
    id: 'reply',
    parent: 'project',
  },
  'POST /api/v1/notifications/:id/retry': { action: 'notification.retry', id: at() },
  'PUT /api/v1/notifications/smtp': { action: 'notification.smtp-set', id: 'none' },
  'DELETE /api/v1/notifications/smtp': { action: 'notification.smtp-clear', id: 'none' },
  'POST /api/v1/notifications/webhook-key': { action: 'notification.webhook-key', id: 'none' },
  'POST /api/v1/notifications/test': { action: 'notification.test', id: 'none' },
  'POST /api/v1/launch-configs/:id/environment': {
    action: 'environment.create',
    id: 'reply',
    parent: 'launch-config',
  },
  'POST /api/v1/workspaces/:id/environments': {
    action: 'environment.create',
    id: 'reply',
    parent: 'workspace',
  },
  'PATCH /api/v1/environments/:id': { action: 'environment.change', id: at() },
  'DELETE /api/v1/environments/:id': { action: 'environment.delete', id: at() },
  'POST /api/v1/environments/:id/builds': { action: 'environment.build', id: at() },
  'PUT /api/v1/default-environment': { action: 'environment.server-default', id: 'none' },
  'POST /api/v1/launch-configs/:id/schedules': {
    action: 'schedule.create',
    id: 'reply',
    parent: 'launch-config',
  },
  'PATCH /api/v1/launch-configs/:id/schedules/:schedule': {
    action: 'schedule.change',
    id: at('schedule'),
  },
  'DELETE /api/v1/launch-configs/:id/schedules/:schedule': {
    action: 'schedule.delete',
    id: at('schedule'),
  },
  'POST /api/v1/admin/certificate/request': { action: 'certificate.request', id: 'none' },
  'POST /api/v1/admin/certificate/install': { action: 'certificate.install', id: 'none' },
  'POST /api/v1/admin/certificate/self-signed': { action: 'certificate.self-signed', id: 'none' },
  'POST /api/v1/admin/certificate/rollback': { action: 'certificate.rollback', id: 'none' },
  // AFS-30: sign-in providers, and who may sign in with a password.
  'POST /api/v1/admin/oidc-providers': { action: 'oidc-provider.create', id: 'reply' },
  'PATCH /api/v1/admin/oidc-providers/:id': { action: 'oidc-provider.change', id: at() },
  'DELETE /api/v1/admin/oidc-providers/:id': { action: 'oidc-provider.delete', id: at() },
  'PUT /api/v1/admin/sign-in': { action: 'sign-in.change', id: 'none' },
  // AFS-31: directories.
  'POST /api/v1/admin/ldap-directories': { action: 'ldap-directory.create', id: 'reply' },
  'PATCH /api/v1/admin/ldap-directories/:id': { action: 'ldap-directory.change', id: at() },
  'DELETE /api/v1/admin/ldap-directories/:id': { action: 'ldap-directory.delete', id: at() },
  'POST /api/v1/admin/ldap-directories/:id/sync': { action: 'ldap-directory.sync', id: at() },
};

/** Routes that are POSTs but change nothing. */
export const READS = new Set([
  'POST /api/v1/launch-configs/:id/check',
  'POST /api/v1/launch-configs/:id/facts',
  'POST /api/v1/admin/oidc-providers/:id/test',
  'POST /api/v1/admin/ldap-directories/:id/test',
  // AFS-171: a source's address read before a project is added: nothing is kept.
  'POST /api/v1/workspaces/:id/projects/check',
  'POST /git/:workspace/:repo/git-upload-pack',
  // AFS-76: edits of a draft are kept with the draft (who, before, after); its save is audited.
  'POST /api/v1/projects/:id/drafts',
  'POST /api/v1/drafts/:id/commands',
  'POST /api/v1/drafts/:id/undo',
  'POST /api/v1/drafts/:id/redo',
  'POST /api/v1/drafts/:id/tidy',
  'POST /api/v1/drafts/:id/here',
  'POST /api/v1/drafts/:id/flushed',
  'POST /api/v1/drafts/:id/catalog',
  'POST /api/v1/projects/:id/flows/catalog',
  // AFS-183: the repository's variables, read for the canvas: nothing is kept but a cache.
  'POST /api/v1/projects/:id/vars',
]);

const CHANGES = ['POST', 'PUT', 'PATCH', 'DELETE'];
/**
 * AFS-141: the kinds whose refusals keep the server's reason: their messages name rules and
 * names, never a value sent (a credential's, a sign-in's or a notification's could).
 */
const REASONED = new Set([
  'user',
  'group',
  'workspace',
  'project',
  'grant',
  'launch-config',
  'schedule',
  'environment',
  'run',
  'approval',
]);
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
    case 'draft':
      return one(
        db.selectFrom('flow_draft').select('file as n').where('id', '=', id).executeTakeFirst(),
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
    case 'approval':
      return nameOf(db, 'run', id);
    case 'grant': {
      const grant = await db
        .selectFrom('access_grant')
        .leftJoin('user_account', 'user_account.id', 'access_grant.principal_id')
        .leftJoin('user_group', 'user_group.id', 'access_grant.principal_id')
        .leftJoin('workspace', 'workspace.id', 'access_grant.workspace_id')
        .leftJoin('project', 'project.id', 'access_grant.project_id')
        .select([
          'access_grant.level',
          'access_grant.principal_type',
          'access_grant.flow_file',
          'user_account.login',
          'user_group.name',
          'workspace.key as workspace',
          'project.key as project',
        ])
        .where('access_grant.id', '=', id)
        .executeTakeFirst()
        .catch(() => undefined);
      if (!grant) return undefined;
      const who = grant.principal_type === 'user' ? grant.login : `group ${grant.name}`;
      // AFS-141: and where: the workspace, or the flow in it.
      const where = grant.flow_file
        ? `${grant.workspace}/${grant.project ? `${grant.project}/` : ''}${grant.flow_file}`
        : `${grant.workspace}`;
      return `${grant.level} for ${who} on ${where}`;
    }
    // AFS-141: named, not left as ids: what is deleted cannot be asked later.
    case 'environment':
      return one(
        db.selectFrom('environment').select('name as n').where('id', '=', id).executeTakeFirst(),
      );
    case 'schedule':
      return one(
        db.selectFrom('schedule').select('name as n').where('id', '=', id).executeTakeFirst(),
      );
    case 'oidc-provider':
      return one(
        db.selectFrom('oidc_provider').select('name as n').where('id', '=', id).executeTakeFirst(),
      );
    case 'ldap-directory':
      return one(
        db.selectFrom('ldap_directory').select('name as n').where('id', '=', id).executeTakeFirst(),
      );
    case 'run': {
      const run = await db
        .selectFrom('run')
        .select(['number', 'flow_name'])
        .where('id', '=', id)
        .executeTakeFirst()
        .catch(() => undefined);
      // AFS-146: as the pages name a run (its flow and number), on every run's entry.
      return run ? `${run.flow_name} #${run.number}` : undefined;
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
  // AFS-24: a call an MCP tool made for an agent.
  if (viaMcp(request)) return 'mcp';
  if (request.user?.token) return 'api';
  if (request.user) return 'ui';
  // Nobody signed in yet (a sign-in): browsers say where a request comes from; scripts do not
  // (Node's fetch says its mode, but not its site).
  return request.headers['sec-fetch-site'] ? 'ui' : 'api';
}

// AFS-153: the server said no (a field that is not right, a login taken, no access): refused;
// it could not do what it was asked: failed.
const resultOf = (status: number): AuditResult =>
  status < 400 ? 'ok' : status < 500 ? 'refused' : 'failed';

declare module 'fastify' {
  interface FastifyRequest {
    /** The name of the object a change is about, read before the change. */
    auditName?: string;
    /**
     * Names a route adds to its entry that are not secret (a branch, AFS-59; who joined or left
     * a group and the fields a change really changed, AFS-141).
     */
    auditDetail?: Record<string, string | boolean | string[]>;
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
    Object.assign(detail, request.auditDetail);
    // AFS-145: the token by its name, as it was then: a revoked token's row is gone.
    if (request.user?.token) detail.token = request.user.token.name;
    if (result !== 'ok' && typeof answer.error === 'string') detail.error = answer.error;
    // AFS-141: why, in the server's words, where those words echo nothing secret.
    if (result !== 'ok' && REASONED.has(type) && typeof answer.message === 'string')
      detail.reason = answer.message.slice(0, 300);

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
    // AFS-141: a person not made is named by the login tried.
    if (spec.action === 'user.create' && status >= 400) {
      const tried = (request.body as { login?: unknown } | undefined)?.login;
      if (typeof tried === 'string') object = { type, name: tried.slice(0, 64).toLowerCase() };
    }
    if (spec.action === 'run.relaunch' && typeof answer.id === 'string') {
      detail.run = answer.id;
      // AFS-170: the new run by its number too, which still says it once the run is gone.
      if (typeof answer.number === 'number') detail.number = answer.number;
    }
    // AFS-170: whether a launch was a real run or a check run.
    if (
      (spec.action === 'run.launch' || spec.action === 'run.relaunch') &&
      (answer.mode === 'real' || answer.mode === 'check')
    )
      detail.mode = answer.mode;
    // AFS-28: the decision is one of two words, and the approval is named by its node.
    if (spec.action === 'approval.decide') {
      const said = request.body as { decision?: unknown; comment?: unknown } | undefined;
      if (said?.decision === 'approved' || said?.decision === 'rejected')
        detail.decision = said.decision;
      // AFS-133: the approval by its title, and the comment the decision was given with.
      const gate = answer as { node?: { title?: unknown; key?: unknown } };
      // AFS-146: a refused decision names the approval by its title too, not by its key.
      const asked =
        params.id && params.node
          ? await db
              .selectFrom('run_gate')
              .select('title')
              .where('run_id', '=', params.id)
              .where((eb) =>
                eb.or([
                  eb('node_id', '=', params.node as string),
                  eb('node_key', '=', params.node as string),
                ]),
              )
              .executeTakeFirst()
              .catch(() => undefined)
          : undefined;
      detail.approval =
        typeof gate.node?.title === 'string'
          ? gate.node.title
          : (asked?.title ?? params.node ?? undefined);
      if (typeof said?.comment === 'string' && said.comment.trim() && status < 400)
        detail.comment = said.comment.trim().slice(0, 500);
    }
    // AFS-29: which channel a test went by (not where: a webhook's address can be its secret).
    if (spec.action === 'notification.test') {
      const channel = (request.body as { channel?: unknown } | undefined)?.channel;
      if (channel === 'email' || channel === 'webhook') detail.channel = channel;
    }
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
      if (!filter) return reply;
      const page = await listAudit(db, filter);
      // AFS-106: the names of what the page mentions by id, and where they are while they exist.
      return { ...page, refs: await auditRefs(db, page.entries) };
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
