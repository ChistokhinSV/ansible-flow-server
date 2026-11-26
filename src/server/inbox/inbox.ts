// AFS-212 (ADR-0039 §9, §10): Home as an inbox. What needs the person now, from every workspace
// they may see (it does not follow the menu's workspace switcher), each item with its workspace
// and the verbs the person may use there; and the day in numbers. One call, so the page and an
// agent read the same thing, and it stays one place to keep fast.
import type { FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { type Access, atLeast } from '../access/grants';
import type { Level } from '../access/types';
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

  // One's own runs: waiting for someone else's decision, or paused; then the failed ones, each
  // query on its own so that many of one kind never push out another.
  const light = [
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
    'created_at',
  ] as const;
  const runOf = (
    r: { id: string; number: number; flow_file: string; flow_name: string; mode: string } & {
      config_name: string | null;
      step_json: string | null;
    },
    asRunner?: true,
  ): InboxRun => ({
    id: r.id,
    number: r.number,
    flow: { file: r.flow_file, name: r.flow_name },
    mode: r.mode === 'check' ? 'check' : 'real',
    ...(r.config_name ? { config: r.config_name } : {}),
    ...(isDebug(r.step_json) ? { debug: true as const } : {}),
    ...(asRunner ? { asRunner } : {}),
  });
  const waitingOrPaused = await db
    .selectFrom('run')
    .select([...light])
    .where('requested_by', '=', who.id)
    .where((eb) =>
      eb.or([
        eb('state', '=', 'waiting'),
        eb.and([eb('state', '=', 'running'), eb('step_paused', 'is not', null)]),
      ]),
    )
    .orderBy('created_at', 'asc')
    .execute();
  const held = waitingOrPaused.filter((r) => r.state === 'waiting' && !deciding.has(r.id));
  const paused = waitingOrPaused.filter((r) => r.state === 'running');
  // Their gates in one query: the step each waits at, since when.
  const gates = new Map<string, { id: string; title: string; created_at: string }>();
  if (held.length)
    for (const g of await db
      .selectFrom('run_gate')
      .select(['id', 'run_id', 'title', 'created_at'])
      .where(
        'run_id',
        'in',
        held.map((r) => r.id),
      )
      .where('status', '=', 'waiting')
      .orderBy('created_at', 'asc')
      .execute())
      gates.set(g.run_id, g);
  for (const r of held) {
    const reached = reach(r.project_id, r.flow_file, r.config_id);
    if (!reached) continue;
    const gate = gates.get(r.id);
    const deciders = approvals.find((a) => a.run.id === r.id)?.gate.deciders;
    items.push({
      kind: 'request',
      ...reached.place,
      title: `Your run ${r.flow_name} #${r.number} waits for a decision${
        deciders?.length ? ` by ${deciders.join(' or ')}` : ''
      }`,
      since: gate?.created_at ?? r.created_at,
      verbs: ['open'],
      run: runOf(r, reached.asRunner),
      approval: {
        gate: gate?.id ?? '',
        step: gate?.title ?? '',
        requestedBy: who.login,
        ...(deciders?.length ? { deciders } : {}),
      },
    });
  }
  // A paused run's view says since when and until when it waits: read for those listed only.
  const shownPaused = paused.filter((r) => reach(r.project_id, r.flow_file, r.config_id));
  const views = new Map(
    shownPaused.length
      ? (
          await db
            .selectFrom('run')
            .select(['id', 'view_json'])
            .where(
              'id',
              'in',
              shownPaused.slice(0, MOST).map((r) => r.id),
            )
            .execute()
        ).map((v) => [v.id, v.view_json] as const)
      : [],
  );
  for (const r of shownPaused) {
    const reached = reach(r.project_id, r.flow_file, r.config_id);
    if (!reached) continue;
    const pause = pauseOf(views.get(r.id) ?? null);
    const operator = atLeast(levelOn(reached.place, r.flow_file) || undefined, 'operator');
    items.push({
      kind: 'paused',
      ...reached.place,
      title: `Your run ${r.flow_name} #${r.number} is paused before ${r.step_paused}`,
      since: pause?.since ?? r.created_at,
      verbs: operator ? ['open', 'step', 'continue'] : ['open'],
      run: runOf(r, reached.asRunner),
      pause: {
        before: r.step_paused ?? '',
        ...(pause?.stopsAt ? { stopsAt: pause.stopsAt } : {}),
      },
    });
  }
  items.push(...(await failedOf(db, who, now, reach, levelOn, runOf)));

  // Drafts the asker changed and nobody saved, and whether their flow moved on since.
  const drafts = await draftsOf(deps, who, places, levelOn);
  items.push(...drafts.items);

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
    // Every item counts, also those past the most a kind lists (drafts are read for those listed).
    count: items.filter((i) => i.kind !== 'request').length + drafts.total - drafts.items.length,
    items: trimmed(items),
    today: await dayOf(db, who, places, who.since),
    week: await weekOf(db, who, places, now),
    runners: await runnersOf(deps),
  };
}

