// AFS-76: the designer page editing a flow's draft, as its host. The designer's commands go to the
// server, which applies them to the draft everyone edits; each edit, anyone's, comes back on the
// draft's stream as the flow to show. Ctrl+Z takes back the person's own last edit (Ctrl+Y or
// Ctrl+Shift+Z brings it back, AFS-172). The page around the frame (the flow page) is told who is
// there and what each changed.
import type { HostMessage, WebviewMessage } from '@ansible-flow/core/protocol';
import { mount } from '@ansible-flow/designer';
import { answerWords } from './answer';
import { changeWords } from './draftWords';
import { guide } from './guide';
import { isSaveKey } from './saveKey';
import { typingInField } from './typing';
import { flowInventory, openCodeIn, projectKeys, type RepoVars, repoVars } from './viewerVars';

/** AFS-149: what one edit did (the server's words: a step or the flow, and its fields). */
export interface EditChange {
  step?: string;
  /** AFS-186: a note on the canvas, by its first line. */
  note?: string;
  kind: 'added' | 'removed' | 'changed';
  fields: string[];
}

interface Edit {
  revision: number;
  /** AFS-186: the draft changes something against its commit. */
  changed?: boolean;
  by?: { login: string; name: string };
  nodes?: string[];
  changes?: EditChange[];
  wires?: number;
  snapshot?: { doc?: { nodes?: { id: string; title: string }[] } } & Record<string, unknown>;
}

/** What the frame tells the page around it. */
export type DraftNotice =
  | { type: 'afs-draft-people'; people: { login: string; name: string; tabs?: number }[] }
  | { type: 'afs-draft-edit'; by: string; steps: string[]; what: string }
  | {
      type: 'afs-draft-saved';
      commit?: string;
      by?: string;
      /** AFS-149: saved by the person of this page (in another tab). */
      mine?: boolean;
      coAuthors?: string[];
      /** AFS-149: a field here still had the focus: what was typed in it may not be saved. */
      unsent?: boolean;
    }
  | {
      type: 'afs-draft-saving';
      by: string;
      sent: boolean;
      mine?: boolean;
      /** AFS-186: a discard is coming, not a save. */
      what?: 'discard';
    }
  /** AFS-186: whether the draft changes anything (Save is off while it does not). */
  | { type: 'afs-draft-changed'; changed: boolean }
  | { type: 'afs-draft-undone' }
  | { type: 'afs-draft-gone'; by?: string; mine?: boolean }
  /** AFS-79: Insert Shared Subflow… on the canvas: the page picks from the library. */
  | { type: 'afs-draft-insert-shared'; level: string; at?: { x: number; y: number } }
  /** AFS-126: the empty canvas's Import / Open Sample: the page picks what to start from. */
  | { type: 'afs-draft-start-from'; what: 'sample' | 'playbooks' | 'awx' };

/**
 * AFS-126: Get Started on the empty canvas: the guide. AFS-155: its walkthrough of a first flow in
 * the pages, as this server serves it (no internet needed).
 */
export const GET_STARTED = guide('first-flow.md');

/**
 * AFS-149: what an edit did, in a few words: "removed Ping", "changed the name and timeout of
 * Ping", "changed the flow's goal" (AFS-209: the forms' words, not the file's field names; a note
 * by its first words). Names three places at most, and the wires it changed with them.
 */
export function editWords(edit: { changes?: EditChange[]; wires?: number; steps?: string[] }) {
  const parts = (edit.changes ?? []).map((c) => changeWords(c));
  if (!parts.length && edit.steps?.length) parts.push(`changed ${edit.steps.join(', ')}`);
  if (!parts.length) return edit.wires ? 'changed the wires' : 'moved steps on the canvas';
  const named = parts.slice(0, 3).join('; ');
  const wires = edit.wires ? ` and ${edit.wires} wire${edit.wires === 1 ? '' : 's'}` : '';
  return parts.length > 3 ? `${named} and ${parts.length - 3} more${wires}` : `${named}${wires}`;
}

/** AFS-172: Ctrl+Z is undo; Ctrl+Shift+Z and Ctrl+Y are redo (⌘ on macOS). */
export function redoOrUndo(e: {
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey?: boolean;
  key: string;
}): 'undo' | 'redo' | undefined {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return undefined;
  const key = e.key.toLowerCase();
  if (key === 'z') return e.shiftKey ? 'redo' : 'undo';
  if (key === 'y' && !e.shiftKey) return 'redo';
  return undefined;
}

/**
 * AFS-172: what a redo brought back (AFS-186: or an undo took back), in a few words: what the
 * change was, as the activity line says it ("changed the note “Why”", "moved Ping").
 */
