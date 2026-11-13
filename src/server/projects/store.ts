// Workspaces and projects, as rows, and the rules about them the database cannot keep.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { Schema, SyncState } from '../db/schema';
import { gitUrlProblem, refProblem } from './git';

export interface Workspace {
  id: string;
  key: string;
  name: string;
  description?: string;
  /** How many projects it has. */
  projects: number;
  /** AFS-28: who launched a run may decide its approvals too. */
  selfApprove: boolean;
}

export interface Project {
  id: string;
  workspace: string;
  key: string;
  name: string;
  /** The server hosts the repository itself: it has no other source. */
  hosted: boolean;
  /** Where the repository is fetched from; absent for a hosted project. */
  gitUrl?: string;
  /** Where git clients reach the project on this server, after the server's own address. */
  gitPath: string;
  /** The credential the server signs in to the source with (its id); absent: none. */
  gitCredential?: string;
  /** The branch whose commits may run. */
  gitRef: string;
  /** The commit that branch was at when the source last answered. */
  commit?: string;
  sync: { state: SyncState; at?: string; error?: string };
  pollSeconds: number;
  /** A push hook is set up (its token is shown only when it is made). */
  hook: boolean;
}

export class ProjectError extends Error {
  constructor(
    readonly code: 'taken' | 'not_found' | 'not_empty' | 'invalid',
    message: string,
  ) {
    super(message);
    this.name = 'ProjectError';
  }
}

/** The default time between two looks at a project's source. */
export const POLL_SECONDS = 300;
/** Not more often than this: a source is someone's server. */
export const POLL_MIN_SECONDS = 30;

type Db = Kysely<Schema>;
const now = () => new Date().toISOString();

/** A short name for addresses: lower-case letters, digits and dashes. */
export function keyProblem(key: string): string | undefined {
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(key)
    ? undefined
    : 'A key is 1 to 63 lower-case letters, digits and dashes, and does not start or end with a dash';
}

const nameProblem = (name: string) =>
  name.trim().length >= 1 && name.length <= 200 ? undefined : 'A name is 1 to 200 characters';

// --- workspaces

export async function listWorkspaces(db: Db): Promise<Workspace[]> {
  const rows = await db.selectFrom('workspace').selectAll().orderBy('key').execute();
  const counts = await db
    .selectFrom('project')
    .select(['workspace_id', (eb) => eb.fn.countAll().as('n')])
    .groupBy('workspace_id')
    .execute();
  const byId = new Map(counts.map((c) => [c.workspace_id, Number(c.n)]));
  return rows.map((row) => ({
    id: row.id,
    key: row.key,
    name: row.name,
    ...(row.description ? { description: row.description } : {}),
    projects: byId.get(row.id) ?? 0,
    selfApprove: row.self_approve === 1,
  }));
}

export async function getWorkspace(db: Db, idOrKey: string): Promise<Workspace | undefined> {
  return (await listWorkspaces(db)).find((w) => w.id === idOrKey || w.key === idOrKey);
}

export async function createWorkspace(
  db: Db,
  input: { key: string; name: string; description?: string },
): Promise<Workspace> {
  const key = input.key.trim().toLowerCase();
  const problem = keyProblem(key) ?? nameProblem(input.name);
  if (problem) throw new ProjectError('invalid', problem);
  const at = now();
  const row = {
    id: randomUUID(),
    key,
    name: input.name.trim(),
    description: input.description?.trim() || null,
    self_approve: 0,
    created_at: at,
    updated_at: at,
  };
  const done = await db
    .insertInto('workspace')
    .values(row)
    .onConflict((c) => c.column('key').doNothing())
    .executeTakeFirst();
  if (!done.numInsertedOrUpdatedRows)
    throw new ProjectError('taken', `There is a workspace ${key} already`);
  return {
    id: row.id,
    key,
    name: row.name,
    projects: 0,
    ...(row.description ? { description: row.description } : {}),
    selfApprove: false,
  };
}

export async function updateWorkspace(
  db: Db,
  id: string,
  change: { name?: string; description?: string | null; selfApprove?: boolean },
): Promise<Workspace> {
  const problem = change.name !== undefined ? nameProblem(change.name) : undefined;
  if (problem) throw new ProjectError('invalid', problem);
  const done = await db
    .updateTable('workspace')
    .set({
      ...(change.name !== undefined ? { name: change.name.trim() } : {}),
      ...(change.description !== undefined
        ? { description: change.description?.trim() || null }
        : {}),
      ...(change.selfApprove !== undefined ? { self_approve: change.selfApprove ? 1 : 0 } : {}),
      updated_at: now(),
    })
    .where('id', '=', id)
    .executeTakeFirst();
  const after = done.numUpdatedRows ? await getWorkspace(db, id) : undefined;
  if (!after) throw new ProjectError('not_found', 'No such workspace');
  return after;
}

