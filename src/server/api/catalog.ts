// Every address of the server's API, described once: what it does, who may call it, and which
// workspace it reaches. From this list come the OpenAPI document (/api/v1/openapi.json) and the
// check that keeps a token made for one workspace inside it. A route under /api/ or /git/ that
// is not in the list stops the server from being built, so none goes undescribed or unchecked.
import type { FastifyInstance, FastifyRequest, RouteOptions } from 'fastify';
import type { Kysely } from 'kysely';
import { accessOf, atLeast, type Level } from '../access/grants';
import type { Schema } from '../db/schema';
import { serverMeta } from '../meta';

/** Who may call a route. */
export type Who =
  | 'anyone'
  | 'signed in'
  | 'session'
  | 'administrators'
  | 'administrator session'
  | 'push hook token'
  // Access levels (AFS-27), on what the route reaches: the flow when it reaches one, else the
  // workspace; "can see" is any grant in the workspace (or on a flow of the project).
  | 'can see'
  | 'ro'
  | 'operator'
  | 'rw'
  | 'ro on the workspace'
  | 'rw on the workspace';

/**
 * Which workspace a route reaches, for a token made for one workspace: one named by a route
 * parameter (directly, or through a project, launch configuration, run or credential), by the
 * project in the query, or none: then such a token may not call it. `self`: only the caller's
 * own session and tokens; `anyone`: needs no sign-in.
 */
export type Reach =
  | 'self'
  | 'anyone'
  | 'server'
  | { workspace: string }
  | { project: string }
  | { config: string }
  | { run: string }
  | { credential: string }
  | { grant: string }
  | { gitWorkspace: string }
  | { projectQuery: string };

export interface RouteDoc {
  summary: string;
  tag: string;
  who: Who;
  reach: Reach;
}

const S = (tag: string, who: Who, reach: Reach) => (summary: string) => ({
  summary,
  tag,
  who,
  reach,
});
const W = { workspace: 'id' } as const;
const P = { project: 'id' } as const;
const C = { config: 'id' } as const;
const R = { run: 'id' } as const;
const K = { credential: 'id' } as const;

