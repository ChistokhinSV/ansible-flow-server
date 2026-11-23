// Every address of the server's API, described once: what it does, who may call it, and which
// workspace it reaches. From this list come the OpenAPI document (/api/v1/openapi.json) and the
// check that keeps a token made for one workspace inside it. A route under /api/ or /git/ that
// is not in the list stops the server from being built, so none goes undescribed or unchecked.
import type { FastifyInstance, FastifyRequest, RouteOptions } from 'fastify';
import type { Kysely } from 'kysely';
import { accessOf, atLeast, type Level } from '../access/grants';
import { READS } from '../audit/routes';
import type { Schema } from '../db/schema';
import { serverMeta } from '../meta';
import { ANSWERS, type Answer, EMPTY, EVENTS, json, list, one, SCHEMAS } from './schemas';

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
  | 'rw on the workspace'
  // AFS-175: an action's grant, operator on its flow, or an administrator; the route checks it
  // (ADR-0036: the access levels do not know action grants).
  | 'may run the action';

/**
 * Which workspace a route reaches, for a token made for one workspace: one named by a route
 * parameter (directly, or through a project, launch configuration, run or credential), by the
 * project in the query, or none: then such a token may not call it. `self`: only the caller's
 * own session and tokens; `anyone`: needs no sign-in.
 */
/** AFS-135: what a route says of something that does not exist, for what it reaches. */
export function missingOf(reach: Reach): string {
  if (typeof reach !== 'object') return 'Nothing here';
  if ('workspace' in reach || 'gitWorkspace' in reach) return 'No such workspace';
  if ('project' in reach || 'projectQuery' in reach) return 'No such project';
  if ('config' in reach) return 'No such launch configuration';
  if ('run' in reach) return 'No such run';
  if ('credential' in reach) return 'No such credential';
  if ('environment' in reach) return 'No such environment';
  if ('grant' in reach) return 'No such grant';
  if ('draft' in reach) return 'No such draft';
  return 'Nothing here';
}

export type Reach =
  | 'self'
  | 'anyone'
  | 'server'
  | { workspace: string }
  | { project: string }
  | { config: string }
  | { run: string }
  | { credential: string }
  | { environment: string }
  | { grant: string }
  | { gitWorkspace: string }
  /** A list narrowed by its query: to a project, else to a launch configuration (its project's). */
  | { projectQuery: string; configQuery?: string }
  /** AFS-76: a flow's draft, which reaches its project and flow. */
  | { draft: string };

export interface RouteDoc {
  summary: string;
  tag: string;
  who: Who;
  reach: Reach;
  /**
   * AFS-245: what it answers (api/schemas.ts): in the OpenAPI document, and checked against real
   * answers in the route tests. Absent: not described yet.
   */
  returns?: Answer;
}

const S = (tag: string, who: Who, reach: Reach) => (summary: string, returns?: Answer) => ({
  summary,
  tag,
  who,
  reach,
  ...(returns ? { returns } : {}),
});
const W = { workspace: 'id' } as const;
const P = { project: 'id' } as const;
const C = { config: 'id' } as const;
const R = { run: 'id' } as const;
const D = { draft: 'id' } as const;
const K = { credential: 'id' } as const;
const E = { environment: 'id' } as const;

