// The page that is only the designer: one flow of a project, shown and not changed. The
// designer takes a whole page (its styles and keys are the page's), so the application shows
// this page in a frame, and it can be opened on its own.
//   /viewer.html?project=<id>&path=<file in the repository>&theme=light|dark|auto
//                [&commit=<40 hex>]   the flow at that commit (a run's), not the project's
//                [&run=<run id>]      that run on the canvas, live while it goes
// The flow comes from the server once, as a snapshot; this page answers the designer's
// messages itself. The flow's past runs are in the designer's run list; picking one shows it.
import '@ansible-flow/designer/index.css';
import type { HostMessage, WebviewMessage } from '@ansible-flow/core/protocol';
import type { PastRun } from '@ansible-flow/core/run/pastRuns';
import { mount } from '@ansible-flow/designer';

const params = new URLSearchParams(window.location.search);
const project = params.get('project') ?? '';
const path = params.get('path') ?? '';
const commit = params.get('commit') ?? '';
const runId = params.get('run') ?? '';
const wanted = params.get('theme');
const theme = wanted === 'light' || wanted === 'dark' ? wanted : 'auto';
const root = document.getElementById('root') as HTMLElement;

/** Says why there is no flow to show, in the page itself. */
function say(text: string): void {
  const note = document.createElement('p');
  note.className = 'viewer-note';
  note.setAttribute('role', 'alert');
  note.textContent = text;
  root.replaceChildren(note);
}

const get = (url: string) =>
  fetch(url, { credentials: 'same-origin' }).then(async (reply) => ({
    ok: reply.ok,
    status: reply.status,
    data: await reply.json().catch(() => undefined),
  }));

/** A run as the designer's run list shows it. */
interface RunRecord {
  id: string;
  mode: 'check' | 'real';
  state: string;
  createdAt: string;
  startedAt?: string;
  flow: { version: number };
}
const pastRunOf = (run: RunRecord): PastRun => ({
  id: run.id,
  mode: run.mode,
  startedAt: run.startedAt ?? run.createdAt,
  ok: run.state === 'succeeded',
  hosts: 0,
  failed: 0,
  flowVersion: run.flow.version,
});

/** Opens a page of the application: in the window that holds this frame, when there is one. */
function go(to: string): void {
  (window.top ?? window).location.assign(to);
}

