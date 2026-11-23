// AFS-214, AFS-44, AFS-213 (ADR-0038 §2): the hosts of a run that ended, in sets, from its view's
// summary (the designer's RunSummary), and where each one went wrong:
//
//   failed       ended badly: the outcome play failed it (an open fail port, a failed end) or a
//                failure nothing rescued (the run stopped there, or the host dropped out)
//   unreachable  Ansible dropped it as unreachable with no route
//   stopped      the run ended before the host reached an end (Stop, a pause nobody answered, the
//                server stopping, an approval rejected): neither failed nor at an end
//   handled      had a problem, but a wired fail port took it to an end that did not fail: the flow
//                handled it, so it went well (left out of not-ok unless asked for)
//   not-ok       failed + unreachable + stopped: what "the hosts that did not go well" are
//
// Hosts the run never reached are not in the summary, so they cannot be listed.
//
// Where a host went wrong is its earliest failing node: inside a subflow the inner step (a pause
// point works there), except in a rolling subflow, which is one play: the subflow itself.
import type { StepRequest } from '../launch/prepare';

/** The part of a flow's nodes this reads: titles, ends, subflows and their rolling setting. */
export interface FlowStep {
  id: string;
  key?: string;
  title?: string;
  type?: string;
  settings?: { rolling?: string | number } & Record<string, unknown>;
  subflow?: { nodes?: FlowStep[] };
}

interface Problem {
  task?: string;
  status?: string;
  msg?: string;
}

/** The part of a run's view this reads (the designer's RunView). */
export interface ViewOfHosts {
  summary?: {
    hosts?: string[];
    nodes?: Record<string, Record<string, string[]>>;
    outcome?: Record<string, string>;
    failures?: { host: string; node?: string; task?: string; msg?: string }[];
    unreachable?: string[];
    stoppedEarly?: boolean;
    timings?: Record<string, { start: number; end: number }>;
    problems?: Record<string, Record<string, Problem>>;
  };
  step?: { stopped?: { node?: string; hosts?: string[] } };
  stoppedAt?: string;
}

/** One host of a set, with the step it went wrong at (its id, as a pause point, and title). */
export interface HostAt {
  host: string;
  node?: string;
  title?: string;
  /** The task that failed, and Ansible's message, when the run says them. */
  task?: string;
  msg?: string;
}

export interface HostSets {
  /** The hosts the run reached. */
  total: number;
  failed: HostAt[];
  unreachable: HostAt[];
  stopped: HostAt[];
  handled: HostAt[];
  /** failed + unreachable + stopped, by name. */
  notOk: string[];
}

export const HOST_CHOICES = ['all', 'not-ok', 'failed', 'unreachable', 'stopped'] as const;
export type HostChoice = (typeof HOST_CHOICES)[number];

/** The steps of every level, each with the rolling subflow it runs in (the outermost one). */
function index(
  nodes: readonly FlowStep[],
  rolling?: string,
  out = new Map<string, { step: FlowStep; rolling?: string }>(),
) {
  for (const n of nodes) {
    out.set(n.id, { step: n, ...(rolling ? { rolling } : {}) });
    const inner = rolling ?? (n.subflow && n.settings?.rolling ? n.id : undefined);
    if (n.subflow?.nodes) index(n.subflow.nodes, inner, out);
  }
  return out;
}

/** Every step id of a flow, inner levels too (pause points are checked against these). */
export function stepIds(nodes: readonly FlowStep[]): Set<string> {
  return new Set(index(nodes).keys());
}

/**
 * The host sets of a run. `nodes`: the flow's nodes at the run's commit (titles, end nodes,
 * rolling subflows); without them steps are named by id and a stopped run counts every host that
 * did not fail as stopped. `stopped`: the run itself was stopped (its state is cancelled).
 */
