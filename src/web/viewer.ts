// The page that is only the designer: one flow of a project, shown and not changed. The
// designer takes a whole page (its styles and keys are the page's), so the application shows
// this page in a frame, and it can be opened on its own.
//   /viewer.html?project=<id>&path=<file in the repository>&theme=light|dark|auto
//                [&commit=<40 hex>]   the flow at that commit (a run's), not the project's
//                [&run=<run id>]      that run on the canvas, live while it goes
//                [&history=1]         AFS-123: with commit, the flow as that commit left it, in
//                                     the Changes lens against the version before (viewerPast.ts)
//                [&draft=<draft id>]  AFS-76: the flow's draft, edited (viewerDraft.ts)
//                [&tab=<id>]          AFS-149: the page (tab) around it, for a draft's Save
//                [&node=<step id>]    AFS-164: that step selected and in view (a flow's error)
// The flow comes from the server once, as a snapshot; this page answers the designer's
// messages itself. The flow's past runs are in the designer's run list; picking one shows it.
// Run opens the designer's launch dialog over a launch configuration (AFS-67, viewerLaunch.ts).
// When someone changes the flow on the branch, a bar says so (AFS-75, viewerChanges.ts).
import '@ansible-flow/designer/index.css';
import type { HostMessage, WebviewMessage } from '@ansible-flow/core/protocol';
import { mount } from '@ansible-flow/designer';
import { answerWords } from './answer';
import { isSaveKey, SAVE_KEY } from './saveKey';
import { answerCatalog } from './viewerCatalog';
import { followFlow } from './viewerChanges';
import { editDraft, openWebLink } from './viewerDraft';
import { askName, askYes, chooseConfig, launcher } from './viewerLaunch';
import { type PastFacts, showPast } from './viewerPast';
import { going, pastRunOf, type RunRecord, runnerOf, stepTitle, stopQuestion } from './viewerRuns';
import { filesAddress, flowInventory, openCodeIn, projectKeys, repoVars } from './viewerVars';

const params = new URLSearchParams(window.location.search);
const project = params.get('project') ?? '';
const path = params.get('path') ?? '';
const commit = params.get('commit') ?? '';
const runId = params.get('run') ?? '';
const node = params.get('node') ?? '';
const wanted = params.get('theme');
const theme = wanted === 'light' || wanted === 'dark' ? wanted : 'auto';
const root = document.getElementById('root') as HTMLElement;

// AFS-142: / and Ctrl+K open the pages' search on every page, also while the designer here has
// the focus: the frame hands them to the page around it (search.tsx, SEARCH_KEY).
window.addEventListener(
  'keydown',
  (e) => {
    if (window.parent === window) return;
    const t = e.target as HTMLElement | null;
    const typing = !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    if (!((e.key === 'k' && (e.ctrlKey || e.metaKey)) || (e.key === '/' && !typing))) return;
    e.preventDefault();
    window.parent.postMessage({ type: 'afs-search-key' }, window.location.origin);
    // Before the canvas: it may keep the keys it reads to itself.
  },
  true,
);

// AFS-166: Ctrl+S in the canvas is the page's Ctrl+S (a draft's Save, on the flow's page around the
// frame), and never the browser's Save page dialog. Before the canvas, which keeps keys to itself.
window.addEventListener(
  'keydown',
  (e) => {
    if (!isSaveKey(e)) return;
    e.preventDefault();
    if (window.parent !== window && !e.repeat)
      window.parent.postMessage({ type: SAVE_KEY }, window.location.origin);
  },
  true,
);

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

/** AFS-183: the project's keys for its pages' addresses, read once. */
let keysAsked: ReturnType<typeof projectKeys> | undefined;
let keys: Awaited<ReturnType<typeof projectKeys>>;
const projectKeysOnce = () => {
  keysAsked ??= projectKeys(project).then((k) => {
    keys = k;
    return k;
  });
  return keysAsked;
};

/**
 * AFS-132: Open in Text Editor in the pages: the file on its project's Files tab. Resolves with
 * false when the project or its workspace cannot be read. AFS-183: at a line, when given.
 */
