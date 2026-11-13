// From a launch configuration and what a person adds at launch, to exactly what would run: the
// commit, the flow, the inputs read as the flow's types, the hosts it targets. Nothing runs
// here; the answer is what a run is made from, or everything that stands in its way.
import type { FlowDocument } from '@ansible-flow/core/flow/types';
import {
  type LaunchField,
  launchFields,
  readFields,
  targetsOf,
} from '@ansible-flow/core/run/launch';
import type { Kysely } from 'kysely';
import type { Schema } from '../db/schema';
import { type Git, GitError, refProblem } from '../projects/git';
import { getProject } from '../projects/store';
import type { ProjectSync } from '../projects/sync';
import { COMMIT, flowAt, type LaunchConfig, type RunMode } from './configs';

/** What a launch may say beyond its configuration. */
export interface LaunchRequest {
  mode?: RunMode;
  /** Another branch to take the newest commit of. */
  ref?: string;
  /** One commit. */
  commit?: string;
  /** AFS-26: a dev bundle's id: its commit runs, in check mode only. */
  dev?: string;
  /** The inputs as typed: text per input, read as the input's type. */
  inputs?: Record<string, string>;
  limit?: string;
}

export interface Problem {
  /** The input or setting it is about, when it is about one. */
  field?: string;
  message: string;
}

/** Everything a run needs, settled. */
export interface PreparedLaunch {
  config: string;
  project: string;
  /** The commit that runs, and the branch it was the newest of when that is how it was found. */
  commit: string;
  ref?: string;
  flow: { file: string; key: string; name: string; version: number };
  mode: RunMode;
  inventory?: string;
  eeImage?: string;
  limit?: string;
  /** The inputs as the flow gets them. A secret-looking one is here in full: never send this on. */
  inputs: Record<string, unknown>;
  /** The hosts and groups the flow starts on. */
  targets: string[];
  credentials: string[];
  /** AFS-26: a dev run: the bundle of unpushed work whose commit it runs. */
  dev?: string;
}

export interface LaunchForm {
  commit: string;
  ref?: string;
  flow: PreparedLaunch['flow'];
  mode: RunMode;
  /** The flow's inputs as a form shows them, starting with the configuration's values. */
  fields: LaunchField[];
  inventory?: string;
  eeImage?: string;
  limit?: string;
}

export type Prepared =
  | { ok: true; launch: PreparedLaunch; form: LaunchForm }
  | { ok: false; problems: Problem[]; form?: LaunchForm };

export interface PrepareDeps {
  db: Kysely<Schema>;
  git: Git;
  sync: ProjectSync;
}

const flowOf = (doc: FlowDocument, file: string): PreparedLaunch['flow'] => ({
  file,
  key: doc.flow.key,
  name: doc.flow.name,
  version: doc.flow.version,
});

/**
 * Settles a launch. With `look`, a project that has a source is brought up to date first, so
 * "the newest commit" is the newest there is, not the newest the server happened to know.
 */
