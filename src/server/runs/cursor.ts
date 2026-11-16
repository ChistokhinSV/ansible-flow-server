// Where a page of runs ends, and the newest run of a thing: words shared with the pages (which
// must not load the server's code).

/**
 * The newest run of a launch configuration or of a flow, among those the person asking may see:
 * enough to say how it went and to open it.
 */
export interface LastRun {
  id: string;
  number: number;
  state: string;
  createdAt: string;
  endedAt?: string;
}

/** Where a list of runs goes on after a run: the three things the list is ordered by. */
export interface RunCursor {
  createdAt: string;
  number: number;
  id: string;
}

/**
 * What `before` takes to ask for the runs after this one in the list: `createdAt,number,id`.
 * A time alone cannot say where a page ended when several runs were made in the same
 * millisecond; the run's number and id settle it.
 */
export const runCursor = (run: RunCursor): string => `${run.createdAt},${run.number},${run.id}`;

/**
 * Reads `before`: a plain time (runs made before it, as it always was), or a cursor made by
 * `runCursor`, which has `run` too: the run the page ended at. Undefined: neither.
 */
export function readBefore(
  before: string,
): { createdAt: string; run?: { number: number; id: string } } | undefined {
  const parts = before.split(',');
  if (parts.length === 1) return { createdAt: before };
  const [createdAt, number, id] = parts;
  if (parts.length !== 3 || !createdAt || !id || !/^\d+$/.test(number ?? '')) return undefined;
  return { createdAt, run: { number: Number(number), id } };
}