export function hostSets(
  view: ViewOfHosts | undefined,
  nodes: readonly FlowStep[] = [],
  stopped = false,
): HostSets {
  const s = view?.summary ?? {};
  const hosts = s.hosts ?? [];
  const steps = index(nodes);
  /** The pause point for a step: the step, or the rolling subflow it is in. */
  const point = (id: string | undefined) => (id ? (steps.get(id)?.rolling ?? id) : undefined);
  const title = (id: string | undefined) => {
    const step = id ? steps.get(id)?.step : undefined;
    return step ? step.title || step.key : undefined;
  };
  const at = (host: string, node: string | undefined, p?: Problem): HostAt => {
    const where = point(node);
    const named = title(where);
    return {
      host,
      ...(where ? { node: where } : {}),
      ...(named ? { title: named } : {}),
      ...(p?.task ? { task: p.task } : {}),
      ...(p?.msg ? { msg: p.msg } : {}),
    };
  };
  /** The host's first problem (failed or unreachable, rescued or not), by when its step began. */
  const first = (host: string): { node: string; problem: Problem } | undefined => {
    const found = Object.entries(s.problems ?? {})
      .filter(([, byHost]) => byHost[host])
      .sort(([a], [b]) => (s.timings?.[a]?.start ?? 0) - (s.timings?.[b]?.start ?? 0))[0];
    return found ? { node: found[0], problem: found[1][host] as Problem } : undefined;
  };

  const unreachable = new Set(s.unreachable ?? []);
  const failed = new Map<string, HostAt>();
  for (const f of s.failures ?? [])
    if (!failed.has(f.host) && !unreachable.has(f.host)) {
      const p = first(f.host);
      failed.set(
        f.host,
        p ? at(f.host, p.node, p.problem) : at(f.host, f.node, { task: f.task, msg: f.msg }),
      );
    }
  for (const [host, why] of Object.entries(s.outcome ?? {}))
    if (!failed.has(host) && !unreachable.has(host)) {
      const p = first(host);
      failed.set(host, p ? at(host, p.node, p.problem) : { host, msg: why });
    }

  // Hosts that reached one of the flow's ends (top level), however they got there.
  const ends = nodes.filter((n) => n.type === 'end').map((n) => n.id);
  const atEnd = new Set<string>();
  for (const id of ends)
    for (const list of Object.values(s.nodes?.[id] ?? {})) for (const h of list) atEnd.add(h);
  const outcomeRan = !s.stoppedEarly && !stopped;
  const stoppedHosts = hosts.filter(
    (h) => !failed.has(h) && !unreachable.has(h) && (ends.length ? !atEnd.has(h) : !outcomeRan),
  );
  const bad = new Set([...failed.keys(), ...unreachable, ...stoppedHosts]);
  const stepStopped = view?.step?.stopped;
  return {
    total: hosts.length,
    failed: [...failed.values()],
    unreachable: [...unreachable].map((host) => {
      const p = first(host);
      return p ? at(host, p.node, p.problem) : { host };
    }),
    stopped: stoppedHosts.map((host) =>
      at(
        host,
        stepStopped?.node && (stepStopped.hosts ?? []).includes(host)
          ? stepStopped.node
          : view?.stoppedAt,
      ),
    ),
    handled: hosts
      .filter((h) => !bad.has(h))
      .flatMap((host) => {
        const p = first(host);
        return p ? [at(host, p.node, p.problem)] : [];
      }),
    notOk: [...bad],
  };
}