export async function prepareLaunch(
  deps: PrepareDeps,
  config: LaunchConfig,
  request: LaunchRequest = {},
  look = true,
): Promise<Prepared> {
  const fail = (message: string, field?: string): Prepared => ({
    ok: false,
    problems: [{ message, ...(field ? { field } : {}) }],
  });
  let project = await getProject(deps.db, config.project);
  if (!project) return fail('The project is gone');
  if (look && project.gitUrl) project = (await deps.sync.sync(project.id)) ?? project;

  // Which commit: what the launch says, else what the configuration says, else the project's.
  if (request.ref && request.commit) return fail('Name a branch or a commit, not both', 'commit');
  const pinned = request.commit ?? (request.ref ? undefined : config.commit);
  const ref = request.ref ?? (request.commit ? undefined : config.gitRef);
  let commit: string;
  if (pinned) {
    if (!COMMIT.test(pinned)) return fail('A commit is its full 40-character id', 'commit');
    if (!(await deps.git.hasCommit(project.id, pinned)))
      return fail(`The repository has no commit ${pinned.slice(0, 12)}`, 'commit');
    commit = pinned;
  } else if (ref) {
    const problem = refProblem(ref);
    if (problem) return fail(problem, 'ref');
    try {
      commit = await deps.git.resolve(project.id, ref);
    } catch (e) {
      if (!(e instanceof GitError)) throw e;
      return fail(e.message, 'ref');
    }
  } else {
    // The project's own branch. A source that could not be read just now is said, not hidden:
    // the run would be of an older commit than the person thinks.
    if (project.sync.state === 'error')
      return fail(`The project's repository cannot be read: ${project.sync.error ?? 'unknown'}`);
    if (!project.commit) return fail('The project has no commit yet: there is nothing to run');
    commit = project.commit;
  }

  const flow = await flowAt(deps.git, project.id, commit, config.flowFile);
  if ('problem' in flow) return fail(flow.problem, 'flowFile');
  const mode = request.mode ?? config.mode;
  if (mode !== 'check' && mode !== 'real') return fail('A run is check or real', 'mode');
  const limit = request.limit?.trim() || config.limit;
  if (limit && (limit.length > 500 || /[\n\r\0]/.test(limit)))
    return fail('A limit is one line of at most 500 characters', 'limit');

  const fields = launchFields(flow.doc, config.inputs, mode === 'check', false);
  const form: LaunchForm = {
    commit,
    ...(pinned ? {} : { ref: ref ?? project.gitRef }),
    flow: flowOf(flow.doc, config.flowFile),
    mode,
    fields,
    ...(config.inventory ? { inventory: config.inventory } : {}),
    ...(config.eeImage ? { eeImage: config.eeImage } : {}),
    ...(limit ? { limit } : {}),
  };

  const problems: Problem[] = [];
  const known = new Set(fields.map((f) => f.name));
  for (const name of Object.keys(request.inputs ?? {}))
    if (!known.has(name))
      problems.push({ field: name, message: `The flow has no input ${name.slice(0, 60)}` });
  const texts = Object.fromEntries(
    fields.map((field) => [field.name, request.inputs?.[field.name] ?? field.text]),
  );
  for (const field of fields)
    if (field.required && !texts[field.name]?.trim())
      problems.push({ field: field.name, message: `${field.name} is required` });
  const read = readFields(fields, texts);
  if ('error' in read && !problems.some((p) => p.field === read.field))
    problems.push({ field: read.field, message: read.error });
  if (config.inventory && !(await deps.git.exists(project.id, commit, config.inventory)))
    problems.push({
      field: 'inventory',
      message: `The repository has no ${config.inventory} at commit ${commit.slice(0, 12)}`,
    });
  if (config.credentials.length) {
    const have = await deps.db
      .selectFrom('credential')
      .select('id')
      .where('id', 'in', config.credentials)
      .execute();
    if (have.length !== config.credentials.length)
      problems.push({
        field: 'credentials',
        message: 'A credential of this configuration is gone',
      });
  }
  if (problems.length || 'error' in read) return { ok: false, problems, form };

  return {
    ok: true,
    form,
    launch: {
      config: config.id,
      project: project.id,
      commit,
      ...(form.ref ? { ref: form.ref } : {}),
      flow: form.flow,
      mode,
      ...(config.inventory ? { inventory: config.inventory } : {}),
      ...(config.eeImage ? { eeImage: config.eeImage } : {}),
      ...(limit ? { limit } : {}),
      inputs: read.inputs,
      targets: targetsOf(flow.doc, read.inputs),
      credentials: config.credentials,
    },
  };
}

/** A prepared launch as an answer to a request: a secret-looking input's value is not repeated. */
export function withoutSecrets(launch: PreparedLaunch, fields: LaunchField[]): PreparedLaunch {
  const secret = new Set(fields.filter((f) => f.secret).map((f) => f.name));
  return {
    ...launch,
    inputs: Object.fromEntries(
      Object.entries(launch.inputs).map(([name, value]) => [
        name,
        secret.has(name) ? '***' : value,
      ]),
    ),
  };
}
