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
  /** AFS-105: how many hosts it ran on and how many failed, once it went. */
  hosts?: { total: number; failed: number };
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
    ok: run.state === 'succeeded' || (run.state === 'failed' && (run.hosts?.failed ?? 0) > 0),
    hosts: run.hosts?.total ?? 0,
    failed: run.hosts?.failed ?? 0,
    flowVersion: run.flow.version,
    ...(going(run.state) ? { running: true } : {}),
    // AFS-147: how one that did not finish ended, in the list's word (a designer after 1.0.1-rc.7).
    ...(ENDED[run.state] ? { ended: ENDED[run.state] } : {}),
  }) as PastRun;
const ENDED: Record<string, string> = { cancelled: 'stopped', lost: 'lost', failed: 'failed' };

/**
 * AFS-139: where a run of the server ran, for the designer's Run panel (a run on Ansible Flow
 * Server with its number), not a local run of the designer's own.
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
});
