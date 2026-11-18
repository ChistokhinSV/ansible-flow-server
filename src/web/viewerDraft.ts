// AFS-76: the designer page editing a flow's draft, as its host. The designer's commands go to the
// server, which applies them to the draft everyone edits; each edit, anyone's, comes back on the
// draft's stream as the flow to show. Ctrl+Z takes back the person's own last edit. The page
// around the frame (the flow page) is told who is there and what each changed.
import type { HostMessage, WebviewMessage } from '@ansible-flow/core/protocol';
import { mount } from '@ansible-flow/designer';

interface Edit {
  revision: number;
  by?: { login: string; name: string };
  nodes?: string[];
  snapshot?: { doc?: { nodes?: { id: string; title: string }[] } } & Record<string, unknown>;
}

/** What the frame tells the page around it. */
export type DraftNotice =
  | { type: 'afs-draft-people'; people: { login: string; name: string }[] }
  | { type: 'afs-draft-edit'; by: string; steps: string[] }
  | { type: 'afs-draft-saved'; commit?: string; by?: string }
  | { type: 'afs-draft-saving'; by: string; sent: boolean }
  | { type: 'afs-draft-undone' }
  | { type: 'afs-draft-gone'; by?: string }
  /** AFS-79: Insert Shared Subflow… on the canvas: the page picks from the library. */
  | { type: 'afs-draft-insert-shared'; level: string; at?: { x: number; y: number } }
  /** AFS-126: the empty canvas's Import / Open Sample: the page picks what to start from. */
  | { type: 'afs-draft-start-from'; what: 'sample' | 'playbooks' | 'awx' };

/** AFS-126: Get Started on the empty canvas: the guide's walkthrough of a first project. */
export const GET_STARTED =
  'https://github.com/ChistokhinSV/ansible-flow-server/blob/main/docs/guide/first-project.md';

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
}): void {
  const { root, draft, me } = options;
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

  const show = (snapshot: Edit['snapshot']) => {
    if (!snapshot) return;
    latest = snapshot;
    titles = new Map((snapshot.doc?.nodes ?? []).map((n) => [n.id, n.title]));
    if (ready) send({ type: 'snapshot', snapshot } as unknown as HostMessage);
  };

  const events = new EventSource(`${base}/events`);
  events.addEventListener('draft', (e) =>
    show((JSON.parse((e as MessageEvent).data) as { snapshot: Edit['snapshot'] }).snapshot),
  );
  events.addEventListener('edit', (e) => {
    const edit = JSON.parse((e as MessageEvent).data) as Edit;
    const before = titles;
    show(edit.snapshot);
    if (edit.by && edit.by.login !== me)
      tellPage({
        type: 'afs-draft-edit',
        by: edit.by.name,
        steps: (edit.nodes ?? []).map((id) => titles.get(id) ?? before.get(id) ?? 'a removed step'),
      });
  });
  events.addEventListener('people', (e) =>
    tellPage({ type: 'afs-draft-people', people: JSON.parse((e as MessageEvent).data) }),
  );
  // AFS-136: someone else is about to save: what is being typed here is sent first (leaving a
  // field commits it), and the page says so.
  events.addEventListener('saving', (e) => {
    const news = JSON.parse((e as MessageEvent).data) as { by?: { login: string; name: string } };
    if (!news.by || news.by.login === me) return;
    const typing = document.activeElement as HTMLElement | null;
    const sent =
      !!typing && typing !== document.body && /^(INPUT|TEXTAREA|SELECT)$/.test(typing.tagName);
    typing?.blur();
    tellPage({ type: 'afs-draft-saving', by: news.by.name, sent });
  });
  events.addEventListener('saved', (e) => {
    const news = JSON.parse((e as MessageEvent).data) as { commit?: string; by?: { name: string } };
    events.close();
    tellPage({ type: 'afs-draft-saved', commit: news.commit, by: news.by?.name });
  });
  events.addEventListener('discarded', (e) => {
    const news = JSON.parse((e as MessageEvent).data) as { by?: { name: string } };
    events.close();
    tellPage({ type: 'afs-draft-gone', by: news.by?.name });
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

  // "I am here", now and every 20 seconds while the page is open.
  const here = () => void json('POST', `${base}/here`, {}).catch(() => undefined);
  here();
  const beat = setInterval(here, 20_000);
  window.addEventListener('pagehide', () => {
    clearInterval(beat);
    events.close();
  });

  // Ctrl+Z: the person's own last edit, taken back (not in a field being typed in).
  window.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z' || e.shiftKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    e.preventDefault();
    void json('POST', `${base}/undo`).then((r) => {
      if (!r.ok) return notify(String(r.data?.message ?? 'Nothing to undo'), 'info');
      tellPage({ type: 'afs-draft-undone' });
      // AFS-136: what was taken back, said each time.
      const steps = (r.data?.steps as string[] | undefined) ?? [];
      notify(
        steps.length
          ? `Took back your change to ${steps.join(', ')}`
          : 'Took back your last move on the canvas',
        'info',
      );
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
            send({ type: 'config', testMode: false, embed: { mayRun: false } } as HostMessage);
            if (latest) send({ type: 'snapshot', snapshot: latest } as unknown as HostMessage);
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
            void json('POST', `${base}/commands`, { command: message.command }).then(
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
                    : { error: String(r.data?.message ?? `The server answered ${r.status}`) }),
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
          case 'startFrom':
            if (message.what === 'tour') openWebLink(GET_STARTED);
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