export const ROUTES: Record<string, RouteDoc> = {
  'GET /api/v1/meta': S(
    'Server',
    'anyone',
    'anyone',
  )('What the server is: name, version, API', one('Meta')),
  'GET /api/v1/openapi.json': S('Server', 'anyone', 'anyone')('This API as an OpenAPI document'),
  'GET /api/v1/setup': S('Server', 'anyone', 'anyone')('Whether the first administrator is needed'),
  'POST /api/v1/setup': S(
    'Server',
    'anyone',
    'anyone',
  )('Make the first administrator with the setup code from the log'),

  'POST /api/v1/session': S(
    'Session',
    'anyone',
    'anyone',
  )('Sign in with a login and password', one('User')),
  'GET /api/v1/session': S(
    'Session',
    'signed in',
    'self',
  )('Who is signed in (with the header X-AFS-Session: optional, 204 when nobody is)', {
    ...one('User'),
    also: 204,
  }),
  'DELETE /api/v1/session': S('Session', 'anyone', 'self')('Sign out', EMPTY),
  'PATCH /api/v1/session': S(
    'Session',
    'session',
    'self',
  )('Change your own name and email address; a webhook only as an administrator'),
  'PUT /api/v1/session/password': S(
    'Session',
    'session',
    'self',
  )('Change your own password', EMPTY),
  'GET /api/v1/session/access': S(
    'Session',
    'signed in',
    'self',
  )(
    'Your own access, workspace by workspace (level, flows of your own, approves, through), and the administrators who give access',
  ),

  'GET /api/v1/tokens': S('Tokens', 'signed in', 'self')('Your access tokens', list('TokenInfo')),
  'POST /api/v1/tokens': S(
    'Tokens',
    'session',
    'self',
  )(
    'Make an access token (shown once); optionally read-only or for one workspace',
    one('NewToken', 201),
  ),
  'DELETE /api/v1/tokens/:id': S('Tokens', 'session', 'self')('Revoke one of your tokens', EMPTY),
  'GET /api/v1/users/:id/tokens': S(
    'Tokens',
    'administrators',
    'server',
  )("A user's tokens", list('TokenInfo')),
  'POST /api/v1/users/:id/tokens': S(
    'Tokens',
    'administrator session',
    'server',
  )('Make a token for a service account (shown once)', one('NewToken', 201)),
  'DELETE /api/v1/users/:id/tokens/:token': S(
    'Tokens',
    'administrators',
    'server',
  )("Revoke a user's token", EMPTY),

  'GET /api/v1/users': S(
    'People',
    'administrators',
    'server',
  )('Users and service accounts', list('User')),
  'POST /api/v1/users': S(
    'People',
    'administrators',
    'server',
  )('Add a user, or a service account (`service: true`, no password)', one('User', 201)),
  'GET /api/v1/users/:id': S('People', 'administrators', 'server')('One user', one('User')),
  'PATCH /api/v1/users/:id': S(
    'People',
    'administrators',
    'server',
  )('Change a user: name, contact, administrator, disabled', one('User')),
  'PUT /api/v1/users/:id/password': S(
    'People',
    'administrators',
    'server',
  )("Set a user's password (not a service account's)", EMPTY),
  'DELETE /api/v1/users/:id': S('People', 'administrators', 'server')('Delete a user', EMPTY),
  'GET /api/v1/groups': S('People', 'administrators', 'server')('Groups', list('Group')),
  'POST /api/v1/groups': S('People', 'administrators', 'server')('Add a group', one('Group', 201)),
  'GET /api/v1/groups/:id': S('People', 'administrators', 'server')('One group', one('Group')),
  'PATCH /api/v1/groups/:id': S(
    'People',
    'administrators',
    'server',
  )('Change a group', one('Group')),
  'PUT /api/v1/groups/:id/members': S(
    'People',
    'administrators',
    'server',
  )("Set a group's members", one('Group')),
  'DELETE /api/v1/groups/:id': S('People', 'administrators', 'server')('Delete a group', EMPTY),
  'GET /api/v1/users/:id/access': S(
    'People',
    'administrators',
    'server',
  )(
    'What one person reaches, workspace by workspace: level, flows of their own, approves, through; `admin` for an administrator',
  ),
  'GET /api/v1/groups/:id/grants': S(
    'People',
    'administrators',
    'server',
  )('The grants that name a group, in every workspace: workspace, level, the flow when on one'),
  'GET /api/v1/groups/:id/action-grants': S(
    'People',
    'administrators',
    'server',
  )('AFS-207: the actions a group lets its members run, in every workspace', list('ActionGrant')),

  'GET /api/v1/workspaces': S('Workspaces', 'signed in', 'server')('Workspaces', list('Workspace')),
  'POST /api/v1/workspaces': S(
    'Workspaces',
    'administrators',
    'server',
  )('Add a workspace', one('Workspace', 201)),
  'GET /api/v1/workspaces/:id': S(
    'Workspaces',
    'signed in',
    W,
  )('One workspace, by id or key', one('Workspace')),
  'PATCH /api/v1/workspaces/:id': S(
    'Workspaces',
    'administrators',
    W,
  )('Change a workspace', one('Workspace')),
  'DELETE /api/v1/workspaces/:id': S(
    'Workspaces',
    'administrators',
    W,
  )('Delete an empty workspace', EMPTY),

  'GET /api/v1/workspaces/:id/projects': S(
    'Projects',
    'signed in',
    W,
  )("A workspace's projects", list('Project')),
  'POST /api/v1/workspaces/:id/projects': S(
    'Projects',
    'administrators',
    W,
  )('Add a project: one the server keeps, or a mirror of a repository', one('Project', 201)),
  'POST /api/v1/workspaces/:id/projects/check': S(
    'Projects',
    'administrators',
    W,
  )("Read a repository's address before a project mirrors it: whether it answers, its branches"),
  'GET /api/v1/projects/:id': S(
    'Projects',
    'signed in',
    P,
  )('One project, with its sync state', one('Project')),
  'PATCH /api/v1/projects/:id': S(
    'Projects',
    'administrators',
    P,
  )('Change a project', one('Project')),
  'DELETE /api/v1/projects/:id': S(
    'Projects',
    'administrators',
    P,
  )('Delete a project (refused while runs go)', EMPTY),
  'POST /api/v1/projects/:id/sync': S('Projects', 'administrators', P)('Look at the source now'),
  'GET /api/v1/projects/:id/host-key': S(
    'Projects',
    'signed in',
    P,
  )("The SSH host key the server trusts for the project's ssh source (fingerprints)"),
  'POST /api/v1/projects/:id/host-key/forget': S(
    'Projects',
    'administrators',
    P,
  )(
    'Forget the trusted host key of the ssh source (after a change you expected) and look again: the key found is trusted',
  ),
  'GET /api/v1/samples': S(
    'Projects',
    'signed in',
    'server',
  )('The sample projects a hosted project can start from'),
  'POST /api/v1/projects/:id/start': S(
    'Projects',
    'signed in',
    P,
  )('The first commit of a hosted project with none: {"sample"}, or a zip or tar.gz as the body'),
  'GET /api/v1/projects/:id/branches': S(
    'Projects',
    'signed in',
    P,
  )(
    "A project's branches: names, and each with its newest commit, commits not on the project's branch and the launch configurations that run it",
  ),
  'POST /api/v1/projects/:id/branches': S(
    'Projects',
    'signed in',
    P,
  )('Make a branch from a branch or a commit (at the source first for a project with one)'),
  'DELETE /api/v1/projects/:id/branches': S(
    'Projects',
    'signed in',
    P,
  )("Delete a branch (?name=, ?force=true for one with commits not on the project's branch)"),
  'GET /api/v1/projects/:id/pushes': S(
    'Projects',
    'signed in',
    P,
  )('Pushes through the server, newest first: who, how (`kind`), the new commit and its message'),
  'GET /api/v1/projects/:id/flows': S(
    'Projects',
    'signed in',
    P,
  )(
    "The flows at the project's commit, with their findings and newest run (`lastRun`)",
    one('FlowList'),
  ),
  'GET /api/v1/projects/:id/flows/view': S(
    'Projects',
    'signed in',
    P,
  )('One flow as the designer shows it (at a commit when asked)', json(ANSWERS.flowView)),
  'POST /api/v1/projects/:id/flows/catalog': S(
    'Projects',
    'signed in',
    P,
  )(
    "The module catalog of a flow's image as the designer asks it while showing the flow (search, doc, names, status); 202 while it is first read",
    json(ANSWERS.catalog),
  ),
  'GET /api/v1/projects/:id/events': S(
    'Projects',
    'signed in',
    P,
  )(
    "The project's branch as it moves, as server-sent events: `commit` at once, then `moved` (from, to)",
    EVENTS('commit and moved: where the branch is'),
  ),
  'GET /api/v1/projects/:id/changes': S(
    'Projects',
    'signed in',
    P,
  )(
    "The flows that differ between `from` and the project's commit (or `to`): added, changed or removed, and who changed them",
  ),
  'GET /api/v1/projects/:id/flows/history': S(
    'Projects',
    'signed in',
    P,
  )('The commits that changed a flow, newest first', json(ANSWERS.flowHistory)),
  'GET /api/v1/projects/:id/commits': S(
    'Projects',
    'signed in',
    P,
  )(
    "The commits of the project's branch (or ?branch=, or up to ?commit=), newest first: ?q= keeps those whose message, author, hash or changed files have its words; ?path= a flow's commits (its flow and scenarios files); `next` is the ?skip= of the next page",
  ),
  'GET /api/v1/projects/:id/commits/:commit': S(
    'Projects',
    'signed in',
    P,
  )(
    'One commit: author, time, message, and the files it changed (added, changed, removed or renamed from another path; flows with their title)',
  ),
  'GET /api/v1/projects/:id/flows/commit': S(
    'Projects',
    'signed in',
    P,
  )(
    "What a commit did to a flow (added, changed, removed or nothing), with its author, time and message, the commit to compare with, and whether the project's branch has it (else the branches that do); ?commit= is a full commit id or its start (7 characters or more)",
    json(ANSWERS.flowAtCommit),
  ),
  'GET /api/v1/library/subflows': S(
    'Library',
    'signed in',
    'server',
  )(
    "The subflows the server's library projects offer, of the libraries whose workspace you may read: source (afs://…), title, flow, version and commit",
    json(ANSWERS.librarySubflows),
  ),
  'GET /api/v1/library/subflow': S(
    'Library',
    'signed in',
    'server',
  )('One library subflow as it is now, to copy (?from=afs://…)', json(ANSWERS.librarySubflow)),
  'GET /api/v1/projects/:id/files': S(
    'Files',
    'signed in',
    P,
  )("The files of the project's branch (or ?branch=): path, size, program or link"),
  'GET /api/v1/projects/:id/files/content': S(
    'Files',
    'signed in',
    P,
  )('A file at a commit: text as text/plain, anything else (or ?download=true) as a download'),
  'GET /api/v1/projects/:id/files/history': S(
    'Files',
    'signed in',
    P,
  )('The commits that changed a file or folder up to a commit, newest first'),
  'POST /api/v1/projects/:id/vars': S(
    'Files',
    'signed in',
    P,
  )(
    "Where a value comes from: the variables the repository defines at a commit (the inventory a run uses, or ansible.cfg's; group_vars and host_vars; the `roles` and the playbooks and task files (`files`) a flow runs), with file, line and precedence; never a secret value",
  ),
  'POST /api/v1/projects/:id/files': S(
    'Files',
    'signed in',
    P,
  )(
    'Save a change set as one commit on a branch: write (text or base64), delete, move (files or folders) and unpack (a zip or tar.gz into a folder); refused when the branch changed the same files since `base`. Configurations that run a flow it deletes or moves have their schedules turned off (`turnedOff`), unless `repoint` makes those of a moved flow run it from its new file (`repointed`)',
  ),
  'GET /api/v1/projects/:id/drafts': S(
    'Editing',
    'signed in',
    P,
  )('The flows being edited in the pages, each with who has edited it'),
  'POST /api/v1/projects/:id/drafts': S(
    'Editing',
    'signed in',
    P,
  )("Open the flow's draft (`path`), made from the project's commit when there is none"),
  'GET /api/v1/drafts/:id': S(
    'Editing',
    'signed in',
    D,
  )('A draft, and its flow as the designer shows it'),
  'GET /api/v1/drafts/:id/events': S(
    'Editing',
    'signed in',
    D,
  )(
    'A draft as it changes, as server-sent events: `draft`, `edit` (who, which steps and fields, the flow after), `people`, `saving` (send what is being typed, then answer `/flushed`), `saved`, `discarded`; `tab` names the page',
  ),
  'POST /api/v1/drafts/:id/commands': S(
    'Editing',
    'signed in',
    D,
  )("One of the designer's commands, on the draft as it is now"),
  'POST /api/v1/drafts/:id/undo': S(
    'Editing',
    'signed in',
    D,
  )(
    "Take back the caller's own last edit (`nothing` when there is none); refused when someone changed the same place since",
  ),
  'POST /api/v1/drafts/:id/redo': S(
    'Editing',
    'signed in',
    D,
  )(
    "Bring back what the caller's own last undo took, while they made no edit since (`nothing` when there is none); refused when someone changed the same place since",
  ),
  'POST /api/v1/drafts/:id/tidy': S('Editing', 'signed in', D)('Lay out a level (`level`) again'),
  'POST /api/v1/drafts/:id/here': S(
    'Editing',
    'signed in',
    D,
  )('Say the caller is in the draft, and which step they have selected (`node`)'),
  'POST /api/v1/drafts/:id/flushed': S(
    'Editing',
    'signed in',
    D,
  )("Say a page sent what it was typing for a save (the `saving` event's `flush` and `stream`)"),
  'POST /api/v1/drafts/:id/save': S(
    'Editing',
    'signed in',
    D,
  )(
    "Save the draft as one commit on the project's branch (merged first when the branch moved; `choices` keeps the draft's or the branch's side per conflict, `force` the draft's side of the rest)",
  ),
  'DELETE /api/v1/drafts/:id': S(
    'Editing',
    'signed in',
    D,
  )(
    "Discard the draft (the other pages send what they are typing first; `tab` names the caller's page); it can be brought back for 15 minutes",
  ),
  'POST /api/v1/projects/:id/drafts/restore': S(
    'Editing',
    'signed in',
    P,
  )(
    "Bring back a draft of the flow (`path`) discarded in the last 15 minutes (`draft`, its old id), as the flow's draft again with its edits and who made them; when the flow has a new draft, merged into it (`merged`; `kept` lists the places where the new draft's value stayed); asked again, it answers the draft it went to",
  ),
  'GET /api/v1/drafts/:id/summary': S(
    'Editing',
    'signed in',
    D,
  )(
    "What the draft changes against the commit it began at, step by step (and notes and the flow's fields), with who changed each place, the steps moved on the canvas and by whom (`moves`) and the files Save adds (`files`); `changed` says whether there is anything to save",
  ),
  'POST /api/v1/drafts/:id/leave': S(
    'Editing',
    'signed in',
    D,
  )(
    "Say the caller's page (`tab`) left the draft; a draft that changes nothing, with nobody else in it, is dropped (`dropped`)",
  ),
  'GET /api/v1/drafts/:id/start-from': S(
    'Editing',
    'signed in',
    D,
  )("What an empty flow can start from: samples, the repository's playbooks, AWX credentials"),
  'GET /api/v1/drafts/:id/start-from/awx': S(
    'Editing',
    'signed in',
    D,
  )("An AWX credential's workflow and job templates (`credential`)"),
  'POST /api/v1/drafts/:id/start-from': S(
    'Editing',
    'signed in',
    D,
  )('An empty flow made from a sample, a playbook of the repository or an AWX template'),
  'POST /api/v1/drafts/:id/catalog': S(
    'Editing',
    'signed in',
    D,
  )(
    "The module catalog of the flow's image, as the designer asks it (search, doc, names, status, rebuild); 202 while it is first read",
  ),
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
  )("A workspace's credentials (never their secrets)", list('Credential')),
  'POST /api/v1/workspaces/:id/credentials': S(
    'Credentials',
    'administrators',
    W,
  )('Add a credential; its secret goes in and is never shown', one('Credential', 201)),
  'GET /api/v1/credentials/:id': S(
    'Credentials',
    'signed in',
    K,
  )('One credential', one('Credential')),
  'PATCH /api/v1/credentials/:id': S(
    'Credentials',
    'administrators',
    K,
  )('Change a credential, or replace its secret', one('Credential')),
  'DELETE /api/v1/credentials/:id': S(
    'Credentials',
    'administrators',
    K,
  )('Delete a credential (refused while used)', EMPTY),
  // AFS-241: secret parts taken from a secret provider.
  'GET /api/v1/workspaces/:id/secret-providers': S(
    'Credentials',
    'administrators',
    W,
  )('The secret providers open to the workspace: what a credential may read its secrets from'),
  'POST /api/v1/workspaces/:id/secret-refs/test': S(
    'Credentials',
    'administrators',
    W,
  )('Test read of a reference to a secret provider: whether it reads, never the value'),

  'GET /api/v1/projects/:id/launch-configs': S(
    'Launch configurations',
    'signed in',
    P,
  )(
    "A project's launch configurations, each with its newest run you may see (`lastRun`)",
    list('LaunchConfig'),
  ),
  'POST /api/v1/projects/:id/launch-configs': S(
    'Launch configurations',
    'administrators',
    P,
  )('Add a launch configuration (saved only if it could run)', one('LaunchConfig', 201)),
  'GET /api/v1/launch-configs/:id': S(
    'Launch configurations',
    'signed in',
    C,
  )('One launch configuration, with its newest run you may see (`lastRun`)', one('LaunchConfig')),
  'PATCH /api/v1/launch-configs/:id': S(
    'Launch configurations',
    'administrators',
    C,
  )('Change a launch configuration', one('LaunchConfig')),
  'DELETE /api/v1/launch-configs/:id': S(
    'Launch configurations',
    'administrators',
    C,
  )('Delete a launch configuration', EMPTY),
  'GET /api/v1/launch-configs/:id/form': S(
    'Launch configurations',
    'signed in',
    C,
  )("The launch form: the flow's inputs with their start values", one('LaunchForm')),
  'POST /api/v1/launch-configs/:id/check': S(
    'Launch configurations',
    'signed in',
    C,
  )('What a launch would run, or what stands in its way (422)', json(ANSWERS.launchCheck)),
  'POST /api/v1/launch-configs/:id/facts': S(
    'Launch configurations',
    'signed in',
    C,
  )(
    "The hosts a launch would touch, read from the inventory in the launch's image; with groups: true, the inventory's groups too",
    json(ANSWERS.facts),
  ),
  'POST /api/v1/launch-configs/:id/launch': S(
    'Launch configurations',
    'administrators',
    C,
  )('Launch: the run goes in the queue', one('Run', 201)),

  'GET /api/v1/actions': S(
    'Actions',
    'signed in',
    'self',
  )(
    'The actions you may run (title, sentence, workspace), each with your newest run of it',
    list('ActionCard'),
  ),
  'GET /api/v1/actions/:id': S(
    'Actions',
    'may run the action',
    C,
  )(
    "An action's form: only the inputs it asks (label, help, choices), what will happen in words, whom to ask",
    one('ActionForm'),
  ),
  'GET /api/v1/actions/:id/link': S(
    'Actions',
    'may run the action',
    C,
  )(
    'AFS-176: what a link to an action gives (its query: values by input name, `_reply` where the result goes back): the form, the values, what is missing or not right, and whether it is ready to confirm. Nothing runs',
    json(ANSWERS.actionLink),
  ),
  'GET /api/v1/actions/:id/hosts': S(
    'Actions',
    'may run the action',
    C,
  )(
    "The inventory's hosts and groups by name, for a host list the action asks",
    json(ANSWERS.actionHosts),
  ),
  'POST /api/v1/actions/:id/run': S(
    'Actions',
    'may run the action',
    C,
  )(
    'Run an action with the values it asks (inputs by name); an input it does not ask is refused. The run goes in the queue. `reply` (a NetBox object `dcim.device:1`, a Zabbix event `event:2048`) is where its result goes back when the action says so. A system with no person runs it with a signed link: `Authorization: Bearer afsl_…`, in the header only',
    json(ANSWERS.actionRunStarted, 201),
  ),
  'GET /api/v1/actions/runs/:id': S(
    'Actions',
    'may run the action',
    R,
  )(
    'How a run of an action goes, in words: steps done of N, who an approval waits for, done or failed and why, whom to ask',
    one('ActionProgress'),
  ),
  'GET /api/v1/actions/runs/:id/events': S(
    'Actions',
    'may run the action',
    R,
  )(
    'The same, live, as server-sent events: progress, end',
    EVENTS('progress: the run of the action as it goes'),
  ),
  'GET /api/v1/launch-configs/:id/action': S(
    'Actions',
    'signed in',
    C,
  )(
    "A launch configuration's action (null when it is none), and who may run it",
    json(ANSWERS.actionSettings),
  ),
  'PUT /api/v1/launch-configs/:id/action': S(
    'Actions',
    'administrators',
    C,
  )(
    'Make a launch configuration an action, or change it: title, sentence, the inputs it asks, mode, confirm, on or off',
    one('Action'),
  ),
  'DELETE /api/v1/launch-configs/:id/action': S(
    'Actions',
    'administrators',
    C,
  )('Stop a launch configuration being an action (its grants go too)', EMPTY),
  'POST /api/v1/launch-configs/:id/action/grants': S(
    'Actions',
    'administrators',
    C,
  )('Let a user or group run the action (nothing else of the workspace)', one('ActionGrant', 201)),
  'DELETE /api/v1/launch-configs/:id/action/grants/:grant': S(
    'Actions',
    'administrators',
    C,
  )('Take back who may run the action', EMPTY),
  'GET /api/v1/launch-configs/:id/action/tokens': S(
    'Actions',
    'administrators',
    C,
  )("An action's signed links, by name (never the tokens)", list('ActionToken')),
  'POST /api/v1/launch-configs/:id/action/tokens': S(
    'Actions',
    'administrators',
    C,
  )(
    'Make a signed link for a system with no person (a Zabbix action, a NetBox webhook): a token that runs this action only, as you, shown this once. In a session only',
    json(ANSWERS.newActionToken, 201),
  ),
  'DELETE /api/v1/launch-configs/:id/action/tokens/:token': S(
    'Actions',
    'administrators',
    C,
  )('Revoke a signed link: it stops at once', EMPTY),
  'GET /api/v1/workspaces/:id/action-grants': S(
    'Actions',
    'administrators',
    W,
  )("Who may run the workspace's actions", list('ActionGrant')),
  'GET /api/v1/workspaces/:id/actions': S(
    'Actions',
    'administrators',
    W,
  )(
    'Every action of the workspace, on or off, with who may run it through a grant (operators of its flow and administrators may too)',
    json({ type: 'array', items: ANSWERS.workspaceAction }),
  ),

  'GET /api/v1/runs': S('Runs', 'signed in', { projectQuery: 'project', configQuery: 'config' })(
    "Runs, newest first; filters project, flow, state, config (a launch configuration), by (who asked, a login), q (words in the flow's name or file, the configuration's name or a login; or a run number); `limit` and `before` (the last run's createdAt,number,id, or a time) for paging",
    list('Run'),
  ),
  'GET /api/v1/runs/:id': S(
    'Runs',
    'signed in',
    R,
  )(
    'One run, with its credentials by name (`credentialNames`), the environment its image came from (`environment`) and the targets Ansible skipped because the inventory does not have them (`skippedTargets`)',
    one('Run'),
  ),
  'GET /api/v1/runs/:id/output': S(
    'Runs',
    'signed in',
    R,
  )('What Ansible wrote, secrets hidden (text); `from` for what came after', {
    text: 'text/plain',
    description: "The run's output, as text",
  }),
  'GET /api/v1/runs/:id/view': S(
    'Runs',
    'signed in',
    R,
  )('How the run went, step by step, as the designer shows it', json(ANSWERS.runView)),
  'GET /api/v1/runs/:id/hosts/:node/:host': S(
    'Runs',
    'signed in',
    R,
  )('What one host did in one step', json(ANSWERS.hostOutput)),
  'GET /api/v1/runs/:id/hosts/:host': S(
    'Runs',
    'signed in',
    R,
  )('What one host did in the run, step by step', json(ANSWERS.hostSteps)),
  'GET /api/v1/runs/:id/events': S(
    'Runs',
    'signed in',
    R,
  )(
    'The run as it goes, as server-sent events: run, view, output, end',
    EVENTS('run, view, output and end: the run as it goes'),
  ),
  'POST /api/v1/runs/:id/cancel': S('Runs', 'administrators', R)('Stop a run', one('Run', 202)),
  'POST /api/v1/runs/:id/step': S(
    'Runs',
    'administrators',
    R,
  )(
    'Drive a step-by-step run: `command` step (run the next step, pause again), continue (run on to a pause point), pause (pause before the next step), stop (end before the next step), retry (a debug run paused where hosts failed: run the step again on them; changes on hosts are not undone); `points`: new pause points (node ids, or in a debug run {node, condition, hits, log}); `failures` {failed, unreachable}: which failures pause a debug run. A debug run is driven by who launched it and administrators (Stop: operators too)',
    one('Run', 202),
  ),
  'POST /api/v1/runs/:id/inspect': S(
    'Runs',
    'signed in',
    R,
  )(
    "Ask a paused debug run (who launched it, or an administrator): `op` scopes (a host's scopes; `facts` lists facts too), vars (`scope`, `path`, `start`, `count`), facts, eval (`expr` for `host`; lookups refused, 2 s limit) or watch (`exprs` for `hosts`, all paused hosts by default). Waits for the run's answer, masked by the run. 409 when the run is not a debug run or goes on another server; 410 when the pause or the run has ended. Audited with the op and the expression, never the answer",
    json(ANSWERS.inspect),
  ),
  'GET /api/v1/runs/:id/debug': S(
    'Runs',
    'signed in',
    R,
  )(
    "What a debug run's pauses showed (scopes and watches, masked), kept with the run (at most 1 MB): for who launched it and administrators",
    json(ANSWERS.debugKept),
  ),
  'GET /api/v1/projects/:id/approvers': S(
    'Approvals',
    'signed in',
    P,
  )(
    'Who an approval of a flow (`path`) asks when its approvers are empty: the people and groups holding approve on the flow or its workspace, by name; and whether the workspace lets who launched a run decide it (`selfApprove`)',
  ),
  'GET /api/v1/projects/:id/pause-points': S(
    'Runs',
    'signed in',
    P,
  )(
    'Your pause points on a flow (`path`): the steps your step-by-step runs of it pause before',
    json(ANSWERS.pausePoints),
  ),
  'PUT /api/v1/projects/:id/pause-points': S(
    'Runs',
    'signed in',
    P,
  )(
    'Keep your pause points on a flow (`path`, body `points`: node ids, or {node, condition, hits, log} for debug runs; `failures` {failed, unreachable}: which failures pause your debug runs); your step-by-step runs of it going now get them too',
    json(ANSWERS.pausePoints),
  ),
  'GET /api/v1/runs/:id/relaunch': S(
    'Runs',
    'signed in',
    R,
  )(
    "What Run again offers: the run's hosts in sets (failed, unreachable, stopped, handled, notOk) with the step each went wrong at, the outcome line, what a host limit changes in the flow (`risks`), and its approvals",
  ),
  'POST /api/v1/runs/:id/relaunch': S(
    'Runs',
    'administrators',
    R,
  )(
    "The run again, as a new run, through the launch's checks (its configuration's credentials now; approvals are asked again). Body, every field optional: `hosts` all (default), not-ok, failed, unreachable, stopped, or names of its hosts (at most 5000; they go to a limit file); `includeHandled` adds hosts whose failure the flow handled; `mode` check or real; `step` {every, points, timeoutMinutes, debug, pauseOnFailure, failures} or null (a debug run needs rw on the flow, or operator where the workspace lets operators debug); `commit` same (default) or newest. 409 while the run goes; 422 for an empty set, a run that reached no host, a host not of the run, a pause point not in the flow",
    one('Run', 201),
  ),

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
  'GET /api/v1/workspaces/:id/recipients': S(
    'Launch configurations',
    'signed in',
    W,
  )('Whom a launch configuration can tell: logins (with names) and group names, no addresses'),
  'GET /api/v1/projects/:id/access': S(
    'Access',
    'signed in',
    P,
  )('What you may do in a project: your level on it and on each flow'),
  'GET /api/v1/approvals': S(
    'Approvals',
    'signed in',
    'server',
  )(
    'Approvals that wait for a decision, that you may see; each says whether you may decide it. `?decided=1`: the newest 50 decided ones instead',
    list('WaitingApproval'),
  ),
  'GET /api/v1/runs/:id/approvals': S(
    'Approvals',
    'signed in',
    R,
  )(
    "A run's approvals: waiting or decided, by whom, when, why; whether you may decide each",
    list('Gate'),
  ),
  'POST /api/v1/runs/:id/approvals/:node': S(
    'Approvals',
    'signed in',
    R,
  )(
    'Decide an approval the run waits at: approved or rejected, with a comment; the run goes on',
    one('Gate'),
  ),
  'GET /api/v1/audit': S(
    'Audit',
    'administrators',
    'server',
  )(
    'The audit log, newest first, filtered; `before` for older entries; `refs`: the workspaces, projects, launch configurations and runs it names by id that still exist (name, page)',
  ),
  'GET /api/v1/audit/export': S(
    'Audit',
    'administrators',
    'server',
  )('The audit log as a CSV or JSON file'),
  'POST /api/v1/projects/:id/dev-bundles': S(
    'Launch',
    'signed in',
    P,
  )(
    'Send unpushed work as a git bundle (application/x-git-bundle, one ref) for a dev run: a check run of it',
  ),
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
  )('Turn email off (forget the mail server)'),
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
  'GET /api/v1/workspaces/:id/environments': S(
    'Environments',
    'signed in',
    W,
  )(
    "A workspace's execution environments, with the image a launch gets now and the newest build",
    list('Environment'),
  ),
  'POST /api/v1/workspaces/:id/environments': S(
    'Environments',
    'signed in',
    W,
  )(
    'Add an execution environment: a spec the server builds (`kind: spec`), or a registered image (`kind: image`)',
    one('Environment', 201),
  ),
  'GET /api/v1/environments/:id': S(
    'Environments',
    'signed in',
    E,
  )('One execution environment', one('Environment')),
  'PATCH /api/v1/environments/:id': S(
    'Environments',
    'signed in',
    E,
  )(
    'Change an execution environment; a new spec takes effect at its next build',
    one('Environment'),
  ),
  'DELETE /api/v1/environments/:id': S(
    'Environments',
    'signed in',
    E,
  )(
    'Delete an execution environment no launch configuration uses, with its builds and images',
    EMPTY,
  ),
  'GET /api/v1/environments/:id/builds': S(
    'Environments',
    'signed in',
    E,
  )(
    'Its builds, newest first: state, image, the versions settled (lock), what the image holds (catalog)',
    list('EnvironmentBuild'),
  ),
  'POST /api/v1/environments/:id/builds': S(
    'Environments',
    'signed in',
    E,
  )(
    'Build it now (a registered image: pull it and read what it holds); builds go one at a time',
    one('EnvironmentBuild', 201),
  ),
  'GET /api/v1/environments/:id/builds/:build/log': S(
    'Environments',
    'signed in',
    E,
  )("A build's log, as text", { text: 'text/plain', description: 'The build log, as text' }),
  'GET /api/v1/environments/:id/execution-environment.yml': S(
    'Environments',
    'signed in',
    E,
  )('The environment as ansible-builder v3 reads it, for AWX or AAP'),
  'GET /api/v1/default-environment': S(
    'Environments',
    'signed in',
    'self',
  )(
    "The server's default image: what runs get when their launch configuration names no environment or image; the environment picked for it, else AFS_EE_IMAGE",
  ),
  'PUT /api/v1/default-environment': S(
    'Environments',
    'administrators',
    'server',
  )(
    "Pick the environment whose image is the server's default (`environment`: its id), or null for AFS_EE_IMAGE",
  ),
  'GET /api/v1/search': S(
    'Search',
    'signed in',
    'self',
  )(
    'What the words name, among what the caller may see: workspaces, projects, flows, launch configurations, runs (by number too), environments; people and groups for administrators. Each with the page it opens',
  ),
  'GET /api/v1/galaxy/search': S(
    'Environments',
    'signed in',
    'self',
  )(
    'Collections on the collection server (AFS_GALAXY_URL) whose name or description has the words: newest version, description',
  ),
  'GET /api/v1/launch-configs/:id/environment-check': S(
    'Environments',
    'signed in',
    C,
  )(
    "What the configuration's flow needs (its steps and collections/requirements.yml) against what its environment's image holds, or another environment's (`environment`)",
    json(ANSWERS.environmentCheck),
  ),
  'POST /api/v1/launch-configs/:id/environment': S(
    'Environments',
    'signed in',
    C,
  )(
    "Make an environment for the configuration's flow (`name`), its spec from what the flow needs, and build it; rw on the workspace",
  ),
  'GET /api/v1/launch-configs/:id/schedules': S(
    'Schedules',
    'signed in',
    C,
  )("A launch configuration's schedules: their rule, next times and last fire", list('Schedule')),
  'POST /api/v1/launch-configs/:id/schedules': S(
    'Schedules',
    'signed in',
    C,
  )(
    'Run the launch configuration on a cron (`cron`, `timezone`) or once (`onceAt`); the caller owns the schedule and its runs are checked against the owner’s grants when they fire',
    one('Schedule', 201),
  ),
  'PATCH /api/v1/launch-configs/:id/schedules/:schedule': S(
    'Schedules',
    'signed in',
    C,
  )('Change a schedule; `owner` (a service account) only by an administrator', one('Schedule')),
  'DELETE /api/v1/launch-configs/:id/schedules/:schedule': S(
    'Schedules',
    'signed in',
    C,
  )('Delete a schedule', EMPTY),
  'GET /api/v1/schedule-times': S(
    'Schedules',
    'signed in',
    'self',
  )(
    'The next times a cron expression fires in a time zone, or why it cannot be read; with `check=1`, every problem in `problems` (each with its field) instead of a refusal',
    json(ANSWERS.scheduleTimes),
  ),
  // AFS-30: sign-in with OIDC providers.
  'GET /api/v1/auth/methods': S(
    'Session',
    'anyone',
    'anyone',
  )(
    'How people may sign in: with a password (everyone, or administrators only) and which providers',
  ),
  'GET /api/v1/auth/oidc/:key/start': S(
    'Session',
    'anyone',
    'anyone',
  )('Sign in with a provider: to its sign-in page (`return`: the page to come back to)'),
  'GET /api/v1/auth/oidc/:key/callback': S(
    'Session',
    'anyone',
    'anyone',
  )('Back from the provider: a session, then the page asked for (the provider calls this)'),
  'GET /api/v1/admin/oidc-providers': S(
    'Sign-in',
    'administrators',
    'server',
  )('The sign-in providers, each with the address to register at the provider (`redirectUri`)'),
  'POST /api/v1/admin/oidc-providers': S(
    'Sign-in',
    'administrator session',
    'server',
  )(
    'Add a provider: issuer, client id and secret, scopes, the groups claim and what its values are here',
  ),
  'GET /api/v1/admin/oidc-providers/:id': S('Sign-in', 'administrators', 'server')('One provider'),
  'PATCH /api/v1/admin/oidc-providers/:id': S(
    'Sign-in',
    'administrator session',
    'server',
  )('Change a provider; a secret left out is kept, null removes it'),
  'DELETE /api/v1/admin/oidc-providers/:id': S(
    'Sign-in',
    'administrator session',
    'server',
  )('Remove a provider; its people stay, the groups and administrator rights it gave go'),
  'POST /api/v1/admin/oidc-providers/:id/test': S(
    'Sign-in',
    'administrators',
    'server',
  )('Whether the provider answers its discovery, and what it offers'),
  // AFS-241: secret providers (HashiCorp Vault, CyberArk Conjur and CCP, AWS Secrets Manager).
  'GET /api/v1/admin/secret-providers': S(
    'Secret providers',
    'administrators',
    'server',
  )('The secret providers credentials may read their secrets from (never their own secrets)'),
  'POST /api/v1/admin/secret-providers': S(
    'Secret providers',
    'administrator session',
    'server',
  )(
    'Add a secret provider: its kind, address, CA, timeout, its own settings, its secret part (never shown again) and the workspaces that may use it',
  ),
  'GET /api/v1/admin/secret-providers/:id': S(
    'Secret providers',
    'administrators',
    'server',
  )('One secret provider, with the credentials that read from it (`uses`)'),
  'PATCH /api/v1/admin/secret-providers/:id': S(
    'Secret providers',
    'administrator session',
    'server',
  )('Change a secret provider; a secret part left out is kept, one given replaces it whole'),
  'DELETE /api/v1/admin/secret-providers/:id': S(
    'Secret providers',
    'administrator session',
    'server',
  )('Remove a secret provider (refused while a credential reads from it)'),
  'POST /api/v1/admin/secret-providers/:id/test': S(
    'Secret providers',
    'administrators',
    'server',
  )('Sign in to the provider; with `ref`, read that secret too. The value is never answered'),
  // AFS-53: event streaming to syslog and OpenTelemetry.
  'GET /api/v1/admin/streams': S(
    'Event streaming',
    'administrators',
    'server',
  )('The event streaming destinations, each with its backlog, drops, last success and last error'),
  'POST /api/v1/admin/streams': S(
    'Event streaming',
    'administrator session',
    'server',
  )(
    'Add a destination: a syslog receiver (TLS, TCP or UDP) or an OpenTelemetry collector (OTLP/HTTP JSON), and what it gets (audit entries, runs)',
  ),
  'GET /api/v1/admin/streams/:id': S(
    'Event streaming',
    'administrators',
    'server',
  )('One destination'),
  'PATCH /api/v1/admin/streams/:id': S(
    'Event streaming',
    'administrator session',
    'server',
  )('Change a destination; a header sent without its value keeps the value it has'),
  'DELETE /api/v1/admin/streams/:id': S(
    'Event streaming',
    'administrator session',
    'server',
  )('Remove a destination and what waits to go to it'),
  'POST /api/v1/admin/streams/:id/test': S(
    'Event streaming',
    'administrators',
    'server',
  )('Send a test message to a destination now, and say how it went'),
  // AFS-31: LDAP and Active Directory directories.
  'GET /api/v1/admin/ldap-directories': S(
    'Sign-in',
    'administrators',
    'server',
  )('The LDAP and Active Directory directories people sign in with, in the order they are tried'),
  'POST /api/v1/admin/ldap-directories': S(
    'Sign-in',
    'administrator session',
    'server',
  )(
    'Add a directory: address, service account, where people and groups are, what the groups are here',
  ),
  'GET /api/v1/admin/ldap-directories/:id': S(
    'Sign-in',
    'administrators',
    'server',
  )('One directory'),
  'PATCH /api/v1/admin/ldap-directories/:id': S(
    'Sign-in',
    'administrator session',
    'server',
  )('Change a directory; a bind password left out is kept, null removes it'),
  'DELETE /api/v1/admin/ldap-directories/:id': S(
    'Sign-in',
    'administrator session',
    'server',
  )('Remove a directory; its people stay, the groups, rights and disabling it gave go'),
  'POST /api/v1/admin/ldap-directories/:id/test': S(
    'Sign-in',
    'administrators',
    'server',
  )(
    'Whether the service account binds; with `login`, the entry found and its groups (no password)',
  ),
  'POST /api/v1/admin/ldap-directories/:id/sync': S(
    'Sign-in',
    'administrator session',
    'server',
  )(
    "Bring the directory's people in step now: names, groups, administrator; those it no longer has are disabled",
  ),
  'GET /api/v1/admin/sign-in': S(
    'Sign-in',
    'administrators',
    'server',
  )('Who may sign in with a password here'),
  'PUT /api/v1/admin/sign-in': S(
    'Sign-in',
    'administrator session',
    'server',
  )('Passwords for everyone (`all`) or administrators only (`admins`)'),
  'GET /api/v1/certificate.pem': S(
    'Certificate',
    'anyone',
    'anyone',
  )('The server certificate in use, for git and scripts to trust a self-signed one'),
  'GET /api/v1/admin/certificate': S(
    'Certificate',
    'administrators',
    'server',
  )('The server certificate in use, the one before it, a waiting request, and whether TLS is on'),
  'GET /api/v1/admin/certificate/history': S(
    'Certificate',
    'administrators',
    'server',
  )('Every change made to the server certificate, newest first'),
  'GET /api/v1/admin/certificate/request.pem': S(
    'Certificate',
    'administrators',
    'server',
  )('The waiting certificate request, as a file for a certificate authority'),
  'POST /api/v1/admin/certificate/request': S(
    'Certificate',
    'administrator session',
    'server',
  )(
    'Make a new key and a request for a certificate authority (`names`, `organization`); the key stays with the server',
  ),
  'POST /api/v1/admin/certificate/install': S(
    'Certificate',
    'administrator session',
    'server',
  )(
    'Install a signed certificate (its chain may follow it), with its key or for the waiting request or the key in use; 422 with every reason it is refused',
  ),
  'POST /api/v1/admin/certificate/self-signed': S(
    'Certificate',
    'administrator session',
    'server',
  )(
    'Replace the certificate with a new self-signed one (`names`, else the names the server is reached by)',
  ),
  'POST /api/v1/admin/certificate/rollback': S(
    'Certificate',
    'administrator session',
    'server',
  )('Go back to the certificate that was in use before'),
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
  // AFS-206: the pushes' messages and authors are the repository's: ro on it, as History.
  'GET /api/v1/projects/:id/pushes': 'ro',
  'GET /api/v1/projects/:id/flows': 'can see',
  'GET /api/v1/projects/:id/access': 'can see',
  'GET /api/v1/projects/:id/flows/view': 'ro',
  'POST /api/v1/projects/:id/flows/catalog': 'ro',
  'GET /api/v1/projects/:id/events': 'can see',
  'GET /api/v1/projects/:id/drafts': 'can see',
  'POST /api/v1/projects/:id/drafts': 'rw',
  'GET /api/v1/drafts/:id': 'ro',
  'GET /api/v1/drafts/:id/events': 'ro',
  'POST /api/v1/drafts/:id/commands': 'rw',
  'POST /api/v1/drafts/:id/undo': 'rw',
  'POST /api/v1/drafts/:id/redo': 'rw',
  'POST /api/v1/drafts/:id/tidy': 'rw',
  'POST /api/v1/drafts/:id/here': 'ro',
  'POST /api/v1/drafts/:id/flushed': 'ro',
  'POST /api/v1/drafts/:id/save': 'rw',
  'DELETE /api/v1/drafts/:id': 'rw',
  'POST /api/v1/projects/:id/drafts/restore': 'rw',
  'GET /api/v1/drafts/:id/summary': 'ro',
  'POST /api/v1/drafts/:id/leave': 'ro',
  'POST /api/v1/drafts/:id/catalog': 'ro',
  'GET /api/v1/drafts/:id/start-from': 'rw',
  'GET /api/v1/drafts/:id/start-from/awx': 'rw',
  'POST /api/v1/drafts/:id/start-from': 'rw',
  'GET /api/v1/projects/:id/changes': 'can see',
  'GET /api/v1/projects/:id/flows/history': 'ro',
  'GET /api/v1/projects/:id/commits': 'ro',
  'GET /api/v1/projects/:id/commits/:commit': 'ro',
  'GET /api/v1/projects/:id/flows/commit': 'ro',
  'GET /api/v1/projects/:id/files': 'ro',
  'GET /api/v1/projects/:id/files/content': 'ro',
  'GET /api/v1/projects/:id/files/history': 'ro',
  'POST /api/v1/projects/:id/vars': 'ro',
  'POST /api/v1/projects/:id/files': 'rw on the workspace',
  'POST /api/v1/projects/:id/sync': 'rw on the workspace',
  'GET /api/v1/projects/:id/host-key': 'ro',
  'POST /api/v1/projects/:id/branches': 'rw on the workspace',
  'DELETE /api/v1/projects/:id/branches': 'rw on the workspace',
  'POST /api/v1/projects/:id/start': 'rw on the workspace',
  'GET /git/:workspace/:repo/info/refs': 'ro on the workspace',
  'POST /git/:workspace/:repo/git-upload-pack': 'ro on the workspace',
  'POST /git/:workspace/:repo/git-receive-pack': 'rw on the workspace',
  'GET /api/v1/workspaces/:id/credentials': 'ro on the workspace',
  'GET /api/v1/workspaces/:id/recipients': 'rw on the workspace',
  'GET /api/v1/credentials/:id': 'ro on the workspace',
  'GET /api/v1/projects/:id/launch-configs': 'can see',
  // The flow is in the body: the handler asks for rw on it.
  'POST /api/v1/projects/:id/launch-configs': 'can see',
  'GET /api/v1/launch-configs/:id': 'ro',
  'PATCH /api/v1/launch-configs/:id': 'rw',
  'DELETE /api/v1/launch-configs/:id': 'rw',
  'GET /api/v1/launch-configs/:id/form': 'ro',
  'POST /api/v1/launch-configs/:id/check': 'ro',
  // AFS-67: it starts a container, so it is for who may launch.
  'POST /api/v1/launch-configs/:id/facts': 'operator',
  // Another branch or commit than the configuration's: the handler asks for rw.
  'POST /api/v1/launch-configs/:id/launch': 'operator',
  // AFS-32: environments are read by who sees the workspace, set up by who may push to it.
  'GET /api/v1/workspaces/:id/environments': 'ro on the workspace',
  'POST /api/v1/workspaces/:id/environments': 'rw on the workspace',
  'GET /api/v1/environments/:id': 'ro on the workspace',
  'PATCH /api/v1/environments/:id': 'rw on the workspace',
  'DELETE /api/v1/environments/:id': 'rw on the workspace',
  'GET /api/v1/environments/:id/builds': 'ro on the workspace',
  'POST /api/v1/environments/:id/builds': 'rw on the workspace',
  'GET /api/v1/environments/:id/builds/:build/log': 'ro on the workspace',
  'GET /api/v1/environments/:id/execution-environment.yml': 'ro on the workspace',
  // AFS-33: the check reads like the configuration; making an environment asks rw on the workspace too.
  'GET /api/v1/launch-configs/:id/environment-check': 'ro',
  'POST /api/v1/launch-configs/:id/environment': 'rw',
  // AFS-34: schedules are set up by who manages the configuration.
  'GET /api/v1/launch-configs/:id/schedules': 'ro',
  'POST /api/v1/launch-configs/:id/schedules': 'rw',
  'PATCH /api/v1/launch-configs/:id/schedules/:schedule': 'rw',
  'DELETE /api/v1/launch-configs/:id/schedules/:schedule': 'rw',
  // AFS-26: unpushed work comes from someone who may push.
  'POST /api/v1/projects/:id/dev-bundles': 'rw on the workspace',
  'GET /api/v1/runs/:id': 'ro',
  // AFS-175: who sets up actions and gives them: rw on the workspace (ADR-0036).
  'GET /api/v1/launch-configs/:id/action': 'ro',
  'PUT /api/v1/launch-configs/:id/action': 'rw on the workspace',
  'DELETE /api/v1/launch-configs/:id/action': 'rw on the workspace',
  'POST /api/v1/launch-configs/:id/action/grants': 'rw on the workspace',
  'DELETE /api/v1/launch-configs/:id/action/grants/:grant': 'rw on the workspace',
  'GET /api/v1/workspaces/:id/action-grants': 'rw on the workspace',
  'GET /api/v1/workspaces/:id/actions': 'rw on the workspace',
  // AFS-176: signed links are made and revoked by who sets up the action.
  'GET /api/v1/launch-configs/:id/action/tokens': 'rw on the workspace',
  'POST /api/v1/launch-configs/:id/action/tokens': 'rw on the workspace',
  'DELETE /api/v1/launch-configs/:id/action/tokens/:token': 'rw on the workspace',
  'GET /api/v1/runs/:id/output': 'ro',
  'GET /api/v1/runs/:id/view': 'ro',
  'GET /api/v1/runs/:id/hosts/:node/:host': 'ro',
  'GET /api/v1/runs/:id/hosts/:host': 'ro',
  'GET /api/v1/runs/:id/events': 'ro',
  'POST /api/v1/runs/:id/cancel': 'operator',
  // AFS-177: who may stop a run may drive it step by step (the person who launched it is
  // operator on its flow; administrators too).
  'POST /api/v1/runs/:id/step': 'operator',
  // AFS-179: who launched a debug run and administrators: checked by the handler.
  'POST /api/v1/runs/:id/inspect': 'operator',
  'GET /api/v1/runs/:id/debug': 'operator',
  'GET /api/v1/projects/:id/pause-points': 'ro',
  'GET /api/v1/projects/:id/approvers': 'ro',
  'PUT /api/v1/projects/:id/pause-points': 'operator',
  'GET /api/v1/runs/:id/relaunch': 'ro',
  // AFS-240: another branch or commit than its configuration names, a dev run, and a debug run
  // need rw on the flow: checked by the handler.
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
const FLOW_QUERY: Record<string, string> = {
  'GET /api/v1/projects/:id/flows/view': 'path',
  'POST /api/v1/projects/:id/flows/catalog': 'path',
  'POST /api/v1/projects/:id/drafts': 'path',
  'POST /api/v1/projects/:id/drafts/restore': 'path',
  'GET /api/v1/projects/:id/flows/history': 'path',
  'GET /api/v1/projects/:id/commits': 'path',
  'GET /api/v1/projects/:id/flows/commit': 'path',
  'GET /api/v1/projects/:id/pause-points': 'path',
  'GET /api/v1/projects/:id/approvers': 'path',
  'PUT /api/v1/projects/:id/pause-points': 'path',
};

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
  if ('projectQuery' in reach) {
    if (query[reach.projectQuery]) return ofProject(query[reach.projectQuery]);
    // No project named, a launch configuration is: the list reaches that one's project.
    const config = reach.configQuery ? query[reach.configQuery] : undefined;
    if (!config) return undefined;
    const row = await db
      .selectFrom('launch_config')
      .select('project_id')
      .where('id', '=', config)
      .executeTakeFirst();
    return row ? ofProject(row.project_id) : undefined;
  }
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
  if ('environment' in reach) {
    const id = params[reach.environment];
    const row = id
      ? await db
          .selectFrom('environment')
          .select('workspace_id')
          .where('id', '=', id)
          .executeTakeFirst()
      : undefined;
    return row ? { workspace: row.workspace_id } : undefined;
  }
  if ('draft' in reach) {
    const id = params[reach.draft];
    const row = id
      ? await db
          .selectFrom('flow_draft')
          .innerJoin('project', 'project.id', 'flow_draft.project_id')
          .select(['project.workspace_id', 'flow_draft.project_id', 'flow_draft.file'])
          .where('flow_draft.id', '=', id)
          .executeTakeFirst()
      : undefined;
    return row
      ? { workspace: row.workspace_id, project: row.project_id, file: row.file }
      : undefined;
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

const STATUS_WORDS: Record<number, string> = {
  200: 'Done',
  201: 'Made',
  202: 'Accepted: it goes on after this answer',
};

/** AFS-245: a route's answers, as OpenAPI writes them. */
export function answered(answer: Answer): Record<string, unknown> {
  if ('empty' in answer) return { '204': { description: answer.description ?? 'Done' } };
  if ('text' in answer)
    return {
      '200': {
        description: answer.description,
        content: { [answer.text]: { schema: { type: 'string' } } },
      },
    };
  if ('events' in answer)
    return {
      '200': {
        description: `Server-sent events: ${answer.events}`,
        content: { 'text/event-stream': { schema: { type: 'string' } } },
      },
    };
  const status = answer.status ?? 200;
  return {
    [String(status)]: {
      description: answer.description ?? STATUS_WORDS[status],
      content: { 'application/json': { schema: answer.json } },
    },
    ...(answer.also ? { [String(answer.also)]: { description: 'Nothing to say' } } : {}),
  };
}

/** A route's parameters, `:id` as OpenAPI writes it (`{id}`). */
const openPath = (url: string) => url.replace(/:([A-Za-z_]+)/g, '{$1}');

/** The OpenAPI 3.1 document of the routes the server has. */
export function openApi(routes: Seen[]): Record<string, unknown> {
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
        ...(doc.returns
          ? answered(doc.returns)
          : {
              default: {
                description: 'The answer, as JSON (an output as text, events as a stream)',
              },
            }),
        '4XX': { $ref: '#/components/responses/Refused' },
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
    // AFS-199: this server, wherever it is reached (behind a TLS proxy too): the pages' Try it
    // and generated clients send to the address the document came from.
    servers: [{ url: '/', description: 'This server' }],
    components: {
      schemas: SCHEMAS,
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
        token: {
          type: 'http',
          scheme: 'bearer',
          description:
            'A personal access token (`afs_...`), made on the Access tokens page. Pasted in the API reference it stays on that page only.',
        },
        session: {
          type: 'apiKey',
          in: 'cookie',
          name: 'afs_session',
          description:
            'The session of the pages, after signing in: the browser sends it, there is nothing to type.',
        },
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

  // AFS-145: a read-only token is refused before its body is checked: it must not learn what a
  // write would need, nor fill the audit with refusals of its form. The routes still refuse it
  // themselves (signedIn); this only answers first. A POST that changes nothing is the route's
  // to judge (asking what a launch would run is open to a read-only token).
  app.addHook('preValidation', async (request, reply) => {
    if (!request.user?.token?.readOnly || ['GET', 'HEAD', 'OPTIONS'].includes(request.method))
      return;
    const route = request.routeOptions.url;
    const key = `${request.method} ${route}`;
    const doc = route ? ROUTES[key] : undefined;
    // AFS-195: a draft's edits are kept with the draft, not in the audit log, but they are
    // writes all the same: refused here first, not after a form error ("Path is needed.").
    const open = READS.has(key) && !key.includes('/drafts');
    if (!doc || doc.who === 'anyone' || doc.who === 'push hook token' || open) return;
    return reply.code(403).send({ error: 'read_only_token', message: 'This token may only read' });
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
          : 'This token is for one workspace: it cannot reach this',
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
    // Who may not see it at all is not told it is there: the same answer as for one that does
    // not exist (AFS-135), so neither a key nor an id can be tried for.
    if (!access.sees(target.workspace, target.project))
      return reply.code(404).send({ error: 'not_found', message: missingOf(doc.reach) });
    return reply.code(403).send({
      error: 'forbidden',
      message: `This needs ${doc.who === 'can see' ? 'access' : doc.who} here`,
    });
  });

  app.get('/api/v1/openapi.json', async () => openApi(seen));
}
