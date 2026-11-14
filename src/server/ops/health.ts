// What /readyz says (AFS-37): whether the server can do its work, check by check. Unavailable
// (503) when it cannot keep anything: the database does not answer or the data folder cannot be
// written. Degraded (200) when it serves but something waits: no container engine (runs stay
// queued) or little disk space left. Paths and host names stay in the log, not in the answer.
import { randomBytes } from 'node:crypto';
import { rm, statfs, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type CheckState = 'ok' | 'warn' | 'fail';

export interface Readiness {
  status: 'ready' | 'degraded' | 'unavailable';
  database: string;
  checks: {
    database: { state: CheckState };
    data?: { state: CheckState; freeBytes?: number };
    engine?: { state: CheckState; engine: string };
  };
}

export interface ReadinessDeps {
  database: { kind: string; ping(): Promise<void> };
  /** The data folder; without it (tests) it is not checked. */
  dataDir?: string;
  /** The engine runs use now; undefined: none answers. Without the function: not checked. */
  engine?: () => string | undefined;
  /** Below this much free space the server is degraded (AFS_MIN_FREE_MB). */
  minFreeBytes?: number;
  log?: { error(o: object, m: string): void; warn(o: object, m: string): void };
}

export async function readiness(d: ReadinessDeps): Promise<Readiness> {
  const checks: Readiness['checks'] = { database: { state: 'ok' } };
  try {
    await d.database.ping();
  } catch (e) {
    d.log?.error({ err: e }, 'The database does not answer');
    checks.database.state = 'fail';
  }
  if (d.dataDir) {
    const probe = join(d.dataDir, `.ready-${randomBytes(4).toString('hex')}`);
    try {
      await writeFile(probe, 'ok');
      await rm(probe, { force: true });
      const fs = await statfs(d.dataDir);
      const freeBytes = Number(fs.bavail) * Number(fs.bsize);
      const low = freeBytes < (d.minFreeBytes ?? 1024 * 1024 * 1024);
      if (low) d.log?.warn({ folder: d.dataDir, freeBytes }, 'Little disk space left for the data');
      checks.data = { state: low ? 'warn' : 'ok', freeBytes };
    } catch (e) {
      d.log?.error({ err: e, folder: d.dataDir }, 'The data folder cannot be written');
      checks.data = { state: 'fail' };
    }
  }
  if (d.engine) {
    const engine = d.engine();
    checks.engine = engine ? { state: 'ok', engine } : { state: 'warn', engine: 'none' };
  }
  const states = Object.values(checks).map((c) => c.state);
  return {
    status: states.includes('fail')
      ? 'unavailable'
      : states.includes('warn')
        ? 'degraded'
        : 'ready',
    database: d.database.kind,
    checks,
  };
}
