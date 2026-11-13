// How long ended runs are kept: a run older than `days`, or beyond the newest `perFlow` ended
// runs of its flow in its project, goes, with its output and the designer's run folder. Runs
// that are going are never removed.
import { rm } from 'node:fs/promises';
import type { Kysely } from 'kysely';
import type { Schema } from '../db/schema';
import { ACTIVE } from './queue';

export interface Retention {
  /** Ended runs older than this many days go. */
  days: number;
  /** Of one flow in one project, at most this many ended runs stay. */
  perFlow: number;
}

/**
 * Removes the runs past their keeping. `outputFile` says where a run's output is. Resolves with
 * how many runs went.
 */
export async function pruneRuns(
  db: Kysely<Schema>,
  keep: Retention,
  outputFile: (runId: string) => string,
  now = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - keep.days * 24 * 60 * 60 * 1000).toISOString();
  const ended = await db
    .selectFrom('run')
    .select(['id', 'project_id', 'flow_file', 'created_at', 'run_dir', 'segments_json'])
    .where('state', 'not in', [...ACTIVE])
    .orderBy('created_at', 'desc')
    .execute();
  const seen = new Map<string, number>();
  const gone: { id: string; run_dir: string | null; segments_json: string | null }[] = [];
  for (const run of ended) {
    const flow = `${run.project_id}\u0000${run.flow_file}`;
    const rank = (seen.get(flow) ?? 0) + 1;
    seen.set(flow, rank);
    if (run.created_at < cutoff || rank > keep.perFlow) gone.push(run);
  }
  for (const run of gone) {
    await db.deleteFrom('run').where('id', '=', run.id).execute();
    await rm(outputFile(run.id), { force: true }).catch(() => undefined);
    // A run of a flow with approvals has a folder per segment, and its gates (AFS-28).
    const dirs = new Set([
      ...(run.run_dir ? [run.run_dir] : []),
      ...((run.segments_json ? JSON.parse(run.segments_json) : []) as { dir: string }[]).map(
        (s) => s.dir,
      ),
    ]);
    for (const dir of dirs) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    await db.deleteFrom('run_gate').where('run_id', '=', run.id).execute();
  }
  return gone.length;
}
