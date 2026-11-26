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
import type { FailureFilters, PointSpec } from '@ansible-flow/core/run/step';
import type { Kysely } from 'kysely';
import type { Schema } from '../db/schema';
import { environmentImage } from '../environments/image';
import type { FlowError } from '../flowErrors';
import { type Git, GitError, refProblem } from '../projects/git';
import { getProject } from '../projects/store';
import type { ProjectSync } from '../projects/sync';
import { flowAt, fullCommit, type LaunchConfig, type RunMode } from './configs';

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
  /** AFS-164: a flow that cannot run: its errors, with the step each is on. */
  errors?: FlowError[];
}

/** Everything a run needs, settled. */
export interface PreparedLaunch {
  /** AFS-34: launched by this schedule. */
  schedule?: string;
  /** AFS-175: started through an action: its title. */
  action?: string;
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
  /** AFS-177: run step by step (launch pages, API, MCP; never a schedule or an action). */
  step?: StepAsked;
}

/** AFS-177: what a launch asks for: `{every: true}` pauses before each step, `points` at those. */
export interface StepRequest {
  every?: boolean;
  /** Node ids, or (AFS-179, ADR-0040 §6) points with a condition, a hit count or a log message. */
  points?: PointSpec[];
  /** How long a pause waits, at most the server's setting. */
  timeoutMinutes?: number;
  /** AFS-214 (ADR-0038 §1): a debug run: the debugger may look into its pauses. */
  debug?: boolean;
  /** AFS-214: pause when a host fails, before the run routes it on. */
  pauseOnFailure?: boolean;
  /** AFS-179: which failures pause a debug run (a host failed: as pauseOnFailure says). */
  failures?: FailureFilters;
}

/**
 * AFS-177: what a step-by-step run was asked for: pause before every step (`every`) or only at the
 * pause points (`points`, node ids); `timeoutS` how long a pause waits before the run stops itself.
 */
export interface StepAsked {
  every: boolean;
  points: PointSpec[];
  timeoutS: number;
  /**
   * AFS-205: who set the pause points the run has now, when someone changed them while it went
   * (their login); else they are the launcher's.
   */
  pointsBy?: string;
  /** AFS-214: a debug run (the designer's engine reads it, ADR-0040). */
  debug?: boolean;
  /** AFS-214: pauses when a host fails. */
  pauseOnFailure?: boolean;
  /** AFS-179: a debug run's failure filters, as asked (else from pauseOnFailure). */
  failures?: FailureFilters;
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
  /**
   * AFS-183: per input, where it goes in one line (the steps that read it, its default, what it
   * wins over). Only on the form route's answer.
   */
  origins?: Record<string, string>;
  /** AFS-272: the steps a run goes through when everything goes well, by title (`stepsOf`). */
  steps?: string[];
  /** AFS-272: the flow's approvals, by title, with the approvers each names (none: the default). */
  approvals?: { title: string; approvers: string[] }[];
}

export type Prepared =
  | { ok: true; launch: PreparedLaunch; form: LaunchForm }
  | { ok: false; problems: Problem[]; form?: LaunchForm };

export interface PrepareDeps {
  db: Kysely<Schema>;
  git: Git;
  sync: ProjectSync;
}

/** How far `stepsOf` lists: enough to see what a run does, short enough to read beside a form. */
export const STEPS_SHOWN = 12;

/**
 * AFS-272: the steps a run goes through when everything goes well, by title, from the start to an
 * end: each step's ok port, an approval's approved port. A step that branches (a decision, parallel
 * paths) is the last one listed: past it the way depends on the hosts. Top level only: a subflow is
 * one step, as the canvas shows it.
 */
export function stepsOf(doc: Pick<FlowDocument, 'nodes' | 'edges'>): string[] {
  const titles: string[] = [];
  let at = doc.nodes.find((n) => n.type === 'start');
  const seen = new Set<string>();
  while (at && titles.length < STEPS_SHOWN) {
    seen.add(at.id);
    const from: string = at.id;
    const port = at.type === 'approval' ? 'approved' : 'ok_hosts';
    const edge = doc.edges?.find((e) => e.from.node === from && e.from.port === port);
    const next = edge && doc.nodes.find((n) => n.id === edge.to.node);
    if (!next || seen.has(next.id) || next.type === 'end') break;
    // A step with no title is named by its key: an empty name reads as "A ›  › B".
    titles.push(next.title?.trim() || next.key || 'an untitled step');
    at = next;
  }
  return titles;
}

