// The flow's runs as the designer's Run panel gets them on a page of the server (viewer.ts).
import type { PastRun } from '@ansible-flow/core/run/pastRuns';

/** A run as the designer's run list shows it. */
export interface RunRecord {
  id: string;
  number?: number;
  mode: 'check' | 'real';
  state: string;
  createdAt: string;
  startedAt?: string;
  commit?: string;
  config?: { id: string; name: string };
  flow: { version: number };
  /** AFS-189: the inputs it was given, as anyone may see them (a secret one as ***). */
  inputs?: Record<string, unknown>;
  /** AFS-105: how many hosts it ran on and how many failed, once it went. */
  hosts?: { total: number; failed: number };
  /** AFS-193: a failed run whose approval was decided against. */
  decidedAgainst?: 'rejected' | 'timed out';
}
/** AFS-139: a run that has not ended yet. */
export const going = (state: string | undefined): boolean =>
  state === 'queued' || state === 'running' || state === 'waiting';
/**
 * AFS-105: "ok" is the designer's "the run itself finished": a run that failed because hosts
 * failed did finish (its list line says how many); one stopped, lost or broken did not.
 * AFS-139: one still going says so (`running`, a designer after 1.0.1-rc.6), not "did not finish".
 */
export const pastRunOf = (run: RunRecord): PastRun =>
  ({
    id: run.id,
    mode: run.mode,
    startedAt: run.startedAt ?? run.createdAt,
    // AFS-193: a rejected run reads "rejected" in the list, not "1 host, 1 failed".
    ok:
      run.state === 'succeeded' ||
      (run.state === 'failed' && !run.decidedAgainst && (run.hosts?.failed ?? 0) > 0),
    hosts: run.hosts?.total ?? 0,
    failed: run.hosts?.failed ?? 0,
    flowVersion: run.flow.version,
    ...(going(run.state) ? { running: true } : {}),
    // AFS-147: how one that did not finish ended, in the list's word (a designer after 1.0.1-rc.7).
    ...(run.state === 'failed' && run.decidedAgainst
      ? { ended: run.decidedAgainst === 'rejected' ? 'rejected' : 'not decided in time' }
      : ENDED[run.state]
        ? { ended: ENDED[run.state] }
        : {}),
  }) as PastRun;
const ENDED: Record<string, string> = { cancelled: 'stopped', lost: 'lost', failed: 'failed' };

/**
 * AFS-139: where a run of the server ran, for the designer's Run panel (a run on Ansible Flow
 * Server with its number), not a local run of the designer's own; and the inputs it was given.
 */
export const runnerOf = (run: RunRecord) => ({
  source: 'runner' as const,
  runner: {
    runId: run.id,
    number: run.number ?? 0,
    url: `/runs/${encodeURIComponent(run.id)}`,
    state: run.state,
    commit: run.commit ?? '',
    config: run.config?.name ?? '',
  },
  // AFS-189: "In this run" on a flow input a step reads directly (a designer after 1.0.2-rc.3
  // reads it; an older one ignores it).
  ...(run.inputs ? { flowInputs: run.inputs } : {}),
});

/**
 * AFS-185: the question Stop asks for a real run (a check run changes nothing, and stops at
 * once): which run, and what stopping it does where it is now.
 */
export function stopQuestion(run: {
  number?: number;
  flowName?: string;
  state: string;
  step?: string;
}): string {
  const which = `real run${run.number ? ` #${run.number}` : ''}${run.flowName ? ` of ${run.flowName}` : ''}`;
  if (run.state === 'waiting')
    return `Stop ${which}? It waits for approval: nobody decides it after this, and its hosts go no further.`;
  if (run.state === 'queued') return `Stop ${which}? It has not started: it will not run.`;
  const at = run.step ? `${run.step} is cut off` : 'The step in progress is cut off';
  return `Stop ${which}? ${at}, and its hosts go no further.`;
}

/** AFS-185: a step's title by its id, at any level of the flow. */
export function stepTitle(doc: unknown, id: string | undefined): string | undefined {
  if (!id) return undefined;
  type Node = { id: string; title?: string; subflow?: { nodes?: Node[] } };
  const find = (nodes: Node[] | undefined): string | undefined => {
    for (const n of nodes ?? []) {
      if (n.id === id) return n.title;
      const inner = find(n.subflow?.nodes);
      if (inner) return inner;
    }
    return undefined;
  };
  return find((doc as { nodes?: Node[] } | undefined)?.nodes);
}
