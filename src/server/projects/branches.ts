// AFS-59: a project's branches, managed from the server: listed with their newest commit, made
// from a branch or a commit, deleted. For a project with a source the change is made at the source
// with the project's credential, as a push through the server is (ADR-0010): the mirror follows
// only what the source took. Every change is written down like a push (`git_push`).
//
// Rules: the project's branch (the one that runs) is never deleted here; a branch a launch
// configuration names is not deleted until the configuration names another; a branch with commits
// that are not on the project's branch is deleted only when asked again (`force`), since for a
// hosted project those commits are then gone.
import type { Kysely } from 'kysely';
import type { Schema } from '../db/schema';
import { type BranchInfo, type Git, GitError, refProblem } from './git';
import { type Project, ProjectError, recordPushes } from './store';
import type { ProjectSync } from './sync';

export interface Branch extends BranchInfo {
  /** The project's branch: the one that runs. */
  project?: boolean;
  /** The launch configurations that run this branch's newest commit. */
  configurations?: string[];
}

export class BranchRefused extends Error {
  constructor(
    readonly code: 'project_branch' | 'in_use' | 'unmerged' | 'exists' | 'not_found',
    message: string,
    readonly details: { configurations?: string[]; ahead?: number } = {},
  ) {
    super(message);
    this.name = 'BranchRefused';
  }
}

export interface BranchDeps {
  db: Kysely<Schema>;
  git: Git;
  sync: ProjectSync;
}

/** Launch configurations of the project that name a branch, by branch. */
async function configurationsByBranch(
  db: Kysely<Schema>,
  projectId: string,
): Promise<Map<string, string[]>> {
  const rows = await db
    .selectFrom('launch_config')
    .select(['name', 'git_ref'])
    .where('project_id', '=', projectId)
    .where('git_ref', 'is not', null)
    .orderBy('name')
    .execute();
  const out = new Map<string, string[]>();
  for (const row of rows) {
    const ref = row.git_ref as string;
    out.set(ref, [...(out.get(ref) ?? []), row.name]);
  }
  return out;
}

export async function listBranches(deps: BranchDeps, project: Project): Promise<Branch[]> {
  let branches: BranchInfo[];
  try {
    branches = await deps.git.branchDetails(project.id, project.gitRef);
  } catch (e) {
    if (e instanceof GitError) return [];
    throw e;
  }
  const configs = await configurationsByBranch(deps.db, project.id);
  return branches.map((b) => ({
    ...b,
    ...(b.name === project.gitRef ? { project: true } : {}),
    ...(configs.get(b.name) ? { configurations: configs.get(b.name) } : {}),
  }));
}

const upstreamOf = async (deps: BranchDeps, project: Project) =>
  project.gitUrl ? { url: project.gitUrl, auth: await deps.sync.auth(project) } : undefined;

/** Makes `name` from a branch or a commit of the project. */
export async function createBranch(
  deps: BranchDeps,
  project: Project,
  input: { name: string; from: string },
  by: { id: string; login: string },
): Promise<{ name: string; commit: string }> {
  const name = input.name.trim();
  const problem = refProblem(name);
  if (problem) throw new ProjectError('invalid', problem);
  return deps.sync.exclusive(project.id, async () => {
    // A project with a source: look at it first, so the branch is made from what it has now.
    if (project.gitUrl) await deps.sync.refresh(project.id);
    const refs = await deps.git.refs(project.id);
    if (refs.has(name)) throw new BranchRefused('exists', `There is a branch ${name} already`);
    let commit: string;
    try {
      commit = await deps.git.commitOf(project.id, input.from.trim());
    } catch (e) {
      if (e instanceof GitError)
        // AFS-194: one sentence: "Nothing to start from: the repository has no branch x".
        throw new BranchRefused(
          'not_found',
          `Nothing to start from: ${e.message.replace(/^[A-Z](?=[a-z ])/, (c) => c.toLowerCase())}`,
        );
      throw e;
    }
    await deps.git.setBranch(project.id, name, { commit }, await upstreamOf(deps, project));
    await recordPushes(deps.db, project.id, by, [{ ref: name, to: commit }], 'branch');
    return { name, commit };
  });
}

/** Deletes `name`; refused for the project's branch, a branch in use, or unmerged work. */
export async function deleteBranch(
  deps: BranchDeps,
  project: Project,
  name: string,
  options: { force?: boolean },
  by: { id: string; login: string },
): Promise<{ name: string; commit: string }> {
  if (name === project.gitRef)
    throw new BranchRefused(
      'project_branch',
      `${name} is the project's branch: make another branch the project's first`,
    );
  return deps.sync.exclusive(project.id, async () => {
    if (project.gitUrl) await deps.sync.refresh(project.id);
    const branch = (await deps.git.branchDetails(project.id, project.gitRef)).find(
      (b) => b.name === name,
    );
    if (!branch) throw new BranchRefused('not_found', `There is no branch ${name}`);
    const configurations = (await configurationsByBranch(deps.db, project.id)).get(name);
    if (configurations)
      throw new BranchRefused(
        'in_use',
        `Launch configurations run ${name}: ${configurations.join(', ')}. Change them first`,
        { configurations },
      );
    if (branch.ahead > 0 && !options.force)
      throw new BranchRefused(
        'unmerged',
        `${name} has ${branch.ahead} commit${branch.ahead === 1 ? '' : 's'} not on ${project.gitRef}${project.hosted ? ': deleting it loses them' : ''}`,
        { ahead: branch.ahead },
      );
    await deps.git.setBranch(
      project.id,
      name,
      { old: branch.commit },
      await upstreamOf(deps, project),
    );
    await recordPushes(deps.db, project.id, by, [{ ref: name, from: branch.commit }], 'branch');
    return { name, commit: branch.commit };
  });
}
