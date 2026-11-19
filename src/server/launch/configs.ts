// Launch configurations: a flow of a project with what a run of it needs, saved under a name,
// so launching is one choice instead of a form filled in again each time. A configuration
// names; it holds no secret (those are credentials) and no copy of the flow (that is git's).
import { randomUUID } from 'node:crypto';
import type { FlowDocument } from '@ansible-flow/core/flow/types';
import { inputText, launchFields, parseInput } from '@ansible-flow/core/run/launch';
import type { Kysely } from 'kysely';
import type { Schema } from '../db/schema';
import { errorsSentence, type FlowError } from '../flowErrors';
import { checkFlow } from '../flows';
import { namesWithoutAccess, unknownNames } from '../notify/recipients';
import type { RunNotify } from '../notify/types';
import { type Git, refProblem } from '../projects/git';
import { getProject, type Project } from '../projects/store';
import type { LastRun } from '../runs/cursor';
import type { CredentialKind } from '../secrets/credentials';

export type RunMode = 'check' | 'real';

export interface LaunchConfig {
  id: string;
  project: string;
  name: string;
  description?: string;
  /** The flow's file in the repository. */
  flowFile: string;
  /** Another branch than the project's to take the newest commit of. */
  gitRef?: string;
  /** One commit, always: the configuration is pinned. */
  commit?: string;
  /** The inventory in the repository; absent: what the repository's ansible.cfg names. */
  inventory?: string;
  /** The execution environment's image; absent: the server's default. */
  eeImage?: string;
  /** AFS-32: an environment of the workspace: its newest good build's image (before `eeImage`). */
  environment?: string;
  /** What a launch is unless it says otherwise: a skeleton run (`check`) or a real one. */
  mode: RunMode;
  /** Ansible's --limit, when the run is for fewer hosts than the flow targets. */
  limit?: string;
  /** Values the flow's inputs start with. Never a secret-looking input. */
  inputs: Record<string, unknown>;
  /** The credentials a run gets (ids). */
  credentials: string[];
  /** AFS-29: whom its runs tell, and when; absent: nobody. */
  notify?: RunNotify;
  createdAt: string;
  updatedAt: string;
  /**
   * Its newest run, among the runs the person asking may see; absent when there is none. Only
   * the list and the configuration read by id say it.
   */
  lastRun?: LastRun;
  /**
   * AFS-147: read by id only: its credentials by name (in order), and its environment by name with
   * the image a launch gets now, or why it gets none.
   */
  credentialNames?: string[];
  environmentInfo?: { name: string; image?: string; why?: string };
  /** AFS-147: in the list and read by id: the flow is not in the repository any more. */
  flowGone?: string;
}

export class LaunchError extends Error {
  constructor(
    readonly code: 'invalid' | 'not_found' | 'taken',
    message: string,
    /** The input or setting the message is about, for a form. */
    readonly field?: string,
    /** AFS-164: the errors of a flow that cannot run, with the step each is on. */
    readonly errors?: FlowError[],
  ) {
    super(message);
    this.name = 'LaunchError';
  }
}

export interface LaunchConfigInput {
  name: string;
  description?: string;
  flowFile: string;
  gitRef?: string | null;
  commit?: string | null;
  inventory?: string | null;
  eeImage?: string | null;
  environment?: string | null;
  mode?: RunMode;
  limit?: string | null;
  inputs?: Record<string, unknown>;
  credentials?: string[];
  /** null: nobody is told. */
  notify?: RunNotify | null;
}

type Db = Kysely<Schema>;
type Row = Schema['launch_config'];
const now = () => new Date().toISOString();
const invalid = (message: string, field?: string, errors?: FlowError[]) =>
  new LaunchError('invalid', message, field, errors);
export const COMMIT = /^[0-9a-f]{40}$/;
/** AFS-140: a commit as people copy it: the 12 digits the pages show, or more, or all 40. */
export const SHORT_COMMIT = /^[0-9a-f]{7,40}$/;

/**
 * AFS-140: a commit typed in full or short, as its full id; or why it is not one of the
 * repository's commits.
 */
export async function fullCommit(
  git: Pick<Git, 'commitOf'>,
  projectId: string,
  typed: string,
): Promise<{ commit: string } | { problem: string }> {
  const asked = typed.trim().toLowerCase();
  if (!SHORT_COMMIT.test(asked))
    return { problem: 'A commit is its id: 7 to 40 hex digits, like c300821e56a6.' };
  const commit = await git.commitOf(projectId, asked).catch(() => undefined);
  // A branch named like the digits is not taken for the commit.
  if (!commit || !COMMIT.test(commit) || !commit.startsWith(asked))
    return { problem: `The repository has no commit ${asked.slice(0, 12)}.` };
  return { commit };
}
/** The kinds of credential a run can be given; a git token is for a repository, not a run. */
const RUN_KINDS: CredentialKind[] = ['ssh_key', 'login', 'become', 'vault', 'registry', 'env'];
/** A run signs in to machines one way, and becomes another user one way. */
const ONE_EACH: CredentialKind[] = ['ssh_key', 'login', 'become'];

