// AFS-214, AFS-240, AFS-238 (ADR-0038 §2): running a run again, all of it or only the hosts that
// did not go well, in another mode, step by step with pause points (Debug this failure), at the
// same commit or the newest.
//
//   GET  /api/v1/runs/:id/relaunch   what Run again offers: the run's host sets, its outcome line,
//                                    the risks of a host limit, the flow's approvals
//   POST /api/v1/runs/:id/relaunch   {hosts?, includeHandled?, mode?, step?, commit?}: the new run
//
// A run again goes through the launch's checks: its launch configuration as it is now (the
// credentials it gives its operators now, its flow, its environment), rw for another branch or
// commit than the configuration names or for a dev run, and its inputs read again as the flow's
// types. Approvals are asked again: a run's approvals are its own. `{}` is 1.1's Run again.
import { inputText } from '@ansible-flow/core/run/launch';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { accessOf, atLeast } from '../access/grants';
import { signedIn } from '../auth/guards';
import { flowAt, LaunchConfigs } from '../launch/configs';
import { getDevBundle } from '../launch/dev';
import { type PrepareDeps, prepareLaunch, type StepAsked, withoutSecrets } from '../launch/prepare';
import { getProject } from '../projects/store';
import {
  chosenHosts,
  type FlowStep,
  HOST_CHOICES,
  type HostChoice,
  hostSets,
  MAX_LIMIT_HOSTS,
  outcomeLine,
  type RelaunchBody,
  type RelaunchOffer,
  stepIds,
  type ViewOfHosts,
} from './hostSets';
import {
  ACTIVE,
  stepAsked as askedOf,
  type RelaunchOf,
  type RelaunchPlan,
  type Run,
  type RunQueue,
} from './queue';
import { STEP_SCHEMA, STEP_TIMEOUT_MINUTES, stepAsked } from './stepping';

const text = (max: number, min = 0) => ({ type: 'string', minLength: min, maxLength: max });
const ID = { params: { type: 'object', properties: { id: text(64, 1) }, required: ['id'] } };
const NONE = { error: 'not_found', message: 'No such run' };
export const RELAUNCH_BODY = {
  type: 'object',
  additionalProperties: false,
  properties: {
    hosts: {
      anyOf: [
        { type: 'string', enum: [...HOST_CHOICES] },
        { type: 'array', minItems: 1, maxItems: MAX_LIMIT_HOSTS, items: text(500, 1) },
      ],
    },
    includeHandled: { type: 'boolean' },
    mode: { type: 'string', enum: ['check', 'real'] },
    step: { anyOf: [STEP_SCHEMA, { type: 'null' }] },
    commit: { type: 'string', enum: ['same', 'newest'] },
  },
};

type Refusal = { status: number; error: string; message: string; field?: string };
const refuse = (status: number, message: string, field?: string): Refusal => ({
  status,
  error: status === 409 ? 'conflict' : status === 403 ? 'forbidden' : 'not_ready',
  message,
  ...(field ? { field } : {}),
});

interface Node extends FlowStep {
  disabled?: boolean;
  type?: string;
  impl?: { keywords?: Record<string, unknown> } | null;
  settings?: FlowStep['settings'] & {
    inventory_target?: string;
    max_fail_percentage?: number;
    serial?: string | number;
  };
  subflow?: { nodes?: Node[] };
}

