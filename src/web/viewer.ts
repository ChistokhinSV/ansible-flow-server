// The page that is only the designer: one flow of a project, shown and not changed. The
// designer takes a whole page (its styles and keys are the page's), so the application shows
// this page in a frame, and it can be opened on its own.
//   /viewer.html?project=<id>&path=<file in the repository>&theme=light|dark|auto
// The flow comes from the server once, as a snapshot; this page answers the designer's
// messages itself. Runs are not built yet: asking for one says so.
import '@ansible-flow/designer/index.css';
import type { HostMessage, WebviewMessage } from '@ansible-flow/core/protocol';
import { mount } from '@ansible-flow/designer';

const params = new URLSearchParams(window.location.search);
const project = params.get('project') ?? '';
const path = params.get('path') ?? '';
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

async function start(): Promise<void> {
  if (!project || !path) return say('This address names no flow.');
  let reply: Response;
  try {
    reply = await fetch(
      `/api/v1/projects/${encodeURIComponent(project)}/flows/view?path=${encodeURIComponent(path)}`,
      { credentials: 'same-origin' },
    );
  } catch {
    return say('The server does not answer.');
  }
  const data = await reply.json().catch(() => undefined);
  if (!reply.ok)
    return say(
      reply.status === 401
        ? 'Sign in to see this flow.'
        : (data?.message ?? `The server answered ${reply.status}`),
    );

  const listeners = new Set<(message: HostMessage) => void>();
  // The designer expects answers after its own call returns, as from a real host.
  const send = (message: HostMessage) =>
    setTimeout(() => {
      for (const listener of listeners) listener(message);
    }, 0);
  const stateKey = `afs.viewer.${project}.${path}`;
  mount(root, {
    theme,
    viewer: true,
    transport: {
      hostName: 'Ansible Flow Server',
      post(message: WebviewMessage) {
        if (message.type === 'ready') {
          send({ type: 'config', testMode: false, viewer: true });
          send({ type: 'catalogStatus', status: { state: 'idle' } });
          send({ type: 'snapshot', snapshot: data.snapshot });
        } else if (message.type === 'run')
          send({
            type: 'notify',
            level: 'info',
            text: 'This server does not run flows yet: that part is not built.',
          });
        else if ('reqId' in message && typeof message.reqId === 'number')
          send({
            type: 'ack',
            reqId: message.reqId,
            ok: false,
            error: 'This page only shows the flow',
          });
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
