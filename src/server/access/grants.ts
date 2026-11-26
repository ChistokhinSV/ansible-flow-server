// Access levels. A grant gives a user or a group a level on a whole workspace or on one flow
// (a project's flow file). The levels, each with what the one below may do:
//   ro        see the workspace, its projects, flows, launch configurations and runs; clone
//   operator  launch a flow as its launch configuration says, stop and run again
//   rw        launch any branch or commit, manage launch configurations, push through the server
//   approve   decide approval gates: a grant of its own, not above or below the others
// A flow grant replaces the workspace grant for that flow (it may give less, or more). Of the
// grants a person has, as themself and through their groups, the highest counts. Administrators
// may do everything; workspaces, projects, credentials and grants are theirs to change.
import { randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import type { SessionUser } from '../auth/sessions';
import type { Schema } from '../db/schema';

import {
  type Grant,
  type GrantLevel,
  type GroupGrant,
  LEVELS,
  type Level,
  type Reach,
  type ReachedAction,
  type UserReach,
  type WorkspaceName,
} from './types';

export { type Grant, type GrantLevel, LEVELS, type Level };

const RANK: Record<Level, number> = { ro: 1, operator: 2, rw: 3 };
const levelOf = (rank: number): Level | undefined => LEVELS[rank - 1];

type Db = Kysely<Schema>;
const flowKey = (project: string, file: string) => `${project}\u0000${file}`;

export class GrantError extends Error {
  constructor(
    readonly code: 'invalid' | 'not_found' | 'taken',
    message: string,
  ) {
    super(message);
    this.name = 'GrantError';
  }
}

/** What one person may do: computed once per request from their grants and their groups'. */
export class Access {
  private constructor(
    readonly admin: boolean,
    private readonly workspaces: Map<string, number>,
    private readonly flows: Map<string, number>,
    /** Workspace -> projects with a flow grant in them. */
    private readonly flowProjects: Map<string, Set<string>>,
    private readonly flowPairs: [string, string][],
    private readonly approveWorkspaces: Set<string>,
    private readonly approveFlows: Set<string>,
  ) {}

  static everything(): Access {
    return new Access(true, new Map(), new Map(), new Map(), [], new Set(), new Set());
  }

  static async of(db: Db, user: { id: string; admin: boolean }): Promise<Access> {
    if (user.admin) return Access.everything();
    const groups = await db
      .selectFrom('group_member')
      .select('group_id')
      .where('user_id', '=', user.id)
      .execute();
    const rows = await db
      .selectFrom('access_grant')
      .selectAll()
      .where((eb) =>
        eb.or([
          eb.and([eb('principal_type', '=', 'user'), eb('principal_id', '=', user.id)]),
          ...(groups.length
            ? [
                eb.and([
                  eb('principal_type', '=', 'group'),
                  eb(
                    'principal_id',
                    'in',
                    groups.map((g) => g.group_id),
                  ),
                ]),
              ]
            : []),
        ]),
      )
      .execute();
    const workspaces = new Map<string, number>();
    const flows = new Map<string, number>();
    const flowProjects = new Map<string, Set<string>>();
    const pairs = new Map<string, [string, string]>();
    const approveWorkspaces = new Set<string>();
    const approveFlows = new Set<string>();
    for (const row of rows) {
      const onFlow = row.project_id && row.flow_file;
      if (row.level === 'approve') {
        if (onFlow) {
          approveFlows.add(flowKey(row.project_id as string, row.flow_file as string));
          // An approver sees the project of the flow they approve (AFS-28).
          const set = flowProjects.get(row.workspace_id) ?? new Set();
          set.add(row.project_id as string);
          flowProjects.set(row.workspace_id, set);
        } else approveWorkspaces.add(row.workspace_id);
        continue;
      }
      const rank = RANK[row.level as Level] ?? 0;
      if (onFlow) {
        const key = flowKey(row.project_id as string, row.flow_file as string);
        flows.set(key, Math.max(flows.get(key) ?? 0, rank));
        pairs.set(key, [row.project_id as string, row.flow_file as string]);
        const set = flowProjects.get(row.workspace_id) ?? new Set();
        set.add(row.project_id as string);
        flowProjects.set(row.workspace_id, set);
      } else {
        workspaces.set(row.workspace_id, Math.max(workspaces.get(row.workspace_id) ?? 0, rank));
      }
    }
    return new Access(
      false,
      workspaces,
      flows,
      flowProjects,
      [...pairs.values()],
      approveWorkspaces,
      approveFlows,
    );
  }

  /** The level on a workspace as a whole (its git repositories, its lists). */
  onWorkspace(workspace: string): Level | undefined {
    if (this.admin) return 'rw';
    // An approver sees what they approve (AFS-28): approve counts as ro, never lowers a level.
    return (
      levelOf(this.workspaces.get(workspace) ?? 0) ??
      (this.approveWorkspaces.has(workspace) ? 'ro' : undefined)
    );
  }

  /** The level on one flow: its own grant, else the workspace's; approve counts as ro. */
  onFlow(workspace: string, project: string, file: string): Level | undefined {
    if (this.admin) return 'rw';
    const own = this.flows.get(flowKey(project, file));
    return (
      levelOf(own ?? this.workspaces.get(workspace) ?? 0) ??
      (this.approves(workspace, project, file) ? 'ro' : undefined)
    );
  }

  /** May decide approval gates of this flow (or of the workspace). */
  approves(workspace: string, project?: string, file?: string): boolean {
    if (this.admin) return true;
    if (project && file && this.approveFlows.has(flowKey(project, file))) return true;
    return this.approveWorkspaces.has(workspace);
  }

  /** Sees the workspace at all: a grant on it, or on a flow in it. */
  sees(workspace: string, project?: string): boolean {
    if (this.admin || (this.workspaces.get(workspace) ?? 0) > 0) return true;
    if (this.approveWorkspaces.has(workspace)) return true;
    const projects = this.flowProjects.get(workspace);
    return !!projects && (project ? projects.has(project) : projects.size > 0);
  }

  /** What a list of runs or flows is narrowed to; undefined: everything. */
  visible(): { workspaces: string[]; flows: [string, string][] } | undefined {
    if (this.admin) return undefined;
    // AFS-103: `approve` counts as `ro` (ADR-0020), in lists too: an approver of a workspace or a
    // flow sees its runs, as onFlow already lets them open each one.
    const workspaces = new Set([
      ...[...this.workspaces].filter(([, r]) => r > 0).map(([w]) => w),
      ...this.approveWorkspaces,
    ]);
    const flows = new Map(this.flowPairs.map((p) => [flowKey(p[0], p[1]), p]));
    for (const key of this.approveFlows) {
      const [project, file] = key.split('\u0000') as [string, string];
      flows.set(key, [project, file]);
    }
    return { workspaces: [...workspaces], flows: [...flows.values()] };
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    access?: Access;
  }
}

/** The signed-in person's access, read once per request; nobody signed in has none. */
export async function accessOf(db: Db, request: FastifyRequest): Promise<Access | undefined> {
  // Typed here, not through auth/routes.ts's declaration: the pages' build reaches this file
  // (through the launch configurations) without the server's routes (AFS-145).
  const user = (request as { user?: SessionUser }).user;
  if (!user) return undefined;
  request.access ??= await Access.of(db, user);
  return request.access;
}

export const atLeast = (have: Level | undefined, need: Level) => !!have && RANK[have] >= RANK[need];

// --- the grants themselves (administrators)

/** Whose grants, or where: of one workspace, or the ones that name one of these principals. */
type GrantsOf = { workspace: string } | { principals: { type: 'user' | 'group'; ids: string[] }[] };

async function readGrants(db: Db, of: GrantsOf): Promise<Grant[]> {
  let query = db
    .selectFrom('access_grant')
    .leftJoin('user_account', (j) =>
      j
        .onRef('user_account.id', '=', 'access_grant.principal_id')
        .on('access_grant.principal_type', '=', 'user'),
    )
    .leftJoin('user_group', (j) =>
      j
        .onRef('user_group.id', '=', 'access_grant.principal_id')
        .on('access_grant.principal_type', '=', 'group'),
    )
    .leftJoin('project', 'project.id', 'access_grant.project_id')
    .select([
      'access_grant.id',
      'access_grant.principal_type',
      'access_grant.principal_id',
      'access_grant.level',
      'access_grant.workspace_id',
      'access_grant.project_id',
      'access_grant.flow_file',
      'access_grant.created_at',
      'access_grant.created_by',
      'user_account.login',
      'user_group.name as group_name',
      'project.key as project_key',
    ])
    .orderBy('access_grant.created_at')
    // Grants given in the same moment come in the same order each time they are read.
    .orderBy('access_grant.id');
  if ('workspace' in of) query = query.where('access_grant.workspace_id', '=', of.workspace);
  else {
    const named = of.principals.filter((p) => p.ids.length);
    if (!named.length) return [];
    query = query.where((eb) =>
      eb.or(
        named.map((p) =>
          eb.and([
            eb('access_grant.principal_type', '=', p.type),
            eb('access_grant.principal_id', 'in', p.ids),
          ]),
        ),
      ),
    );
  }
  const rows = await query.execute();
  return rows.map((r) => ({
    id: r.id,
    principal: {
      type: r.principal_type as 'user' | 'group',
      id: r.principal_id,
      name: (r.principal_type === 'user' ? r.login : r.group_name) ?? '(gone)',
    },
    level: r.level as GrantLevel,
    workspace: r.workspace_id,
    ...(r.project_id && r.flow_file
      ? { flow: { project: r.project_id, projectKey: r.project_key ?? '', file: r.flow_file } }
      : {}),
    createdAt: r.created_at,
    createdBy: r.created_by,
  }));
}

export const listGrants = (db: Db, workspace: string): Promise<Grant[]> =>
  readGrants(db, { workspace });

async function workspaceNames(db: Db, ids: string[]): Promise<Map<string, WorkspaceName>> {
  if (!ids.length) return new Map();
  const rows = await db
    .selectFrom('workspace')
    .select(['id', 'key', 'name'])
    .where('id', 'in', ids)
    .execute();
  return new Map(rows.map((w) => [w.id, w]));
}

/** The grants that name a group, in every workspace, by the workspace's name. */
export async function groupGrants(db: Db, group: string): Promise<GroupGrant[]> {
  const grants = await readGrants(db, { principals: [{ type: 'group', ids: [group] }] });
  const names = await workspaceNames(db, [...new Set(grants.map((g) => g.workspace))]);
  return grants
    .flatMap(({ principal: _principal, workspace, ...grant }) => {
      const named = names.get(workspace);
      return named ? [{ ...grant, workspace: named }] : [];
    })
    .sort((a, b) => a.workspace.name.localeCompare(b.workspace.name));
}

export interface NewGrant {
  user?: string;
  group?: string;
  level: GrantLevel;
  /** For a grant on one flow: the project (id) and the flow's file. */
  project?: string;
  flow?: string;
}

/** Gives a grant. One principal has one grant of a level on one place: a second is refused. */
export async function createGrant(
  db: Db,
  workspace: string,
  input: NewGrant,
  by: string,
): Promise<Grant> {
  if (!!input.user === !!input.group)
    throw new GrantError('invalid', 'A grant is for a user or for a group: name one');
  if (!['ro', 'operator', 'rw', 'approve'].includes(input.level))
    throw new GrantError('invalid', 'The level is ro, operator, rw or approve');
  if (!!input.project !== !!input.flow)
    throw new GrantError('invalid', 'A grant on one flow names its project and its flow file');
  const principal = input.user
    ? await db
        .selectFrom('user_account')
        .select('id')
        .where((eb) =>
          eb.or([eb('id', '=', input.user as string), eb('login', '=', input.user as string)]),
        )
        .executeTakeFirst()
    : await db
        .selectFrom('user_group')
        .select('id')
        .where((eb) =>
          eb.or([eb('id', '=', input.group as string), eb('name', '=', input.group as string)]),
        )
        .executeTakeFirst();
  if (!principal)
    throw new GrantError(
      'not_found',
      input.user ? `No user ${input.user}` : `No group ${input.group}`,
    );
  if (input.project) {
    const project = await db
      .selectFrom('project')
      .select('id')
      .where('id', '=', input.project)
      .where('workspace_id', '=', workspace)
      .executeTakeFirst();
    if (!project) throw new GrantError('not_found', 'The workspace has no such project');
    if (!/\.flow\.ya?ml$/.test(input.flow ?? '') || (input.flow ?? '').includes('..'))
      throw new GrantError('invalid', 'Name the flow by its file in the repository: a *.flow.yaml');
  }
  const type = input.user ? 'user' : 'group';
  let same = db
    .selectFrom('access_grant')
    .select('id')
    .where('workspace_id', '=', workspace)
    .where('principal_type', '=', type)
    .where('principal_id', '=', principal.id)
    .where('level', input.level === 'approve' ? '=' : '!=', 'approve');
  same = input.project
    ? same.where('project_id', '=', input.project).where('flow_file', '=', input.flow as string)
    : same.where('project_id', 'is', null);
  if (await same.executeTakeFirst())
    throw new GrantError(
      'taken',
      input.level === 'approve'
        ? 'They may already approve here'
        : 'They already have a level here: remove it first to change it',
    );
  const id = randomUUID();
  await db
    .insertInto('access_grant')
    .values({
      id,
      principal_type: type,
      principal_id: principal.id,
      level: input.level,
      workspace_id: workspace,
      project_id: input.project ?? null,
      flow_file: input.flow ?? null,
      created_at: new Date().toISOString(),
      created_by: by,
    })
    .execute();
  return (await listGrants(db, workspace)).find((g) => g.id === id) as Grant;
}

/**
 * AFS-273: a grant's level changed in place (Read, Operate or Edit), so nobody is without access
 * between a take back and a give. Approve is a grant of its own: it is given and taken back, it
 * has no level to change. Undefined: there is no such grant.
 */
export async function changeGrant(db: Db, id: string, level: string): Promise<Grant | undefined> {
  if (!['ro', 'operator', 'rw'].includes(level))
    throw new GrantError('invalid', 'A level changes to ro, operator or rw');
  const row = await db
    .selectFrom('access_grant')
    .select(['workspace_id', 'level'])
    .where('id', '=', id)
    .executeTakeFirst();
  if (!row) return undefined;
  if (row.level === 'approve')
    throw new GrantError('invalid', 'Approve is given and taken back on its own: it has no level');
  await db.updateTable('access_grant').set({ level }).where('id', '=', id).execute();
  return (await listGrants(db, row.workspace_id)).find((g) => g.id === id);
}

export async function deleteGrant(db: Db, id: string): Promise<boolean> {
  const done = await db.deleteFrom('access_grant').where('id', '=', id).executeTakeFirst();
  return Number(done.numDeletedRows) > 0;
}

/** AFS-206: an action grant with the action it gives and where. */
interface ActionGrantRow {
  config: string;
  title: string;
  projectKey: string;
  workspace: string;
  type: 'user' | 'group';
  principal: string;
  through: string;
}

/** AFS-206: the action grants of a workspace, or the ones that name these principals. */
async function actionGrantRows(
  db: Db,
  of: { workspace: string } | { user: string; groups: string[] },
): Promise<ActionGrantRow[]> {
  let query = db
    .selectFrom('action_grant')
    .innerJoin('launch_action', 'launch_action.config_id', 'action_grant.config_id')
    .innerJoin('launch_config', 'launch_config.id', 'action_grant.config_id')
    .innerJoin('project', 'project.id', 'launch_config.project_id')
    .leftJoin('user_account', (j) =>
      j
        .onRef('user_account.id', '=', 'action_grant.principal_id')
        .on('action_grant.principal_type', '=', 'user'),
    )
    .leftJoin('user_group', (j) =>
      j
        .onRef('user_group.id', '=', 'action_grant.principal_id')
        .on('action_grant.principal_type', '=', 'group'),
    )
    .select([
      'action_grant.config_id',
      'action_grant.principal_type',
      'action_grant.principal_id',
      'launch_action.title',
      'project.key as project_key',
      'project.workspace_id',
      'user_account.login',
      'user_group.name as group_name',
    ])
    .orderBy('launch_action.title');
  if ('workspace' in of) query = query.where('project.workspace_id', '=', of.workspace);
  else {
    const { user, groups } = of;
    query = query.where((eb) =>
      eb.or([
        eb.and([
          eb('action_grant.principal_type', '=', 'user'),
          eb('action_grant.principal_id', '=', user),
        ]),
        ...(groups.length
          ? [
              eb.and([
                eb('action_grant.principal_type', '=', 'group'),
                eb('action_grant.principal_id', 'in', groups),
              ]),
            ]
          : []),
      ]),
    );
  }
  return (await query.execute()).map((r) => ({
    config: r.config_id,
    title: r.title,
    projectKey: r.project_key,
    workspace: r.workspace_id,
    type: r.principal_type as 'user' | 'group',
    principal: r.principal_id,
    through: `${r.principal_type}:${(r.principal_type === 'user' ? r.login : r.group_name) ?? '(gone)'}`,
  }));
}

/** AFS-206: the actions in these rows, once each, as a person's reach says them. */
const reachedActions = (rows: ActionGrantRow[]): ReachedAction[] => [
  ...new Map(
    rows.map((r) => [
      r.config,
      { config: r.config, title: r.title, projectKey: r.projectKey, through: r.through },
    ]),
  ).values(),
];

/**
 * Who can do what in a workspace: every user with a grant there (theirs or a group's), an access
 * grant or (AFS-206) an action grant.
 */
export async function whoCan(db: Db, workspace: string) {
  const grants = await listGrants(db, workspace);
  const actionRows = await actionGrantRows(db, { workspace });
  const users = await db
    .selectFrom('user_account')
    .select(['id', 'login', 'name', 'is_admin', 'disabled', 'service'])
    .orderBy('login')
    .execute();
  const members = await db.selectFrom('group_member').select(['group_id', 'user_id']).execute();
  const out = [];
  for (const user of users) {
    const groups = new Set(members.filter((m) => m.user_id === user.id).map((m) => m.group_id));
    const mine = grants.filter((g) =>
      g.principal.type === 'user' ? g.principal.id === user.id : groups.has(g.principal.id),
    );
    const myActions = actionRows.filter((r) =>
      r.type === 'user' ? r.principal === user.id : groups.has(r.principal),
    );
    if (!mine.length && !myActions.length && user.is_admin !== 1) continue;
    const access = await Access.of(db, { id: user.id, admin: user.is_admin === 1 });
    const { level, ...reached } = reachIn(access, workspace, mine, myActions);
    out.push({
      user: { id: user.id, login: user.login, name: user.name },
      admin: user.is_admin === 1,
      disabled: user.disabled === 1,
      service: user.service === 1,
      workspace: level,
      ...reached,
    });
  }
  return out;
}

/**
 * What a person reaches in one workspace, as their grants there (`mine`: their own and their
 * groups') come out: the level on the workspace, the flows with a grant of their own, whether
 * they approve, and whose grants gave it.
 */
function reachIn(
  access: Access,
  workspace: string,
  mine: Grant[],
  actions: ActionGrantRow[] = [],
): Reach {
  const flows = [
    ...new Map(
      mine.filter((g) => g.flow).map((g) => [`${g.flow?.project}/${g.flow?.file}`, g.flow]),
    ).values(),
  ].map((f) => ({
    project: f?.projectKey as string,
    projectId: f?.project as string,
    file: f?.file as string,
    level: access.onFlow(workspace, f?.project as string, f?.file as string) ?? null,
  }));
  return {
    level: access.onWorkspace(workspace) ?? null,
    approve: access.approves(workspace),
    flows,
    actions: reachedActions(actions),
    through: [
      ...new Set([
        ...mine.map((g) => `${g.principal.type}:${g.principal.name}`),
        ...actions.map((a) => a.through),
      ]),
    ],
  };
}

/**
 * What one person reaches, workspace by workspace: only the workspaces where a grant names them
 * or one of their groups. An administrator reaches everything: said with a flag, without rows.
 * Undefined: no such user.
 */
export async function reachOf(db: Db, userId: string): Promise<UserReach | undefined> {
  const user = await db
    .selectFrom('user_account')
    .select(['id', 'is_admin'])
    .where('id', '=', userId)
    .executeTakeFirst();
  if (!user) return undefined;
  if (user.is_admin === 1) return { admin: true, workspaces: [], approves: true };
  const groups = await db
    .selectFrom('group_member')
    .select('group_id')
    .where('user_id', '=', user.id)
    .execute();
  const grants = await readGrants(db, {
    principals: [
      { type: 'user', ids: [user.id] },
      { type: 'group', ids: groups.map((g) => g.group_id) },
    ],
  });
  const actionRows = await actionGrantRows(db, {
    user: user.id,
    groups: groups.map((g) => g.group_id),
  });
  const access = await Access.of(db, { id: user.id, admin: false });
  // AFS-206: a workspace where they may only run actions is one they reach too.
  const names = await workspaceNames(db, [
    ...new Set([...grants.map((g) => g.workspace), ...actionRows.map((a) => a.workspace)]),
  ]);
  return {
    admin: false,
    approves: grants.some((g) => g.level === 'approve'),
    workspaces: [...names.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((workspace) => ({
        workspace,
        ...reachIn(
          access,
          workspace.id,
          grants.filter((g) => g.workspace === workspace.id),
          actionRows.filter((a) => a.workspace === workspace.id),
        ),
      })),
  };
}
