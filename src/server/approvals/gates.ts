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

/**
 * AFS-133: the hosts waiting at a gate: the carried set `flow_<key>_waiting` (the designer's
 * name for the approval's waiting hosts), else any `_waiting` set.
 */
export function waitingHosts(carriedJson: string | null, key: string): string[] | undefined {
  if (!carriedJson) return undefined;
  try {
    const sets = (JSON.parse(carriedJson) as { afd_hostsets?: Record<string, unknown> })
      .afd_hostsets;
    if (!sets) return undefined;
    const own = sets[`flow_${key.replace(/[^A-Za-z0-9_]/g, '_')}_waiting`];
    const any = Object.entries(sets).find(([name]) => name.endsWith('_waiting'))?.[1];
    const hosts = Array.isArray(own) ? own : Array.isArray(any) ? any : undefined;
    return hosts?.filter((h): h is string => typeof h === 'string');
  } catch {
    return undefined;
  }
}

const gateOf = (row: Row): Gate => {
  const approval = (row.approval_json ? JSON.parse(row.approval_json) : {}) as ApprovalFields & {
    next?: Gate['next'];
  };
  const hosts = waitingHosts(row.carried_json, row.node_key);
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
    ...(hosts ? { hosts } : {}),
    ...(approval.next && Object.keys(approval.next).length ? { next: approval.next } : {}),
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
  /** AFS-146: where each decision sends the waiting hosts, by the next step's title. */
  next?: Gate['next'];
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
    approval_json:
      input.approval || input.next
        ? JSON.stringify({ ...input.approval, ...(input.next ? { next: input.next } : {}) })
        : null,
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
  // AFS-146: whoever decided, by name too.
  const names = await namesOf(
    db,
    rows.map((r) => r.decided_by ?? ''),
  );
  return rows.map((r) => withNames(gateOf(r), names));
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
  if (!row) return undefined;
  const names = await namesOf(db, [row.decided_by ?? '']);
  return { ...withNames(gateOf(row), names), carried: JSON.parse(row.carried_json) };
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
      // AFS-146: the hosts that wait (or waited) here, for the node's Run tab.
      ...(g.hosts?.length ? ({ hosts: g.hosts } as object) : {}),
      ...(g.decidedBy ? { by: g.decidedByName ?? g.decidedBy } : {}),
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

/** AFS-146: display names of these logins (a login without one names itself). */
export async function namesOf(db: Db, logins: string[]): Promise<Map<string, string>> {
  const wanted = [...new Set(logins.filter(Boolean).map((l) => l.toLowerCase()))];
  if (!wanted.length) return new Map();
  const rows = await db
    .selectFrom('user_account')
    .select(['login', 'name'])
    .where('login', 'in', wanted)
    .execute();
  return new Map(rows.filter((r) => r.name).map((r) => [r.login, r.name]));
}

/** A gate with its decider named as the pages name people. */
export function withNames(gate: Gate, names: Map<string, string>): Gate {
  const name = gate.decidedBy ? names.get(gate.decidedBy.toLowerCase()) : undefined;
  return name ? { ...gate, decidedByName: name } : gate;
}

/**
 * AFS-146: who may decide a gate, by name, for whoever waits on it: the approval's approvers
 * (people by display name, groups by name), else the people and groups holding approve on the
 * flow or its workspace. Who launched the run is left out when the workspace does not let them
 * decide. Administrators may always decide and are not listed.
 */
export async function decidersOf(
  db: Db,
  gate: Gate,
  place: { workspace: string; project: string; flowFile: string },
  except?: { id: string; login: string },
): Promise<string[]> {
  const out: string[] = [];
  if (gate.approvers.length) {
    const names = await namesOf(db, gate.approvers);
    for (const a of gate.approvers)
      if (a.toLowerCase() !== except?.login.toLowerCase())
        out.push(names.get(a.toLowerCase()) ?? a);
    return out;
  }
  const grants = await db
    .selectFrom('access_grant')
    .leftJoin('user_account', 'user_account.id', 'access_grant.principal_id')
    .leftJoin('user_group', 'user_group.id', 'access_grant.principal_id')
    .select([
      'access_grant.principal_type as type',
      'access_grant.principal_id as id',
      'user_account.login',
      'user_account.name as person',
      'user_account.disabled',
      'user_group.name as group',
    ])
    .where('access_grant.level', '=', 'approve')
    .where('access_grant.workspace_id', '=', place.workspace)
    .where((eb) =>
      eb.or([
        eb('access_grant.project_id', 'is', null),
        eb.and([
          eb('access_grant.project_id', '=', place.project),
          eb('access_grant.flow_file', '=', place.flowFile),
        ]),
      ]),
    )
    .execute();
  for (const g of grants) {
    if (g.type === 'group' && g.group) out.push(g.group);
    else if (g.type === 'user' && g.login && !g.disabled && g.id !== except?.id)
      out.push(g.person || g.login);
  }
  return [...new Set(out)].sort((a, b) => a.localeCompare(b));
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
    // AFS-146: and how that changes: the workspace's own setting.
    return 'Who launched the run does not decide its approvals here. The workspace can allow it on its Access page';
  return undefined;
}

/**
 * A run that stops while it waits takes its waiting gate with it: nobody is asked any more.
 * Resolves with the gates it closed (AFS-185: their approvers are told).
 */
export async function closeGates(db: Db, run: string, by?: string): Promise<string[]> {
  const open = await db
    .selectFrom('run_gate')
    .select('id')
    .where('run_id', '=', run)
    .where('status', '=', 'waiting')
    .execute();
  if (!open.length) return [];
  await db
    .updateTable('run_gate')
    // AFS-110: who stopped the run is who cancelled its gate (the page said "by nobody").
    .set({
      status: 'cancelled',
      ...(by ? { decided_by: by, decided_at: new Date().toISOString() } : {}),
    })
    .where('run_id', '=', run)
    .where('status', '=', 'waiting')
    .execute();
  return open.map((g) => g.id);
}

/**
 * Gates whose time ran out time out: the server decides them so, and their runs go on, the
 * waiting hosts through the approval's timeout port. Resolves with the runs that went on.
 */
export async function timeOutDue(
  db: Db,
  resume: (run: string) => Promise<boolean>,
  now = new Date(),
  /** AFS-29: told of each gate that timed out. */
  timedOut?: (run: string, gate: string) => void,
): Promise<string[]> {
  const went: string[] = [];
  for (const gate of await dueGates(db, now)) {
    const decided = await decideGate(
      db,
      gate.id,
      { status: 'timed out', by: 'the server', comment: 'Nobody decided in time' },
      now,
    );
    if (decided) timedOut?.(gate.run, gate.id);
    if (decided && (await resume(gate.run))) went.push(gate.run);
  }
  return went;
}
