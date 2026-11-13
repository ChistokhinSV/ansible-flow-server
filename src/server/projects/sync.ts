// Keeps the projects' mirrors up to date: when someone asks, when the source says it changed (a
// push hook), and on a timer for sources that say nothing.
import { rm } from 'node:fs/promises';
import type { Kysely } from 'kysely';
import type { Schema } from '../db/schema';
import type { Logger } from '../log';
import { type Git, GitError } from './git';
import { dueProjects, getProject, type Project, recordSync } from './store';

/** How often the timer looks for projects that are due. */
const TICK_MS = 15_000;

export class ProjectSync {
  /** One look at a time per project: a second asker waits for the first's answer. */
  private readonly going = new Map<string, Promise<Project | undefined>>();
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;

  constructor(
    private readonly db: Kysely<Schema>,
    private readonly git: Git,
    private readonly log: Logger,
  ) {}

  /**
   * Looks at the project's source now. Resolves with the project as it stands afterwards (its
   * commit, or why it failed); undefined when there is no such project. Never rejects for a
   * source that cannot be reached: that is the project's state, not an error of the server.
   */
  sync(projectId: string): Promise<Project | undefined> {
    const running = this.going.get(projectId);
    if (running) return running;
    const run = this.once(projectId).finally(() => this.going.delete(projectId));
    this.going.set(projectId, run);
    return run;
  }

  private async once(projectId: string): Promise<Project | undefined> {
    const project = await getProject(this.db, projectId);
    if (!project) return undefined;
    try {
      const commit = await this.git.sync(project.id, project.gitUrl, project.gitRef);
      await recordSync(this.db, project.id, { commit });
      if (commit !== project.commit)
        this.log.info(
          { project: project.key, branch: project.gitRef, commit: commit.slice(0, 12) },
          'Project is at a new commit',
        );
    } catch (e) {
      if (!(e instanceof GitError)) throw e;
      await recordSync(this.db, project.id, { error: e.message });
      // The first failure is worth a line; the same failure every few minutes is not.
      if (project.sync.error !== e.message)
        this.log.warn(
          { project: project.key, why: e.message, detail: e.detail.slice(0, 400) },
          'Project source could not be read',
        );
    }
    return getProject(this.db, projectId);
  }

  /** Removes a project's mirror (after the project is deleted). */
  async forget(projectId: string): Promise<void> {
    await this.going.get(projectId)?.catch(() => undefined);
    await rm(this.git.mirror(projectId), { recursive: true, force: true }).catch((e) =>
      this.log.warn({ err: e }, 'A project mirror could not be removed'),
    );
  }

  /** Looks at every project that is due, one after another. */
  async tick(at = new Date()): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    try {
      const due = await dueProjects(this.db, at);
      for (const project of due) await this.sync(project.id);
      return due.length;
    } catch (e) {
      this.log.error({ err: e }, 'Looking for projects to bring up to date failed');
      return 0;
    } finally {
      this.ticking = false;
    }
  }

  start(): void {
    this.timer ??= setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
    void this.tick();
  }

  /** Stops the timer and waits for the looks that are going. */
  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await Promise.allSettled([...this.going.values()]);
  }
}