export const ROUTES: Record<string, RouteDoc> = {
  'GET /api/v1/meta': S('Server', 'anyone', 'anyone')('What the server is: name, version, API'),
  'GET /api/v1/openapi.json': S('Server', 'anyone', 'anyone')('This API as an OpenAPI document'),
  'GET /api/v1/setup': S('Server', 'anyone', 'anyone')('Whether the first administrator is needed'),
  'POST /api/v1/setup': S(
    'Server',
    'anyone',
    'anyone',
  )('Make the first administrator with the setup code from the log'),

  'POST /api/v1/session': S('Session', 'anyone', 'anyone')('Sign in with a login and password'),
  'GET /api/v1/session': S('Session', 'signed in', 'self')('Who is signed in'),
  'DELETE /api/v1/session': S('Session', 'anyone', 'self')('Sign out'),
  'PUT /api/v1/session/password': S('Session', 'session', 'self')('Change your own password'),

  'GET /api/v1/tokens': S('Tokens', 'signed in', 'self')('Your access tokens'),
  'POST /api/v1/tokens': S(
    'Tokens',
    'session',
    'self',
  )('Make an access token (shown once); optionally read-only or for one workspace'),
  'DELETE /api/v1/tokens/:id': S('Tokens', 'session', 'self')('Revoke one of your tokens'),
  'GET /api/v1/users/:id/tokens': S('Tokens', 'administrators', 'server')("A user's tokens"),
  'POST /api/v1/users/:id/tokens': S(
    'Tokens',
    'administrator session',
    'server',
  )('Make a token for a service account (shown once)'),
  'DELETE /api/v1/users/:id/tokens/:token': S(
    'Tokens',
    'administrators',
    'server',
  )("Revoke a user's token"),

  'GET /api/v1/users': S('People', 'administrators', 'server')('Users and service accounts'),
  'POST /api/v1/users': S(
    'People',
    'administrators',
    'server',
  )('Add a user, or a service account (`service: true`, no password)'),
  'GET /api/v1/users/:id': S('People', 'administrators', 'server')('One user'),
  'PATCH /api/v1/users/:id': S(
    'People',
    'administrators',
    'server',
  )('Change a user: name, contact, administrator, disabled'),
  'PUT /api/v1/users/:id/password': S(
    'People',
    'administrators',
    'server',
  )("Set a user's password (not a service account's)"),
  'DELETE /api/v1/users/:id': S('People', 'administrators', 'server')('Delete a user'),
  'GET /api/v1/groups': S('People', 'administrators', 'server')('Groups'),
  'POST /api/v1/groups': S('People', 'administrators', 'server')('Add a group'),
  'GET /api/v1/groups/:id': S('People', 'administrators', 'server')('One group'),
  'PATCH /api/v1/groups/:id': S('People', 'administrators', 'server')('Change a group'),
  'PUT /api/v1/groups/:id/members': S(
    'People',
    'administrators',
    'server',
  )("Set a group's members"),
  'DELETE /api/v1/groups/:id': S('People', 'administrators', 'server')('Delete a group'),

  'GET /api/v1/workspaces': S('Workspaces', 'signed in', 'server')('Workspaces'),
  'POST /api/v1/workspaces': S('Workspaces', 'administrators', 'server')('Add a workspace'),
  'GET /api/v1/workspaces/:id': S('Workspaces', 'signed in', W)('One workspace, by id or key'),
  'PATCH /api/v1/workspaces/:id': S('Workspaces', 'administrators', W)('Change a workspace'),
  'DELETE /api/v1/workspaces/:id': S(
    'Workspaces',
    'administrators',
    W,
  )('Delete an empty workspace'),

  'GET /api/v1/workspaces/:id/projects': S('Projects', 'signed in', W)("A workspace's projects"),
  'POST /api/v1/workspaces/:id/projects': S(
    'Projects',
    'administrators',
    W,
  )('Add a project: one the server keeps, or a mirror of a repository'),
  'GET /api/v1/projects/:id': S('Projects', 'signed in', P)('One project, with its sync state'),
  'PATCH /api/v1/projects/:id': S('Projects', 'administrators', P)('Change a project'),
  'DELETE /api/v1/projects/:id': S(
    'Projects',
    'administrators',
    P,
  )('Delete a project (refused while runs go)'),
  'POST /api/v1/projects/:id/sync': S('Projects', 'administrators', P)('Look at the source now'),
  'GET /api/v1/projects/:id/branches': S('Projects', 'signed in', P)("A project's branches"),
  'GET /api/v1/projects/:id/pushes': S(
    'Projects',
    'signed in',
    P,
  )('Pushes through the server, newest first'),
  'GET /api/v1/projects/:id/flows': S(
    'Projects',
    'signed in',
    P,
  )("The flows at the project's commit, with their findings"),
  'GET /api/v1/projects/:id/flows/view': S(
    'Projects',
    'signed in',
    P,
  )('One flow as the designer shows it (at a commit when asked)'),
  'POST /api/v1/projects/:id/hook': S(
    'Projects',
    'administrators',
    P,
  )('Make (or replace) the push hook token; shown once'),
  'DELETE /api/v1/projects/:id/hook': S('Projects', 'administrators', P)('Remove the push hook'),
  'POST /api/v1/hooks/projects/:id/push': S(
    'Projects',
    'push hook token',
    'anyone',
  )('Called by the git host on a push: the server looks at the source'),

  'GET /git/:workspace/:repo/info/refs': S('Git', 'signed in', { gitWorkspace: 'workspace' })(
    'git smart HTTP: what the repository has (clone, fetch, push)',
  ),
  'POST /git/:workspace/:repo/git-upload-pack': S('Git', 'signed in', {
    gitWorkspace: 'workspace',
  })('git smart HTTP: clone and fetch'),
  'POST /git/:workspace/:repo/git-receive-pack': S('Git', 'administrators', {
    gitWorkspace: 'workspace',
  })('git smart HTTP: push'),

  'GET /api/v1/workspaces/:id/credentials': S(
    'Credentials',
    'signed in',
    W,
  )("A workspace's credentials (never their secrets)"),
  'POST /api/v1/workspaces/:id/credentials': S(
    'Credentials',
    'administrators',
    W,
  )('Add a credential; its secret goes in and is never shown'),
  'GET /api/v1/credentials/:id': S('Credentials', 'signed in', K)('One credential'),
  'PATCH /api/v1/credentials/:id': S(
    'Credentials',
    'administrators',
    K,
  )('Change a credential, or replace its secret'),
  'DELETE /api/v1/credentials/:id': S(
    'Credentials',
    'administrators',
    K,
  )('Delete a credential (refused while used)'),

  'GET /api/v1/projects/:id/launch-configs': S(
    'Launch configurations',
    'signed in',
    P,
  )("A project's launch configurations"),
  'POST /api/v1/projects/:id/launch-configs': S(
    'Launch configurations',
    'administrators',
    P,
  )('Add a launch configuration (saved only if it could run)'),
  'GET /api/v1/launch-configs/:id': S(
    'Launch configurations',
    'signed in',
    C,
  )('One launch configuration'),
  'PATCH /api/v1/launch-configs/:id': S(
    'Launch configurations',
    'administrators',
    C,
  )('Change a launch configuration'),
  'DELETE /api/v1/launch-configs/:id': S(
    'Launch configurations',
    'administrators',
    C,
  )('Delete a launch configuration'),
  'GET /api/v1/launch-configs/:id/form': S(
    'Launch configurations',
    'signed in',
    C,
  )("The launch form: the flow's inputs with their start values"),
  'POST /api/v1/launch-configs/:id/check': S(
    'Launch configurations',
    'signed in',
    C,
  )('What a launch would run, or what stands in its way (422)'),
  'POST /api/v1/launch-configs/:id/launch': S(
    'Launch configurations',
    'administrators',
    C,
  )('Launch: the run goes in the queue'),

  'GET /api/v1/runs': S('Runs', 'signed in', { projectQuery: 'project' })(
    'Runs, newest first; filters project, flow, state; `before` and `limit` for paging',
  ),
  'GET /api/v1/runs/:id': S('Runs', 'signed in', R)('One run'),
  'GET /api/v1/runs/:id/output': S(
    'Runs',
    'signed in',
    R,
  )('What Ansible wrote, secrets hidden (text); `from` for what came after'),
  'GET /api/v1/runs/:id/view': S(
    'Runs',
    'signed in',
    R,
  )('How the run went, step by step, as the designer shows it'),
  'GET /api/v1/runs/:id/hosts/:node/:host': S(
    'Runs',
    'signed in',
    R,
  )('What one host did in one step'),
  'GET /api/v1/runs/:id/events': S(
    'Runs',
    'signed in',
    R,
  )('The run as it goes, as server-sent events: run, view, output, end'),
  'POST /api/v1/runs/:id/cancel': S('Runs', 'administrators', R)('Stop a run'),
  'POST /api/v1/runs/:id/relaunch': S(
    'Runs',
    'administrators',
    R,
  )('The same run again, as a new run'),

  'GET /api/v1/workspaces/:id/grants': S(
    'Access',
    'administrators',
    W,
  )('The grants of a workspace: who has which level, on it or on one flow'),
  'POST /api/v1/workspaces/:id/grants': S(
    'Access',
    'administrators',
    W,
  )('Give a user or group a level (ro, operator, rw, approve) on the workspace or one flow'),
  'DELETE /api/v1/grants/:id': S('Access', 'administrators', { grant: 'id' })('Take a grant back'),
  'GET /api/v1/workspaces/:id/access': S(
    'Access',
    'administrators',
    W,
  )('Who can do what in a workspace, as their grants and groups come out'),
  'GET /api/v1/projects/:id/access': S(
    'Access',
    'signed in',
    P,
  )('What you may do in a project: your level on it and on each flow'),
  'GET /api/v1/approvals': S(
    'Approvals',
    'signed in',
    'server',
  )('Approvals that wait for a decision, that you may see; each says whether you may decide it'),
  'GET /api/v1/runs/:id/approvals': S(
    'Approvals',
    'signed in',
    R,
  )("A run's approvals: waiting or decided, by whom, when, why; whether you may decide each"),
  'POST /api/v1/runs/:id/approvals/:node': S(
    'Approvals',
    'signed in',
    R,
  )('Decide an approval the run waits at: approved or rejected, with a comment; the run goes on'),
  'GET /api/v1/audit': S(
    'Audit',
    'administrators',
    'server',
  )('The audit log, newest first, filtered; `before` for older entries'),
  'GET /api/v1/audit/export': S(
    'Audit',
    'administrators',
    'server',
  )('The audit log as a CSV or JSON file'),
  'GET /api/v1/notifications': S(
    'Notifications',
    'administrators',
    'server',
  )('The delivery log: each message, where it went, and how; newest first, filtered'),
  'POST /api/v1/notifications/:id/retry': S(
    'Notifications',
    'administrators',
    'server',
  )('Try a message that was given up on again'),
  'GET /api/v1/notifications/settings': S(
    'Notifications',
    'administrators',
    'server',
  )('How the server sends: the mail server (never its password), whether webhooks are signed'),
  'PUT /api/v1/notifications/smtp': S(
    'Notifications',
    'administrator session',
    'server',
  )('Set the mail server email goes through'),
  'DELETE /api/v1/notifications/smtp': S(
    'Notifications',
    'administrator session',
    'server',
  )('Send no email'),
  'POST /api/v1/notifications/webhook-key': S(
    'Notifications',
    'administrator session',
    'server',
  )('A new key webhooks are signed with, shown in this answer only; the old one stops working'),
  'POST /api/v1/notifications/test': S(
    'Notifications',
    'administrators',
    'server',
  )('Send a test message now, by email or webhook, and say how it went'),
};