/** Deletes an empty workspace. One with projects is not deleted by accident. */
export async function deleteWorkspace(db: Db, id: string): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const projects = await trx
      .selectFrom('project')
      .select('id')
      .where('workspace_id', '=', id)
      .limit(1)
      .execute();
    if (projects.length)
      throw new ProjectError('not_empty', 'The workspace still has projects: delete them first');
    await trx.deleteFrom('access_grant').where('workspace_id', '=', id).execute();
    const done = await trx.deleteFrom('workspace').where('id', '=', id).executeTakeFirst();
    if (!done.numDeletedRows) throw new ProjectError('not_found', 'No such workspace');
  });
}

// --- projects

type ProjectRow = Schema['project'];
const projectOf = (row: ProjectRow, workspaceKey: string): Project => ({
  id: row.id,
  workspace: row.workspace_id,
  key: row.key,
  name: row.name,
  hosted: row.git_url === '',
  ...(row.git_url ? { gitUrl: row.git_url } : {}),
  gitPath: `/git/${workspaceKey}/${row.key}.git`,
  ...(row.git_credential_id ? { gitCredential: row.git_credential_id } : {}),
  gitRef: row.git_ref,
  ...(row.commit_id ? { commit: row.commit_id } : {}),
  sync: {
    state: row.sync_state,
    ...(row.synced_at ? { at: row.synced_at } : {}),
    ...(row.sync_error ? { error: row.sync_error } : {}),
  },
  pollSeconds: row.poll_seconds,
  hook: row.hook_token_hash !== null,
});

const projectRows = (db: Db) =>
  db
    .selectFrom('project')
    .innerJoin('workspace', 'workspace.id', 'project.workspace_id')
    .selectAll('project')
    .select('workspace.key as workspace_key');

export async function listProjects(db: Db, workspaceId?: string): Promise<Project[]> {
  let query = projectRows(db).orderBy('workspace.key').orderBy('project.key');
  if (workspaceId) query = query.where('project.workspace_id', '=', workspaceId);
  return (await query.execute()).map((row) => projectOf(row, row.workspace_key));
}

export async function getProject(db: Db, id: string): Promise<Project | undefined> {
  const row = await projectRows(db).where('project.id', '=', id).executeTakeFirst();
  return row ? projectOf(row, row.workspace_key) : undefined;
}

function pollProblem(seconds: number): string | undefined {
  return Number.isInteger(seconds) &&
    (seconds === 0 || (seconds >= POLL_MIN_SECONDS && seconds <= 86_400))
    ? undefined
    : `Look at the source every ${POLL_MIN_SECONDS} seconds to once a day, or 0 for never`;
}

export interface NewProject {
  key: string;
  name: string;
  /** The source's address. Left out: the server hosts the repository itself. */
  gitUrl?: string;
  /** The credential to sign in to the source with (its id). */
  gitCredential?: string;
  gitRef?: string;
  pollSeconds?: number;
}

export async function createProject(
  db: Db,
  workspaceId: string,
  input: NewProject,
  allowLocal: boolean,
): Promise<Project> {
  const key = input.key.trim().toLowerCase();
  const gitRef = input.gitRef?.trim() || 'main';
  const gitUrl = input.gitUrl?.trim() ?? '';
  // A hosted project has no source to look at on a timer.
  const pollSeconds = gitUrl ? (input.pollSeconds ?? POLL_SECONDS) : 0;
  const problem =
    keyProblem(key) ??
    nameProblem(input.name) ??
    (gitUrl ? gitUrlProblem(gitUrl, allowLocal) : undefined) ??
    refProblem(gitRef) ??
    pollProblem(pollSeconds);
  if (problem) throw new ProjectError('invalid', problem);
  const workspace = await db
    .selectFrom('workspace')
    .select('key')
    .where('id', '=', workspaceId)
    .executeTakeFirst();
  if (!workspace) throw new ProjectError('not_found', 'No such workspace');
  if (input.gitCredential)
    await credentialProblem(db, input.gitCredential, workspaceId, gitUrl).then((why) => {
      if (why) throw new ProjectError('invalid', why);
    });
  const at = now();
  const row: ProjectRow = {
    id: randomUUID(),
    workspace_id: workspaceId,
    key,
    name: input.name.trim(),
    git_url: gitUrl,
    git_ref: gitRef,
    commit_id: null,
    sync_state: 'never',
    sync_error: null,
    synced_at: null,
    poll_seconds: pollSeconds,
    git_credential_id: input.gitCredential ?? null,
    hook_token_hash: null,
    created_at: at,
    updated_at: at,
  };
  const done = await db
    .insertInto('project')
    .values(row)
    .onConflict((c) => c.columns(['workspace_id', 'key']).doNothing())
    .executeTakeFirst();
  if (!done.numInsertedOrUpdatedRows)
    throw new ProjectError('taken', `The workspace has a project ${key} already`);
  return projectOf(row, workspace.key);
}

