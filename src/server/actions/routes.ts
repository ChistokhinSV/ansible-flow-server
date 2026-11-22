// AFS-175: actions over HTTP (ADR-0036). Who may run an action is checked here, on every route:
// the catalog's access-level hook does not know action grants, so these routes are "may run the
// action" there. A person who may not even see the workspace is told nothing is there (404).
//   GET    /api/v1/actions                         the actions I may run, my last run of each
//   GET    /api/v1/actions/:id                     its form: the asked inputs, what will happen
//   GET    /api/v1/actions/:id/hosts               the inventory's names, for a host list
//   POST   /api/v1/actions/:id/run                 run it with the asked values
//   GET    /api/v1/actions/runs/:id                how a run of an action goes, in words
//   GET    /api/v1/actions/runs/:id/events         the same, live (server-sent events)
//   GET|PUT|DELETE /api/v1/launch-configs/:id/action
//   POST   /api/v1/launch-configs/:id/action/grants
//   DELETE /api/v1/launch-configs/:id/action/grants/:grant
//   GET    /api/v1/workspaces/:id/action-grants    for the workspace's Access tab
// AFS-176 (ADR-0037): links to actions from other systems.
//   GET    /api/v1/actions/:id/link?<input>=<value>  what a link gives: ready to confirm, or a form
//   GET|POST /api/v1/launch-configs/:id/action/tokens, DELETE …/tokens/:token   signed links
//   POST   /api/v1/actions/:id/run also takes `Authorization: Bearer afsl_…` (a signed link)

import type { ServerResponse } from 'node:http';
import type { FlowDocument } from '@ansible-flow/core/flow/types';
import type { RunView } from '@ansible-flow/core/protocol';
import { parseInput } from '@ansible-flow/core/run/launch';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type Access, accessOf, atLeast } from '../access/grants';
import { decidersOf, gatesOf } from '../approvals/gates';
import { inSession, signedIn } from '../auth/guards';
import { FailureLimiter } from '../auth/limiter';
import type { LaunchConfig } from '../launch/configs';
import { flowAt, LaunchConfigs } from '../launch/configs';
import { type PrepareDeps, prepareLaunch, withoutSecrets } from '../launch/prepare';
import { getProject, getWorkspace } from '../projects/store';
import type { VarIndexes } from '../projects/vars';
import type { RunHub } from '../runs/hub';
import { ACTIVE, type Run, type RunQueue, type RunState } from '../runs/queue';
import { flowSteps, progressOf, runLine } from './progress';
import {
  ActionError,
  type ActionPlace,
  actionFields,
  actionGrants,
  actionTokenOf,
  actionTokens,
  checkSettings,
  createActionToken,
  enabledActions,
  fillAction,
  getAction,
  grantAction,
  grantedActions,
  groupHosts,
  looksLikeActionToken,
  mayRun,
  noteReply,
  outsideGroup,
  placeOf,
  removeAction,
  revokeActionToken,
  setAction,
  ungrantAction,
  workspaceActionGrants,
} from './store';
import {
  type Action,
  type ActionCard,
  type ActionField,
  type ActionForm,
  type ActionHosts,
  type ActionLink,
  type ActionSettings,
  REPLY_PARAM,
  replyObject,
  SYSTEM_NAME,
} from './types';

const STATUS: Record<ActionError['code'], number> = { invalid: 400, not_found: 404, taken: 409 };
const text = (max: number, min = 0) => ({ type: 'string', minLength: min, maxLength: max });
const ID = { params: { type: 'object', properties: { id: text(64, 1) }, required: ['id'] } };
const NO_ACTION = { error: 'not_found', message: 'No such action' };
const NO_RUN = { error: 'not_found', message: 'No such run' };
const LOOK_MS = 1000;
const KEEP_ALIVE_MS = 15_000;

const SETTINGS = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'summary', 'asked', 'mode'],
  properties: {
    title: text(100, 1),
    summary: text(300, 1),
    asked: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'label'],
        properties: {
          name: text(200, 1),
          label: text(80, 1),
          help: text(200),
          choices: { type: 'array', maxItems: 50, items: text(200, 1) },
          group: text(200),
        },
      },
    },
    mode: { type: 'string', enum: ['check', 'real'] },
    confirm: { type: 'boolean' },
    enabled: { type: 'boolean' },
    runOnOpen: { type: 'boolean' },
    reply: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          required: ['system', 'credential', 'when'],
          properties: {
            system: { type: 'string', enum: ['netbox', 'zabbix'] },
            credential: text(64, 1),
            when: { type: 'string', enum: ['ended', 'failed'] },
          },
        },
      ],
    },
  },
};

