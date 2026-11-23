// AFS-179 (ADR-0038 §1): what the debugger looked at in a debug run's pauses, kept with the run.
// The run's answers to `scopes` and `watch` (masked by the engine before they left the run) are
// kept per pause, at most 1 MB per run, and go with the run (retention, a project deleted). A run
// that ended can then show what its pauses held.

import { randomUUID } from 'node:crypto';
import type { InspectAnswer } from '@ansible-flow/core/run/step';
import type { Kysely } from 'kysely';
import type { Schema } from '../db/schema';

/** At most this much kept per run (the answers' JSON). */
export const MAX_DEBUG_BYTES = 1024 * 1024;

/** The ops whose answers are kept. */
export const KEPT_OPS = ['scopes', 'watch'] as const;

export interface DebugEntry {
  op: (typeof KEPT_OPS)[number];
  host?: string;
  exprs?: string[];
  answer: InspectAnswer;
  at: string;
}

export interface DebugPause {
  pause: string;
  node: string;
  /** The step's play ("[key] Title"). */
  play?: string;
  entries: DebugEntry[];
}

/**
 * Keeps an answer of a pause (one per op, host and expressions: a later one replaces it); false
 * when the run's 1 MB is used up (nothing more is kept).
 */
export async function keepDebug(
  db: Kysely<Schema>,
  run: string,
  at: { pause: string; node: string; play?: string },
  entry: Omit<DebugEntry, 'at'>,
  now = new Date(),
): Promise<boolean> {
  const answerJson = JSON.stringify(entry.answer);
  const key = `${entry.op}|${entry.host ?? ''}|${JSON.stringify(entry.exprs ?? [])}`;
  const size = Buffer.byteLength(answerJson);
  const same = await db
    .selectFrom('run_debug')
    .select(['id', 'size'])
    .where('run_id', '=', run)
    .where('pause_id', '=', at.pause)
    .where('entry_key', '=', key)
    .executeTakeFirst();
  const used = await db
    .selectFrom('run_debug')
    .select((eb) => eb.fn.sum<number | string | null>('size').as('total'))
    .where('run_id', '=', run)
    .executeTakeFirst();
  const total = Number(used?.total ?? 0) - (same?.size ?? 0);
  if (total + size > MAX_DEBUG_BYTES) return false;
  if (same) await db.deleteFrom('run_debug').where('id', '=', same.id).execute();
  await db
    .insertInto('run_debug')
    .values({
      id: randomUUID(),
      run_id: run,
      pause_id: at.pause,
      node: at.node,
      play: at.play ?? null,
      entry_key: key,
      op: entry.op,
      host: entry.host ?? null,
      exprs_json: entry.exprs ? JSON.stringify(entry.exprs) : null,
      answer_json: answerJson,
      size,
      created_at: now.toISOString(),
    })
    .execute();
  return true;
}

/** What a run's pauses showed, pause by pause in the order they came. */
export async function debugKept(db: Kysely<Schema>, run: string): Promise<DebugPause[]> {
  const rows = await db
    .selectFrom('run_debug')
    .selectAll()
    .where('run_id', '=', run)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  const pauses = new Map<string, DebugPause>();
  for (const row of rows) {
    let pause = pauses.get(row.pause_id);
    if (!pause) {
      pause = {
        pause: row.pause_id,
        node: row.node,
        ...(row.play ? { play: row.play } : {}),
        entries: [],
      };
      pauses.set(row.pause_id, pause);
    }
    pause.entries.push({
      op: row.op as DebugEntry['op'],
      ...(row.host ? { host: row.host } : {}),
      ...(row.exprs_json ? { exprs: JSON.parse(row.exprs_json) as string[] } : {}),
      answer: JSON.parse(row.answer_json) as InspectAnswer,
      at: row.created_at,
    });
  }
  return [...pauses.values()];
}

/** Removes what a run's pauses kept (the run goes). */
export async function dropDebug(db: Kysely<Schema>, runs: string[]): Promise<void> {
  if (runs.length) await db.deleteFrom('run_debug').where('run_id', 'in', runs).execute();
}