const each = (nodes: readonly Node[], visit: (n: Node) => void) => {
  for (const n of nodes) {
    visit(n);
    each(n.subflow?.nodes ?? [], visit);
  }
};
const named = (n: Node) => n.title || n.key || n.id;
const listed = (names: string[]) =>
  names.length > 3
    ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`
    : names.join(', ');

/**
 * ADR-0038 §2: what a host limit changes in this flow, said in the form before a run again of some
 * hosts: steps that run on other hosts (localhost, a controller group) are skipped unless those
 * hosts are in the limit; run_once, failure percentages and rolling batches see only the hosts in
 * the limit.
 */
export function limitRisks(nodes: readonly Node[]): string[] {
  const elsewhere = new Map<string, string[]>();
  const once: string[] = [];
  const counted: string[] = [];
  each(nodes, (n) => {
    if (n.disabled) return;
    const target = n.settings?.inventory_target?.trim();
    if (target) elsewhere.set(target, [...(elsewhere.get(target) ?? []), named(n)]);
    const runOnce = n.impl?.keywords?.run_once;
    if (runOnce === true || runOnce === 'true' || runOnce === 'yes') once.push(named(n));
    if (
      n.settings?.max_fail_percentage !== undefined ||
      n.settings?.serial !== undefined ||
      n.settings?.rolling !== undefined
    )
      counted.push(named(n));
  });
  const risks: string[] = [];
  for (const [target, steps] of elsewhere)
    risks.push(
      `${listed(steps)} ${steps.length === 1 ? 'runs' : 'run'} on ${target}: the host limit skips ${steps.length === 1 ? 'it' : 'them'} unless ${target} is one of the hosts`,
    );
  if (once.length)
    risks.push(
      `${listed(once)} ${once.length === 1 ? 'runs' : 'run'} once (run_once): only on these hosts, and ${once.length === 1 ? 'it sees' : 'they see'} only them`,
    );
  if (counted.length)
    risks.push(
      `Failure percentages and rolling batches (${listed(counted)}) count only these hosts: 1 of 3 is 33%`,
    );
  return risks;
}

/** The approvals of a flow, by title, every level. */
export function approvalTitles(nodes: readonly Node[]): string[] {
  const out: string[] = [];
  each(nodes, (n) => {
    if (n.type === 'approval' && !n.disabled) out.push(named(n));
  });
  return out;
}

/** "No host failed in run #41": a set that is empty, in words. */
export function emptyWords(choice: Exclude<HostChoice, 'all'>, number: number): string {
  const of = `run #${number}`;
  switch (choice) {
    case 'failed':
      return `No host failed in ${of}`;
    case 'unreachable':
      return `Every host of ${of} could be reached`;
    case 'stopped':
      return `No host of ${of} stopped before the end`;
    default:
      return `Every host of ${of} went well: there is no host to run again`;
  }
}

export interface RelaunchDeps extends PrepareDeps {
  queue: RunQueue;
  /** How long a step-by-step run's pause may wait at most (minutes). */
  stepTimeoutMinutes?: number;
}