async function openInFiles(file: string, line?: number): Promise<boolean> {
  const k = await projectKeysOnce().catch(() => undefined);
  if (!k) return false;
  go(filesAddress(k, file, line));
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
      ...(params.get('tab') ? { tab: params.get('tab') as string } : {}),
      ...(node ? { reveal: node } : {}),
    });
    return;
  }
  // AFS-143: the viewer opened by itself, without a flow: where flows are opened instead.
  if (!project || !path)
    return say('This address names no flow. Open a flow from its project page in Workspaces.');
  // AFS-123: the flow as a commit left it, in the Changes lens against the version before.
  if (params.get('history') === '1' && /^[0-9a-f]{40}$/.test(commit)) return startPast();
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
          : (flow.data?.message ?? answerWords(flow.status)),
    );

  const access = await accessAsked;
  const operate = mayOperate(access?.ok ? (access.data as ProjectAccess) : undefined, path);
  const manage = mayManage(access?.ok ? (access.data as ProjectAccess) : undefined, path);
  // AFS-105: on a run's page the page shows the run (state, hosts, outputs, approvals, Stop, Run
  // again): the canvas does not repeat it. Elsewhere it launches and stops for an operator.
  // AFS-153: the canvas tells runs in the pages' words (check run, went well, stopped).
  const embed = {
    runShown: !!runId,
    mayRun: operate && !commit,
    mayStop: operate,
    words: 'server' as const,
  };

  const listeners = new Set<(message: HostMessage) => void>();
  // The designer expects answers after its own call returns, as from a real host.
  const tell = (message: HostMessage) =>
    setTimeout(() => {
      for (const listener of listeners) listener(message);
    }, 0);
  // AFS-183: the repository's variables at the commit shown, for where a value comes from. A
  // run's page uses the run's inventory; elsewhere the flow's launch configurations'.
  const vars = repoVars({
    project,
    commit: flow.data.commit,
    inventory: async () => {
      if (runId) {
        const run = await get(`/api/v1/runs/${encodeURIComponent(runId)}`);
        return run.ok ? String(run.data?.inventory ?? '') : '';
      }
      const configs = await get(`/api/v1/projects/${encodeURIComponent(project)}/launch-configs`);
      return configs.ok ? flowInventory(configs.data ?? [], path) : '';
    },
    send: tell,
  });
  void projectKeysOnce();
  /** What goes to the designer; each snapshot with the repository's findings once they are in. */
  const send = (message: HostMessage) =>
    tell(
      message.type === 'snapshot'
        ? { ...message, snapshot: vars.snapshot(message.snapshot) }
        : message,
    );
  // AFS-152: the canvas here only shows the flow; Delete on it is not ignored without a word.
  let toldReadOnly = 0;
  window.addEventListener('keydown', (e) => {
    if ((e.key !== 'Delete' && e.key !== 'Backspace') || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (e.repeat || Date.now() - toldReadOnly < 4000) return;
    toldReadOnly = Date.now();
    send({
      type: 'notify',
      level: 'info',
      text:
        manage && !runId && !commit
          ? 'The flow is shown read only: Edit on its page opens a draft to change it.'
          : 'The flow is shown read only: changing it needs read and write access to it.',
    });
  });
  /** The run on the canvas now, for a step's host output and Stop. */
  let shown = runId;
  /** AFS-185: the step it was last seen in, for Stop's question. */
  let lastRunning: string | undefined;
  let stream: EventSource | undefined;
  /** AFS-139: the flow's runs as last read, newest first. */
  let known: RunRecord[] = [];
  /** AFS-139: tells the page around the frame that the flow's runs changed (Latest runs). */
  const runsChanged = () => {
    if (window.parent !== window)
      window.parent.postMessage({ type: 'afs-flow-runs' }, window.location.origin);
  };

  /** Shows a run on the canvas: live while it goes, from its record once it ended. */
  const showRun = (id: string, past: boolean) => {
    shown = id;
    stream?.close();
    const events = new EventSource(`/api/v1/runs/${encodeURIComponent(id)}/events`);
    stream = events;
    // AFS-139: the run's record (the events send it first) says where it ran and how it stands.
    let record = known.find((r) => r.id === id);
    let ended = !!record && !going(record.state);
    events.addEventListener('run', (event) => {
      record = JSON.parse((event as MessageEvent).data) as RunRecord;
    });
    events.addEventListener('view', (event) => {
      const view = JSON.parse((event as MessageEvent).data);
      lastRunning = view?.summary?.running;
      void decidable(id, view).then((approvals) =>
        // Named by the server's run id, as the run list names it, so the canvas knows it there.
        send({
          type: 'run',
          run: {
            ...view,
            ...(record ? runnerOf(record) : {}),
            id,
            ...(approvals ? { approvals } : {}),
            ...(past ? { past: true } : {}),
          },
        }),
      );
    });
    events.addEventListener('end', () => {
      events.close();
      // AFS-139: a run that ended while shown: the run list and the page's Latest runs say how.
      if (!ended) {
        ended = true;
        void runs();
        runsChanged();
      }
    });
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
    type Told = {
      node: { id: string };
      mayDecide: boolean;
      deciders?: string[];
      hosts?: string[];
      next?: Record<string, string>;
    };
    const told = new Map((gates.data as Told[]).map((g) => [g.node.id, g]));
    return Object.fromEntries(
      Object.entries(approvals).map(([node, a]) => {
        const g = told.get(node);
        if (a.status !== 'waiting' || !g) return [node, a];
        // AFS-146: and who may decide it, the hosts that wait, and where each decision sends
        // them, for the node's Run tab.
        return [
          node,
          {
            ...a,
            ...(g.mayDecide ? { mayDecide: true } : {}),
            ...(g.deciders ? { deciders: g.deciders } : {}),
            ...(g.hosts?.length ? { hosts: g.hosts } : {}),
            ...(g.next ? { next: g.next } : {}),
          },
        ];
      }),
    );
  };

  const runs = async () => {
    const list = await get(
      `/api/v1/runs?project=${encodeURIComponent(project)}&flow=${encodeURIComponent(path)}&limit=50`,
    ).catch(() => undefined);
    if (!list?.ok) return;
    known = list.data as RunRecord[];
    send({ type: 'runs', runs: known.map(pastRunOf) });
  };
  /**
   * AFS-139: the flow page shows the flow's newest run on the canvas, the one its header lists
   * first: live while it goes, else as it ended. Not on a run's page (it names its run) nor at
   * an older commit.
   */
  const showLatest = async () => {
    await runs();
    const latest = known[0];
    if (latest && !shown) showRun(latest.id, !going(latest.state));
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
      void runs().then(() => showRun(id, false));
      runsChanged();
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
    onCommit: (c) => vars.at(c),
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
            // AFS-164: the step a link names (an error on it): selected, its level open.
            if (node) send({ type: 'reveal', node });
            if (runId) {
              void runs();
              showRun(runId, false);
            } else if (commit) void runs();
            else void showLatest();
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
            // AFS-139: a run picked from the list that has not ended is followed live.
            showRun(message.id, !going(known.find((r) => r.id === message.id)?.state));
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
          case 'openCode':
            // AFS-183: where a value is defined: the Files tab at that line.
            openCodeIn(keys, message.path, message.line, (file, line) => {
              void openInFiles(file, line).then((opened) => {
                if (!opened)
                  send({
                    type: 'notify',
                    level: 'error',
                    text: `${file} could not be opened: open it on the project's Files tab.`,
                  });
              });
            });
            return;
          case 'catalog':
            // AFS-118: a step's module docs, from the catalog of the flow's image.
            answerCatalog(project, path, message, send);
            return;
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
          case 'stopRun': {
            const id = shown;
            if (!id) return;
            void (async () => {
              // AFS-185: a real run asks first, as Launch and Run again do.
              const record =
                known.find((r) => r.id === id) ??
                ((await get(`/api/v1/runs/${encodeURIComponent(id)}`).catch(() => undefined))
                  ?.data as RunRecord | undefined);
              if (record?.mode === 'real') {
                const step = stepTitle(flow.data.snapshot?.doc, lastRunning);
                const question = stopQuestion({
                  number: record.number,
                  state: record.state,
                  ...(step ? { step } : {}),
                });
                if (!(await askYes(question, 'Stop the run'))) return;
              }
              const reply = await fetch(`/api/v1/runs/${encodeURIComponent(id)}/cancel`, {
                method: 'POST',
                credentials: 'same-origin',
              });
              if (!reply.ok)
                send({ type: 'notify', level: 'error', text: 'You may not stop this run' });
            })();
            return;
          }
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
              if (reply.ok) {
                // AFS-146: the page around the frame counts what waits again at once (its
                // Approvals badge) and reads the run's approvals again.
                if (window.parent !== window)
                  window.parent.postMessage(
                    { type: 'afs-approvals-changed' },
                    window.location.origin,
                  );
                return;
              }
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

/** AFS-123: the flow at `commit`, a past version on the canvas (viewerPast.ts). */
async function startPast(): Promise<void> {
  const p = encodeURIComponent(project);
  const f = encodeURIComponent(path);
  let facts: Awaited<ReturnType<typeof get>>;
  try {
    facts = await get(`/api/v1/projects/${p}/flows/commit?path=${f}&commit=${commit}`);
  } catch {
    return say('The server does not answer.');
  }
  if (!facts.ok)
    return say(
      facts.status === 401
        ? 'Sign in to see this flow.'
        : facts.status === 404
          ? `The flow ${path} is not at this commit, or is not shared with you.`
          : (facts.data?.message ?? answerWords(facts.status)),
    );
  const told = facts.data as PastFacts;
  if (told.change === 'removed')
    return say(`Commit ${commit.slice(0, 12)} removed the flow ${path}: it has no version here.`);
  const [shown, before] = await Promise.all([
    get(`/api/v1/projects/${p}/flows/view?path=${f}&commit=${commit}`).catch(() => undefined),
    told.before
      ? get(`/api/v1/projects/${p}/flows/view?path=${f}&commit=${told.before}`).catch(
          () => undefined,
        )
      : undefined,
  ]);
  if (!shown?.ok)
    return say(shown?.data?.message ?? `The flow ${path} cannot be read at this commit.`);
  showPast({
    root,
    project,
    path,
    theme,
    facts: told,
    snapshot: shown.data.snapshot,
    ...(before?.ok && before.data?.snapshot?.doc ? { before: before.data.snapshot.doc } : {}),
  });
}

void start();
