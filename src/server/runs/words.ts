// AFS-147: how a run that ended says why, in plain words: hosts that failed and at which step,
// targets the inventory does not have, a limit that leaves no host, who stopped it and where.
import type { RunView } from '@ansible-flow/core/protocol';

/** Ansible's warning for a target the inventory does not have: the target, or undefined. */
const SKIPPED = /Could not match supplied host pattern, ignoring: (.+?)\s*$/;
/** Ansible's error when the inventory, the targets and the limit leave no host. */
export const NO_HOSTS = /leaves us with no hosts to target/i;

export function skippedTarget(line: string): string | undefined {
  return SKIPPED.exec(line)?.[1]?.trim() || undefined;
}

interface Titled {
  id: string;
  title?: string;
  key?: string;
  subflow?: { nodes?: Titled[] };
}

/** A step's title by its id, inner levels too. */
export function titleOf(nodes: readonly Titled[], id: string | undefined): string | undefined {
  if (!id) return undefined;
  for (const n of nodes) {
    if (n.id === id) return n.title || n.key;
    const inner = titleOf(n.subflow?.nodes ?? [], id);
    if (inner) return inner;
  }
  return undefined;
}

/**
 * AFS-205: a step by its path from the top level: "Pre-checks › Read device status" for a step
 * inside a subflow (a pause there says where it is); undefined when the flow does not have it.
 */
export function pathOf(nodes: readonly Titled[], id: string | undefined): string | undefined {
  if (!id) return undefined;
  for (const n of nodes) {
    if (n.id === id) return n.title || n.key;
    const inner = pathOf(n.subflow?.nodes ?? [], id);
    if (inner) return `${n.title || n.key} › ${inner}`;
  }
  return undefined;
}

/**
 * AFS-205: a step-by-step run's own lines in its output, in the pages' words. The designer before
 * 1.1.0 wrote "AFD: paused before [key] Title (2 host(s)); waiting for the driver"; later ones
 * write the plain line themselves. Other lines are returned as they are.
 */
export function plainStepLine(text: string): string {
  const paused =
    /AFD: paused before (?:\[[^\]]*\]\s*)?(.*) \((\d+) host\(s\)\); waiting for the driver/.exec(
      text,
    );
  if (paused) {
    const n = Number(paused[2]);
    return `Paused before ${paused[1]}: ${n === 1 ? '1 host waits' : `${n} hosts wait`} for Step, Continue or Stop`;
  }
  const timeout = /AFD: nobody answered within (\d+) s; the run stops/.exec(text);
  if (timeout) return `Nobody answered the pause for ${timeout[1]} s: the run stops here`;
  return text;
}

const list = (names: readonly string[]) =>
  names.length > 5
    ? `${names.slice(0, 5).join(', ')} and ${names.length - 5} more`
    : names.join(', ');

/** Why a run reached no host: the limit, the targets the inventory lacks, or an empty inventory. */
export function noHostWhy(run: {
  targets: readonly string[];
  limit?: string | undefined;
  inventory?: string | undefined;
  skipped?: readonly string[];
}): string {
  const inventory = run.inventory ? `the inventory ${run.inventory}` : 'the inventory';
  const skipped = run.skipped ?? [];
  if (run.limit && skipped.length < run.targets.length)
    return `No host ran: the limit ${run.limit} matched none of the targets (${list(run.targets)}) in ${inventory}`;
  if (!run.targets.length) return 'No host ran: the flow has no targets';
  return `No host ran: none of the targets (${list(run.targets)}) is in ${inventory}`;
}

/** AFS-167: what ansible-playbook's exit codes mean. */
export const EXIT_CODES: Readonly<Record<number, string>> = {
  1: 'Ansible stopped on an error',
  2: 'One or more hosts failed',
  3: 'One or more hosts could not be reached',
  4: 'Ansible could not read the playbook or the inventory, or found no host to run on',
  5: 'Ansible was given options it does not accept',
  99: 'The run was interrupted',
  250: 'Ansible stopped on an unexpected error',
};

/**
 * AFS-167: "One or more hosts could not be reached: fatal: [sw-edge-01]: UNREACHABLE! (Ansible
 * ended with code 3)". The meaning of the code, and Ansible's last error line, which names the
 * host or the file, when there is one.
 */
