// Approvals over HTTP (AFS-28):
//   GET  /api/v1/approvals                    what waits for a decision, that the person may see
//   GET  /api/v1/runs/:id/approvals           a run's approvals, with whether the person may decide
//   POST /api/v1/runs/:id/approvals/:node     decide one: approved or rejected, with a comment
// The run then goes back to the queue and continues with the segment the decision picks.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { type Access, accessOf } from '../access/grants';
import { signedIn } from '../auth/guards';
import { getUser } from '../auth/users';
import type { Schema } from '../db/schema';
import type { RunHub } from '../runs/hub';
import type { RunQueue } from '../runs/queue';
import { DECISIONS, type Decision, decideGate, type Gate, gatesOf, whyNot } from './gates';
import type { WaitingApproval } from './types';

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
      return (await gatesOf(db, run.id)).map((gate) => {
        const why = judge(who, gate, run, place);
        return { ...gate, mayDecide: !why, ...(why && gate.status === 'waiting' ? { why } : {}) };
      });
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
      if (why) return reply.code(403).send({ error: 'forbidden', message: why });
      const { decision, comment } = request.body;
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

  app.get('/api/v1/approvals', async (request, reply) => {
    if (!signedIn(request, reply)) return reply;
    const who = await deciderFor(request);
    if (!who) return reply;
    const rows = await db
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
        'workspace.id as workspace',
        'workspace.self_approve',
      ])
      .where('run_gate.status', '=', 'waiting')
      .where('run.state', '=', 'waiting')
      .orderBy('run_gate.created_at')
      .execute();
    const out: WaitingApproval[] = [];
    for (const row of rows) {
      // Only what the person may see; and of that, whether they may decide.
      const sees =
        who.access.admin ||
        who.access.onFlow(row.workspace, row.project_id, row.flow_file) ||
        who.access.approves(row.workspace, row.project_id, row.flow_file);
      if (!sees) continue;
      const gate = (await gatesOf(db, row.run)).find((g) => g.id === row.gate);
      if (!gate) continue;
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
      out.push({
        run: {
          id: row.run,
          number: row.number,
          project: row.project_id,
          flow: { file: row.flow_file, name: row.flow_name },
        },
        requestedBy: row.requested_login,
        gate,
        mayDecide: !why,
        ...(why ? { why } : {}),
      });
    }
    return out;
  });
}
