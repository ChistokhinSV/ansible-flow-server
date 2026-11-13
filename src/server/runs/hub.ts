// What a run going on this server says while it goes: the designer's view of it (about twice a
// second) and its output, line by line. Whoever watches the run (a page, a script) hears it here
// at once; what is kept for later is in the run's record and its output file.
import type { RunView } from '@ansible-flow/core/protocol';

export type RunNews =
  | { kind: 'view'; view: RunView }
  | { kind: 'output'; text: string }
  /** The run's record changed (it started, ended, was asked to stop). */
  | { kind: 'state' };

type Listener = (news: RunNews) => void;

export class RunHub {
  private readonly listeners = new Map<string, Set<Listener>>();
  /** The last view of each run that is going here. */
  private readonly views = new Map<string, RunView>();

  publish(runId: string, news: RunNews): void {
    if (news.kind === 'view') this.views.set(runId, news.view);
    for (const listener of this.listeners.get(runId) ?? []) {
      try {
        listener(news);
      } catch {
        // One watcher that fails does not stop the others or the run.
      }
    }
  }

  /** Hears what the run says from now on; gives what stops hearing. */
  subscribe(runId: string, listener: Listener): () => void {
    let set = this.listeners.get(runId);
    if (!set) {
      set = new Set();
      this.listeners.set(runId, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(runId);
    };
  }

  /** The run's last view while it goes here; undefined when it is not going here. */
  live(runId: string): RunView | undefined {
    return this.views.get(runId);
  }

  /** The run ended: its view is in its record from now on. */
  ended(runId: string): void {
    this.views.delete(runId);
    this.publish(runId, { kind: 'state' });
  }
}
