// Approvals over HTTP (AFS-28):
//   GET  /api/v1/approvals                    what waits for a decision, that the person may see
//   GET  /api/v1/runs/:id/approvals           a run's approvals, with whether the person may decide
//   POST /api/v1/runs/:id/approvals/:node     decide one: approved or rejected, with a comment
//   GET  /api/v1/projects/:id/approvers?path=  who an approval of a flow with no approvers asks
// The run then goes back to the queue and continues with the segment the decision picks.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { type Access, accessOf } from '../access/grants';
import { signedIn } from '../auth/guards';
import { getUser } from '../auth/users';
import type { Schema } from '../db/schema';
import type { RunHub } from '../runs/hub';
import type { RunQueue } from '../runs/queue';
import {
  approveHolders,
  DECISIONS,
  type Decision,
  decideGate,
  decidersOf,
  type Gate,
  gatesOf,
  whyNot,
} from './gates';
import { decidersWords, type WaitingApproval } from './types';

export type { WaitingApproval };

const text = (max: number, min = 1) => ({ type: 'string', minLength: min, maxLength: max });

export interface ApprovalDeps {
  db: Kysely<Schema>;
  queue: RunQueue;
  hub?: RunHub;
  /** AFS-29: told of each decision. */
  decided?: (run: string, gate: string) => void;
}