/**
 * The access level each route needs (AFS-27), in place of "signed in" or "administrators" in
 * the list above. Routes not named here keep theirs. Lists that span what a person may see
 * (workspaces, projects, flows, runs) are narrowed by their handlers.
 */
const NEEDS: Record<string, Who> = {
  'GET /api/v1/workspaces/:id': 'can see',
  'GET /api/v1/workspaces/:id/projects': 'can see',
  'GET /api/v1/projects/:id': 'can see',
  'GET /api/v1/projects/:id/branches': 'can see',
  'GET /api/v1/projects/:id/pushes': 'can see',
  'GET /api/v1/projects/:id/flows': 'can see',
  'GET /api/v1/projects/:id/access': 'can see',
  'GET /api/v1/projects/:id/flows/view': 'ro',
  'POST /api/v1/projects/:id/sync': 'rw on the workspace',
  'GET /git/:workspace/:repo/info/refs': 'ro on the workspace',
  'POST /git/:workspace/:repo/git-upload-pack': 'ro on the workspace',
  'POST /git/:workspace/:repo/git-receive-pack': 'rw on the workspace',
  'GET /api/v1/workspaces/:id/credentials': 'ro on the workspace',
  'GET /api/v1/credentials/:id': 'ro on the workspace',
  'GET /api/v1/projects/:id/launch-configs': 'can see',
  // The flow is in the body: the handler asks for rw on it.
  'POST /api/v1/projects/:id/launch-configs': 'can see',
  'GET /api/v1/launch-configs/:id': 'ro',
  'PATCH /api/v1/launch-configs/:id': 'rw',
  'DELETE /api/v1/launch-configs/:id': 'rw',
  'GET /api/v1/launch-configs/:id/form': 'ro',
  'POST /api/v1/launch-configs/:id/check': 'ro',
  // Another branch or commit than the configuration's: the handler asks for rw.
  'POST /api/v1/launch-configs/:id/launch': 'operator',
  'GET /api/v1/runs/:id': 'ro',
  'GET /api/v1/runs/:id/output': 'ro',
  'GET /api/v1/runs/:id/view': 'ro',
  'GET /api/v1/runs/:id/hosts/:node/:host': 'ro',
  'GET /api/v1/runs/:id/events': 'ro',
  'POST /api/v1/runs/:id/cancel': 'operator',
  'POST /api/v1/runs/:id/relaunch': 'operator',
  // An approver sees what they decide: approve counts as ro; deciding is checked by the handler
  // (the approve grant, the approval's approvers, self-approval).
  'GET /api/v1/runs/:id/approvals': 'ro',
  'POST /api/v1/runs/:id/approvals/:node': 'ro',
};
for (const [route, who] of Object.entries(NEEDS)) {
  const doc = ROUTES[route];
  if (doc) doc.who = who;
}
/** The level a `who` asks for; none for the rest (signed in, administrators, ...). */
const LEVEL_OF: Partial<Record<Who, Level | 'see'>> = {
  'can see': 'see',
  ro: 'ro',
  operator: 'operator',
  rw: 'rw',
  'ro on the workspace': 'ro',
  'rw on the workspace': 'rw',
};
/** flows/view names its flow in the query. */
const FLOW_QUERY: Record<string, string> = { 'GET /api/v1/projects/:id/flows/view': 'path' };

