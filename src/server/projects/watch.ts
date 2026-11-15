// AFS-75: tells whoever watches a project when its branch moves to another commit: a push through
// the server, a look at the source (timer, request, push hook), later a save from the pages. The
// commit is read from the database, so a move made by another server on the same database is
// seen too; one timer looks at every watched project in one query.
import type { Kysely } from 'kysely';
import type { Schema } from '../db/schema';
import type { Logger } from '../log';

/** How often the watched projects' commits are read. */
const LOOK_MS = 2_000;

export type Moved = (move: { from?: string; to: string }) => void;

export class ProjectWatch {
  private readonly watchers = new Map<string, Set<Moved>>();
  private readonly commits = new Map<string, string | undefined>();
  private timer: NodeJS.Timeout | undefined;
  private looking = false;

  constructor(
    private readonly db: Kysely<Schema>,
    private readonly log: Logger,
    private readonly everyMs = LOOK_MS,
  ) {}

  /** Calls `moved` each time the project's commit changes; the answer stops it. */
  async watch(projectId: string, moved: Moved): Promise<() => void> {
    let set = this.watchers.get(projectId);
    if (!set) {
      set = new Set();
      this.watchers.set(projectId, set);
      this.commits.set(projectId, await this.commitOf(projectId));
    }
    set.add(moved);
    this.timer ??= setInterval(() => void this.look(), this.everyMs);
    this.timer.unref();
    return () => {
      const watching = this.watchers.get(projectId);
      watching?.delete(moved);
      if (watching?.size === 0) {
        this.watchers.delete(projectId);
        this.commits.delete(projectId);
      }
      if (!this.watchers.size) this.stop();
    };
  }

  /** Reads the watched projects' commits now and tells of each move (also for tests). */
  async look(): Promise<void> {
    if (this.looking || !this.watchers.size) return;
    this.looking = true;
    try {
      const rows = await this.db
        .selectFrom('project')
        .select(['id', 'commit_id'])
        .where('id', 'in', [...this.watchers.keys()])
        .execute();
      for (const row of rows) {
        const before = this.commits.get(row.id);
        const now = row.commit_id ?? undefined;
        if (!now || now === before) continue;
        this.commits.set(row.id, now);
        for (const moved of this.watchers.get(row.id) ?? []) {
          try {
            moved({ ...(before ? { from: before } : {}), to: now });
          } catch (e) {
            this.log.warn({ err: e }, 'A project watcher failed');
          }
        }
      }
    } catch (e) {
      this.log.warn({ err: e }, 'Looking at the watched projects failed');
    } finally {
      this.looking = false;
    }
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private async commitOf(projectId: string): Promise<string | undefined> {
    const row = await this.db
      .selectFrom('project')
      .select('commit_id')
      .where('id', '=', projectId)
      .executeTakeFirst();
    return row?.commit_id ?? undefined;
  }
}