/** AFS-176: a wrong signed-link token counts as a wrong attempt: it must not be guessable. */
const TOKEN_WINDOW_MS = 15 * 60_000;

/** AFS-176: the bearer token of a request, when it is a signed link's (never from a URL). */
const actionBearer = (request: FastifyRequest): string | undefined => {
  const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? '')?.[1];
  return bearer?.startsWith('afsl_') ? bearer : undefined;
};

export interface ActionDeps extends PrepareDeps {
  queue?: RunQueue;
  hub?: RunHub;
  vars?: VarIndexes;
}

/** "Nora Brandt (who set up this action)", then the administrators: whom a runner asks. */
async function whomToAsk(deps: ActionDeps, action: Action | undefined): Promise<string[]> {
  const admins = await deps.db
    .selectFrom('user_account')
    .select(['name', 'login'])
    .where('is_admin', '=', 1)
    .where('disabled', '=', 0)
    .orderBy('name')
    .execute();
  const ask = action?.owner ? [`${action.owner.name} (who set up this action)`] : [];
  const names = admins.map((a) => a.name || a.login).filter((n) => n !== action?.owner?.name);
  if (names.length)
    ask.push(
      `${names.length === 1 ? 'the administrator' : 'the administrators'} ${names.slice(0, 3).join(', ')}${names.length > 3 ? ' and others' : ''}`,
    );
  return ask;
}