/** What a route reaches: the workspace, and the project and flow when it reaches one. */
interface Target {
  workspace: string;
  project?: string;
  file?: string;
}

/** What a route reaches for this request; undefined when it reaches no workspace. */
async function targetOf(
  db: Kysely<Schema>,
  reach: Reach,
  request: FastifyRequest,
  flowQuery?: string,
): Promise<Target | undefined> {
  if (typeof reach === 'string') return undefined;
  const params = request.params as Record<string, string | undefined>;
  const query = request.query as Record<string, string | undefined>;
  if ('workspace' in reach || 'gitWorkspace' in reach) {
    const key = params['workspace' in reach ? reach.workspace : reach.gitWorkspace];
    if (!key) return undefined;
    const row = await db
      .selectFrom('workspace')
      .select('id')
      .where((eb) => eb.or([eb('id', '=', key), eb('key', '=', key)]))
      .executeTakeFirst();
    return row ? { workspace: row.id } : undefined;
  }
  const ofProject = async (id: string | undefined, file?: string) => {
    if (!id) return undefined;
    const row = await db
      .selectFrom('project')
      .select('workspace_id')
      .where('id', '=', id)
      .executeTakeFirst();
    return row
      ? { workspace: row.workspace_id, project: id, ...(file ? { file } : {}) }
      : undefined;
  };
  if ('project' in reach)
    return ofProject(params[reach.project], flowQuery ? query[flowQuery] : undefined);
  if ('projectQuery' in reach) return ofProject(query[reach.projectQuery]);
  if ('grant' in reach) {
    const id = params[reach.grant];
    const row = id
      ? await db
          .selectFrom('access_grant')
          .select('workspace_id')
          .where('id', '=', id)
          .executeTakeFirst()
      : undefined;
    return row ? { workspace: row.workspace_id } : undefined;
  }
  if ('credential' in reach) {
    const id = params[reach.credential];
    const row = id
      ? await db
          .selectFrom('credential')
          .select('workspace_id')
          .where('id', '=', id)
          .executeTakeFirst()
      : undefined;
    return row ? { workspace: row.workspace_id } : undefined;
  }
  const id = params['config' in reach ? reach.config : reach.run];
  if (!id) return undefined;
  const row =
    'config' in reach
      ? await db
          .selectFrom('launch_config')
          .select(['project_id', 'flow_file'])
          .where('id', '=', id)
          .executeTakeFirst()
      : await db
          .selectFrom('run')
          .select(['project_id', 'flow_file'])
          .where('id', '=', id)
          .executeTakeFirst();
  return row ? ofProject(row.project_id, row.flow_file) : undefined;
}

