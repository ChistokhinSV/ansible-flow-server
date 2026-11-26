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
import type { CheckRunEvidence, Gate, GateStatus } from './types';

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
    intent?: string;
    after?: string[];
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
    ...(approval.intent ? { intent: approval.intent } : {}),
    ...(row.decided_by ? { decidedBy: row.decided_by } : {}),
    ...(row.decided_at ? { decidedAt: row.decided_at } : {}),
    ...(row.comment ? { comment: row.comment } : {}),
    ...(hosts ? { hosts } : {}),
    ...(approval.next && Object.keys(approval.next).length ? { next: approval.next } : {}),
    ...(approval.after?.length ? { after: approval.after } : {}),
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
  /** AFS-193: the approval step's intent: what the approvers read when it has no message. */
  intent?: string;
  /** AFS-271: the steps on the approved path, by title (`approvedPath`). */
  after?: string[];
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
      input.approval || input.next || input.intent || input.after?.length
        ? JSON.stringify({
            ...input.approval,
            ...(input.next ? { next: input.next } : {}),
            ...(input.intent?.trim() ? { intent: input.intent.trim() } : {}),
            ...(input.after?.length ? { after: input.after } : {}),
          })
        : null,
    decided_by: null,
    decided_at: null,
    comment: null,
    created_at: now.toISOString(),
  };
  await db.insertInto('run_gate').values(row).execute();
  return gateOf(row);
}

/** How far `approvedPath` lists: enough to see what an approval lets happen, short enough to read. */
export const PATH_STEPS = 8;

/**
 * AFS-271: the steps the hosts go through once an approval is approved, by title, in order: the
 * approved port's step, then each step's ok port, up to an end. A step that branches (a decision,
 * another approval, parallel paths) is the last one listed: past it the way depends on the hosts.
 */
export function approvedPath(
  doc: {
    nodes: { id: string; title: string; type?: string }[];
    edges?: { from: { node: string; port: string }; to: { node: string } }[];
  },
  gate: string,
): string[] {
  const titles: string[] = [];
  const seen = new Set<string>([gate]);
  let edge = doc.edges?.find((e) => e.from.node === gate && e.from.port === 'approved');
  while (edge && titles.length < PATH_STEPS) {
    const to = edge.to.node;
    const node = doc.nodes.find((n) => n.id === to);
    if (!node || seen.has(node.id)) break;
    seen.add(node.id);
    titles.push(node.title);
    if (node.type === 'end') break;
    edge = doc.edges?.find((e) => e.from.node === node.id && e.from.port === 'ok_hosts');
  }
  return titles;
}

const ENDED = ['succeeded', 'failed', 'cancelled', 'lost'];

/**
 * AFS-271: the last check run of a run's launch configuration that ended before the run was
 * launched: what a decider can weigh. A run of no configuration has none to weigh (undefined).
 */
export async function evidenceOf(
  db: Db,
  run: { id: string; config?: string | undefined; commit: string; createdAt: string },
): Promise<Gate['evidence']> {
  if (!run.config) return undefined;
  const last = await db
    .selectFrom('run')
    .select(['id', 'number', 'state', 'ended_at', 'commit_id'])
    .where('config_id', '=', run.config)
    .where('mode', '=', 'check')
    .where('id', '!=', run.id)
    .where('state', 'in', ENDED)
    .where('created_at', '<', run.createdAt)
    .orderBy('created_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (!last) return {};
  const checkRun: CheckRunEvidence = {
    id: last.id,
    number: last.number,
    state: last.state,
    ...(last.ended_at ? { endedAt: last.ended_at } : {}),
    sameCommit: last.commit_id === run.commit,
  };
  return { checkRun };
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
    return except ? apartFrom(db, out, except.id) : out;
  }
  const holders = await approveHolders(db, place, except?.id);
  return except ? apartFrom(db, holders, except.id) : holders;
}

/**
 * AFS-211: a group among the deciders that the launcher is in says who else decides: "Sam Reyes
 * (change-board)", its other members by name; a group with nobody else is left out. A launcher
 * who reads "change-board decides it" while in change-board cannot tell who can act.
 */
async function apartFrom(db: Db, names: string[], launcher: string): Promise<string[]> {
  if (!names.length) return names;
  const rows = await db
    .selectFrom('user_group')
    .innerJoin('group_member', 'group_member.group_id', 'user_group.id')
    .innerJoin('user_account', 'user_account.id', 'group_member.user_id')
    .select([
      'user_group.name as group',
      'user_account.id as user',
      'user_account.login',
      'user_account.name',
      'user_account.disabled',
    ])
    .where('user_group.name', 'in', names)
    .execute();
  const members = new Map<string, typeof rows>();
  for (const r of rows) members.set(r.group, [...(members.get(r.group) ?? []), r]);
  return names.flatMap((name) => {
    const of = members.get(name);
    if (!of?.some((m) => m.user === launcher)) return [name];
    const others = of
      .filter((m) => m.user !== launcher && !m.disabled)
      .map((m) => m.name || m.login)
      .sort((a, b) => a.localeCompare(b));
    if (!others.length) return [];
    const who =
      others.length === 1 ? others[0] : `${others.slice(0, -1).join(', ')} or ${others.at(-1)}`;
    return [`${who} (${name})`];
  });
}

/**
 * AFS-146, AFS-224: who an approval with no approvers asks: the people and groups holding approve
 * on the flow or its workspace, by name (a person by display name, a group by its name), sorted.
 * `except`: a person's id left out (who launched the run, when they may not decide it).
 * Administrators may always decide and are not listed.
 */
export async function approveHolders(
  db: Db,
  place: { workspace: string; project: string; flowFile: string },
  except?: string,
): Promise<string[]> {
  const out: string[] = [];
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
    else if (g.type === 'user' && g.login && !g.disabled && g.id !== except)
      out.push(g.person || g.login);
  }
  return [...new Set(out)].sort((a, b) => a.localeCompare(b));
}

/**
 * AFS-211: whether this person would decide an approval of this flow if they had not launched the
 * run: one of its approvers (by login or a group of theirs), or, with none named, holding approve
 * on the flow or its workspace (themselves or through a group).
 */
export async function wouldDecide(
  db: Db,
  approvers: readonly string[],
  place: { workspace: string; project: string; flowFile: string },
  user: string,
): Promise<boolean> {
  const person = await db
    .selectFrom('user_account')
    .select('login')
    .where('id', '=', user)
    .executeTakeFirst();
  if (!person) return false;
  const groups = await db
    .selectFrom('group_member')
    .innerJoin('user_group', 'user_group.id', 'group_member.group_id')
    .select(['user_group.id', 'user_group.name'])
    .where('group_member.user_id', '=', user)
    .execute();
  if (approvers.length) {
    const names = new Set([person.login, ...groups.map((g) => g.name)].map((n) => n.toLowerCase()));
    return approvers.some((a) => names.has(a.toLowerCase()));
  }
  const held = await db
    .selectFrom('access_grant')
    .select('id')
    .where('level', '=', 'approve')
    .where('workspace_id', '=', place.workspace)
    .where('principal_id', 'in', [user, ...groups.map((g) => g.id)])
    .where((eb) =>
      eb.or([
        eb('project_id', 'is', null),
        eb.and([eb('project_id', '=', place.project), eb('flow_file', '=', place.flowFile)]),
      ]),
    )
    .executeTakeFirst();
  return !!held;
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
    // AFS-193: said to the launcher, who cannot open the setting that changes it: no pointer to
    // a page they do not have, only who can.
    return 'You launched this run, so others decide its approvals (only an administrator can change that)';
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