/** A step-by-step record that asked for a debug run. */
function isDebug(json: string | null): boolean {
  if (!json) return false;
  try {
    return !!(JSON.parse(json) as { debug?: boolean }).debug;
  } catch {
    return false;
  }
}

/**
 * The asker's runs that failed (or were lost) in the last days and were not decided against, and
 * that nothing ran after: a run of the same launch configuration (or, without one, of the same
 * flow) made later, a check run too, means it is being dealt with. Every one is counted; the list
 * shows the first few.
 */
async function failedOf(
  db: Db,
  who: Asker,
  now: Date,
  reach: (
    project: string,
    file: string,
    config: string | null,
  ) => { place: Place; asRunner?: true } | undefined,
  levelOn: (place: Place, file: string) => Level | undefined,
  runOf: (
    r: {
      id: string;
      number: number;
      flow_file: string;
      flow_name: string;
      mode: string;
      config_name: string | null;
      step_json: string | null;
    },
    asRunner?: true,
  ) => InboxRun,
): Promise<InboxItem[]> {
  const failed = await db
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
      'error',
      'host_count',
      'failed_count',
      'created_at',
      'ended_at',
    ])
    .where('requested_by', '=', who.id)
    .where('state', 'in', ['failed', 'lost'])
    .where('ended_at', '>=', new Date(now.getTime() - FAILED_DAYS * DAY_MS).toISOString())
    .where((eb) =>
      eb(
        'id',
        'not in',
        eb
          .selectFrom('run_gate')
          .select('run_gate.run_id')
          .where('run_gate.status', 'in', ['rejected', 'timed out']),
      ),
    )
    .orderBy('created_at', 'desc')
    .execute();
  if (!failed.length) return [];
  // The newest run of each configuration (and of each flow run without one) since the oldest of
  // these failed runs, in one query.
  const oldest = failed.map((r) => r.created_at).sort()[0] as string;
  const latest = new Map<string, string>();
  for (const r of await db
    .selectFrom('run')
    .select(['project_id', 'config_id', 'flow_file'])
    .select((eb) => eb.fn.max('created_at').as('last'))
    .where('project_id', 'in', [...new Set(failed.map((r) => r.project_id))])
    .where('created_at', '>', oldest)
    .groupBy(['project_id', 'config_id', 'flow_file'])
    .execute()) {
    const key = r.config_id
      ? `${r.project_id} config ${r.config_id}`
      : `${r.project_id} flow ${r.flow_file}`;
    const last = String(r.last);
    if (!latest.has(key) || last > (latest.get(key) as string)) latest.set(key, last);
  }
  const out: InboxItem[] = [];
  for (const r of failed) {
    const key = r.config_id
      ? `${r.project_id} config ${r.config_id}`
      : `${r.project_id} flow ${r.flow_file}`;
    if ((latest.get(key) ?? '') > r.created_at) continue;
    const reached = reach(r.project_id, r.flow_file, r.config_id);
    if (!reached) continue;
    const run = runOf(r, reached.asRunner);
    const operator = atLeast(levelOn(reached.place, r.flow_file) || undefined, 'operator');
    const lost = r.state === 'lost';
    out.push({
      kind: 'failed',
      ...reached.place,
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
  return out;
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

/**
 * The files a project's branch changed between two commits, kept for a while: Home asks again
 * every few seconds, and a draft's base and its project's head rarely move. Bounded: the oldest
 * goes first.
 */
const CHANGED_KEPT = 200;
const changed = new Map<string, Promise<Set<string>>>();
function changedFiles(git: Git, project: string, from: string, to: string): Promise<Set<string>> {
  const key = `${project} ${from} ${to}`;
  let files = changed.get(key);
  if (!files) {
    files = git
      .changedFiles(project, from, to)
      .then((list) => new Set(list.map((f) => f.file)))
      .catch(() => new Set<string>());
    changed.set(key, files);
    if (changed.size > CHANGED_KEPT) changed.delete(changed.keys().next().value as string);
  }
  return files;
}

/** The drafts the asker may still finish, the newest first: all counted, the first few listed. */
async function draftsOf(
  deps: InboxDeps,
  who: Asker,
  places: Map<string, Place>,
  levelOn: (place: Place, file: string) => Level | undefined,
): Promise<{ items: InboxItem[]; total: number }> {
  const { db } = deps;
  const drafts = await db
    .selectFrom('flow_draft')
    .innerJoin('project', 'project.id', 'flow_draft.project_id')
    .select([
      'flow_draft.id',
      'flow_draft.project_id',
      'flow_draft.file',
      'flow_draft.base_commit',
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
    .execute();
  // A draft is edited with rw on its flow: without it now, it is not the asker's to finish. Left
  // out before the list is cut, so drafts they lost rw on never hide those they may finish.
  const theirs = drafts.flatMap((d) => {
    const place = places.get(d.project_id);
    return place && atLeast(levelOn(place, d.file), 'rw') ? [{ ...d, place }] : [];
  });
  const shown = theirs.slice(0, MOST);
  if (!shown.length) return { items: [], total: theirs.length };
  const ids = shown.map((d) => d.id);
  const [others, texts, behind] = await Promise.all([
    db
      .selectFrom('flow_draft_edit')
      .innerJoin('user_account', 'user_account.id', 'flow_draft_edit.user_id')
      .select(['flow_draft_edit.draft_id', 'user_account.login', 'user_account.name'])
      .where('flow_draft_edit.draft_id', 'in', ids)
      .where('flow_draft_edit.user_id', '!=', who.id)
      .groupBy(['flow_draft_edit.draft_id', 'user_account.login', 'user_account.name'])
      .execute(),
    db.selectFrom('flow_draft').select(['id', 'text']).where('id', 'in', ids).execute(),
    Promise.all(
      shown.map(async (d) =>
        deps.git && d.commit_id && d.commit_id !== d.base_commit
          ? (await changedFiles(deps.git, d.project_id, d.base_commit, d.commit_id)).has(d.file)
          : false,
      ),
    ),
  ]);
  const items = shown.map((d, i): InboxItem => {
    const flow = flowName(d.file, texts.find((t) => t.id === d.id)?.text ?? '');
    const moved = behind[i] ?? false;
    return {
      kind: 'draft',
      ...d.place,
      title: moved
        ? `Your draft of ${flow} is not saved, and the flow changed since it began`
        : `Your draft of ${flow} is not saved`,
      since: d.updated_at,
      verbs: ['openDraft'],
      draft: {
        id: d.id,
        file: d.file,
        flow,
        others: others.filter((o) => o.draft_id === d.id).map((o) => o.name || o.login),
        behind: moved,
      },
    };
  });
  return { items, total: theirs.length };
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

/**
 * The day's runs by state and mode, counted by the database: only the paused ones are read (for
 * which of them are debug runs), and the rejected ones counted apart.
 */
async function dayOf(
  db: Db,
  who: Asker,
  places: Map<string, Place>,
  since: Date,
): Promise<InboxDay> {
  const from = since.toISOString();
  const [counts, paused, against] = await Promise.all([
    seenRuns(db, who, places)
      .select(['state', 'mode'])
      .select((eb) => eb.fn.countAll<number | string>().as('n'))
      .where('created_at', '>=', from)
      .groupBy(['state', 'mode'])
      .execute(),
    seenRuns(db, who, places)
      .select(['step_json'])
      .where('created_at', '>=', from)
      .where('state', '=', 'running')
      .where('step_paused', 'is not', null)
      .execute(),
    seenRuns(db, who, places)
      .select((eb) => eb.fn.countAll<number | string>().as('n'))
      .where('created_at', '>=', from)
      .where('state', '=', 'failed')
      .where((eb) =>
        eb(
          'id',
          'in',
          eb
            .selectFrom('run_gate')
            .select('run_gate.run_id')
            .where('run_gate.status', 'in', ['rejected', 'timed out']),
        ),
      )
      .executeTakeFirst(),
  ]);
  const of = (state: string) =>
    counts.filter((c) => c.state === state).reduce((n, c) => n + Number(c.n), 0);
  const rejected = Number(against?.n ?? 0);
  return {
    runs: counts.reduce((n, c) => n + Number(c.n), 0),
    real: counts.filter((c) => c.mode !== 'check').reduce((n, c) => n + Number(c.n), 0),
    check: counts.filter((c) => c.mode === 'check').reduce((n, c) => n + Number(c.n), 0),
    succeeded: of('succeeded'),
    failed: of('failed') - rejected + of('lost'),
    rejected,
    cancelled: of('cancelled'),
    going: of('queued') + of('running') - paused.length,
    waiting: of('waiting'),
    paused: paused.length,
    pausedDebug: paused.filter((r) => isDebug(r.step_json)).length,
  };
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