/** The hosts a choice takes, in the run's order; `includeHandled` adds the handled ones. */
export function chosenHosts(
  sets: HostSets,
  choice: Exclude<HostChoice, 'all'>,
  includeHandled = false,
): string[] {
  const names = (list: HostAt[]) => list.map((h) => h.host);
  const base =
    choice === 'not-ok'
      ? sets.notOk
      : choice === 'failed'
        ? names(sets.failed)
        : choice === 'unreachable'
          ? names(sets.unreachable)
          : names(sets.stopped);
  return [...new Set([...base, ...(includeHandled ? names(sets.handled) : [])])];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * AFS-213: how the hosts of a run went, in one line: "3 of 40 hosts did not go well: 2 failed at
 * Apply config, 1 unreachable"; "; 1 more had a failure the flow handled" when some were handled.
 * Undefined for a run whose hosts are not known.
 */
export function outcomeLine(sets: HostSets): string | undefined {
  if (!sets.total) return undefined;
  const n = sets.notOk.length;
  const handled = sets.handled.length
    ? `${n ? '; ' : ', '}${sets.handled.length} ${n ? 'more ' : ''}had a failure the flow handled`
    : '';
  if (n === 0)
    return `${sets.total === 1 ? 'The host' : `All ${sets.total} hosts`} went well${handled}`;
  const byStep = new Map<string, number>();
  for (const f of sets.failed) {
    const where = f.title ?? f.node ?? '';
    byStep.set(where, (byStep.get(where) ?? 0) + 1);
  }
  const parts = [...byStep].map(([where, c]) => `${c} failed${where ? ` at ${where}` : ''}`);
  if (sets.unreachable.length) parts.push(`${sets.unreachable.length} unreachable`);
  if (sets.stopped.length) {
    const before = sets.stopped[0]?.title;
    const same = sets.stopped.every((h) => h.title === before);
    parts.push(
      `${sets.stopped.length} stopped before the end${before && same ? ` (before ${before})` : ''}`,
    );
  }
  const head =
    n === sets.total
      ? `${n === 1 ? 'The host' : `All ${n} hosts`} did not go well`
      : `${n} of ${plural(sets.total, 'host')} did not go well`;
  return `${head}: ${parts.join(', ')}${handled}`;
}

/** At most this many hosts in a relaunch's limit file. */
export const MAX_LIMIT_HOSTS = 5000;

const BACKSLASH = String.fromCharCode(92);
/**
 * One line of a limit file (`--limit @file`) for one host name. Ansible reads each line as one
 * pattern, never split on `,` or `:`; but a pattern with `[ ] * ?` is matched as a wildcard, and a
 * leading `! & ~ @` means exclude, intersect, regex or file (a host named `!x` would make every
 * host of the inventory run). Those names, and names with outer spaces, become an anchored regex
 * with ASCII punctuation escaped; every other name is written as it is, so `localhost` and plain
 * names match as Ansible matches them on the command line.
 */
export function limitLine(name: string): string {
  const plain = !/[[\]*?]/.test(name) && !/^[!&~@]/.test(name) && name.trim() === name;
  if (plain) return name;
  const escaped = name.replace(/[^A-Za-z0-9_]/g, (c) =>
    c.charCodeAt(0) < 128 ? BACKSLASH + c : c,
  );
  return `~^${escaped}$`;
}

/** The text of a limit file: one line per host. */
export const limitFile = (hosts: readonly string[]): string =>
  `${hosts.map(limitLine).join('\n')}\n`;

/** AFS-240: the body of POST /runs/:id/relaunch (relaunch.ts); `{}` is 1.1's Run again. */
export interface RelaunchBody {
  /** Which hosts: all (default), a set of the run's, or names (each a host of the run). */
  hosts?: HostChoice | string[];
  /** Add the hosts whose failure the flow handled through a wired fail port. */
  includeHandled?: boolean;
  /** Default: the run's mode. */
  mode?: 'check' | 'real';
  /** null: not step by step; absent: as the run was asked. */
  step?: StepRequest | null;
  /** The run's commit (default), or the newest of its branch. */
  commit?: 'same' | 'newest';
}

/** What GET /runs/:id/relaunch answers. */
export interface RelaunchOffer {
  /** How the hosts went: absent for a run that reached no host (or never ran). */
  sets?: HostSets;
  /** "3 of 40 hosts did not go well: 2 failed at Apply config, 1 unreachable". */
  line?: string;
  /** What a host limit changes in this flow (steps on other hosts, run_once, percentages). */
  risks: string[];
  /** The flow's approvals, by title: a run again asks each again. */
  approvals: string[];
}