export function registerApprovals(app: FastifyInstance, deps: ApprovalDeps): void {
  const { db, queue } = deps;

  /** What a person may do about a run's gates: its workspace, the rules, their groups. */
  const deciderFor = async (request: FastifyRequest) => {
    const me = request.user;
    const access = await accessOf(db, request);
    if (!me || !access) return undefined;
    const groups = (await getUser(db, me.id))?.groups ?? [];
    return { user: { id: me.id, login: me.login, admin: me.admin, groups }, access };
  };
  const placeOf = async (projectId: string) =>
    db
      .selectFrom('project')
      .innerJoin('workspace', 'workspace.id', 'project.workspace_id')
      .select(['workspace.id as workspace', 'workspace.self_approve'])
      .where('project.id', '=', projectId)
      .executeTakeFirst();
  const judge = (
    who: { user: { id: string; login: string; admin: boolean; groups: string[] }; access: Access },
    gate: Gate,
    run: { project: string; flow: { file: string }; requestedBy: { id: string } },
    place: { workspace: string; self_approve: number },
  ) =>
    gate.status === 'waiting'
      ? whyNot(
          who,
          gate,
          {
            workspace: place.workspace,
            project: run.project,
            flowFile: run.flow.file,
            requestedBy: run.requestedBy.id,
          },
          place.self_approve === 1,
        )
      : 'It is decided';

  /**
   * AFS-146: a gate as the pages show it: while it waits, who may decide it (by name).
   */
  const dressed = async (
    gate: Gate,
    place: { workspace: string; project: string; flowFile: string },
    launcher: { id: string; login: string },
    selfApprove: boolean,
  ): Promise<Gate> => {
    if (gate.status !== 'waiting') return gate;
    const deciders = await decidersOf(db, gate, place, selfApprove ? undefined : launcher);
    return { ...gate, deciders };
  };

  /**
   * AFS-224: who an approval of this flow asks when its Approvers is empty: the people and groups
   * holding approve on the flow or its workspace (administrators may always decide). For the
   * Approvers field, so empty does not have to be guessed.
   */
  app.get<{ Params: { id: string }; Querystring: { path: string } }>(
    '/api/v1/projects/:id/approvers',
    {
      schema: {
        params: { type: 'object', properties: { id: text(64) }, required: ['id'] },
        querystring: {
          type: 'object',
          properties: { path: text(500) },
          required: ['path'],
        },
      },
    },
    async (request, reply) => {
      if (!signedIn(request, reply)) return reply;
      const place = await db
        .selectFrom('project')
        .innerJoin('workspace', 'workspace.id', 'project.workspace_id')
        .select(['workspace.id as workspace', 'workspace.self_approve'])
        .where('project.id', '=', request.params.id)
        .executeTakeFirst();
      if (!place) return reply.code(404).send({ error: 'not_found', message: 'No such project' });
      return {
        approvers: await approveHolders(db, {
          workspace: place.workspace,
          project: request.params.id,
          flowFile: request.query.path,
        }),
        // Whether who launches a run may decide its approvals too.
        selfApprove: place.self_approve === 1,
      };
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/v1/runs/:id/approvals',
    { schema: { params: { type: 'object', properties: { id: text(64) }, required: ['id'] } } },
    async (request, reply) => {
      if (!signedIn(request, reply)) return reply;
      const run = await queue.get(request.params.id);
      if (!run) return reply.code(404).send({ error: 'not_found', message: 'No such run' });
      const who = await deciderFor(request);
      const place = await placeOf(run.project);
      if (!who || !place) return reply;
      const gates = await gatesOf(db, run.id);
      const where = { workspace: place.workspace, project: run.project, flowFile: run.flow.file };
      return Promise.all(
        gates.map(async (gate) => {
          const why = judge(who, gate, run, place);
          return {
            ...(await dressed(gate, where, run.requestedBy, place.self_approve === 1)),
            mayDecide: !why,
            ...(why && gate.status === 'waiting' ? { why } : {}),
          };
        }),
      );
    },
  );

  app.post<{
    Params: { id: string; node: string };
    Body: { decision: Decision; comment?: string };
  }>(
    '/api/v1/runs/:id/approvals/:node',
    {
      schema: {
        params: {
          type: 'object',
          properties: { id: text(64), node: text(64) },
          required: ['id', 'node'],
        },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['decision'],
          properties: {
            decision: { type: 'string', enum: [...DECISIONS] },
            comment: text(2000, 0),
          },
        },
      },
    },
    async (request, reply) => {
      const me = signedIn(request, reply);
      if (!me) return reply;
      // AFS-116: approvals stay with people: a run's own token (a flow calling the server) never
      // decides one, its own or another run's.
      if (me.token?.run)
        return reply.code(403).send({
          error: 'forbidden',
          message: "A run's token does not decide approvals: a person does",
        });
      const run = await queue.get(request.params.id);
      if (!run) return reply.code(404).send({ error: 'not_found', message: 'No such run' });
      const gate = (await gatesOf(db, run.id)).find(
        (g) => g.node.id === request.params.node || g.node.key === request.params.node,
      );
      if (!gate)
        return reply
          .code(404)
          .send({ error: 'not_found', message: 'The run did not reach this approval' });
      if (gate.status !== 'waiting' || run.state !== 'waiting')
        return reply.code(409).send({
          error: 'decided',
          message:
            gate.status === 'waiting'
              ? `This approval is not waiting: the run is ${run.state}`
              : `This approval is ${gate.status}`,
        });
      const who = await deciderFor(request);
      const place = await placeOf(run.project);
      if (!who || !place) return reply;
      const why = judge(who, gate, run, place);
      if (why) {
        // AFS-211: the launcher is told who decides it, as the pages tell them.
        const self = why.startsWith('You launched');
        const deciders = self
          ? await decidersOf(
              db,
              gate,
              { workspace: place.workspace, project: run.project, flowFile: run.flow.file },
              run.requestedBy,
            )
          : undefined;
        return reply.code(403).send({
          error: 'forbidden',
          message: deciders ? `${why}. ${decidersWords(deciders)} decides it` : why,
        });
      }
      const { decision, comment } = request.body;
      // AFS-146: a rejection says why, whatever asks for it (the pages, the canvas, the API, an
      // agent): the comment is what who launched the run reads.
      if (decision === 'rejected' && !comment?.trim())
        return reply.code(400).send({
          error: 'comment_required',
          message: 'Say why you reject it: a rejection needs a comment',
        });
      if (!(await decideGate(db, gate.id, { status: decision, by: me.login, comment })))
        return reply
          .code(409)
          .send({ error: 'decided', message: 'Someone decided it a moment ago' });
      await queue.resume(run.id);
      deps.hub?.publish(run.id, { kind: 'state' });
      deps.decided?.(run.id, gate.id);
      request.log.info(
        { by: me.login, run: run.id, number: run.number, gate: gate.node.key, decision },
        'Approval decided',
      );
      const after = (await gatesOf(db, run.id)).find((g) => g.id === gate.id) as Gate;
      return { ...after, mayDecide: false };
    },
  );

  app.get<{ Querystring: { decided?: string } }>('/api/v1/approvals', async (request, reply) => {
    if (!signedIn(request, reply)) return reply;
    const who = await deciderFor(request);
    if (!who) return reply;
    // AFS-133: `?decided=1`: the newest decided approvals the person may see (50), not those
    // that wait.
    const decided = request.query.decided === '1' || request.query.decided === 'true';
    let query = db
      .selectFrom('run_gate')
      .innerJoin('run', 'run.id', 'run_gate.run_id')
      .innerJoin('project', 'project.id', 'run.project_id')
      .innerJoin('workspace', 'workspace.id', 'project.workspace_id')
      .select([
        'run_gate.id as gate',
        'run.id as run',
        'run.number',
        'run.project_id',
        'run.flow_file',
        'run.flow_name',
        'run.requested_by',
        'run.requested_login',
        'run.mode',
        'run.inputs_shown_json',
        'project.name as project_name',
        'workspace.id as workspace',
        'workspace.name as workspace_name',
        'workspace.self_approve',
      ])
      .orderBy('run_gate.created_at', decided ? 'desc' : 'asc');
    query = decided
      ? query.where('run_gate.status', 'in', ['approved', 'rejected', 'timed out']).limit(200)
      : query.where('run_gate.status', '=', 'waiting').where('run.state', '=', 'waiting');
    const rows = await query.execute();
    const out: WaitingApproval[] = [];
    // AFS-146: people by their names, as on the other pages.
    const people = await db
      .selectFrom('user_account')
      .select(['id', 'login', 'name'])
      .where('id', 'in', [...new Set(rows.map((r) => r.requested_by)), ''])
      .execute();
    const launcherName = new Map(people.filter((p) => p.name).map((p) => [p.id, p.name]));
    const inputsOf = (json: string | null) => {
      try {
        return json ? (JSON.parse(json) as Record<string, unknown>) : undefined;
      } catch {
        return undefined;
      }
    };
    for (const row of rows) {
      // Only what the person may see; and of that, whether they may decide.
      const sees =
        who.access.admin ||
        who.access.onFlow(row.workspace, row.project_id, row.flow_file) ||
        who.access.approves(row.workspace, row.project_id, row.flow_file);
      if (!sees) continue;
      if (decided && out.length >= 50) break;
      const found = (await gatesOf(db, row.run)).find((g) => g.id === row.gate);
      if (!found) continue;
      const gate = await dressed(
        found,
        { workspace: row.workspace, project: row.project_id, flowFile: row.flow_file },
        { id: row.requested_by, login: row.requested_login },
        row.self_approve === 1,
      );
      const requestedByName = launcherName.get(row.requested_by);
      const byName = requestedByName ? { requestedByName } : {};
      if (decided) {
        out.push({
          run: {
            id: row.run,
            number: row.number,
            project: row.project_id,
            flow: { file: row.flow_file, name: row.flow_name },
          },
          requestedBy: row.requested_login,
          ...byName,
          gate,
          mayDecide: false,
        });
        continue;
      }
      const why = judge(
        who,
        gate,
        {
          project: row.project_id,
          flow: { file: row.flow_file },
          requestedBy: { id: row.requested_by },
        },
        { workspace: row.workspace, self_approve: row.self_approve },
      );
      const inputs = inputsOf(row.inputs_shown_json);
      out.push({
        run: {
          id: row.run,
          number: row.number,
          project: row.project_id,
          flow: { file: row.flow_file, name: row.flow_name },
          projectName: row.project_name,
          workspaceName: row.workspace_name,
          mode: row.mode as 'check' | 'real',
          ...(inputs ? { inputs } : {}),
        },
        requestedBy: row.requested_login,
        ...byName,
        gate,
        mayDecide: !why,
        ...(why ? { why } : {}),
      });
    }
    return out;
  });
}
