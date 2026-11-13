// Keeps the projects' repositories and what the server knows about them in step: when someone
// asks, when the source says it changed (a push hook), on a timer for sources that say nothing,
// and after a push through the server.
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
  /** What is done to a project's repository is done one thing after another. */
  private readonly queue = new Map<string, Promise<unknown>>();
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;

  constructor(
    private readonly db: Kysely<Schema>,
    private readonly git: Git,
    private readonly log: Logger,
  ) {}

  /**
   * Runs `work` when nothing else is changing the project's repository, and keeps everything
   * else out until it is done: a push and a fetch from the source never interleave.
   */
  exclusive<T>(projectId: string, work: () => Promise<T>): Promise<T> {
    const before = this.queue.get(projectId) ?? Promise.resolve();
    const run = before.catch(() => undefined).then(work);
    const tail = run.catch(() => undefined);
    this.queue.set(projectId, tail);
    void tail.then(() => {
      if (this.queue.get(projectId) === tail) this.queue.delete(projectId);
    });
    return run;
  }

  /**
   * Looks at the project's source now (for a project the server hosts: at its own repository).
   * Resolves with the project as it stands afterwards (its commit, or why it failed); undefined
   * when there is no such project. Never rejects for a source that cannot be reached: that is
   * the project's state, not an error of the server.
   */
  sync(projectId: string): Promise<Project | undefined> {
    const running = this.going.get(projectId);
    if (running) return running;
    const run = this.exclusive(projectId, () => this.refresh(projectId)).finally(() =>
      this.going.delete(projectId),
    );
    this.going.set(projectId, run);
    return run;
  }

  /** What `sync` does, for a caller that already holds the project (`exclusive`). */
  async refresh(projectId: string): Promise<Project | undefined> {
    const project = await getProject(this.db, projectId);
    if (!project) return undefined;
    try {
      await this.git.ensure(project.id, project.gitRef);
      if (project.gitUrl) await this.git.fetch(project.id, project.gitUrl);
      // A hosted project nobody has pushed to yet is not a failure: it has nothing to run.
      else if (!(await this.git.branches(project.id)).length) return project;
      const commit = await this.git.resolve(project.id, project.gitRef);
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

  /**
   * Takes a deleted project's repository away. A mirror is removed: its source has everything.
   * A hosted project's repository is the only copy, so it is put aside (`repos/deleted`), not
   * removed.
   */
  async forget(projectId: string, hosted = false): Promise<void> {
    await this.exclusive(projectId, async () => {
      try {
        if (hosted) {
          const kept = await this.git.retire(projectId);
          if (kept) this.log.info({ kept }, 'The deleted project had the only copy: kept aside');
        } else await rm(this.git.mirror(projectId), { recursive: true, force: true });
      } catch (e) {
        this.log.warn({ err: e }, 'A project repository could not be removed');
      }
    });
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

  /** Stops the timer and waits for what is going. */
  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await Promise.allSettled([...this.going.values(), ...this.queue.values()]);
  }
}