export function redoWords(
  reply: { steps?: unknown; started?: unknown; changes?: unknown; wires?: unknown },
  undo = false,
): string {
  const started = reply.started as { what: string; steps: number } | undefined;
  const verb = undo ? 'Took back' : 'Brought back';
  if (started)
    return `${verb} ${started.what} (${started.steps} step${started.steps === 1 ? '' : 's'})`;
  const changes = reply.changes as EditChange[] | undefined;
  if (changes?.length || reply.wires)
    return `${undo ? 'Took back' : 'Redid'} your change: ${editWords({ changes, wires: Number(reply.wires ?? 0) })}`;
  const steps = (reply.steps as string[] | undefined) ?? [];
  if (steps.length) return `${undo ? 'Took back' : 'Redid'} your change to ${steps.join(', ')}`;
  return undo ? 'Took back your last move on the canvas' : 'Redid your last move on the canvas';
}

/** A field being typed in, or none. */
const typingIn = (): HTMLElement | undefined => {
  const typing = document.activeElement as HTMLElement | null;
  return typing &&
    typing !== document.body &&
    (typing.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(typing.tagName))
    ? typing
    : undefined;
};

/**
 * AFS-149: lets the designer act on what just happened (a field left commits on blur) without a
 * timer, which a background tab slows to once a second or more.
 */
const nextTask = () =>
  new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => resolve();
    channel.port2.postMessage(undefined);
  });

const json = (method: string, url: string, body?: unknown) =>
  fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then(async (reply) => ({
    ok: reply.ok,
    status: reply.status,
    data: (await reply.json().catch(() => undefined)) as Record<string, unknown> | undefined,
  }));

/** Tells the page around the frame (the same origin only). */
function tellPage(notice: DraftNotice): void {
  if (window.parent !== window) window.parent.postMessage(notice, window.location.origin);
}