/** Why a path is not one inside a repository; undefined when it is. */
export function pathProblem(path: string): string | undefined {
  return !path ||
    path.length > 500 ||
    path.startsWith('/') ||
    /[\0\n\r\\]/.test(path) ||
    path.split('/').some((part) => part === '..' || part === '')
    ? 'Not a path inside the repository'
    : undefined;
}

/** The flow in a file at a commit, when it is one the server can run; else why not. */
export async function flowAt(
  git: Git,
  projectId: string,
  commit: string,
  file: string,
): Promise<{ doc: FlowDocument } | { problem: string; errors?: FlowError[] }> {
  if (pathProblem(file) || !/\.flow\.ya?ml$/i.test(file))
    return { problem: 'A flow is a file named *.flow.yaml in the repository' };
  const bytes = await git.read(projectId, commit, file).catch(() => undefined);
  if (!bytes) return { problem: `There is no flow ${file} at commit ${commit.slice(0, 12)}` };
  const { summary, doc, errors } = checkFlow(file, bytes.toString('utf8'));
  if (!summary.ok || !doc) return { problem: summary.problem ?? 'Not a flow file' };
  // AFS-164: which errors and on which steps, so the pages link to each.
  if (summary.errors > 0) return { problem: errorsSentence(summary.errors, errors), errors };
  return { doc };
}

export class LaunchConfigs {
  constructor(
    private readonly db: Db,
    private readonly git: Git,
  ) {}

  private async credentialsOf(ids: string[]): Promise<Map<string, string[]>> {
    const byConfig = new Map<string, string[]>();
    if (!ids.length) return byConfig;
    const rows = await this.db
      .selectFrom('launch_config_credential')
      .selectAll()
      .where('config_id', 'in', ids)
      .orderBy('position')
      .execute();
    for (const row of rows)
      byConfig.set(row.config_id, [...(byConfig.get(row.config_id) ?? []), row.credential_id]);
    return byConfig;
  }