/**
 * Why a credential cannot be what a project signs in to its source with; undefined when it can.
 * It is one of the project's own workspace, of a kind git can use over HTTPS, for a source that
 * is reached over HTTPS.
 */
async function credentialProblem(
  db: Db,
  credentialId: string,
  workspaceId: string,
  gitUrl: string,
): Promise<string | undefined> {
  if (!gitUrl) return 'The server hosts this project: there is no source to sign in to';
  if (!/^https?:\/\//i.test(gitUrl))
    return 'A credential is for a source reached over https; an ssh source uses the server’s own key';
  const credential = await db
    .selectFrom('credential')
    .select(['workspace_id', 'kind'])
    .where('id', '=', credentialId)
    .executeTakeFirst();
  if (!credential || credential.workspace_id !== workspaceId)
    return 'The workspace has no such credential';
  if (credential.kind !== 'git_token' && credential.kind !== 'login')
    return 'A repository is signed in to with a git token or a login, not another kind of credential';
  return undefined;
}

export interface ProjectChange {
  name?: string;
  gitUrl?: string;
  /** The credential for the source (its id); null takes it away. */
  gitCredential?: string | null;
  gitRef?: string;
  pollSeconds?: number;
}

/**
 * Changes a project. A new source or branch makes what is known about the old one untrue: the
 * commit is forgotten until the next look at the source.
 */
export async function updateProject(
  db: Db,
  id: string,
  change: ProjectChange,
  allowLocal: boolean,
): Promise<Project> {
  const problem =
    (change.name !== undefined ? nameProblem(change.name) : undefined) ??
    (change.gitUrl !== undefined ? gitUrlProblem(change.gitUrl.trim(), allowLocal) : undefined) ??
    (change.gitRef !== undefined ? refProblem(change.gitRef.trim()) : undefined) ??
    (change.pollSeconds !== undefined ? pollProblem(change.pollSeconds) : undefined);
  if (problem) throw new ProjectError('invalid', problem);
  const current = await getProject(db, id);
  if (!current) throw new ProjectError('not_found', 'No such project');
  // The hosted repository is the only copy: pointing the project elsewhere would orphan it.
  if (current.hosted && change.gitUrl !== undefined)
    throw new ProjectError('invalid', 'The server hosts this project: it has no source to change');
  if (current.hosted && change.pollSeconds)
    throw new ProjectError('invalid', 'The server hosts this project: there is no source to ask');
  if (change.gitCredential) {
    const why = await credentialProblem(
      db,
      change.gitCredential,
      current.workspace,
      change.gitUrl?.trim() ?? current.gitUrl ?? '',
    );
    if (why) throw new ProjectError('invalid', why);
  }
  // A source that is no longer reached over https has no use for the credential it had.
  const dropped =
    change.gitCredential === undefined &&
    change.gitUrl !== undefined &&
    !/^https?:\/\//i.test(change.gitUrl.trim());
  const moved =
    change.gitUrl !== undefined ||
    change.gitRef !== undefined ||
    change.gitCredential !== undefined;
  const done = await db
    .updateTable('project')
    .set({
      ...(change.name !== undefined ? { name: change.name.trim() } : {}),
      ...(change.gitUrl !== undefined ? { git_url: change.gitUrl.trim() } : {}),
      ...(change.gitRef !== undefined ? { git_ref: change.gitRef.trim() } : {}),
      ...(change.pollSeconds !== undefined ? { poll_seconds: change.pollSeconds } : {}),
      ...(change.gitCredential !== undefined ? { git_credential_id: change.gitCredential } : {}),
      ...(dropped ? { git_credential_id: null } : {}),
      ...(moved
        ? { commit_id: null, sync_state: 'never' as const, sync_error: null, synced_at: null }
        : {}),
      updated_at: now(),
    })
    .where('id', '=', id)
    .executeTakeFirst();
  const after = done.numUpdatedRows ? await getProject(db, id) : undefined;
  if (!after) throw new ProjectError('not_found', 'No such project');
  return after;
}

export async function deleteProject(db: Db, id: string): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const going = await trx
      .selectFrom('run')
      .select('number')
      .where('project_id', '=', id)
      .where('state', 'in', ['queued', 'running', 'waiting'])
      .executeTakeFirst();
    if (going)
      throw new ProjectError(
        'not_empty',
        `Run ${going.number} of the project is still going: cancel it first`,
      );
    await trx
      .deleteFrom('run_gate')
      .where('run_id', 'in', (eb) => eb.selectFrom('run').select('id').where('project_id', '=', id))
      .execute();
    await trx.deleteFrom('run').where('project_id', '=', id).execute();
    await trx.deleteFrom('git_push').where('project_id', '=', id).execute();
    await trx
      .deleteFrom('launch_config_credential')
      .where('config_id', 'in', (eb) =>
        eb.selectFrom('launch_config').select('id').where('project_id', '=', id),
      )
      .execute();
    await trx.deleteFrom('launch_config').where('project_id', '=', id).execute();
    await trx.deleteFrom('access_grant').where('project_id', '=', id).execute();
    const done = await trx.deleteFrom('project').where('id', '=', id).executeTakeFirst();
    if (!done.numDeletedRows) throw new ProjectError('not_found', 'No such project');
  });
}

