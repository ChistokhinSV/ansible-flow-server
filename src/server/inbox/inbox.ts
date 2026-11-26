// AFS-212 (ADR-0039 §9, §10): Home as an inbox. What needs the person now, from every workspace
// they may see (it does not follow the menu's workspace switcher), each item with its workspace
// and the verbs the person may use there; and the day in numbers. One call, so the page and an
// agent read the same thing, and it stays one place to keep fast.
import type { FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { type Access, atLeast } from '../access/grants';
import type { ApprovalLists } from '../approvals/routes';
import type { Schema } from '../db/schema';
import { summarizeFlow } from '../flows';
import type { Git } from '../projects/git';
import type { RunQueue } from '../runs/queue';
import type { CertificateInfo } from '../tls/types';
import type {
  Inbox,
  InboxDay,
  InboxItem,
  InboxKind,
  InboxPlace,
  InboxRun,
  InboxVerb,
} from './types';

type Db = Kysely<Schema>;

export type { Inbox, InboxDay, InboxItem, InboxKind, InboxPlace, InboxRun, InboxVerb };

/** Failed runs older than this have been dealt with, or will not be. */
const FAILED_DAYS = 7;
/** A certificate this close to its end is said, as its page's banner does. */
const CERTIFICATE_DAYS = 30;
const DAY_MS = 86_400_000;
/** Each kind lists at most this many, newest first. */
const MOST = 20;

export interface InboxDeps {
  db: Db;
  queue: RunQueue;
  approvals: ApprovalLists;
  git?: Git;
  certificate?: () => CertificateInfo | undefined;
}

export interface Asker {
  id: string;
  login: string;
  admin: boolean;
  access: Access;
  /** Launch configurations the asker may run as actions (ADR-0036). */
  granted: ReadonlySet<string>;
  /** The workspaces the inbox is of: a token's one, or the one asked for; undefined: all. */
  only?: string;
  /** The start of the asker's day. */
  since: Date;
  now?: Date;
}

interface Place {
  workspace: InboxPlace;
  project: InboxPlace;
}

const words = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export async function inboxFor(
  deps: InboxDeps,
  request: FastifyRequest,
  who: Asker,
): Promise<Inbox> {
  const { db } = deps;
  const now = who.now ?? new Date();
  const { access } = who;
  // Every project with its workspace, of those the inbox is of: an item names both.
  const rows = await db
    .selectFrom('project')
    .innerJoin('workspace', 'workspace.id', 'project.workspace_id')
    .select([
      'project.id as project',
      'project.key as projectKey',
      'project.name as projectName',
      'workspace.id as workspace',
      'workspace.key as workspaceKey',
      'workspace.name as workspaceName',
    ])
    .execute();
  const places = new Map<string, Place>();
  for (const r of rows)
    if (!who.only || r.workspace === who.only)
      places.set(r.project, {
        workspace: { id: r.workspace, key: r.workspaceKey, name: r.workspaceName },
        project: { id: r.project, key: r.projectKey, name: r.projectName },
      });
  const levelOn = (place: Place, file: string) =>
    who.admin ? 'rw' : access.onFlow(place.workspace.id, place.project.id, file);
  // A run of one's own is in the inbox where its flow is seen, or as an action one may run.
  const reach = (
    project: string,
    file: string,
    config: string | null,
  ): { place: Place; asRunner?: true } | undefined => {
    const place = places.get(project);
    if (!place) return undefined;
    if (levelOn(place, file)) return { place };
    return config && who.granted.has(config) ? { place, asRunner: true } : undefined;
  };
  const items: InboxItem[] = [];

  // Approvals the asker may decide, as on the Approvals page.
  const approvals = await deps.approvals.waiting(request);
  const deciding = new Set<string>();
  for (const a of approvals) {
    if (!a.mayDecide) continue;
    const place = places.get(a.run.project);
    if (!place) continue;
    deciding.add(a.run.id);
    const by = a.requestedByName ?? a.requestedBy;
    items.push({
      kind: 'approval',
      ...place,
      title: `${a.gate.node.title}: ${a.run.flow.name} #${a.run.number} waits for your decision`,
      since: a.gate.createdAt,
      verbs: ['review'],
      run: {
        id: a.run.id,
        number: a.run.number,
        flow: a.run.flow,
        mode: a.run.mode ?? 'real',
      },
      approval: {
        gate: a.gate.id,
        step: a.gate.node.title,
        requestedBy: by,
        ...(a.gate.deciders?.length ? { deciders: a.gate.deciders } : {}),
      },
    });
  }

  // One's own runs: waiting for someone else's decision, paused, or failed.
  const mine = await db
    .selectFrom('run')
    .select([
      'id',
      'number',
      'project_id',
      'flow_file',
      'flow_name',
      'mode',
      'config_id',
      'config_name',
      'state',
      'step_json',
      'step_paused',
      'view_json',
      'error',
      'host_count',
      'failed_count',
      'created_at',
      'ended_at',
    ])
    .where('requested_by', '=', who.id)
    .where((eb) =>
      eb.or([
        eb('state', '=', 'waiting'),
        eb.and([eb('state', '=', 'running'), eb('step_paused', 'is not', null)]),
        eb.and([
          eb('state', 'in', ['failed', 'lost']),
          eb('ended_at', '>=', new Date(now.getTime() - FAILED_DAYS * DAY_MS).toISOString()),
          eb(
            'id',
            'not in',
            eb
              .selectFrom('run_gate')
              .select('run_gate.run_id')
              .where('run_gate.status', 'in', ['rejected', 'timed out']),
          ),
        ]),
      ]),
    )
    .orderBy('created_at', 'desc')
    .limit(MOST * 3)
    .execute();
  const runOf = (r: (typeof mine)[number], asRunner?: true): InboxRun => ({
    id: r.id,
    number: r.number,
    flow: { file: r.flow_file, name: r.flow_name },
    mode: r.mode === 'check' ? 'check' : 'real',
    ...(r.config_name ? { config: r.config_name } : {}),
    ...(r.step_json && JSON.parse(r.step_json).debug ? { debug: true as const } : {}),
    ...(asRunner ? { asRunner } : {}),
  });
  let failed = 0;
  for (const r of mine) {
    const reached = reach(r.project_id, r.flow_file, r.config_id);
    if (!reached) continue;
    const { place, asRunner } = reached;
    const run = runOf(r, asRunner);
    const operator = atLeast(levelOn(place, r.flow_file) || undefined, 'operator');
    if (r.state === 'waiting') {
      if (deciding.has(r.id)) continue;
      const gate = await db
        .selectFrom('run_gate')
        .select(['id', 'title', 'created_at'])
        .where('run_id', '=', r.id)
        .where('status', '=', 'waiting')
        .orderBy('created_at', 'desc')
        .executeTakeFirst();
      const deciders = approvals.find((a) => a.run.id === r.id)?.gate.deciders;
      items.push({
        kind: 'request',
        ...place,
        title: `Your run ${r.flow_name} #${r.number} waits for a decision${
          deciders?.length ? ` by ${deciders.join(' or ')}` : ''
        }`,
        since: gate?.created_at ?? r.created_at,
        verbs: ['open'],
        run,
        approval: {
          gate: gate?.id ?? '',
          step: gate?.title ?? '',
          requestedBy: who.login,
          ...(deciders?.length ? { deciders } : {}),
        },
      });
    } else if (r.state === 'running') {
      const paused = pauseOf(r.view_json);
      const stopsAt = paused?.stopsAt;
      items.push({
        kind: 'paused',
        ...place,
        title: `Your run ${r.flow_name} #${r.number} is paused before ${r.step_paused}`,
        since: paused?.since ?? r.created_at,
        verbs: operator ? ['open', 'step', 'continue'] : ['open'],
        run,
        pause: { before: r.step_paused ?? '', ...(stopsAt ? { stopsAt } : {}) },
      });
    } else if (failed < MOST) {
      // Done with once the same configuration (or, without one, the same flow) ran again after it.
      const after = await db
        .selectFrom('run')
        .select('id')
        .where('project_id', '=', r.project_id)
        .where('created_at', '>', r.created_at)
        .where((eb) =>
          r.config_id
            ? eb('config_id', '=', r.config_id)
            : eb.and([eb('config_id', 'is', null), eb('flow_file', '=', r.flow_file)]),
        )
        .limit(1)
        .executeTakeFirst();
      if (after) continue;
      failed++;
      const lost = r.state === 'lost';
      items.push({
        kind: 'failed',
        ...place,
        title: `Your run ${r.flow_name} #${r.number} ${lost ? 'was lost' : 'failed'}`,
        since: r.ended_at ?? r.created_at,
        // Run again asks operator on the flow; a debug run is debugged again from its page.
        verbs: operator && !run.debug ? ['open', 'runAgain'] : ['open'],
        run,
        failure: {
          ...(r.error ? { error: r.error } : {}),
          ...(r.host_count != null
            ? { hosts: { total: r.host_count, failed: r.failed_count ?? 0 } }
            : {}),
          ...(lost ? { lost: true as const } : {}),
        },
      });
    }
  }

  // Drafts the asker changed and nobody saved, and whether their flow moved on since.
  items.push(...(await draftsOf(deps, who, places, levelOn)));

  // The server's certificate, to its administrators, when it ends soon.
  const info = who.admin && !who.only ? deps.certificate?.() : undefined;
  if (info && info.daysLeft <= CERTIFICATE_DAYS)
    items.push({
      kind: 'certificate',
      title:
        info.daysLeft <= 0
          ? 'The server certificate has ended'
          : `The server certificate ends in ${words(info.daysLeft, 'day', 'days')}`,
      since: new Date(new Date(info.notAfter).getTime() - CERTIFICATE_DAYS * DAY_MS).toISOString(),
      verbs: ['replace'],
      certificate: { notAfter: info.notAfter, daysLeft: info.daysLeft, names: info.names },
    });

  // What needs a decision first, then what waits on a run of one's own, then the rest; the
  // oldest first within each, as a queue is worked through.
  const ORDER: InboxKind[] = ['approval', 'paused', 'failed', 'certificate', 'draft', 'request'];
  items.sort(
    (a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || a.since.localeCompare(b.since),
  );
  return {
    // Every item counts, also those past the most a kind lists.
    count: items.filter((i) => i.kind !== 'request').length,
    items: trimmed(items),
    today: await dayOf(db, who, places, who.since),
    week: await weekOf(db, who, places, now),
    runners: await runnersOf(deps),
  };
}

/** At most `MOST` of each kind. */
function trimmed(items: InboxItem[]): InboxItem[] {
  const seen = new Map<InboxKind, number>();
  return items.filter((i) => {
    const n = (seen.get(i.kind) ?? 0) + 1;
    seen.set(i.kind, n);
    return n <= MOST;
  });
}

/** When a paused run paused, and when it stops by itself: from its view (seconds). */
function pauseOf(view: string | null): { since: string; stopsAt: string } | undefined {
  if (!view) return undefined;
  try {
    const paused = (
      JSON.parse(view) as { step?: { paused?: { since?: number; timeout?: number } } }
    ).step?.paused;
    if (typeof paused?.since !== 'number' || typeof paused.timeout !== 'number') return undefined;
    return {
      since: new Date(paused.since * 1000).toISOString(),
      stopsAt: new Date((paused.since + paused.timeout) * 1000).toISOString(),
    };
  } catch {
    return undefined;
  }
}

async function draftsOf(
  deps: InboxDeps,
  who: Asker,
  places: Map<string, Place>,
  levelOn: (place: Place, file: string) => string | undefined,
): Promise<InboxItem[]> {
  const { db } = deps;
  const drafts = await db
    .selectFrom('flow_draft')
    .innerJoin('project', 'project.id', 'flow_draft.project_id')
    .select([
      'flow_draft.id',
      'flow_draft.project_id',
      'flow_draft.file',
      'flow_draft.base_commit',
      'flow_draft.text',
      'flow_draft.updated_at',
      'project.commit_id',
    ])
    .where(
      'flow_draft.id',
      'in',
      db
        .selectFrom('flow_draft_edit')
        .select('flow_draft_edit.draft_id')
        .where('flow_draft_edit.user_id', '=', who.id)
        // Changes that still count: not taken back, and not the taking back itself.
        .where('flow_draft_edit.kind', 'in', ['command', 'layout', 'start', 'redo'])
        .where('flow_draft_edit.undone', '=', 0),
    )
    .orderBy('flow_draft.updated_at', 'desc')
    .limit(MOST)
    .execute();
  const out: InboxItem[] = [];
  for (const d of drafts) {
    const place = places.get(d.project_id);
    // A draft is edited with rw on its flow: without it now, it is not the asker's to finish.
    if (!place || !atLeast((levelOn(place, d.file) as 'rw' | undefined) || undefined, 'rw'))
      continue;
    const others = await db
      .selectFrom('flow_draft_edit')
      .innerJoin('user_account', 'user_account.id', 'flow_draft_edit.user_id')
      .select(['user_account.login', 'user_account.name'])
      .where('flow_draft_edit.draft_id', '=', d.id)
      .where('flow_draft_edit.user_id', '!=', who.id)
      .groupBy(['user_account.login', 'user_account.name'])
      .execute();
    let behind = false;
    if (deps.git && d.commit_id && d.commit_id !== d.base_commit) {
      const head = d.commit_id;
      behind = await deps.git
        .changedFiles(d.project_id, d.base_commit, head)
        .then((files) => files.some((f) => f.file === d.file))
        .catch(() => false);
    }
    const flow = flowName(d.file, d.text);
    out.push({
      kind: 'draft',
      ...place,
      title: behind
        ? `Your draft of ${flow} is not saved, and the flow changed since it began`
        : `Your draft of ${flow} is not saved`,
      since: d.updated_at,
      verbs: ['openDraft'],
      draft: {
        id: d.id,
        file: d.file,
        flow,
        others: others.map((o) => o.name || o.login),
        behind,
      },
    });
  }
  return out;
}

function flowName(file: string, text: string): string {
  try {
    const name = summarizeFlow(file, text).name;
    if (name) return name;
  } catch {
    // A draft that does not read as a flow is named by its file.
  }
  return file.split('/').pop() ?? file;
}

/** Which runs the numbers count: those the asker may see, of the workspaces asked for. */
function seenRuns(db: Db, who: Asker, places: Map<string, Place>) {
  const visible = who.access.visible();
  const projects = [...places.keys()];
  const query = db.selectFrom('run').where('project_id', 'in', projects.length ? projects : ['']);
  if (!visible) return query;
  const inWorkspaces = projects.filter((p) =>
    visible.workspaces.includes(places.get(p)?.workspace.id ?? ''),
  );
  return query.where((eb) =>
    eb.or([
      eb('project_id', 'in', inWorkspaces.length ? inWorkspaces : ['']),
      ...visible.flows.map(([project, file]) =>
        eb.and([eb('project_id', '=', project), eb('flow_file', '=', file)]),
      ),
    ]),
  );
}

async function dayOf(
  db: Db,
  who: Asker,
  places: Map<string, Place>,
  since: Date,
): Promise<InboxDay> {
  const runs = await seenRuns(db, who, places)
    .select(['id', 'state', 'mode', 'step_paused', 'step_json'])
    .where('created_at', '>=', since.toISOString())
    .execute();
  const against = new Set(
    (
      await db
        .selectFrom('run_gate')
        .select('run_id')
        .where('status', 'in', ['rejected', 'timed out'])
        .where(
          'run_id',
          'in',
          runs
            .filter((r) => r.state === 'failed')
            .map((r) => r.id)
            .concat(''),
        )
        .execute()
    ).map((g) => g.run_id),
  );
  const day: InboxDay = {
    runs: runs.length,
    real: 0,
    check: 0,
    succeeded: 0,
    failed: 0,
    rejected: 0,
    cancelled: 0,
    going: 0,
    waiting: 0,
    paused: 0,
    pausedDebug: 0,
  };
  for (const r of runs) {
    if (r.mode === 'check') day.check++;
    else day.real++;
    if (r.state === 'succeeded') day.succeeded++;
    else if (r.state === 'failed' && against.has(r.id)) day.rejected++;
    else if (r.state === 'failed' || r.state === 'lost') day.failed++;
    else if (r.state === 'cancelled') day.cancelled++;
    else if (r.state === 'waiting') day.waiting++;
    else if (r.state === 'running' && r.step_paused != null) {
      day.paused++;
      if (r.step_json && JSON.parse(r.step_json).debug) day.pausedDebug++;
    } else if (r.state === 'running' || r.state === 'queued') day.going++;
  }
  return day;
}

async function weekOf(db: Db, who: Asker, places: Map<string, Place>, now: Date) {
  const rows = await seenRuns(db, who, places)
    .select(['state'])
    .select((eb) => eb.fn.countAll<number | string>().as('n'))
    .where('created_at', '>=', new Date(now.getTime() - 7 * DAY_MS).toISOString())
    .where('state', 'in', ['succeeded', 'failed', 'cancelled', 'lost'])
    .groupBy('state')
    .execute();
  let ended = 0;
  let succeeded = 0;
  for (const r of rows) {
    ended += Number(r.n);
    if (r.state === 'succeeded') succeeded += Number(r.n);
  }
  return { ended, succeeded };
}

async function runnersOf(deps: InboxDeps): Promise<Inbox['runners']> {
  const rows = await deps.db
    .selectFrom('run')
    .select(['state'])
    .select((eb) => eb.fn.countAll<number | string>().as('n'))
    .where('state', 'in', ['running', 'queued'])
    .groupBy('state')
    .execute();
  const count = (state: string) => Number(rows.find((r) => r.state === state)?.n ?? 0);
  return { busy: count('running'), slots: deps.queue.limits.maxRuns, queued: count('queued') };
}
