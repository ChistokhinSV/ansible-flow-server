// AFS-75: the viewer page follows its flow on the project's branch. When someone changes the flow
// there (a push, a look at the source, later a save from the pages), a bar says who and how much,
// with Show changes (the designer's Changes lens against the version shown before) and Update.
// The Changes lens also compares with any earlier commit that changed the flow.

import { diffFlows } from '@ansible-flow/core/flow/semanticDiff';
import type { FlowDocument } from '@ansible-flow/core/flow/types';
import type { CompareFacts, CompareRef } from '@ansible-flow/core/lens/types';
import type { HostMessage, Snapshot } from '@ansible-flow/core/protocol';

interface Changed {
  file: string;
  change: 'added' | 'changed' | 'removed';
  authors: string[];
  at?: string;
  commit?: string;
}
interface HistoryEntry {
  commit: string;
  author: string;
  at: string;
  subject: string;
}

const get = async <T>(url: string): Promise<T | undefined> => {
  const reply = await fetch(url, { credentials: 'same-origin' }).catch(() => undefined);
  return reply?.ok ? ((await reply.json()) as T) : undefined;
};

const short = (commit: string) => commit.slice(0, 8);
const names = (authors: string[]) =>
  authors.length <= 2
    ? authors.join(' and ')
    : `${authors.slice(0, 2).join(', ')} and ${authors.length - 2} more`;
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** "3 steps and 1 wire": how much differs between two versions of a flow. */
export function howMuch(before: FlowDocument, after: FlowDocument): string {
  const diff = diffFlows(before, after);
  const parts = [
    diff.nodes.length ? plural(diff.nodes.length, 'step') : '',
    diff.wires.length ? plural(diff.wires.length, 'wire') : '',
  ].filter(Boolean);
  return parts.length ? parts.join(' and ') : 'its settings';
}

export interface Following {
  /** The designer picked a lens (null: none). */
  lens(lens: string | null): void;
  /** The designer's base picker. */
  compareWith(ref: string): void;
}

/**
 * Follows the flow shown at `commit` on the project's branch. `send` talks to the designer;
 * `bar` is where the page shows the notice.
 */