/** Writes how a look at the source ended. */
export async function recordSync(
  db: Db,
  id: string,
  result: { commit: string } | { error: string },
): Promise<void> {
  await db
    .updateTable('project')
    .set(
      'commit' in result
        ? { commit_id: result.commit, sync_state: 'ok', sync_error: null, synced_at: now() }
        : // The commit stays: what ran before can still be read, the page says it is not fresh.
          { sync_state: 'error', sync_error: result.error.slice(0, 500), synced_at: now() },
    )
    .where('id', '=', id)
    .execute();
}

/** The projects whose source it is time to look at again. */
export async function dueProjects(db: Db, at = new Date()): Promise<Project[]> {
  return (await listProjects(db)).filter(
    (project) =>
      project.pollSeconds > 0 &&
      !project.hosted &&
      (!project.sync.at ||
        at.getTime() - Date.parse(project.sync.at) >= project.pollSeconds * 1000),
  );
}

// --- pushes through the server

/** One branch as a push changed it. */
export interface PushedRef {
  ref: string;
  /** The commit before; absent: the push made the branch. */
  from?: string;
  /** The commit after; absent: the push deleted the branch. */
  to?: string;
}

export interface Push extends PushedRef {
  id: string;
  /** Who pushed, as the server knew them then. */
  login: string;
  at: string;
}

/** Writes down who pushed which branches. The commits keep their own authors. */
export async function recordPushes(
  db: Db,
  projectId: string,
  user: { id: string; login: string },
  refs: PushedRef[],
): Promise<void> {
  if (!refs.length) return;
  const at = now();
  await db
    .insertInto('git_push')
    .values(
      refs.map((ref) => ({
        id: randomUUID(),
        project_id: projectId,
        user_id: user.id,
        login: user.login,
        ref: ref.ref,
        old_commit: ref.from ?? null,
        new_commit: ref.to ?? null,
        created_at: at,
      })),
    )
    .execute();
}

/** The project's pushes, newest first. */
export async function listPushes(db: Db, projectId: string, limit = 50): Promise<Push[]> {
  const rows = await db
    .selectFrom('git_push')
    .selectAll()
    .where('project_id', '=', projectId)
    .orderBy('created_at', 'desc')
    .orderBy('ref')
    .limit(Math.min(Math.max(limit, 1), 200))
    .execute();
  return rows.map((row) => ({
    id: row.id,
    login: row.login,
    ref: row.ref,
    ...(row.old_commit ? { from: row.old_commit } : {}),
    ...(row.new_commit ? { to: row.new_commit } : {}),
    at: row.created_at,
  }));
}

// --- the push hook

const hashOf = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * Makes a new token for the project's push hook and resolves with it. It is shown this once;
 * the database keeps its hash. A token made before stops working.
 */
export async function newHookToken(db: Db, id: string): Promise<string> {
  const token = randomBytes(24).toString('base64url');
  const done = await db
    .updateTable('project')
    .set({ hook_token_hash: hashOf(token), updated_at: now() })
    .where('id', '=', id)
    .executeTakeFirst();
  if (!done.numUpdatedRows) throw new ProjectError('not_found', 'No such project');
  return token;
}

export async function removeHookToken(db: Db, id: string): Promise<void> {
  await db
    .updateTable('project')
    .set({ hook_token_hash: null, updated_at: now() })
    .where('id', '=', id)
    .execute();
}

/** True when `token` is the one the project's hook must show. */
export async function hookTokenMatches(db: Db, id: string, token: string): Promise<boolean> {
  const row = await db
    .selectFrom('project')
    .select('hook_token_hash')
    .where('id', '=', id)
    .executeTakeFirst();
  // A project without a hook, and no project at all, compare against nothing anyone knows.
  const expected = Buffer.from(row?.hook_token_hash ?? hashOf(randomBytes(8).toString('hex')));
  return timingSafeEqual(Buffer.from(hashOf(token)), expected) && !!row?.hook_token_hash;
}
