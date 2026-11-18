// The page that is only the designer: one flow of a project, shown and not changed. The
// designer takes a whole page (its styles and keys are the page's), so the application shows
// this page in a frame, and it can be opened on its own.
//   /viewer.html?project=<id>&path=<file in the repository>&theme=light|dark|auto
//                [&commit=<40 hex>]   the flow at that commit (a run's), not the project's
//                [&run=<run id>]      that run on the canvas, live while it goes
//                [&draft=<draft id>]  AFS-76: the flow's draft, edited (viewerDraft.ts)
// The flow comes from the server once, as a snapshot; this page answers the designer's
// messages itself. The flow's past runs are in the designer's run list; picking one shows it.
// Run opens the designer's launch dialog over a launch configuration (AFS-67, viewerLaunch.ts).
// When someone changes the flow on the branch, a bar says so (AFS-75, viewerChanges.ts).
import '@ansible-flow/designer/index.css';
import type { HostMessage, WebviewMessage } from '@ansible-flow/core/protocol';
import type { PastRun } from '@ansible-flow/core/run/pastRuns';
import { mount } from '@ansible-flow/designer';
import { followFlow } from './viewerChanges';
import { editDraft, openWebLink } from './viewerDraft';
import { askName, chooseConfig, launcher } from './viewerLaunch';

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
  /** AFS-105: how many hosts it ran on and how many failed, once it went. */
  hosts?: { total: number; failed: number };
}
/**
 * AFS-105: "ok" is the designer's "the run itself finished": a run that failed because hosts
 * failed did finish (its list line says how many); one stopped, lost or broken did not.
 */
const pastRunOf = (run: RunRecord): PastRun => ({
  id: run.id,
  mode: run.mode,
  startedAt: run.startedAt ?? run.createdAt,
  ok: run.state === 'succeeded' || (run.state === 'failed' && (run.hosts?.failed ?? 0) > 0),
  hosts: run.hosts?.total ?? 0,
  failed: run.hosts?.failed ?? 0,
  flowVersion: run.flow.version,
});

/** AFS-105: the person's level on the flow (its own, else the workspace's), as the server says. */
interface ProjectAccess {
  admin: boolean;
  workspace: string | null;
  flows: Record<string, string | null>;
}
const RANK: Partial<Record<string, number>> = { ro: 1, operator: 2, rw: 3 };
const OPERATOR = 2;
/** AFS-135: rw on the flow: may add and change its launch configurations. */
const mayManage = (access: ProjectAccess | undefined, file: string): boolean =>
  !!access && (access.admin || (RANK[access.flows[file] ?? access.workspace ?? ''] ?? 0) >= 3);
const mayOperate = (access: ProjectAccess | undefined, file: string): boolean =>
  !!access &&
  (access.admin || (RANK[access.flows[file] ?? access.workspace ?? ''] ?? 0) >= OPERATOR);

/** Opens a page of the application: in the window that holds this frame, when there is one. */
function go(to: string): void {
  (window.top ?? window).location.assign(to);
}

/**
 * AFS-132: Open in Text Editor in the pages: the file on its project's Files tab. Resolves with
 * false when the project or its workspace cannot be read.
 */
async function openInFiles(file: string): Promise<boolean> {
  const read = async (url: string) => {
    const reply = await fetch(url, { credentials: 'same-origin' });
    return reply.ok ? ((await reply.json()) as { key?: string; workspace?: string }) : undefined;
  };
  const p = await read(`/api/v1/projects/${encodeURIComponent(project)}`).catch(() => undefined);
  const w =
    p?.workspace &&
    (await read(`/api/v1/workspaces/${encodeURIComponent(p.workspace)}`).catch(() => undefined));
  if (!p?.key || !w || !w.key) return false;
  go(`/w/${w.key}/${p.key}/files?path=${encodeURIComponent(file)}`);
  return true;
}