interface Seen {
  method: string;
  url: string;
  schema?: RouteOptions['schema'];
}

/** A route's parameters, `:id` as OpenAPI writes it (`{id}`). */
const openPath = (url: string) => url.replace(/:([A-Za-z_]+)/g, '{$1}');

/** The OpenAPI 3.1 document of the routes the server has. */
export function openApi(routes: Seen[], origin?: string): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of routes) {
    const doc = ROUTES[`${route.method} ${route.url}`];
    if (!doc) continue;
    const schema = (route.schema ?? {}) as Record<string, Record<string, unknown> | undefined>;
    const parameters: Record<string, unknown>[] = [];
    for (const [where, part] of [
      ['path', schema.params],
      ['query', schema.querystring],
    ] as const) {
      const properties = (part?.properties ?? {}) as Record<string, unknown>;
      const required = (part?.required ?? []) as string[];
      for (const [name, property] of Object.entries(properties))
        parameters.push({
          name,
          in: where,
          required: where === 'path' || required.includes(name),
          schema: property,
        });
    }
    // A path parameter without a schema of its own is still a parameter.
    for (const name of route.url.match(/:([A-Za-z_]+)/g) ?? [])
      if (!parameters.some((p) => p.in === 'path' && p.name === name.slice(1)))
        parameters.push({
          name: name.slice(1),
          in: 'path',
          required: true,
          schema: { type: 'string' },
        });
    const method = route.method.toLowerCase();
    paths[openPath(route.url)] ??= {};
    (paths[openPath(route.url)] as Record<string, unknown>)[method] = {
      summary: doc.summary,
      tags: [doc.tag],
      description: `Who: ${doc.who}.`,
      operationId: `${method}${openPath(route.url).replace(/[^A-Za-z0-9]+(.)?/g, (_m, c: string) => (c ?? '').toUpperCase())}`,
      ...(parameters.length ? { parameters } : {}),
      ...(schema.body
        ? {
            requestBody: {
              required: true,
              content: { 'application/json': { schema: schema.body } },
            },
          }
        : {}),
      responses: {
        '4XX': { $ref: '#/components/responses/Refused' },
        default: { description: 'The answer, as JSON (an output as text, events as a stream)' },
      },
      ...(doc.who === 'anyone' || doc.who === 'push hook token' ? { security: [] } : {}),
    };
  }
  const meta = serverMeta();
  return {
    openapi: '3.1.0',
    info: {
      title: 'Ansible Flow Server API',
      version: meta.version,
      license: { name: 'MIT', identifier: 'MIT' },
      description:
        'Sign in with a personal access token as a bearer token (`Authorization: Bearer afs_...`), or with the session cookie of the pages. A token made for one workspace reaches only that workspace; a read-only token only reads.',
    },
    ...(origin ? { servers: [{ url: origin }] } : {}),
    components: {
      responses: {
        Refused: {
          description: 'Refused: what was wrong, in words fit to show',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error', 'message'],
                properties: {
                  error: {
                    type: 'string',
                    description: 'A code: invalid, not_found, forbidden, ...',
                  },
                  message: { type: 'string' },
                  field: { type: 'string', description: 'The field it is about, when one' },
                  problems: {
                    type: 'array',
                    description: 'Everything in the way of a launch (422)',
                    items: {
                      type: 'object',
                      properties: { field: { type: 'string' }, message: { type: 'string' } },
                    },
                  },
                },
              },
            },
          },
        },
      },
      securitySchemes: {
        token: { type: 'http', scheme: 'bearer', description: 'A personal access token' },
        session: { type: 'apiKey', in: 'cookie', name: 'afs_session' },
      },
    },
    security: [{ token: [] }, { session: [] }],
    paths: Object.fromEntries(Object.entries(paths).sort(([a], [b]) => a.localeCompare(b))),
  };
}