async function start(): Promise<void> {
  if (!project || !path) return say('This address names no flow.');
  let flow: Awaited<ReturnType<typeof get>>;
  try {
    flow = await get(
      `/api/v1/projects/${encodeURIComponent(project)}/flows/view?path=${encodeURIComponent(path)}${
        commit ? `&commit=${encodeURIComponent(commit)}` : ''
      }`,
    );
  } catch {
    return say('The server does not answer.');
  }
  if (!flow.ok)
    return say(
      flow.status === 401
        ? 'Sign in to see this flow.'
        : (flow.data?.message ?? `The server answered ${flow.status}`),
    );

  const listeners = new Set<(message: HostMessage) => void>();
  // The designer expects answers after its own call returns, as from a real host.
  const send = (message: HostMessage) =>
    setTimeout(() => {
      for (const listener of listeners) listener(message);
    }, 0);
  /** The run on the canvas now, for a step's host output and Stop. */
  let shown = runId;
  let stream: EventSource | undefined;

  /** Shows a run on the canvas: live while it goes, from its record once it ended. */
  const showRun = (id: string, past: boolean) => {
    shown = id;
    stream?.close();
    stream = new EventSource(`/api/v1/runs/${encodeURIComponent(id)}/events`);
    stream.addEventListener('view', (event) => {
      const view = JSON.parse((event as MessageEvent).data);
      void decidable(id, view).then((approvals) =>
        // Named by the server's run id, as the run list names it, so the canvas knows it there.
        send({
          type: 'run',
          run: {
            ...view,
            id,
            ...(approvals ? { approvals } : {}),
            ...(past ? { past: true } : {}),
          },
        }),
      );
    });
    stream.addEventListener('end', () => stream?.close());
  };

  /**
   * AFS-28: an approval that waits says whether this person may decide it here; the server
   * knows (the approve grant, the approval's approvers, who launched the run).
   */
  const decidable = async (
    id: string,
    view: { approvals?: Record<string, { status: string; mayDecide?: boolean }> },
  ) => {
    const approvals = view.approvals;
    if (!approvals || !Object.values(approvals).some((a) => a.status === 'waiting'))
      return approvals;
    const gates = await get(`/api/v1/runs/${encodeURIComponent(id)}/approvals`).catch(
      () => undefined,
    );
    if (!gates?.ok) return approvals;
    const may = new Set(
      (gates.data as { node: { id: string }; mayDecide: boolean }[])
        .filter((g) => g.mayDecide)
        .map((g) => g.node.id),
    );
    return Object.fromEntries(
      Object.entries(approvals).map(([node, a]) => [
        node,
        a.status === 'waiting' && may.has(node) ? { ...a, mayDecide: true } : a,
      ]),
    );
  };

  const runs = async () => {
    const list = await get(
      `/api/v1/runs?project=${encodeURIComponent(project)}&flow=${encodeURIComponent(path)}&limit=50`,
    ).catch(() => undefined);
    if (list?.ok) send({ type: 'runs', runs: (list.data as RunRecord[]).map(pastRunOf) });
  };

  const stateKey = `afs.viewer.${project}.${path}`;
  mount(root, {
    theme,
    viewer: true,
    transport: {
      hostName: 'Ansible Flow Server',
      post(message: WebviewMessage) {
        switch (message.type) {
          case 'ready':
            send({ type: 'config', testMode: false, viewer: true });
            send({ type: 'catalogStatus', status: { state: 'idle' } });
            send({ type: 'snapshot', snapshot: flow.data.snapshot });
            void runs();
            if (runId) showRun(runId, false);
            return;
          case 'run':
            // Runs start from a launch configuration: its page asks what the run needs.
            send({
              type: 'notify',
              level: 'info',
              text: 'Launch runs from a launch configuration of the project.',
            });
            return;
          case 'showRun':
            showRun(message.id, true);
            return;
          case 'showRunOutput':
            if (shown) go(`/runs/${encodeURIComponent(shown)}`);
            return;
          case 'stopRun':
            if (shown)
              void fetch(`/api/v1/runs/${encodeURIComponent(shown)}/cancel`, {
                method: 'POST',
                credentials: 'same-origin',
              }).then((reply) => {
                if (!reply.ok)
                  send({ type: 'notify', level: 'error', text: 'You may not stop this run' });
              });
            return;
          case 'approve': {
            if (!shown) return;
            const { node, decision, comment } = message;
            void fetch(
              `/api/v1/runs/${encodeURIComponent(shown)}/approvals/${encodeURIComponent(node)}`,
              {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ decision, ...(comment ? { comment } : {}) }),
              },
            ).then(async (reply) => {
              if (reply.ok) return;
              const why = (await reply.json().catch(() => undefined))?.message;
              send({ type: 'notify', level: 'error', text: why ?? 'The decision was not taken' });
            });
            return;
          }
          case 'runOutput': {
            const reqId = message.reqId;
            if (!shown) {
              send({ type: 'runOutputReply', reqId, error: 'No run is shown' });
              return;
            }
            void get(
              `/api/v1/runs/${encodeURIComponent(shown)}/hosts/${encodeURIComponent(message.node)}/${encodeURIComponent(message.host)}`,
            ).then(
              (reply) =>
                send(
                  reply.ok
                    ? { type: 'runOutputReply', reqId, entries: reply.data.entries }
                    : { type: 'runOutputReply', reqId, error: 'The output could not be read' },
                ),
              () => send({ type: 'runOutputReply', reqId, error: 'The server does not answer' }),
            );
            return;
          }
          default:
            if ('reqId' in message && typeof message.reqId === 'number')
              send({
                type: 'ack',
                reqId: message.reqId,
                ok: false,
                error: 'This page only shows the flow',
              });
        }
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      getState() {
        try {
          return JSON.parse(window.localStorage.getItem(stateKey) ?? 'null') ?? undefined;
        } catch {
          return undefined;
        }
      },
      setState(state) {
        try {
          window.localStorage.setItem(stateKey, JSON.stringify(state));
        } catch {
          // Not kept: the view starts from the flow's own layout next time.
        }
      },
    },
  });
}

void start();
