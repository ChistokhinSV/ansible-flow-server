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
import type { Schema } from '../db/schema';

import { type Grant, type GrantLevel, LEVELS, type Level } from './types';

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
    return {
      workspaces: [...this.workspaces].filter(([, r]) => r > 0).map(([w]) => w),
      flows: this.flowPairs,
    };
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    access?: Access;
  }
}

/** The signed-in person's access, read once per request; nobody signed in has none. */
export async function accessOf(db: Db, request: FastifyRequest): Promise<Access | undefined> {
  if (!request.user) return undefined;
  request.access ??= await Access.of(db, request.user);
  return request.access;
}

export const atLeast = (have: Level | undefined, need: Level) => !!have && RANK[have] >= RANK[need];

// --- the grants themselves (administrators)

export async function listGrants(db: Db, workspace: string): Promise<Grant[]> {
  const rows = await db
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
    .where('access_grant.workspace_id', '=', workspace)
    .orderBy('access_grant.created_at')
    .execute();
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

export async function deleteGrant(db: Db, id: string): Promise<boolean> {
  const done = await db.deleteFrom('access_grant').where('id', '=', id).executeTakeFirst();
  return Number(done.numDeletedRows) > 0;
}

/** Who can do what in a workspace: every user with a grant there (theirs or a group's). */
export async function whoCan(db: Db, workspace: string) {
  const grants = await listGrants(db, workspace);
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
    if (!mine.length && user.is_admin !== 1) continue;
    const access = await Access.of(db, { id: user.id, admin: user.is_admin === 1 });
    const flows = [
      ...new Map(
        mine.filter((g) => g.flow).map((g) => [`${g.flow?.project}/${g.flow?.file}`, g.flow]),
      ).values(),
    ].map((f) => ({
      project: f?.projectKey as string,
      file: f?.file as string,
      level: access.onFlow(workspace, f?.project as string, f?.file as string) ?? null,
    }));
    out.push({
      user: { id: user.id, login: user.login, name: user.name },
      admin: user.is_admin === 1,
      disabled: user.disabled === 1,
      service: user.service === 1,
      workspace: access.onWorkspace(workspace) ?? null,
      approve: access.approves(workspace),
      flows,
      through: [...new Set(mine.map((g) => `${g.principal.type}:${g.principal.name}`))],
    });
  }
  return out;
}