/** AFS-272: the flow's approvals, with the approvers each names: what a real run waits for. */
export const approvalsOf = (doc: Pick<FlowDocument, 'nodes'>) =>
  doc.nodes
    .filter((n) => n.type === 'approval')
    .map((n) => ({ title: n.title, approvers: [...(n.approval?.approvers ?? [])] }));

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
  const fail = (message: string, field?: string, errors?: FlowError[]): Prepared => ({
    ok: false,
    problems: [{ message, ...(field ? { field } : {}), ...(errors?.length ? { errors } : {}) }],
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
    const found = await fullCommit(deps.git, project.id, pinned);
    if ('problem' in found) return fail(found.problem, 'commit');
    commit = found.commit;
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
  if ('problem' in flow) return fail(flow.problem, 'flowFile', flow.errors);
  const mode = request.mode ?? config.mode;
  if (mode !== 'check' && mode !== 'real') return fail('A run is check or real', 'mode');
  // AFS-191: a limit given at launch, even an empty one, is the run's: empty runs without one.
  const limit = request.limit !== undefined ? request.limit.trim() || undefined : config.limit;
  if (limit && (limit.length > 500 || /[\n\r\0]/.test(limit)))
    return fail('A limit is one line of at most 500 characters', 'limit');

  // AFS-32: the environment's image now; the configuration's own image when it names none.
  let eeImage = config.eeImage;
  if (config.environment) {
    const env = await environmentImage(deps.db, config.environment);
    if (!env.image) return fail(env.why ?? 'The environment has no image', 'environment');
    eeImage = env.image;
  }
  const fields = launchFields(flow.doc, config.inputs, mode === 'check', false);
  markTargets(flow.doc, fields);
  const steps = stepsOf(flow.doc);
  const approvals = approvalsOf(flow.doc);
  const form: LaunchForm = {
    commit,
    ...(pinned ? {} : { ref: ref ?? project.gitRef }),
    flow: flowOf(flow.doc, config.flowFile),
    mode,
    fields,
    ...(config.inventory ? { inventory: config.inventory } : {}),
    ...(eeImage ? { eeImage } : {}),
    ...(limit ? { limit } : {}),
    ...(steps.length ? { steps } : {}),
    ...(approvals.length ? { approvals } : {}),
  };

  const problems: Problem[] = [];
  const known = new Set(fields.map((f) => f.name));
  for (const name of Object.keys(request.inputs ?? {}))
    if (!known.has(name))
      problems.push({ field: name, message: `The flow has no input ${name.slice(0, 60)}` });
  const typed = Object.fromEntries(
    fields.map((field) => [field.name, request.inputs?.[field.name] ?? field.text]),
  );
  const lists = hostListTexts(fields, typed);
  if ('error' in lists) problems.push({ field: lists.field, message: lists.error });
  const texts = 'texts' in lists ? lists.texts : typed;
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
      ...(eeImage ? { eeImage } : {}),
      ...(limit ? { limit } : {}),
      inputs: read.inputs,
      targets: targetsOf(flow.doc, read.inputs),
      credentials: config.credentials,
    },
  };
}

/**
 * AFS-191: the host lists typed as a JSON list (the text starts with "["), as names separated by
 * commas, which is how the designer's reading takes a host list. A text that does not read as a
 * list of names is refused at its field, so it never becomes a host name of its own.
 */
export function hostListTexts(
  fields: readonly LaunchField[],
  texts: Record<string, string>,
): { texts: Record<string, string> } | { field: string; error: string } {
  const out = { ...texts };
  for (const field of fields) {
    const text = texts[field.name]?.trim() ?? '';
    if (field.type !== 'host_list' || !text.startsWith('[')) continue;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      value = undefined;
    }
    const names = Array.isArray(value)
      ? value.map((v) =>
          typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '',
        )
      : [];
    if (!Array.isArray(value) || names.some((n) => !n || /[\s,]/.test(n)))
      return {
        field: field.name,
        error: `${field.name} is not a JSON list of names: write it as ["web-01", "web-02"], or the names separated by commas`,
      };
    out[field.name] = names.join(', ');
  }
  return { texts: out };
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

/**
 * AFS-170: a flow that marks no input as its targets runs on its first host list (targetsOf):
 * that field is then the targets, and offers the inventory's groups as a marked one does.
 */
export function markTargets(doc: FlowDocument, fields: LaunchField[]): void {
  if (fields.some((f) => f.targets)) return;
  const first = Object.entries(doc.flow.inputs ?? {}).find(([, f]) => f?.type === 'host_list');
  const field = first && fields.find((f) => f.name === first[0]);
  if (field) field.targets = true;
}