export function exitWords(rc: number | undefined, error?: string): string {
  const said = error?.replace(/^(ERROR!|\[?error\]?:?)\s*/i, '').trim();
  const code =
    rc === undefined ? 'Ansible ended without an exit code' : `Ansible ended with code ${rc}`;
  const meaning = rc === undefined ? undefined : EXIT_CODES[rc];
  if (!meaning) return said ? `${code}: ${said}` : code;
  return `${meaning}${said ? `: ${said}` : ''} (${code})`;
}

/**
 * AFS-170: " (Ansible ended with code 2: one or more hosts failed)", after the hosts that failed;
 * nothing without a code.
 */
function codeAfter(rc: number | undefined, unreachable = false): string {
  if (rc === undefined) return '';
  // Ansible ends with 4 when hosts could not be reached, too, and with 2 when the flow's outcome
  // play failed them for it (AFS-256): that is what it meant here.
  const meaning = unreachable && (rc === 4 || rc === 2) ? EXIT_CODES[3] : EXIT_CODES[rc];
  const lower = meaning?.startsWith('Ansible ')
    ? meaning
    : meaning && `${meaning.charAt(0).toLowerCase()}${meaning.slice(1)}`;
  const words = lower ? `: ${lower}` : '';
  return ` (Ansible ended with code ${rc}${words})`;
}

/**
 * "1 of 4 hosts failed at Pre-checks (Ansible ended with code 2: one or more hosts failed)": a run
 * whose hosts failed, in words.
 */
export function failedWhy(
  view: RunView,
  nodes: readonly Titled[],
  rc: number | undefined,
  error?: string,
): string {
  const s = view.summary;
  const code = exitWords(rc, error);
  if (!s) return code;
  const failed = new Set([
    ...Object.keys(s.outcome),
    ...s.failures.map((f) => f.host),
    ...s.unreachable,
  ]);
  if (!failed.size) return code;
  // AFS-256: a host the outcome play failed because Ansible could not reach it (an unreachable
  // port that is not enabled) was not reached: its problems say UNREACHABLE and nothing else.
  const problemsOf = (host: string) =>
    Object.values(s.problems ?? {}).flatMap((byHost) => (byHost[host] ? [byHost[host]] : []));
  const unreachable = new Set(
    [...failed].filter(
      (h) =>
        s.unreachable.includes(h) ||
        (!s.failures.some((f) => f.host === h) &&
          problemsOf(h).length > 0 &&
          problemsOf(h).every((p) => p.status === 'unreachable')),
    ),
  );
  const failedOnly = new Set([...failed].filter((h) => !unreachable.has(h)));
  const steps = [
    ...new Set(
      [
        ...s.failures.filter((f) => failedOnly.has(f.host)).map((f) => f.node),
        // A problem a step rescued into a port counts where the host then failed.
        ...Object.entries(s.problems ?? {})
          .filter(([, hosts]) => Object.keys(hosts).some((h) => failedOnly.has(h)))
          .map(([node]) => node),
      ]
        .map((id) => titleOf(nodes, id))
        .filter((t): t is string => !!t),
    ),
  ];
  const total = Math.max(s.hosts.length, failed.size);
  const of = (n: number) => `${n} of ${total} ${total === 1 ? 'host' : 'hosts'}`;
  const at = steps.length ? ` at ${list(steps)}` : '';
  // Only unreachable hosts: that, with their names, says more than "failed".
  if (!failedOnly.size)
    return `${of(unreachable.size)} could not be reached: ${list([...unreachable])}${codeAfter(rc, true)}`;
  const notReached = unreachable.size
    ? `, ${unreachable.size} could not be reached (${list([...unreachable])})`
    : '';
  return `${of(failedOnly.size)} failed${at}${notReached}${codeAfter(rc)}`;
}

/** "Stopped by Dana Whitfield during Upgrade", from the worker's "Stopped on request …". */
export function stoppedBy(error: string | undefined, who: string | undefined): string | undefined {
  if (!who || !error?.startsWith('Stopped on request')) return error;
  return `Stopped by ${who}${error.slice('Stopped on request'.length)}`;
}

/**
 * AFS-153: a run's state in the words the pages use (went well, stopped), for whatever tells it
 * outside a page: search, mails, messages.
 */
export const STATE_WORDS: Record<string, string> = {
  queued: 'queued',
  running: 'running',
  waiting: 'waiting for a decision',
  succeeded: 'went well',
  failed: 'failed',
  cancelled: 'stopped',
  lost: 'lost',
};

/** A state in words; an unknown one as it is. */
export const stateWord = (state: string): string => STATE_WORDS[state] ?? state;