export function followFlow(options: {
  project: string;
  path: string;
  commit: string;
  snapshot: Snapshot;
  send: (message: HostMessage) => void;
  bar: HTMLElement;
  /** False for a flow pinned at a commit (a run's): it never moves. */
  live: boolean;
  /** AFS-183: the canvas shows the flow at another commit now (its repository's variables too). */
  onCommit?: (commit: string) => void;
}): Following {
  const { project, path, send, bar } = options;
  const p = encodeURIComponent(project);
  const f = encodeURIComponent(path);
  let shown = { commit: options.commit, doc: options.snapshot.doc as FlowDocument };
  /** The version shown before the last Update, the lens's first base after it. */
  let before: { commit: string; doc: FlowDocument; who: string } | undefined;
  /** A newer version waiting for Update. */
  let waiting: { commit: string; snapshot: Snapshot; who: string } | undefined;
  let version = options.snapshot.docVersion;
  let lensOpen = false;
  let compare: CompareFacts | undefined;

  const viewAt = (commit: string) =>
    get<{ commit: string; snapshot: Snapshot }>(
      `/api/v1/projects/${p}/flows/view?path=${f}&commit=${commit}`,
    );

  const show = (text: string, buttons: [string, () => void][]) => {
    const words = document.createElement('span');
    words.textContent = text;
    const parts: HTMLElement[] = [words];
    for (const [label, act] of buttons) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.addEventListener('click', act);
      parts.push(button);
    }
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'viewer-bar-close';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Dismiss');
    close.addEventListener('click', () => {
      bar.hidden = true;
    });
    parts.push(close);
    bar.replaceChildren(...parts);
    bar.hidden = false;
  };

  /** The commits that changed the flow, as the lens's base picker offers them. */
  const refsOf = async (): Promise<CompareRef[]> => {
    const history =
      (await get<HistoryEntry[]>(
        `/api/v1/projects/${p}/flows/history?path=${f}&commit=${shown.commit}`,
      )) ?? [];
    return history
      .filter((h) => h.commit !== shown.commit)
      .map((h) => ({
        ref: h.commit,
        label: `${short(h.commit)} ${h.author}: ${h.subject}`,
      }));
  };

  /** Gives the Changes lens the flow at `ref` to compare with. */
  const readBase = async (ref?: string) => {
    const refs = await refsOf();
    const label = (r: string) =>
      before?.commit === r
        ? `before ${before.who}'s change (${short(r)})`
        : (refs.find((x) => x.ref === r)?.label ?? short(r));
    const all =
      before && !refs.some((r) => r.ref === before?.commit)
        ? [{ ref: before.commit, label: label(before.commit) }, ...refs]
        : refs.map((r) => ({ ...r, label: label(r.ref) }));
    const pick = ref ?? before?.commit ?? all[0]?.ref;
    if (!pick) {
      compare = {
        state: 'error',
        ref: '',
        label: '',
        refs: [],
        error: 'This flow has no earlier version on the branch',
      };
      send({ type: 'lensFacts', facts: { compare } });
      return;
    }
    compare = { state: 'loading', ref: pick, label: label(pick), refs: all };
    send({ type: 'lensFacts', facts: { compare } });
    const doc =
      before?.commit === pick ? before.doc : ((await viewAt(pick))?.snapshot.doc as FlowDocument);
    compare = doc
      ? { state: 'ready', ref: pick, label: label(pick), refs: all, base: doc }
      : { state: 'error', ref: pick, label: label(pick), refs: all, error: 'Not readable' };
    send({ type: 'lensFacts', facts: { compare } });
  };

  const update = () => {
    if (!waiting) return;
    before = { ...shown, who: waiting.who };
    version += 1;
    send({ type: 'snapshot', snapshot: { ...waiting.snapshot, docVersion: version } });
    shown = { commit: waiting.commit, doc: waiting.snapshot.doc as FlowDocument };
    options.onCommit?.(shown.commit);
    // The application around the frame names the commit shown.
    if (window.parent !== window)
      window.parent.postMessage(
        { type: 'afs-flow-shown', commit: shown.commit },
        window.location.origin,
      );
    const who = waiting.who;
    waiting = undefined;
    if (lensOpen) void readBase(before.commit);
    show(`You see ${who}'s change.`, [['Show changes', () => showChanges()]]);
  };

  const showChanges = () => {
    update();
    lensOpen = true;
    void readBase(before?.commit);
    send({ type: 'setLens', lens: 'changes' });
  };

  /** The branch moved: what happened to this flow, if anything. */
  const moved = async (to: string) => {
    if (to === shown.commit || to === waiting?.commit) return;
    const changes = await get<{ flows: Changed[] }>(
      `/api/v1/projects/${p}/changes?from=${shown.commit}&to=${to}`,
    );
    if (!changes) return;
    const mine = changes.flows.find((c) => c.file === path);
    if (!mine) {
      // Other files changed: this flow is the same at the new commit.
      shown = { ...shown, commit: to };
      // AFS-183: the repository's variables may have changed with them.
      options.onCommit?.(to);
      return;
    }
    const who = names(mine.authors) || 'Someone';
    if (mine.change === 'removed') {
      waiting = undefined;
      show(`${who} removed this flow from the branch. You see it as it was.`, []);
      return;
    }
    const next = await viewAt(to);
    if (!next) return;
    waiting = { commit: to, snapshot: next.snapshot, who };
    show(`${who} changed this flow: ${howMuch(shown.doc, next.snapshot.doc as FlowDocument)}.`, [
      ['Show changes', () => showChanges()],
      ['Update', () => update()],
    ]);
  };

  if (options.live && typeof EventSource !== 'undefined') {
    const events = new EventSource(`/api/v1/projects/${p}/events`);
    // `commit` comes at once and after each reconnect: the branch may have moved meanwhile.
    for (const kind of ['commit', 'moved'])
      events.addEventListener(kind, (event) => {
        const data = JSON.parse((event as MessageEvent).data) as { commit?: string; to?: string };
        const to = data.to ?? data.commit;
        if (to) void moved(to);
      });
  }

  return {
    lens: (lens) => {
      lensOpen = lens === 'changes';
      if (!lensOpen) return;
      if (!compare || compare.state === 'error') void readBase();
      else send({ type: 'lensFacts', facts: { compare } });
    },
    compareWith: (ref) => void readBase(ref),
  };
}
