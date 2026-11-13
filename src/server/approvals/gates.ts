// Approval gates (AFS-28). A run of a flow with top-level approvals runs segment by segment
// (the designer's runSegments steps, ADR-0021); when hosts wait at an approval, the run records
// the gate and waits, holding no worker. Someone allowed decides it, or its time runs out; the
// run then goes back to the queue and continues with the segment the decision picks.
//
// Who may decide a gate:
//   - the `approve` grant on the flow (or its workspace), or an administrator;
//   - and, when the approval names approvers, being one of them (by login or by a group);
//     administrators may always decide, as they may do everything;
//   - not who launched the run, unless the workspace allows it (self_approve).
import { randomUUID } from 'node:crypto';
import type { ApprovalFields } from '@ansible-flow/core/flow/types';
import type { RunApproval } from '@ansible-flow/core/protocol';
import type { Kysely } from 'kysely';
import type { Access } from '../access/grants';
import type { Schema } from '../db/schema';
import type { Gate, GateStatus } from './types';

export type { Gate, GateStatus };

type Db = Kysely<Schema>;
type Row = Schema['run_gate'];

export const DECISIONS = ['approved', 'rejected'] as const;
export type Decision = (typeof DECISIONS)[number];

const gateOf = (row: Row): Gate => {
  const approval = (row.approval_json ? JSON.parse(row.approval_json) : {}) as ApprovalFields;
  return {
    id: row.id,
    run: row.run_id,
    node: { id: row.node_id, key: row.node_key, title: row.title },
    segment: row.segment,
    status: row.status as GateStatus,
    ...(row.deadline ? { deadline: row.deadline } : {}),
    approvers: approval.approvers ?? [],
    notify: approval.notify ?? [],
    ...(approval.message ? { message: approval.message } : {}),
    ...(row.decided_by ? { decidedBy: row.decided_by } : {}),
    ...(row.decided_at ? { decidedAt: row.decided_at } : {}),
    ...(row.comment ? { comment: row.comment } : {}),
    createdAt: row.created_at,
  };
};

export interface NewGate {
  run: string;
  node: { id: string; key: string; title: string };
  segment: string;
  /** The host sets the segment carried: what the next segment starts with. */
  carried: Record<string, unknown>;
  deadline?: Date;
  approval?: ApprovalFields;
}

/** A run reached an approval: the gate waits. */
export async function openGate(db: Db, input: NewGate, now = new Date()): Promise<Gate> {
  const row: Row = {
    id: randomUUID(),
    run_id: input.run,
    node_id: input.node.id,
    node_key: input.node.key,
    title: input.node.title,
    segment: input.segment,
    status: 'waiting',
    carried_json: JSON.stringify(input.carried),
    deadline: input.deadline ? input.deadline.toISOString() : null,
    approval_json: input.approval ? JSON.stringify(input.approval) : null,
    decided_by: null,
    decided_at: null,
    comment: null,
    created_at: now.toISOString(),
  };
  await db.insertInto('run_gate').values(row).execute();
  return gateOf(row);
}

export async function gatesOf(db: Db, run: string): Promise<Gate[]> {
  const rows = await db
    .selectFrom('run_gate')
    .selectAll()
    .where('run_id', '=', run)
    .orderBy('created_at')
    .execute();
  return rows.map(gateOf);
}

/** The gate a run decided last (or waits at): what its next segment starts from. */
export async function lastGate(
  db: Db,
  run: string,
): Promise<(Gate & { carried: Record<string, unknown> }) | undefined> {
  const row = await db
    .selectFrom('run_gate')
    .selectAll()
    .where('run_id', '=', run)
    .orderBy('created_at', 'desc')
    .executeTakeFirst();
  return row ? { ...gateOf(row), carried: JSON.parse(row.carried_json) } : undefined;
}

/**
 * Decides a waiting gate. False when it is not waiting any more (decided by someone else, timed
 * out, its run stopped): the first decision counts.
 */
export async function decideGate(
  db: Db,
  id: string,
  decision: { status: Exclude<GateStatus, 'waiting'>; by: string; comment?: string },
  now = new Date(),
): Promise<boolean> {
  const done = await db
    .updateTable('run_gate')
    .set({
      status: decision.status,
      decided_by: decision.by,
      decided_at: now.toISOString(),
      comment: decision.comment?.trim() || null,
    })
    .where('id', '=', id)
    .where('status', '=', 'waiting')
    .executeTakeFirst();
  return Number(done.numUpdatedRows) > 0;
}

/** Gates whose time is up and nobody decided. */
export async function dueGates(db: Db, now = new Date()): Promise<Gate[]> {
  const rows = await db
    .selectFrom('run_gate')
    .selectAll()
    .where('status', '=', 'waiting')
    .where('deadline', 'is not', null)
    .where('deadline', '<=', now.toISOString())
    .execute();
  return rows.map(gateOf);
}

/** The approvals of a run as the designer shows them (RunView.approvals). */
export function approvalsOf(
  gates: Gate[],
  mayDecide?: (gate: Gate) => boolean,
): Record<string, RunApproval> {
  const out: Record<string, RunApproval> = {};
  for (const g of gates) {
    if (g.status === 'cancelled') continue;
    out[g.node.id] = {
      status: g.status,
      ...(g.decidedBy ? { by: g.decidedBy } : {}),
      ...(g.decidedAt ? { at: g.decidedAt } : {}),
      ...(g.comment ? { comment: g.comment } : {}),
      ...(g.status === 'waiting' && mayDecide?.(g) ? { mayDecide: true } : {}),
    };
  }
  return out;
}

export interface Decider {
  user: { id: string; login: string; admin: boolean; groups: string[] };
  access: Access;
}

/** Why this person may not decide this gate; undefined when they may. */
export function whyNot(
  who: Decider,
  gate: Gate,
  run: { workspace: string; project: string; flowFile: string; requestedBy: string },
  selfApprove: boolean,
): string | undefined {
  if (!who.user.admin) {
    if (!who.access.approves(run.workspace, run.project, run.flowFile))
      return 'Deciding approvals here needs the approve grant';
    if (gate.approvers.length) {
      const names = new Set([who.user.login, ...who.user.groups].map((n) => n.toLowerCase()));
      if (!gate.approvers.some((a) => names.has(a.toLowerCase())))
        return `Only ${gate.approvers.join(', ')} may decide this approval`;
    }
  }
  if (!selfApprove && run.requestedBy === who.user.id)
    return 'Who launched the run does not decide its approvals here';
  return undefined;
}

/** A run that stops while it waits takes its waiting gate with it: nobody is asked any more. */
export async function closeGates(db: Db, run: string): Promise<void> {
  await db
    .updateTable('run_gate')
    .set({ status: 'cancelled' })
    .where('run_id', '=', run)
    .where('status', '=', 'waiting')
    .execute();
}

/**
 * Gates whose time ran out time out: the server decides them so, and their runs go on, the
 * waiting hosts through the approval's timeout port. Resolves with the runs that went on.
 */
export async function timeOutDue(
  db: Db,
  resume: (run: string) => Promise<boolean>,
  now = new Date(),
): Promise<string[]> {
  const went: string[] = [];
  for (const gate of await dueGates(db, now)) {
    const decided = await decideGate(
      db,
      gate.id,
      { status: 'timed out', by: 'the server', comment: 'Nobody decided in time' },
      now,
    );
    if (decided && (await resume(gate.run))) went.push(gate.run);
  }
  return went;
}