export function registerActions(app: FastifyInstance, deps: ActionDeps): void {
  const { db } = deps;
  const configs = new LaunchConfigs(db, deps.git);
  /** The progress streams open now: a server that closes ends them, or it would wait for them. */
  const streams = new Set<ServerResponse>();
  app.addHook('preClose', async () => {
    for (const stream of streams) stream.end();
    streams.clear();
  });
  type WithId = { Params: { id: string } };

  const answering =
    <R extends FastifyRequest>(handler: (request: R, reply: FastifyReply) => Promise<unknown>) =>
    async (request: R, reply: FastifyReply) => {
      try {
        return await handler(request, reply);
      } catch (e) {
        if (e instanceof ActionError)
          return reply.code(STATUS[e.code]).send({
            error: e.code,
            message: e.message,
            ...(e.field ? { field: e.field } : {}),
          });
        throw e;
      }
    };

  /** Refuses as the catalog does: 404 for who may not see the workspace at all, else 403. */
  const refuse = (reply: FastifyReply, access: Access | undefined, place?: ActionPlace) =>
    !place || !access?.sees(place.workspace, place.project)
      ? reply.code(404).send(NO_ACTION)
      : reply.code(403).send({ error: 'forbidden', message: 'You may not run this action' });

  /** The action, its place and its configuration, when this person may run it now. */
  const runnable = async (request: FastifyRequest, reply: FastifyReply, id: string) => {
    const user = signedIn(request, reply);
    if (!user) return undefined;
    const access = await accessOf(db, request);
    const [action, place] = await Promise.all([getAction(db, id), placeOf(db, id)]);
    const scope = user.token?.workspace;
    if (!access || !action?.enabled || !place || (scope && scope !== place.workspace)) {
      reply.code(404).send(NO_ACTION);
      return undefined;
    }
    if (!mayRun(access, place, await grantedActions(db, user.id))) {
      refuse(reply, access, place);
      return undefined;
    }
    const config = await configs.get(id);
    if (!config) {
      reply.code(404).send(NO_ACTION);
      return undefined;
    }
    return { user, access, action, place, config };
  };

  app.get('/api/v1/actions', async (request, reply) => {
    const user = signedIn(request, reply);
    if (!user) return reply;
    const access = await accessOf(db, request);
    if (!access) return [];
    const granted = await grantedActions(db, user.id);
    const scope = user.token?.workspace;
    const mine = (await enabledActions(db)).filter(
      (a) => (!scope || scope === a.place.workspace) && mayRun(access, a.place, granted),
    );
    // My newest run of each, one query.
    const runs = mine.length
      ? await db
          .selectFrom('run')
          .select('id')
          .where('requested_by', '=', user.id)
          .where('action_title', 'is not', null)
          .where(
            'config_id',
            'in',
            mine.map((a) => a.id),
          )
          .orderBy('created_at', 'desc')
          .limit(500)
          .execute()
      : [];
    const last = new Map<string, Run>();
    for (const { id } of runs) {
      const run = await deps.queue?.get(id);
      if (run?.config && !last.has(run.config.id)) last.set(run.config.id, run);
      if (last.size === mine.length) break;
    }
    const cards: ActionCard[] = mine.map((a) => {
      const run = last.get(a.id);
      return {
        id: a.id,
        title: a.title,
        summary: a.summary,
        mode: a.mode,
        workspace: { key: a.place.workspaceKey, name: a.place.workspaceName },
        ...(run ? { lastRun: runLine(run) } : {}),
      };
    });
    return cards;
  });

  type Got = NonNullable<Awaited<ReturnType<typeof runnable>>>;

  /** An action's form, the launch form's fields under it, and the commit it reads. */
  const formFor = async ({ action, place, config, access }: Got) => {
    const prepared = await prepareLaunch(deps, { ...config, mode: action.mode }, {}, false);
    const launchForm = prepared.form;
    const fields = launchForm ? actionFields(action, launchForm.fields) : [];
    const flow = launchForm
      ? await flowAt(deps.git, config.project, launchForm.commit, config.flowFile)
      : undefined;
    const doc = flow && 'doc' in flow ? flow.doc : undefined;
    const happens: string[] = [
      action.mode === 'real'
        ? 'It runs for real: it changes the machines it runs on.'
        : 'It runs as a check: it shows what would change, and changes nothing.',
    ];
    if (doc) {
      const steps = flowSteps(doc).filter((s) => s.onPath);
      if (steps.length)
        happens.push(
          `It goes through ${steps.length === 1 ? 'one step' : `${steps.length} steps`}: ${steps
            .map((s) => s.node.title || s.node.key)
            .join(', ')}.`,
        );
      for (const { node } of steps)
        if (node.type === 'approval') {
          const who = node.approval?.approvers?.length
            ? node.approval.approvers.join(', ')
            : 'someone who may approve';
          happens.push(`It waits at ${node.title} until ${who} decides.`);
        }
    }
    // AFS-176 (AFS-175's note): the values the action keeps fixed are not listed by their
    // variable names: runners do not read those. Whoever set it up answers for them.
    if (action.reply)
      happens.push(
        `When it was started from a ${SYSTEM_NAME[action.reply.system]} link, ${SYSTEM_NAME[action.reply.system]} is told how it ended${action.reply.when === 'failed' ? ', if it did not go well' : ''}.`,
      );
    const asked = new Set(fields.map((f) => f.name));
    const problems = prepared.ok ? [] : prepared.problems;
    const blocking = problems.find((p) => !p.field || !asked.has(p.field));
    const form: ActionForm = {
      id: action.id,
      title: action.title,
      summary: action.summary,
      mode: action.mode,
      confirm: action.confirm,
      fields,
      happens,
      ask: await whomToAsk(deps, action),
      // Only what the runner cannot fix: an empty asked input is the form's to fill.
      ...(!launchForm || blocking
        ? {
            blocked: `It cannot run now: ${(blocking ?? problems[0])?.message ?? 'the flow cannot be read'}`,
          }
        : {}),
      ...(atLeast(access.onFlow(place.workspace, place.project, place.file), 'ro')
        ? {
            configPage: `/w/${place.workspaceKey}/${place.projectKey}/launch/${place.config}`,
          }
        : {}),
      ...(action.runOnOpen ? { runOnOpen: true } : {}),
      ...(action.reply ? { replies: action.reply.system } : {}),
    };
    return { form, fields, commit: launchForm?.commit };
  };

  /**
   * AFS-176: the hosts of each group the action narrows a host list to, read from the inventory
   * at a commit. A group the inventory does not have: no hosts (nothing can be picked).
   */
  const groupsOf = async (
    config: LaunchConfig,
    commit: string | undefined,
    fields: readonly ActionField[],
  ): Promise<Map<string, string[]> | undefined> => {
    const wanted = [...new Set(fields.flatMap((f) => (f.group ? [f.group] : [])))];
    if (!wanted.length) return new Map();
    if (!commit || !deps.vars) return undefined;
    try {
      const index = await deps.vars.index(config.project, commit, {
        inventory: config.inventory ?? '',
      });
      return new Map(wanted.map((g) => [g, groupHosts(index.groups, g) ?? []]));
    } catch {
      return undefined;
    }
  };

  /** The values given for an action that are not right, at their names, in the form's words. */
  const problemsOf = (
    fields: readonly ActionField[],
    values: Record<string, string>,
    groups: Map<string, string[]> | undefined,
  ) => {
    const problems: { field: string; message: string }[] = [];
    for (const f of fields) {
      const value = values[f.name]?.trim() ?? '';
      if (!value) continue;
      const chosen = fillAction([f], { [f.name]: value });
      if ('error' in chosen) {
        problems.push({ field: f.name, message: chosen.error });
        continue;
      }
      const read = parseInput(f.type, value);
      if ('error' in read) {
        problems.push({ field: f.name, message: `${f.label}: ${read.error}` });
        continue;
      }
      if (f.group) {
        const hosts = groups?.get(f.group);
        const outside = hosts ? outsideGroup(f, value, hosts) : undefined;
        if (outside) problems.push(outside);
      }
    }
    return problems;
  };

  app.get<WithId>('/api/v1/actions/:id', { schema: ID }, async (request, reply) => {
    const got = await runnable(request, reply, request.params.id);
    if (!got) return reply;
    return (await formFor(got)).form;
  });

  // AFS-176: what a link to an action gives. A GET only reads: nothing runs from here.
  app.get<WithId & { Querystring: Record<string, string | string[]> }>(
    '/api/v1/actions/:id/link',
    { schema: ID },
    async (request, reply) => {
      const got = await runnable(request, reply, request.params.id);
      if (!got) return reply;
      const { form, fields, commit } = await formFor(got);
      const given: Record<string, string> = {};
      let refused: string | undefined;
      let replyText: string | undefined;
      for (const [name, value] of Object.entries(request.query ?? {})) {
        if (Array.isArray(value)) {
          refused ??= `This link gives ${name.slice(0, 60)} more than once: it is not clear which to use. Ask whoever made the link to fix it.`;
          continue;
        }
        if (name === REPLY_PARAM) replyText = value;
        else given[name] = value;
      }
      const unknown = Object.keys(given).find((n) => !fields.some((f) => f.name === n));
      if (unknown)
        refused ??= `This link gives a value for ${unknown.slice(0, 60)}, which "${form.title}" does not ask: it runs with its own value. Ask whoever made the link to fix it.`;
      const values = Object.fromEntries(
        fields.map((f) => [f.name, (given[f.name] ?? f.text).trim()]),
      );
      const groups = await groupsOf(got.config, commit, fields);
      const problems = refused ? [] : problemsOf(fields, values, groups);
      const missing = fields.filter((f) => f.required && !values[f.name]).map((f) => f.name);
      let replyTo: string | undefined;
      let replyNote: string | undefined;
      const system = got.action.reply?.system;
      if (system && replyText !== undefined) {
        if (replyObject(system, replyText)) replyTo = replyText.trim();
        else
          replyNote = `The link does not say a ${SYSTEM_NAME[system]} ${system === 'netbox' ? 'object' : 'problem'} to tell: how it ends is not written back.`;
      }
      const link: ActionLink = {
        form,
        values,
        given: Object.keys(given),
        missing,
        problems,
        ready: !refused && !form.blocked && !missing.length && !problems.length,
        ...(refused ? { refused } : {}),
        ...(replyTo ? { reply: replyTo } : {}),
        ...(replyNote ? { replyNote } : {}),
      };
      return link;
    },
  );

  app.get<WithId>('/api/v1/actions/:id/hosts', { schema: ID }, async (request, reply) => {
    const got = await runnable(request, reply, request.params.id);
    if (!got) return reply;
    const { config, action } = got;
    const prepared = await prepareLaunch(deps, { ...config, mode: action.mode }, {}, false);
    const answer: ActionHosts = { hosts: [], groups: [] };
    if (!prepared.form || !deps.vars)
      return { ...answer, why: 'The inventory cannot be read now: type the names' };
    try {
      const index = await deps.vars.index(config.project, prepared.form.commit, {
        inventory: config.inventory ?? '',
      });
      const groups = Object.keys(index.groups)
        .filter((g) => g !== 'all' && g !== 'ungrouped')
        .sort();
      // AFS-176: a host list narrowed to a group offers only that group's hosts.
      const narrowed = [
        ...new Set(action.asked.flatMap((a) => (a.group && !a.choices?.length ? [a.group] : []))),
      ];
      return {
        hosts: index.hosts,
        groups,
        ...(narrowed.length
          ? {
              inGroup: Object.fromEntries(
                narrowed.map((g) => [g, groupHosts(index.groups, g) ?? []]),
              ),
            }
          : {}),
        ...(index.dynamic ? { dynamic: true } : {}),
        ...(!index.hosts.length && !groups.length
          ? {
              why: index.dynamic
                ? 'The inventory finds its hosts when it runs: type the names'
                : 'The inventory names no hosts',
            }
          : {}),
      };
    } catch {
      return { ...answer, why: 'The inventory cannot be read now: type the names' };
    }
  });

  const queue = deps.queue;
  if (queue) {
    const wrongTokens = new FailureLimiter({ max: 20, windowMs: TOKEN_WINDOW_MS });

    /**
     * AFS-176: a signed link: a system with no person runs one action with its token, as whoever
     * made it. The request then acts as them for this route only, and says so in the audit log.
     * Undefined when it answered (a token that is not one, or its maker can no longer sign in).
     */
    const signedLink = async (
      request: FastifyRequest,
      reply: FastifyReply,
      id: string,
      token: string,
    ): Promise<true | undefined> => {
      const address = `ip:${request.ip}`;
      const wait = wrongTokens.retryAfter(address);
      if (wait > 0) {
        reply
          .code(429)
          .header('retry-after', String(wait))
          .send({ error: 'too_many_attempts', message: 'Too many wrong tokens: try again later' });
        return undefined;
      }
      const found = looksLikeActionToken(token) ? await actionTokenOf(db, id, token) : undefined;
      const maker = found
        ? await db
            .selectFrom('user_account')
            .select(['id', 'login', 'name', 'is_admin', 'disabled'])
            .where('id', '=', found.by)
            .executeTakeFirst()
        : undefined;
      if (!found || !maker || maker.disabled === 1) {
        wrongTokens.fail(address);
        reply.code(401).send({
          error: 'unauthorized',
          message: 'This signed link is not valid for this action, or was revoked',
        });
        return undefined;
      }
      const place = await placeOf(db, id);
      request.user = {
        session: `action-token:${found.id}`,
        id: maker.id,
        login: maker.login,
        name: maker.name,
        admin: maker.is_admin === 1,
        token: {
          id: found.id,
          name: `signed link ${found.name}`,
          readOnly: false,
          ...(place ? { workspace: place.workspace } : {}),
        },
      };
      request.auditDetail = { ...request.auditDetail, via: 'signed link' };
      return true;
    };

    type RunBody = { inputs?: Record<string, string>; reply?: string; link?: boolean };
    app.post<WithId & { Body: RunBody }>(
      '/api/v1/actions/:id/run',
      {
        schema: {
          ...ID,
          body: {
            type: 'object',
            additionalProperties: false,
            properties: {
              inputs: {
                type: 'object',
                maxProperties: 50,
                additionalProperties: { type: 'string', maxLength: 10_000 },
              },
              // AFS-176: where the result goes back (a link's _reply), and that it came by a link.
              reply: text(200, 1),
              link: { type: 'boolean' },
            },
          },
        },
      },
      async (request, reply) => {
        // AFS-176: no session and no person's token: a signed link's, in the header only.
        const signed = request.user ? undefined : actionBearer(request);
        if (signed && !(await signedLink(request, reply, request.params.id, signed))) return reply;
        const got = await runnable(request, reply, request.params.id);
        if (!got) return reply;
        const { user, action, config } = got;
        const settled = { ...config, mode: action.mode };
        const at = await prepareLaunch(deps, settled, {}, false);
        if (!at.form)
          return reply.code(422).send({
            error: 'not_ready',
            message: `It cannot run now: ${at.ok ? '' : (at.problems[0]?.message ?? 'the flow cannot be read')}`,
          });
        const fields = actionFields(action, at.form.fields);
        const filled = fillAction(fields, request.body?.inputs ?? {});
        if ('error' in filled)
          return reply
            .code(400)
            .send({ error: 'invalid', message: filled.error, field: filled.field });
        const label = (name: string) => fields.find((f) => f.name === name)?.label ?? name;
        if (filled.missing.length)
          return reply.code(422).send({
            error: 'not_ready',
            message: `${label(filled.missing[0] as string)} is needed`,
            problems: filled.missing.map((name) => ({
              field: name,
              message: `${label(name)} is needed`,
            })),
          });
        // AFS-176: a host list narrowed to a group takes only that group's hosts.
        if (fields.some((f) => f.group)) {
          const groups = await groupsOf(config, at.form.commit, fields);
          if (!groups)
            return reply.code(422).send({
              error: 'not_ready',
              message: 'The inventory cannot be read now: try again in a moment',
            });
          const outside = problemsOf(fields, filled.texts, groups).find((p) =>
            fields.some((f) => f.name === p.field && f.group),
          );
          if (outside) return reply.code(400).send({ error: 'invalid', ...outside });
        }
        const system = action.reply?.system;
        const replyTo = request.body?.reply?.trim();
        if (replyTo && system && !replyObject(system, replyTo))
          return reply.code(400).send({
            error: 'invalid',
            field: 'reply',
            message: `reply is a ${SYSTEM_NAME[system]} ${system === 'netbox' ? 'object (dcim.device:1)' : 'event (event:2048)'}`,
          });
        const prepared = await prepareLaunch(deps, settled, {
          mode: action.mode,
          inputs: filled.texts,
        });
        if (!prepared.ok)
          return reply.code(422).send({
            error: 'not_ready',
            message: prepared.problems[0]?.message ?? 'It cannot run now',
            problems: prepared.problems.map((p) => ({
              ...p,
              // A problem with a value the action asks, in its words.
              ...(p.field && fields.some((f) => f.name === p.field)
                ? { message: p.message.replace(p.field, label(p.field)) }
                : {}),
            })),
          });
        const shown = withoutSecrets(prepared.launch, prepared.form.fields).inputs;
        const run = await queue.enqueue(
          { ...prepared.launch, action: action.title },
          shown,
          user,
          config.name,
        );
        if (replyTo && system)
          await noteReply(db, { run: run.id, config: config.id, system, object: replyTo });
        request.auditDetail = {
          ...request.auditDetail,
          run: run.id,
          mode: run.mode,
          ...(request.body?.link && !signed ? { via: 'link' } : {}),
          ...(replyTo && system ? { reply: `${system} ${replyTo}` } : {}),
        };
        request.log.info(
          {
            by: user.login,
            action: action.title,
            run: run.id,
            number: run.number,
            ...(signed ? { via: 'signed link' } : {}),
          },
          'Action run',
        );
        return reply.code(201).send({
          id: run.id,
          number: run.number,
          state: run.state,
          progress: `/actions/runs/${run.id}`,
        });
      },
    );

    /** A run of an action, when this person may follow it: who may run the action, or see the run. */
    const followable = async (request: FastifyRequest, reply: FastifyReply, id: string) => {
      const user = signedIn(request, reply);
      if (!user) return undefined;
      const run = await queue.get(id);
      const access = await accessOf(db, request);
      const project = run && (await getProject(db, run.project));
      if (!run?.action || !run.config || !project || !access) {
        reply.code(404).send(NO_RUN);
        return undefined;
      }
      const scope = user.token?.workspace;
      const place = {
        config: run.config.id,
        workspace: project.workspace,
        project: project.id,
        file: run.flow.file,
      };
      const seesRun = !!access.onFlow(place.workspace, place.project, place.file);
      const action = await getAction(db, run.config.id);
      const runs = !!action && mayRun(access, place, await grantedActions(db, user.id));
      // AFS-176 (AFS-175's note): who may only run the action follows the runs they started;
      // who sees the flow's runs (ro or more) follows them all.
      const mine = run.requestedBy.id === user.id;
      if ((scope && scope !== project.workspace) || (!seesRun && !(runs && mine))) {
        reply.code(404).send(NO_RUN);
        return undefined;
      }
      return { user, run, access, action, place, seesRun, runs };
    };

    const progress = async (got: NonNullable<Awaited<ReturnType<typeof followable>>>) => {
      const { run, action, place } = got;
      const [gates, flow] = await Promise.all([
        gatesOf(db, run.id),
        flowAt(deps.git, run.project, run.commit, run.flow.file).catch(() => undefined),
      ]);
      const doc: FlowDocument | undefined = flow && 'doc' in flow ? flow.doc : undefined;
      const view = (deps.hub?.live(run.id) ?? (await queue.view(run.id))) as RunView | undefined;
      const waiting = gates.find((g) => g.status === 'waiting');
      const deciders = waiting
        ? await decidersOf(
            db,
            waiting,
            { workspace: place.workspace, project: place.project, flowFile: place.file },
            run.requestedBy,
          )
        : [];
      const by = await db
        .selectFrom('user_account')
        .select(['name', 'login'])
        .where('id', '=', run.requestedBy.id)
        .executeTakeFirst();
      // AFS-146: a failed run decided against reads as that.
      const against = gates.find((g) => g.status === 'rejected' || g.status === 'timed out');
      const named: Run =
        run.state === 'failed' && against
          ? { ...run, decidedAgainst: against.status as 'rejected' | 'timed out' }
          : run;
      return progressOf({
        run: named,
        ...(doc ? { doc } : {}),
        ...(view ? { view } : {}),
        gates,
        deciders,
        ...(action ? { action } : {}),
        startedBy: by?.name || by?.login || run.requestedBy.login,
        ask: await whomToAsk(deps, action),
        ...(got.seesRun ? { runPage: `/runs/${run.id}` } : {}),
        ...(got.runs && action?.enabled ? { again: `/actions/${action.id}` } : {}),
      });
    };

    app.get<WithId>('/api/v1/actions/runs/:id', { schema: ID }, async (request, reply) => {
      const got = await followable(request, reply, request.params.id);
      if (!got) return reply;
      return progress(got);
    });

    app.get<WithId>('/api/v1/actions/runs/:id/events', { schema: ID }, async (request, reply) => {
      const got = await followable(request, reply, request.params.id);
      if (!got) return reply;
      const id = got.run.id;
      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      let open = true;
      let last = '';
      const send = async () => {
        if (!open) return;
        const run = await queue.get(id);
        if (!run) return;
        const now = await progress({ ...got, run });
        const said = JSON.stringify(now);
        if (said !== last && open) {
          last = said;
          raw.write(`event: progress\ndata: ${said}\n\n`);
        }
        if (!ACTIVE.includes(run.state as RunState)) {
          raw.write(`event: end\ndata: ${JSON.stringify({ state: run.state })}\n\n`);
          stop();
          raw.end();
        }
      };
      let unsubscribe: (() => void) | undefined;
      let looking: NodeJS.Timeout | undefined;
      let alive: NodeJS.Timeout | undefined;
      let pending: NodeJS.Timeout | undefined;
      const stop = () => {
        open = false;
        unsubscribe?.();
        clearInterval(looking);
        clearInterval(alive);
        clearTimeout(pending);
      };
      raw.on('close', stop);
      streams.add(raw);
      raw.on('close', () => streams.delete(raw));
      await send().catch(() => undefined);
      if (!open) return reply;
      // The view comes about twice a second: said again at most once a second.
      unsubscribe = deps.hub?.subscribe(id, (news) => {
        if (news.kind === 'output' || pending) return;
        pending = setTimeout(() => {
          pending = undefined;
          void send().catch(() => undefined);
        }, 500);
      });
      looking = setInterval(() => void send().catch(() => undefined), LOOK_MS * 2);
      alive = setInterval(() => {
        if (open) raw.write(': still here\n\n');
      }, KEEP_ALIVE_MS);
      return reply;
    });
  }

  // --- an action's settings and grants, on its launch configuration

  const configPlace = async (reply: FastifyReply, id: string) => {
    const place = await placeOf(db, id);
    if (!place)
      reply.code(404).send({ error: 'not_found', message: 'No such launch configuration' });
    return place;
  };

  app.get<WithId>('/api/v1/launch-configs/:id/action', { schema: ID }, async (request, reply) => {
    if (!signedIn(request, reply)) return reply;
    const place = await configPlace(reply, request.params.id);
    if (!place) return reply;
    const action = await getAction(db, place.config);
    const access = await accessOf(db, request);
    const manage = !!access && atLeast(access.onWorkspace(place.workspace), 'rw');
    return {
      action: action ?? null,
      // Who may run it: for who may change it (people's names are theirs to know).
      ...(manage ? { grants: await actionGrants(db, place.config) } : {}),
      // AFS-176: its signed links, by name (never the tokens).
      ...(manage && action ? { tokens: await actionTokens(db, place.config) } : {}),
      mayManage: manage,
    };
  });

  app.put<WithId & { Body: ActionSettings }>(
    '/api/v1/launch-configs/:id/action',
    { schema: { ...ID, body: SETTINGS } },
    answering(async (request, reply) => {
      const me = signedIn(request, reply);
      if (!me) return reply;
      const config = await configs.get(request.params.id);
      if (!config)
        return reply
          .code(404)
          .send({ error: 'not_found', message: 'No such launch configuration' });
      const prepared = await prepareLaunch(deps, { ...config, mode: request.body.mode }, {}, false);
      if (!prepared.form)
        throw new ActionError(
          'invalid',
          `The flow cannot be read: ${prepared.ok ? '' : (prepared.problems[0]?.message ?? '')}`,
          'asked',
        );
      const settings = checkSettings(request.body, prepared.form.fields);
      // AFS-176: the result goes back with a credential of this workspace, of the system's kind.
      if (settings.reply) {
        const place = await placeOf(db, config.id);
        const credential = await db
          .selectFrom('credential')
          .select(['kind', 'workspace_id'])
          .where('id', '=', settings.reply.credential)
          .executeTakeFirst();
        if (!credential || credential.workspace_id !== place?.workspace)
          throw new ActionError('invalid', 'No such credential in this workspace', 'reply');
        if (credential.kind !== settings.reply.system)
          throw new ActionError(
            'invalid',
            `The credential is not a ${SYSTEM_NAME[settings.reply.system]} token`,
            'reply',
          );
      }
      const before = await getAction(db, config.id);
      const action = await setAction(db, config.id, settings, me);
      request.auditDetail = {
        title: action.title,
        asked: action.asked.map((a) => a.name),
        mode: action.mode,
        ...(before ? {} : { made: true }),
      };
      return action;
    }),
  );

  app.delete<WithId>(
    '/api/v1/launch-configs/:id/action',
    { schema: ID },
    async (request, reply) => {
      if (!signedIn(request, reply)) return reply;
      const place = await configPlace(reply, request.params.id);
      if (!place) return reply;
      if (!(await removeAction(db, place.config))) return reply.code(404).send(NO_ACTION);
      return reply.code(204).send();
    },
  );

  app.post<WithId & { Body: { user?: string; group?: string } }>(
    '/api/v1/launch-configs/:id/action/grants',
    {
      schema: {
        ...ID,
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { user: text(200, 1), group: text(200, 1) },
        },
      },
    },
    answering(async (request, reply) => {
      const me = signedIn(request, reply);
      if (!me) return reply;
      const place = await configPlace(reply, request.params.id);
      if (!place) return reply;
      if (!(await getAction(db, place.config)))
        throw new ActionError(
          'not_found',
          'This configuration is not an action: make it one first',
        );
      const grant = await grantAction(db, place.config, request.body, me.login);
      request.auditDetail = {
        who: `${grant.principal.type === 'group' ? 'group ' : ''}${grant.principal.name}`,
        grant: grant.id,
      };
      return reply.code(201).send(grant);
    }),
  );

  app.delete<{ Params: { id: string; grant: string } }>(
    '/api/v1/launch-configs/:id/action/grants/:grant',
    {
      schema: {
        params: {
          type: 'object',
          properties: { id: text(64, 1), grant: text(64, 1) },
          required: ['id', 'grant'],
        },
      },
    },
    async (request, reply) => {
      if (!signedIn(request, reply)) return reply;
      const grants = await actionGrants(db, request.params.id);
      const grant = grants.find((g) => g.id === request.params.grant);
      if (grant)
        request.auditDetail = {
          who: `${grant.principal.type === 'group' ? 'group ' : ''}${grant.principal.name}`,
          grant: grant.id,
        };
      if (!(await ungrantAction(db, request.params.id, request.params.grant)))
        return reply.code(404).send({ error: 'not_found', message: 'No such grant' });
      return reply.code(204).send();
    },
  );

  // AFS-176: signed links' tokens. Made only in a session: a leaked token must not make more.
  app.get<WithId>(
    '/api/v1/launch-configs/:id/action/tokens',
    { schema: ID },
    async (request, reply) => {
      if (!signedIn(request, reply)) return reply;
      const place = await configPlace(reply, request.params.id);
      if (!place) return reply;
      return actionTokens(db, place.config);
    },
  );

  app.post<WithId & { Body: { name: string } }>(
    '/api/v1/launch-configs/:id/action/tokens',
    {
      schema: {
        ...ID,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['name'],
          properties: { name: text(100, 1) },
        },
      },
    },
    answering(async (request, reply) => {
      const me = inSession(request, reply);
      if (!me) return reply;
      const place = await configPlace(reply, request.params.id);
      if (!place) return reply;
      if (!(await getAction(db, place.config)))
        throw new ActionError(
          'not_found',
          'This configuration is not an action: make it one first',
        );
      const made = await createActionToken(db, place.config, request.body.name, me);
      request.auditDetail = { link: made.info.name, signed: made.info.id };
      return reply.code(201).send({ ...made.info, token: made.token });
    }),
  );

  app.delete<{ Params: { id: string; token: string } }>(
    '/api/v1/launch-configs/:id/action/tokens/:token',
    {
      schema: {
        params: {
          type: 'object',
          properties: { id: text(64, 1), token: text(64, 1) },
          required: ['id', 'token'],
        },
      },
    },
    async (request, reply) => {
      if (!signedIn(request, reply)) return reply;
      const known = (await actionTokens(db, request.params.id)).find(
        (t) => t.id === request.params.token,
      );
      if (known) request.auditDetail = { link: known.name, signed: known.id };
      if (!(await revokeActionToken(db, request.params.id, request.params.token)))
        return reply.code(404).send({ error: 'not_found', message: 'No such signed link' });
      return reply.code(204).send();
    },
  );

  app.get<WithId>(
    '/api/v1/workspaces/:id/action-grants',
    { schema: ID },
    async (request, reply) => {
      if (!signedIn(request, reply)) return reply;
      const workspace = await getWorkspace(db, request.params.id);
      if (!workspace)
        return reply.code(404).send({ error: 'not_found', message: 'No such workspace' });
      return workspaceActionGrants(db, workspace.id);
    },
  );
}