async function start(): Promise<void> {
  // AFS-76: editing the flow's draft, with everyone else editing it.
  const draft = params.get('draft');
  if (draft) {
    const me = await get('/api/v1/session').catch(() => undefined);
    if (!me?.ok) return say('Sign in to edit this flow.');
    editDraft({
      root,
      draft,
      me: String(me.data?.login ?? ''),
      theme,
      stateKey: `afs.draft.${draft}`,
    });
    return;
  }
  // AFS-143: the viewer opened by itself, without a flow: where flows are opened instead.
  if (!project || !path)
    return say('This address names no flow. Open a flow from its project page in Workspaces.');
  // AFS-105: what the person may do here, asked beside the flow: the canvas offers only that.
  const accessAsked = get(`/api/v1/projects/${encodeURIComponent(project)}/access`).catch(
    () => undefined,
  );
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
        : flow.status === 404
          ? `The flow ${path} is not here, or is not shared with you.`
          : (flow.data?.message ?? `The server answered ${flow.status}`),
    );

  const access = await accessAsked;
  const operate = mayOperate(access?.ok ? (access.data as ProjectAccess) : undefined, path);
  const manage = mayManage(access?.ok ? (access.data as ProjectAccess) : undefined, path);
  // AFS-105: on a run's page the page shows the run (state, hosts, outputs, approvals, Stop, Run
  // again): the canvas does not repeat it. Elsewhere it launches and stops for an operator.
  const embed = { runShown: !!runId, mayRun: operate && !commit, mayStop: operate };

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

  const launch = launcher({
    project,
    path,
    send,
    choose: chooseConfig,
    askName,
    go,
    mayAddConfig: manage,
    launched: (id) => {
      showRun(id, false);
      void runs();
    },
  });

  const bar = document.createElement('div');
  bar.className = 'viewer-bar';
  bar.setAttribute('role', 'status');
  bar.hidden = true;
  document.body.prepend(bar);
  const following = followFlow({
    project,
    path,
    commit: flow.data.commit,
    snapshot: flow.data.snapshot,
    send,
    bar,
    live: !commit,
  });

  const stateKey = `afs.viewer.${project}.${path}`;
  mount(root, {
    theme,
    viewer: true,
    transport: {
      hostName: 'Ansible Flow Server',
      post(message: WebviewMessage) {
        // AFS-97: Save as Launch Configuration (designer AFD-300; typed loosely, so this builds
        // against a designer that does not have it yet).
        const saving = message as {
          type: string;
          token?: string;
          inputs?: Record<string, unknown>;
        };
        if (saving.type === 'launchSave' && saving.token) {
          void launch.save(saving.token, saving.inputs ?? {});
          return;
        }
        switch (message.type) {
          case 'ready':
            // `embed` typed loosely, so this builds against a designer that does not have it yet.
            send({ type: 'config', testMode: false, viewer: true, embed } as HostMessage);
            send({ type: 'catalogStatus', status: { state: 'idle' } });
            send({ type: 'snapshot', snapshot: flow.data.snapshot });
            void runs();
            if (runId) showRun(runId, false);
            return;
          case 'run':
            // AFS-67: the designer's launch dialog, backed by a launch configuration of the flow.
            if (commit) {
              send({
                type: 'notify',
                level: 'info',
                text: 'This is the flow at an older commit: open the flow itself to launch it.',
              });
              return;
            }
            void launch.run(message.mode);
            return;
          case 'launchCheck':
            void launch.check(message.token, message.inputs);
            return;
          case 'launchRun':
            void launch.launch(message.token, message.inputs);
            return;
          case 'launchCancel':
            launch.cancel(message.token);
            return;
          case 'lens':
            following.lens(message.lens);
            return;
          case 'compareWith':
            following.compareWith(message.ref);
            return;
          case 'showRun':
            showRun(message.id, true);
            return;
          case 'openLink':
            // AFS-119: a web link of the flow (a note's link) in a new tab, never in this frame.
            openWebLink(message.url);
            return;
          case 'openText':
            // The flow's file (the designer names a node in it, which the Files tab cannot show).
            void openInFiles(path).then((opened) => {
              if (!opened)
                send({
                  type: 'notify',
                  level: 'error',
                  text: `${path} could not be opened: open it on the project's Files tab.`,
                });
            });
            return;
          case 'catalog': {
            // AFS-118: a step's module docs, from the catalog of the flow's image.
            const reqId = message.reqId;
            void fetch(
              `/api/v1/projects/${encodeURIComponent(project)}/flows/catalog?path=${encodeURIComponent(path)}`,
              {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ request: message.request }),
              },
            ).then(
              async (reply) => {
                const data = await reply.json().catch(() => undefined);
                if (reply.status === 202 || !reply.ok)
                  send({
                    type: 'catalogReply',
                    reqId,
                    ok: false,
                    error:
                      data?.status?.message ?? String(data?.message ?? 'The catalog is not ready'),
                  } as HostMessage);
                else
                  send({
                    type: 'catalogReply',
                    reqId,
                    ok: true,
                    result: (data?.result ?? data?.status) as never,
                  } as HostMessage);
              },
              () =>
                send({
                  type: 'catalogReply',
                  reqId,
                  ok: false,
                  error: 'The server does not answer',
                } as HostMessage),
            );
            return;
          }
          case 'showRunOutput': {
            if (!shown) return;
            // AFS-96: on the run's own page, that page scrolls to its output; loading it again
            // flashed the page empty and left the output out of sight. Elsewhere, the run's page
            // opens at its output.
            const page = `/runs/${encodeURIComponent(shown)}`;
            const host = window.parent !== window ? window.parent : undefined;
            if (host && host.location.pathname === page)
              host.postMessage({ type: 'afs-show-output', run: shown }, window.location.origin);
            else go(`${page}#output`);
            return;
          }
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
