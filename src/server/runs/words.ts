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

/** "1 of 4 hosts failed at Pre-checks": a run whose hosts failed, in words. */
export function failedWhy(view: RunView, nodes: readonly Titled[], rc: number | undefined): string {
  const s = view.summary;
  const code = `Ansible ended with code ${rc ?? 'unknown'}`;
  if (!s) return code;
  const failed = new Set([
    ...Object.keys(s.outcome),
    ...s.failures.map((f) => f.host),
    ...s.unreachable,
  ]);
  if (!failed.size) return code;
  const steps = [
    ...new Set(
      [
        ...s.failures.map((f) => f.node),
        // A problem a step rescued into a port counts where the host then failed.
        ...Object.entries(s.problems ?? {})
          .filter(([, hosts]) => Object.keys(hosts).some((h) => failed.has(h)))
          .map(([node]) => node),
      ]
        .map((id) => titleOf(nodes, id))
        .filter((t): t is string => !!t),
    ),
  ];
  const total = Math.max(s.hosts.length, failed.size);
  const at = steps.length ? ` at ${list(steps)}` : '';
  return `${failed.size} of ${total} ${total === 1 ? 'host' : 'hosts'} failed${at}`;
}

/** "Stopped by Dana Whitfield during Upgrade", from the worker's "Stopped on request …". */
export function stoppedBy(error: string | undefined, who: string | undefined): string | undefined {
  if (!who || !error?.startsWith('Stopped on request')) return error;
  return `Stopped by ${who}${error.slice('Stopped on request'.length)}`;
}