export function editDraft(options: {
  root: HTMLElement;
  draft: string;
  me: string;
  theme: 'light' | 'dark' | 'auto';
  stateKey: string;
  /** AFS-149: this page (tab), as the flow page around it names it for its Save. */
  tab?: string;
  /** AFS-164: a step to select once the flow shows (an error on it). */
  reveal?: string;
}): void {
  const { root, draft, me } = options;
  const tab = options.tab ?? (crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`);
  const base = `/api/v1/drafts/${encodeURIComponent(draft)}`;
  const listeners = new Set<(message: HostMessage) => void>();
  const send = (message: HostMessage) =>
    setTimeout(() => {
      for (const listener of listeners) listener(message);
    }, 0);
  const notify = (text: string, level: 'info' | 'error' = 'error') =>
    send({ type: 'notify', level, text });
  let ready = false;
  let latest: Edit['snapshot'];
  /** Step titles by id, to name what others changed. */
  let titles = new Map<string, string>();
  /** AFS-149: the designer's commands on their way to the server. */
  const sending = new Set<Promise<unknown>>();

  let revealing = options.reveal;
  /** AFS-164: the step asked for, selected once the flow is on the canvas. */
  const revealOnce = () => {
    if (!revealing) return;
    send({ type: 'reveal', node: revealing } as HostMessage);
    revealing = undefined;
  };
  /**
   * AFS-183: the repository's variables at the draft's base commit, for where a value comes from;
   * read again when the draft binds other roles or playbooks.
   */
  let vars: RepoVars | undefined;
  let keys: Awaited<ReturnType<typeof projectKeys>>;
  const withVars = (snapshot: NonNullable<Edit['snapshot']>) =>
    (vars ? vars.snapshot(snapshot as never) : snapshot) as unknown;
  const show = (snapshot: Edit['snapshot']) => {
    if (!snapshot) return;
    latest = snapshot;
    titles = new Map((snapshot.doc?.nodes ?? []).map((n) => [n.id, n.title]));
    if (ready) {
      send({ type: 'snapshot', snapshot: withVars(snapshot) } as unknown as HostMessage);
      revealOnce();
    }
  };

  const events = new EventSource(`${base}/events?tab=${encodeURIComponent(tab)}`);
  events.addEventListener('draft', (e) => {
    const first = JSON.parse((e as MessageEvent).data) as {
      draft?: { project: string; file: string; baseCommit: string };
      snapshot: Edit['snapshot'];
    };
    const d = first.draft;
    if (d && !vars) {
      vars = repoVars({
        project: d.project,
        commit: d.baseCommit,
        inventory: async () => {
          const r = await json(
            'GET',
            `/api/v1/projects/${encodeURIComponent(d.project)}/launch-configs`,
          );
          return r.ok && Array.isArray(r.data) ? flowInventory(r.data, d.file) : '';
        },
        send,
      });
      void projectKeys(d.project).then((k) => {
        keys = k;
      });
    }
    show(first.snapshot);
    tellPage({ type: 'afs-draft-changed', changed: !!(first as { changed?: boolean }).changed });
  });
  events.addEventListener('edit', (e) => {
    const edit = JSON.parse((e as MessageEvent).data) as Edit;
    const before = titles;
    show(edit.snapshot);
    if (edit.changed !== undefined) tellPage({ type: 'afs-draft-changed', changed: edit.changed });
    if (edit.by && edit.by.login !== me) {
      const steps = (edit.nodes ?? []).map(
        (id) => titles.get(id) ?? before.get(id) ?? 'a removed step',
      );
      tellPage({
        type: 'afs-draft-edit',
        by: edit.by.name,
        steps,
        what: editWords({ ...edit, steps }),
      });
    }
  });
  events.addEventListener('people', (e) =>
    tellPage({ type: 'afs-draft-people', people: JSON.parse((e as MessageEvent).data) }),
  );
  // AFS-136: someone is about to save: what is being typed here is sent first (leaving a field
  // commits it), and the page says so. AFS-149: the same person's other tab too (the server tells
  // every page but the saver's), and the server hears once it is sent, so it waits no longer.
  events.addEventListener('saving', (e) => {
    const news = JSON.parse((e as MessageEvent).data) as {
      by?: { login: string; name: string };
      flush?: string;
      stream?: string;
      what?: 'discard';
    };
    if (!news.by) return;
    const typing = typingIn();
    typing?.blur();
    tellPage({
      type: 'afs-draft-saving',
      by: news.by.name,
      sent: !!typing,
      mine: news.by.login === me,
      ...(news.what ? { what: news.what } : {}),
    });
    void (async () => {
      await nextTask();
      await Promise.allSettled([...sending]);
      if (news.flush && news.stream)
        await json('POST', `${base}/flushed`, { flush: news.flush, stream: news.stream }).catch(
          () => undefined,
        );
    })();
  });
  events.addEventListener('saved', (e) => {
    const news = JSON.parse((e as MessageEvent).data) as {
      commit?: string;
      by?: { login: string; name: string };
      coAuthors?: string[];
    };
    ended();
    tellPage({
      type: 'afs-draft-saved',
      commit: news.commit,
      by: news.by?.name,
      mine: news.by?.login === me,
      coAuthors: news.coAuthors ?? [],
      unsent: !!typingIn(),
    });
  });
  events.addEventListener('discarded', (e) => {
    const news = JSON.parse((e as MessageEvent).data) as { by?: { login: string; name: string } };
    ended();
    tellPage({ type: 'afs-draft-gone', by: news.by?.name, mine: news.by?.login === me });
  });

  /** The catalog's state, again every 10 seconds while the image's docs are first read. */
  let watching: ReturnType<typeof setTimeout> | undefined;
  const catalogStatus = async (): Promise<void> => {
    const r = await json('POST', `${base}/catalog`, { request: { op: 'status' } }).catch(
      () => undefined,
    );
    const status = r?.data?.status as { state?: string } | undefined;
    if (!status) return;
    send({ type: 'catalogStatus', status } as HostMessage);
    clearTimeout(watching);
    if (status.state === 'loading') watching = setTimeout(() => void catalogStatus(), 10_000);
  };

  // "I am here", now and every 20 seconds while the page is open. AFS-186: not once the draft
  // ended (saved, discarded, gone: a 404), which would only fail.
  let over = false;
  const here = () => {
    if (over) return;
    void json('POST', `${base}/here`, { tab })
      .then((r) => {
        if (r.status === 404) ended();
      })
      .catch(() => undefined);
  };
  here();
  const beat = setInterval(here, 20_000);
  // AFS-209: the server forgets a tab whose stream ended; a stream that comes back says so again.
  let streamed = false;
  events.addEventListener('open', () => {
    if (streamed) here();
    streamed = true;
  });
  function ended() {
    over = true;
    clearInterval(beat);
    events.close();
  }
  window.addEventListener('pagehide', ended);

  // AFS-166: on a page of its own the draft has no Save: Ctrl+S says where it is (viewer.ts keeps
  // the browser's dialog away; in a frame, the flow's page saves).
  window.addEventListener('keydown', (e) => {
    if (window.parent !== window || !isSaveKey(e) || e.repeat) return;
    notify("Save the draft on the flow's page: Save there makes the commit.", 'info');
  });

  // Ctrl+Z: the person's own last edit, taken back; Ctrl+Shift+Z or Ctrl+Y (AFS-172): brought back
  // again. Not in a field being typed in, which has its own.
  window.addEventListener('keydown', (e) => {
    const key = redoOrUndo(e);
    if (!key) return;
    if (typingInField(e)) return;
    e.preventDefault();
    if (key === 'redo') {
      void json('POST', `${base}/redo`).then((r) => {
        if (!r.ok || r.data?.nothing)
          return notify(String(r.data?.message ?? 'Nothing to redo'), 'info');
        notify(redoWords(r.data ?? {}), 'info');
      });
      return;
    }
    void json('POST', `${base}/undo`).then((r) => {
      if (!r.ok || r.data?.nothing)
        return notify(String(r.data?.message ?? 'Nothing to undo'), 'info');
      tellPage({ type: 'afs-draft-undone' });
      // AFS-136: what was taken back, said each time; AFS-151: a start from a sample or an import
      // is one thing taken back; AFS-186: a note's text is named, not called a move.
      notify(redoWords(r.data ?? {}, true), 'info');
    });
  });

  mount(root, {
    theme: options.theme,
    transport: {
      hostName: 'Ansible Flow Server',
      post(message: WebviewMessage) {
        switch (message.type) {
          case 'ready':
            ready = true;
            // AFS-136: a draft does not run (runs use saved commits): no Run buttons while editing.
            send({
              type: 'config',
              testMode: false,
              embed: { mayRun: false, words: 'server' },
            } as HostMessage);
            if (latest) {
              send({ type: 'snapshot', snapshot: withVars(latest) } as unknown as HostMessage);
              revealOnce();
            }
            void catalogStatus();
            return;
          case 'catalog': {
            const reqId = message.reqId;
            void json('POST', `${base}/catalog`, { request: message.request }).then((r) => {
              if (r.status === 202 || !r.ok) {
                const status = r.data?.status as { message?: string } | undefined;
                send({
                  type: 'catalogReply',
                  reqId,
                  ok: false,
                  error: status?.message ?? String(r.data?.message ?? 'The catalog is not ready'),
                } as HostMessage);
                if (status) void catalogStatus();
                return;
              }
              send({
                type: 'catalogReply',
                reqId,
                ok: true,
                result: (r.data?.result ?? r.data?.status) as never,
              } as HostMessage);
            });
            return;
          }
          case 'command': {
            const reqId = message.reqId;
            const going = json('POST', `${base}/commands`, { command: message.command });
            sending.add(going);
            void going.finally(() => sending.delete(going)).catch(() => undefined);
            void going.then(
              (r) =>
                send({
                  type: 'ack',
                  reqId,
                  ok: r.ok,
                  ...(r.ok
                    ? {
                        ...(r.data?.created ? { created: r.data.created as string } : {}),
                        ...(r.data?.pasted ? { pasted: r.data.pasted as string[] } : {}),
                      }
                    : { error: String(r.data?.message ?? answerWords(r.status)) }),
                } as HostMessage),
              () => send({ type: 'ack', reqId, ok: false, error: 'The server does not answer' }),
            );
            return;
          }
          case 'tidyUp':
            void json('POST', `${base}/tidy`, message.level ? { level: message.level } : {}).then(
              (r) => {
                if (!r.ok) notify(String(r.data?.message ?? 'Not laid out'));
              },
            );
            return;
          case 'openLink':
            // AFS-119: a web link of the flow (a note's link) in a new tab, never in this frame.
            openWebLink(message.url);
            return;
          case 'openCode':
            // AFS-183: where a value is defined: the Files tab at that line, in a new tab.
            openCodeIn(keys, message.path, message.line, (file, line) =>
              notify(
                `Open ${file}${line ? ` at line ${line}` : ''} on the project's Files tab.`,
                'info',
              ),
            );
            return;
          case 'startFrom':
            if (message.what === 'tour')
              openWebLink(new URL(GET_STARTED, window.location.origin).href);
            else tellPage({ type: 'afs-draft-start-from', what: message.what });
            return;
          case 'insertShared':
            tellPage({
              type: 'afs-draft-insert-shared',
              level: message.level,
              ...(message.at ? { at: message.at } : {}),
            });
            return;
          case 'run':
          case 'launchRun':
            notify('Save the draft first: runs take the flow from the branch.', 'info');
            return;
          default:
            if ('reqId' in message && typeof message.reqId === 'number')
              send({
                type: 'ack',
                reqId: message.reqId,
                ok: false,
                error: 'Not available while editing in the pages',
              });
        }
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      getState() {
        try {
          return JSON.parse(window.localStorage.getItem(options.stateKey) ?? 'null') ?? undefined;
        } catch {
          return undefined;
        }
      },
      setState(state) {
        try {
          window.localStorage.setItem(options.stateKey, JSON.stringify(state));
        } catch {
          // Not kept.
        }
      },
    },
  });
}

/** AFS-119: a web link the designer asks to open, in a new tab; anything else is ignored. */
export function openWebLink(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (parsed.protocol === 'https:' || parsed.protocol === 'http:')
    window.open(parsed.href, '_blank', 'noopener,noreferrer');
}