export function registerRelaunch(app: FastifyInstance, deps: RelaunchDeps): void {
  const configs = new LaunchConfigs(deps.db, deps.git);
  const { queue } = deps;

  /** The flow's nodes at a commit; none when the flow cannot be read there. */
  const nodesAt = async (run: Run, commit = run.commit): Promise<Node[] | undefined> => {
    const flow = await flowAt(deps.git, run.project, commit, run.flow.file).catch(() => undefined);
    const doc = flow && 'doc' in flow ? flow.doc : undefined;
    return doc ? (doc.nodes as Node[]) : undefined;
  };

  app.get<{ Params: { id: string } }>(
    '/api/v1/runs/:id/relaunch',
    { schema: ID },
    async (request, reply) => {
      // ro on the run's flow: checked before (api/catalog.ts).
      if (!signedIn(request, reply)) return reply;
      const run = await queue.get(request.params.id);
      if (!run) return reply.code(404).send(NONE);
      const nodes = (await nodesAt(run)) ?? [];
      const view = ACTIVE.includes(run.state)
        ? undefined
        : ((await queue.view(run.id)) as ViewOfHosts | undefined);
      const sets = view?.summary?.hosts?.length
        ? hostSets(view, nodes, run.state === 'cancelled')
        : undefined;
      const line = sets && outcomeLine(sets);
      const offer: RelaunchOffer = {
        ...(sets ? { sets } : {}),
        ...(line ? { line } : {}),
        risks: limitRisks(nodes),
        approvals: approvalTitles(nodes),
      };
      return offer;
    },
  );

  /** Settles a run again, or says what stands in its way. */
  const settle = async (
    request: FastifyRequest,
    id: string,
    body: RelaunchBody,
  ): Promise<{ plan: RelaunchPlan; names?: string[] } | Refusal | undefined> => {
    const old = await queue.get(id);
    if (!old) return undefined;
    if (ACTIVE.includes(old.state))
      return refuse(409, `Run #${old.number} is still going: run it again once it has ended`);
    const config = old.config ? await configs.get(old.config.id) : undefined;
    if (!config)
      return refuse(
        422,
        `The launch configuration of run #${old.number} is gone: launch the flow from one of its configurations`,
      );
    if (config.flowFile !== old.flow.file)
      return refuse(
        422,
        `The launch configuration ${config.name} runs ${config.flowFile} now: launch it from there`,
      );
    const project = await getProject(deps.db, old.project);
    if (!project) return refuse(422, 'The project is gone');
    const access = await accessOf(deps.db, request);
    const rw = atLeast(access?.onFlow(project.workspace, project.id, old.flow.file), 'rw');

    const commit = body.commit ?? 'same';
    const mode = body.mode ?? old.mode;
    const row = await deps.db
      .selectFrom('run')
      .select(['dev_bundle', 'step_json'])
      .where('id', '=', id)
      .executeTakeFirst();
    const dev = row?.dev_bundle ?? undefined;
    if (dev) {
      if (commit === 'newest')
        return refuse(
          422,
          'A dev run runs the work it was sent: it has no newest commit',
          'commit',
        );
      if (mode === 'real')
        return refuse(
          422,
          "A dev run is a check run: a real run takes a commit of the project's branch (push it first)",
          'mode',
        );
      if (!(await getDevBundle(deps.db, dev)))
        return refuse(422, 'The work this dev run ran is gone: send it again from VS Code');
    }
    // The launch's rule: another branch or commit than the configuration names is rw's.
    const configRef = config.gitRef ?? project.gitRef;
    const ownBranch = !!old.ref && old.ref !== configRef;
    const asConfigured = config.commit
      ? !old.ref && old.commit.startsWith(config.commit.toLowerCase())
      : old.ref === configRef;
    const needsRw = !!dev || (commit === 'same' ? !asConfigured : ownBranch);
    if (needsRw && !rw)
      return refuse(
        403,
        `Run #${old.number} ran ${dev ? 'unpushed work (a dev run)' : 'another branch or commit than its launch configuration names'}: running it again needs rw on ${old.flow.file}`,
      );

    // AFS-214: the step-by-step part: as the run was asked (absent), none (null), or new.
    let step: StepAsked | null;
    if (body.step === undefined) step = row?.step_json ? askedOf(row.step_json) : null;
    else if (body.step === null) step = null;
    else {
      const asked = stepAsked(body.step, deps.stepTimeoutMinutes ?? STEP_TIMEOUT_MINUTES);
      if (asked && 'error' in asked) return refuse(400, asked.error, 'step');
      step = asked ?? null;
    }
    // ADR-0038 §1: a debug run looks into the run's variables: rw on the flow.
    if (step?.debug && !rw) return refuse(403, `A debug run needs rw on ${old.flow.file}`, 'step');

    // The launch's checks, with the run's inputs, at its commit or the newest.
    const inputs = (await queue.inputsOf(id)) ?? {};
    const typed = Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, inputText(v)]));
    const {
      environment: _environment,
      inventory: _inventory,
      eeImage: _eeImage,
      limit: _limit,
      ...fixed
    } = config;
    const prepared =
      commit === 'same'
        ? await prepareLaunch(
            deps,
            {
              ...fixed,
              ...(old.inventory ? { inventory: old.inventory } : {}),
              ...(old.eeImage ? { eeImage: old.eeImage } : {}),
            },
            { commit: old.commit, mode, inputs: typed, limit: old.limit ?? '' },
            false,
          )
        : await prepareLaunch(
            deps,
            config,
            {
              ...(ownBranch && old.ref ? { ref: old.ref } : {}),
              mode,
              inputs: typed,
              limit: old.limit ?? '',
            },
            true,
          );
    if (!prepared.ok)
      return {
        status: 422,
        error: 'not_ready',
        message: prepared.problems[0]?.message ?? 'The run cannot run again',
      };
    const launch = prepared.launch;

    // The flow at the commit that runs: its steps for the pause points, its titles for the sets.
    const nodes = await nodesAt(old, launch.commit);
    if (step?.points.length) {
      const known = stepIds(nodes ?? []);
      const missing = step.points.find((p) => !known.has(p));
      if (missing)
        return refuse(
          422,
          `A pause point (${missing}) is not a step of the flow at commit ${launch.commit.slice(0, 12)}`,
          'step',
        );
    }

    // Which hosts.
    const choice = body.hosts ?? 'all';
    let relaunchOf: RelaunchOf = { id: old.id, number: old.number, hosts: 'all' };
    let names: string[] | undefined;
    if (choice !== 'all') {
      const view = (await queue.view(id)) as ViewOfHosts | undefined;
      const hosts = view?.summary?.hosts ?? [];
      if (!hosts.length)
        return refuse(
          422,
          `Run #${old.number} has no hosts to choose from: it reached none`,
          'hosts',
        );
      const sets = hostSets(view, (await nodesAt(old)) ?? nodes ?? [], old.state === 'cancelled');
      if (Array.isArray(choice)) {
        names = [...new Set(choice)];
        const unknown = names.find((n) => !hosts.includes(n));
        if (unknown)
          return refuse(
            422,
            `${unknown.slice(0, 200)} was not a host of run #${old.number}`,
            'hosts',
          );
      } else names = chosenHosts(sets, choice, !!body.includeHandled);
      if (!names.length)
        return refuse(
          422,
          emptyWords(Array.isArray(choice) ? 'not-ok' : choice, old.number),
          'hosts',
        );
      if (names.length > MAX_LIMIT_HOSTS)
        return refuse(422, `A run again takes at most ${MAX_LIMIT_HOSTS} hosts`, 'hosts');
      if (names.some((n) => /[\n\r\0]/.test(n)))
        return refuse(422, 'A host name of this run cannot be put in a limit', 'hosts');
      relaunchOf = {
        id: old.id,
        number: old.number,
        hosts: Array.isArray(choice) ? 'chosen' : choice,
        count: names.length,
      };
    }

    const plan: RelaunchPlan = {
      commit: launch.commit,
      ...(commit === 'same'
        ? old.ref
          ? { ref: old.ref }
          : {}
        : launch.ref
          ? { ref: launch.ref }
          : {}),
      flow: launch.flow,
      mode,
      ...(launch.inventory ? { inventory: launch.inventory } : {}),
      ...(launch.eeImage ? { eeImage: launch.eeImage } : {}),
      ...(launch.limit ? { limit: launch.limit } : {}),
      // AFS-238: the credentials its configuration gives now, not the ones the old run had.
      credentials: launch.credentials,
      ...(commit === 'newest'
        ? {
            inputs: launch.inputs,
            shown: withoutSecrets(launch, prepared.form.fields).inputs,
            targets: launch.targets,
          }
        : {}),
      step,
      ...(names ? { limitHosts: names } : {}),
      relaunchOf,
    };
    return { plan, ...(names ? { names } : {}) };
  };

  app.post<{ Params: { id: string }; Body: RelaunchBody | undefined }>(
    '/api/v1/runs/:id/relaunch',
    {
      schema: { ...ID, body: RELAUNCH_BODY },
      // 1.1's Run again sends no body: that is `{}`.
      preValidation: async (request) => {
        request.body ??= {};
      },
    },
    async (request, reply: FastifyReply) => {
      // operator on the run's flow: checked before (api/catalog.ts); the rest here.
      const me = signedIn(request, reply);
      if (!me) return reply;
      const body = request.body ?? {};
      const settled = await settle(request, request.params.id, body);
      if (!settled) return reply.code(404).send(NONE);
      if ('status' in settled) {
        const { status, ...refusal } = settled;
        return reply.code(status).send(refusal);
      }
      const { plan, names } = settled;
      // The audit entry says which hosts (the set, how many, the first names) and how it runs.
      request.auditDetail = {
        hosts: plan.relaunchOf.hosts,
        ...(names
          ? {
              count: String(names.length),
              names: names.length > 100 ? [...names.slice(0, 100), '…'] : names,
            }
          : {}),
        commit: body.commit ?? 'same',
        ...(plan.step
          ? {
              step: plan.step.debug ? 'debug' : plan.step.every ? 'every step' : 'pause points',
            }
          : {}),
      };
      const run = await queue.relaunch(request.params.id, me, plan);
      if (!run) return reply.code(404).send(NONE);
      request.log.info(
        {
          by: me.login,
          run: run.id,
          number: run.number,
          of: request.params.id,
          hosts: plan.relaunchOf.hosts,
          ...(names ? { count: names.length } : {}),
          mode: run.mode,
        },
        'Run queued again',
      );
      return reply.code(201).send(run);
    },
  );
}