export function registerCatalog(app: FastifyInstance, deps: { db: Kysely<Schema> }): void {
  const seen: Seen[] = [];
  app.addHook('onRoute', (route) => {
    for (const method of [route.method].flat()) {
      if (method === 'HEAD') continue;
      const own = route.url.startsWith('/api/') || route.url.startsWith('/git/');
      if (!own) continue;
      const key = `${method} ${route.url}`;
      if (!ROUTES[key])
        throw new Error(`${key} is not described in api/catalog.ts: say what it does and reaches`);
      seen.push({ method, url: route.url, ...(route.schema ? { schema: route.schema } : {}) });
    }
  });

  // A token made for one workspace reaches that workspace only: what is not in it, or not in
  // any one workspace (people, the audit log, every workspace), is refused.
  app.addHook('preHandler', async (request, reply) => {
    const scope = request.user?.token?.workspace;
    const route = request.routeOptions.url;
    if (!scope || !route) return;
    const doc = ROUTES[`${request.method} ${route}`];
    if (!doc || doc.reach === 'self' || doc.reach === 'anyone') return;
    const reached = (await targetOf(deps.db, doc.reach, request))?.workspace;
    if (reached === scope) return;
    return reply.code(403).send({
      error: 'out_of_scope',
      message:
        doc.reach === 'server'
          ? 'This token is for one workspace: it cannot reach this'
          : 'This token is for another workspace',
    });
  });

  // The access level a route needs, on what it reaches (AFS-27). Who is not signed in is told
  // so by the route itself; what does not exist is the route's to say (404).
  app.addHook('preHandler', async (request, reply) => {
    const route = request.routeOptions.url;
    if (!route || !request.user) return;
    const key = `${request.method} ${route}`;
    const doc = ROUTES[key];
    if (!doc) return;
    const level = LEVEL_OF[doc.who];
    if (!level) return;
    const target = await targetOf(deps.db, doc.reach, request, FLOW_QUERY[key]);
    if (!target) return;
    const access = await accessOf(deps.db, request);
    if (!access || access.admin) return;
    const allowed =
      level === 'see'
        ? access.sees(target.workspace, target.project)
        : atLeast(
            doc.who.endsWith('on the workspace') || !target.project || !target.file
              ? access.onWorkspace(target.workspace)
              : access.onFlow(target.workspace, target.project, target.file),
            level,
          );
    if (allowed) return;
    // Who may not see it at all is not told it is there.
    if (!access.sees(target.workspace, target.project))
      return reply.code(404).send({ error: 'not_found', message: 'Nothing here, or not for you' });
    return reply.code(403).send({
      error: 'forbidden',
      message: `This needs ${doc.who === 'can see' ? 'access' : doc.who} here`,
    });
  });

  app.get('/api/v1/openapi.json', async (request) =>
    openApi(seen, `${request.protocol}://${request.host}`),
  );
}