  private of(row: Row, credentials: string[]): LaunchConfig {
    return {
      id: row.id,
      project: row.project_id,
      name: row.name,
      ...(row.description ? { description: row.description } : {}),
      flowFile: row.flow_file,
      ...(row.git_ref ? { gitRef: row.git_ref } : {}),
      ...(row.commit_id ? { commit: row.commit_id } : {}),
      ...(row.inventory ? { inventory: row.inventory } : {}),
      ...(row.ee_image ? { eeImage: row.ee_image } : {}),
      ...(row.environment_id ? { environment: row.environment_id } : {}),
      mode: row.mode as RunMode,
      ...(row.run_limit ? { limit: row.run_limit } : {}),
      inputs: JSON.parse(row.inputs_json) as Record<string, unknown>,
      credentials,
      ...(row.notify_json ? { notify: JSON.parse(row.notify_json) as RunNotify } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async list(projectId: string): Promise<LaunchConfig[]> {
    const rows = await this.db
      .selectFrom('launch_config')
      .selectAll()
      .where('project_id', '=', projectId)
      .orderBy('name')
      .execute();
    const credentials = await this.credentialsOf(rows.map((r) => r.id));
    return rows.map((row) => this.of(row, credentials.get(row.id) ?? []));
  }

  async get(id: string): Promise<LaunchConfig | undefined> {
    const row = await this.db
      .selectFrom('launch_config')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? this.of(row, (await this.credentialsOf([id])).get(id) ?? []) : undefined;
  }

  /**
   * The commit a configuration, as it would be saved, runs now: its pin, else the newest of its
   * branch, else of the project's. Throws what is wrong with the branch or the pin.
   */
  private async commitFor(
    project: Project,
    gitRef: string | undefined,
    commit: string | undefined,
  ): Promise<string> {
    if (gitRef && commit) throw invalid('Name a branch or pin a commit, not both', 'commit');
    if (commit) {
      const found = await fullCommit(this.git, project.id, commit);
      if ('problem' in found) throw invalid(found.problem, 'commit');
      return found.commit;
    }
    if (gitRef) {
      const problem = refProblem(gitRef);
      if (problem) throw invalid(problem, 'gitRef');
      return this.git.resolve(project.id, gitRef).catch((e) => {
        throw invalid((e as Error).message, 'gitRef');
      });
    }
    if (!project.commit)
      throw invalid('The project has no commit yet: there is nothing to run', 'flowFile');
    return project.commit;
  }

  /**
   * Everything a configuration says, checked against the project as it is now. An environment
   * with no image yet is accepted (it may be building): the launch refuses it until it has one,
   * and the configuration's page says why (AFS-147).
   */
  private async checked(project: Project, input: LaunchConfigInput) {
    const name = input.name.trim();
    if (name.length < 1 || name.length > 100)
      throw invalid('A launch configuration has a name of 1 to 100 characters', 'name');
    const gitRef = input.gitRef?.trim() || undefined;
    const commit = input.commit?.trim() || undefined;
    const at = await this.commitFor(project, gitRef, commit);
    const flowFile = input.flowFile.trim();
    const flow = await flowAt(this.git, project.id, at, flowFile);
    if ('problem' in flow) throw invalid(flow.problem, 'flowFile', flow.errors);

    const inventory = input.inventory?.trim() || undefined;
    if (inventory) {
      if (pathProblem(inventory)) throw invalid('Not a path inside the repository', 'inventory');
      if (!(await this.git.exists(project.id, at, inventory)))
        throw invalid(
          `The repository has no ${inventory} at commit ${at.slice(0, 12)}`,
          'inventory',
        );
    }
    const eeImage = input.eeImage?.trim() || undefined;
    if (eeImage && !/^[A-Za-z0-9][\w.\-/:@]{0,299}$/.test(eeImage))
      throw invalid('Not the name of a container image', 'eeImage');
    const environment = input.environment || undefined;
    if (environment) {
      const env = await this.db
        .selectFrom('environment')
        .select('workspace_id')
        .where('id', '=', environment)
        .executeTakeFirst();
      if (!env || env.workspace_id !== project.workspace)
        throw invalid('The workspace has no such environment', 'environment');
    }
    const mode = input.mode ?? 'check';
    if (mode !== 'check' && mode !== 'real') throw invalid('A run is check or real', 'mode');
    const limit = input.limit?.trim() || undefined;
    if (limit && (limit.length > 500 || /[\n\r\0]/.test(limit)))
      throw invalid('A limit is one line of at most 500 characters', 'limit');

    // Start values only for inputs the flow has, of the kind the input is, and never a secret.
    const inputs = input.inputs ?? {};
    const fields = new Map(launchFields(flow.doc, {}, mode === 'check').map((f) => [f.name, f]));
    for (const [key, value] of Object.entries(inputs)) {
      const field = fields.get(key);
      if (!field) throw invalid(`The flow has no input ${key.slice(0, 60)}`, key);
      if (field.secret)
        throw invalid(
          `${key} looks like a secret: it is not kept in a launch configuration. Use a credential, or give it at launch`,
          key,
        );
      const read = parseInput(field.type, inputText(value));
      if ('error' in read) throw invalid(`${key}: ${read.error}`, key);
    }

    const credentials = [...new Set(input.credentials ?? [])];
    if (credentials.length > 20) throw invalid('At most 20 credentials', 'credentials');
    if (credentials.length) {
      const rows = await this.db
        .selectFrom('credential')
        .select(['id', 'kind', 'workspace_id', 'name'])
        .where('id', 'in', credentials)
        .execute();
      const byId = new Map(rows.map((row) => [row.id, row]));
      const seen = new Set<string>();
      for (const id of credentials) {
        const row = byId.get(id);
        if (!row || row.workspace_id !== project.workspace)
          throw invalid('The workspace has no such credential', 'credentials');
        const kind = row.kind as CredentialKind;
        if (!RUN_KINDS.includes(kind))
          throw invalid(`${row.name} is a ${kind}: that is not for a run`, 'credentials');
        if (ONE_EACH.includes(kind) && seen.has(kind))
          throw invalid(`A run takes one ${kind} credential`, 'credentials');
        seen.add(kind);
      }
    }

    // Whom its runs tell: logins and groups the server has.
    let notify: RunNotify | undefined;
    if (input.notify) {
      const to = [...new Set(input.notify.to.map((n) => n.trim()).filter(Boolean))];
      if (input.notify.when !== 'failed' && input.notify.when !== 'ended')
        throw invalid('Runs tell when they fail, or whenever they end', 'notify');
      if (to.length > 20) throw invalid('At most 20 people or groups are told', 'notify');
      const unknown = await unknownNames(this.db, to);
      if (unknown.length)
        throw invalid(`No user or group ${unknown.slice(0, 3).join(', ')}`, 'notify');
      // AFS-145: a run's message says what it did: only to who may see the flow's runs.
      const outside = await namesWithoutAccess(this.db, to, {
        workspace: project.workspace,
        project: project.id,
        flowFile,
      });
      if (outside.length)
        throw invalid(
          `${outside.slice(0, 3).join(', ')}${outside.length > 3 ? ' and others' : ''} ${outside.length === 1 ? 'has' : 'have'} no access to this flow: give a grant first, or leave them out`,
          'notify',
        );
      if (to.length) notify = { when: input.notify.when, to };
    }
    return {
      name,
      description: input.description?.trim() || null,
      flow_file: flowFile,
      git_ref: gitRef ?? null,
      // AFS-140: a short commit is kept as its full id.
      commit_id: commit ? at : null,
      inventory: inventory ?? null,
      ee_image: eeImage ?? null,
      environment_id: environment ?? null,
      mode,
      run_limit: limit ?? null,
      inputs_json: JSON.stringify(inputs),
      notify_json: notify ? JSON.stringify(notify) : null,
      credentials,
    };
  }

  private async write(configId: string, credentials: string[], db: Db): Promise<void> {
    await db.deleteFrom('launch_config_credential').where('config_id', '=', configId).execute();
    if (credentials.length)
      await db
        .insertInto('launch_config_credential')
        .values(
          credentials.map((credential_id, position) => ({
            config_id: configId,
            credential_id,
            position,
          })),
        )
        .execute();
  }

  async create(projectId: string, input: LaunchConfigInput): Promise<LaunchConfig> {
    const project = await getProject(this.db, projectId);
    if (!project) throw new LaunchError('not_found', 'No such project');
    const { credentials, ...columns } = await this.checked(project, input);
    const at = now();
    const id = randomUUID();
    await this.db.transaction().execute(async (trx) => {
      const done = await trx
        .insertInto('launch_config')
        .values({ id, project_id: projectId, ...columns, created_at: at, updated_at: at })
        .onConflict((c) => c.columns(['project_id', 'name']).doNothing())
        .executeTakeFirst();
      if (!done.numInsertedOrUpdatedRows)
        throw new LaunchError(
          'taken',
          `The project has a launch configuration "${columns.name}" already`,
          'name',
        );
      await this.write(id, credentials, trx);
    });
    return (await this.get(id)) as LaunchConfig;
  }

  /** Changes a configuration: what is given replaces what was; the whole is checked again. */
  async update(id: string, change: Partial<LaunchConfigInput>): Promise<LaunchConfig> {
    const current = await this.get(id);
    if (!current) throw new LaunchError('not_found', 'No such launch configuration');
    const project = await getProject(this.db, current.project);
    if (!project) throw new LaunchError('not_found', 'No such project');
    const merged: LaunchConfigInput = {
      name: change.name ?? current.name,
      description: change.description ?? current.description,
      flowFile: change.flowFile ?? current.flowFile,
      gitRef: change.gitRef !== undefined ? change.gitRef : current.gitRef,
      commit: change.commit !== undefined ? change.commit : current.commit,
      inventory: change.inventory !== undefined ? change.inventory : current.inventory,
      eeImage: change.eeImage !== undefined ? change.eeImage : current.eeImage,
      environment: change.environment !== undefined ? change.environment : current.environment,
      mode: change.mode ?? current.mode,
      limit: change.limit !== undefined ? change.limit : current.limit,
      inputs: change.inputs ?? current.inputs,
      credentials: change.credentials ?? current.credentials,
      notify: change.notify !== undefined ? change.notify : current.notify,
    };
    const { credentials, ...columns } = await this.checked(project, merged);
    try {
      await this.db.transaction().execute(async (trx) => {
        await trx
          .updateTable('launch_config')
          .set({ ...columns, updated_at: now() })
          .where('id', '=', id)
          .execute();
        await this.write(id, credentials, trx);
      });
    } catch (e) {
      if (/unique|duplicate/i.test(String((e as Error).message)))
        throw new LaunchError(
          'taken',
          `The project has a launch configuration "${columns.name}" already`,
          'name',
        );
      throw e;
    }
    return (await this.get(id)) as LaunchConfig;
  }

  async delete(id: string): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('launch_config_credential').where('config_id', '=', id).execute();
      // AFS-34: its schedules go with it.
      await trx.deleteFrom('schedule').where('config_id', '=', id).execute();
      const done = await trx.deleteFrom('launch_config').where('id', '=', id).executeTakeFirst();
      if (!done.numDeletedRows) throw new LaunchError('not_found', 'No such launch configuration');
    });
  }
}
