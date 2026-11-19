// One flow on the designer's canvas, and editing its draft together (AFS-76). AFS-85: a slim line
// over the canvas leads to the flow's launch configurations and its latest runs.
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { flowLevel, useProjectAccess } from './access';
import { ApiError, api, type Draft, type LaunchConfig, type Run } from './api';
import { FlowFileActions, FlowFileMenu } from './flowFiles';
import { MissingProject } from './help';
import { InsertFromLibrary, LibraryCopies } from './library';
import { Link } from './router';
import { ACTIVE, RunWords } from './runs';
import { useSaveKey } from './saveKey';
import { StartFrom, type StartWhat } from './startFrom';
import type { ThemeChoice } from './theme';
import {
  Breadcrumb,
  Icon,
  Loading,
  messageOf,
  PageHead,
  ProjectName,
  Time,
  useLoad,
  WorkspaceName,
} from './ui';

/**
 * One flow on the designer's canvas, read-only. The designer is a page of its own
 * (viewer.html), shown here in a frame under the application's bar.
 */
export function FlowPage({
  me,
  workspace,
  project: key,
  file,
  theme,
}: {
  me: { login: string; name?: string };
  workspace: string;
  project: string;
  file: string;
  theme: ThemeChoice;
}) {
  const found = useLoad(
    async () => (await api.projects(workspace)).find((p) => p.key === key),
    [workspace, key],
  );
  const project = found.data;
  const flows = useLoad(
    // Nothing before the project is known: an empty list would say the flow is not there.
    async () => (project ? api.flows(project.id) : undefined),
    [project?.id, project?.commit],
  );
  const flow = flows.data?.flows.find((f) => f.file === file);
  const title = flow?.name ?? file.split('/').at(-1) ?? file;
  // AFS-76: editing the flow's draft (rw on the flow), and the drafts there are.
  const access = useProjectAccess(project?.id).data;
  // AFS-135: only a flow that is there (not a missing one) offers editing and configurations.
  const exists = !!flow;
  // AFS-147: the project's flows are read, and this one is not among them (deleted, or moved).
  const gone = !!flows.data && !flow && !flows.data.more;
  const mayEdit = exists && !!access && (access.admin || access.flows?.[file] === 'rw');
  const drafts = useLoad(
    async () => (project ? api.drafts(project.id) : ([] as Draft[])),
    [project?.id, project?.commit],
  );
  const waiting = drafts.data?.find((d) => d.file === file);
  // AFS-85: from the flow to launching it: its launch configurations and its newest runs.
  const configs = useLoad(
    async () =>
      project
        ? (await api.launchConfigs(project.id)).filter((c) => c.flowFile === file)
        : ([] as LaunchConfig[]),
    [project?.id, file],
  );
  const runs = useLoad(
    async () => (project ? api.runs({ project: project.id, flow: file, limit: 3 }) : ([] as Run[])),
    [project?.id, file],
  );
  // As on the project's page: rw on the flow adds a configuration for it.
  const mayAdd = exists && !!access && flowLevel(access, file) === 'rw';
  // AFS-109: copying and deleting the file is a change of the project's files (rw on the workspace).
  const mayChangeFiles = !!access && (access.admin || access.workspace === 'rw');
  const here = `/w/${encodeURIComponent(workspace)}/${encodeURIComponent(key)}`;
  const [editing, setEditing] = useState<Draft>();
  // AFS-107: the canvas, for Full screen; AFS-114: with what opens over it (the library picker).
  const stage = useRef<HTMLDivElement>(null);
  // AFS-149: the stage, once there, for the draft's notes laid over the canvas.
  const [stageEl, setStageEl] = useState<HTMLDivElement | null>(null);
  // AFS-149: this page, as the draft's frame and Save name it (the same person's other tabs are
  // other pages, asked for their typing before a save).
  const tab = useRef(
    globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random()}`,
  ).current;
  // AFS-149: Save in the full screen bar does what the draft bar's Save does. AFS-165: it asks for
  // the commit's message first (a second Save, or Ctrl+S, while it asks saves).
  const saveNow = useRef<() => void>(() => undefined);
  // AFS-166: Ctrl+S while editing (on the page or in the canvas) is Save.
  useSaveKey(editing ? () => saveNow.current() : undefined);
  // AFS-165: where the draft's Save, Stop editing and Discard go: the head, beside Full screen.
  const [tools, setTools] = useState<HTMLElement | null>(null);
  // AFS-164: `?step=<id>` (a link to an error on it) selects that step on the canvas.
  const [step, setStep] = useState(
    () => new URLSearchParams(window.location.search).get('step') ?? '',
  );
  // AFS-110: Copy or Delete, picked in the head's More menu.
  const [fileAction, setFileAction] = useState<'copy' | 'delete'>();
  const [people, setPeople] = useState<{ login: string; name: string; tabs?: number }[]>([]);
  const [edits, setEdits] = useState<Activity[]>([]);
  const [said, setSaid] = useState<ReactNode>();
  const [inserting, setInserting] = useState<{ level?: string; at?: { x: number; y: number } }>();
  const [starting, setStarting] = useState<StartWhat>();
  // AFS-79: the draft changed (an insert here, an edit by anyone): the library copies are read again.
  const [changed, setChanged] = useState(0);
  const reloadAll = useRef<() => void>(() => undefined);
  reloadAll.current = () => {
    found.reload();
    drafts.reload();
  };
  // AFS-139: the canvas launched a run or one it shows ended: Latest runs is read again.
  const reloadRuns = useRef<() => void>(() => undefined);
  reloadRuns.current = runs.reload;
  // A run listed there that has not ended (launched anywhere) is looked at until it ends.
  const runsGoing = !!runs.data?.some((r) => ACTIVE.includes(r.state));
  // AFS-147: a queued run is taken in a moment: looked at sooner, so the list does not say
  // "queued" while the canvas already shows it running.
  const runsQueued = !!runs.data?.some((r) => r.state === 'queued');
  useEffect(() => {
    if (!runsGoing) return;
    const timer = setInterval(() => reloadRuns.current(), runsQueued ? 1500 : 5000);
    return () => clearInterval(timer);
  }, [runsGoing, runsQueued]);
  const stopEditing = (words?: ReactNode) => {
    setEditing(undefined);
    setStep('');
    setPeople([]);
    setEdits([]);
    setSaid(words);
    // AFS-149: the canvas shows the project's commit again (the one the save made), not the one an
    // Update showed before editing.
    setShown(undefined);
    reloadAll.current();
  };
  const stop = useRef(stopEditing);
  stop.current = stopEditing;
  // AFS-136: another flow of the page (a copy just made): its forms close and the project is
  // read again, for the commit that has it.
  const lastFile = useRef(file);
  useEffect(() => {
    if (lastFile.current === file) return;
    lastFile.current = file;
    setFileAction(undefined);
    setSaid(undefined);
    reloadAll.current();
  }, [file]);
  // AFS-75: the designer's frame says which commit it shows after an Update.
  const [shown, setShown] = useState<string>();
  // AFS-149: a new commit of the project is a new frame, at that commit.
  // biome-ignore lint/correctness/useExhaustiveDependencies: on a new commit only
  useEffect(() => setShown(undefined), [project?.commit]);
  // AFS-149: this page sent its typing for a save someone is making: the saved note says so too.
  const typingSent = useRef(false);
  // AFS-149: a saved draft's commit, as a link to the flow at that commit.
  const commitLink = useRef<(commit: string) => ReactNode>((c) => <code>{c.slice(0, 12)}</code>);
  commitLink.current = (c) =>
    project ? (
      <a
        href={`/viewer.html?project=${encodeURIComponent(project.id)}&path=${encodeURIComponent(file)}&commit=${c}&theme=${theme === 'system' ? 'auto' : theme}`}
        target="_blank"
        rel="noreferrer"
        title="The flow at this commit, on a page of its own"
      >
        <code>{c.slice(0, 12)}</code>
      </a>
    ) : (
      <code>{c.slice(0, 12)}</code>
    );
  useEffect(() => {
    const heard = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as {
        type?: string;
        commit?: string;
        by?: string;
        people?: { login: string; name: string; tabs?: number }[];
        steps?: string[];
        level?: string;
        at?: { x: number; y: number };
        what?: string;
        sent?: boolean;
        mine?: boolean;
        coAuthors?: string[];
        unsent?: boolean;
      } | null;
      if (data?.type === 'afs-flow-shown' && data.commit) setShown(data.commit);
      if (data?.type === 'afs-flow-runs') reloadRuns.current();
      if (data?.type === 'afs-draft-people') setPeople(data.people ?? []);
      if (data?.type === 'afs-draft-edit' && data.by) {
        const by = data.by;
        const what = data.what ?? `changed ${data.steps?.join(', ') || 'the flow'}`;
        setEdits((e) => [{ by, what, at: new Date().toISOString() }, ...e].slice(0, 20));
        setChanged((n) => n + 1);
      }
      // AFS-136: a notice about the last thing done (an import) goes once it is taken back.
      if (data?.type === 'afs-draft-undone') setSaid(undefined);
      // AFS-149: the same person saving in another tab is "you", not their name.
      if (data?.type === 'afs-draft-saving') {
        typingSent.current = !!data.sent;
        setSaid(
          `${data.mine ? 'You are saving the draft in another tab' : `${data.by ?? 'Someone'} is saving the draft`}${data.sent ? ': what you were typing here is in it' : ''}.`,
        );
      }
      if (data?.type === 'afs-draft-saved') {
        const sent = typingSent.current;
        typingSent.current = false;
        stop.current(
          <>
            {data.mine
              ? 'You saved the draft in another tab'
              : `${data.by ?? 'Someone'} saved the draft`}
            {data.commit ? <> as {commitLink.current(data.commit)}</> : null}
            {data.coAuthors?.length ? ` with ${data.coAuthors.join(', ')} as co-authors` : ''}.
            {sent ? ' What you were typing here is in it.' : ''}
            {data.unsent ? ' What you were typing here when it was saved may not be in it.' : ''}
          </>,
        );
      }
      if (data?.type === 'afs-draft-gone')
        stop.current(`${data.by ?? 'Someone'} discarded the draft.`);
      // AFS-79: Insert Shared Subflow… on the canvas picks from the library here.
      // AFS-126: the empty canvas's Import / Open Sample pick what to start from here.
      if (data?.type === 'afs-draft-start-from' && data.what) setStarting(data.what as StartWhat);
      if (data?.type === 'afs-draft-insert-shared')
        setInserting({ level: data.level ?? 'root', ...(data.at ? { at: data.at } : {}) });
    };
    window.addEventListener('message', heard);
    return () => window.removeEventListener('message', heard);
  }, []);
  const commit = shown ?? project?.commit;
  const viewer =
    project &&
    `/viewer.html?project=${encodeURIComponent(project.id)}&path=${encodeURIComponent(file)}${
      editing ? `&draft=${encodeURIComponent(editing.id)}` : ''
    }${step ? `&node=${encodeURIComponent(step)}` : ''}&theme=${theme === 'system' ? 'auto' : theme}`;
  const edit = async () => {
    if (!project) return;
    setSaid(undefined);
    try {
      setEditing(await api.openDraft(project.id, file));
    } catch (e) {
      setSaid(messageOf(e));
    }
  };
  // AFS-115: while editing, the branch moves (a push from VS Code, another save): who changed this
  // flow since the draft began, so nobody's work is saved over unknowingly.
  const [outside, setOutside] = useState<{
    who: string;
    to: string;
    removed: boolean;
    mine: boolean;
  }>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: per draft
  useEffect(() => {
    setOutside(undefined);
    if (!editing || !project || typeof EventSource === 'undefined') return;
    const base = editing.baseCommit;
    const events = new EventSource(`/api/v1/projects/${encodeURIComponent(project.id)}/events`);
    const moved = (to?: string) => {
      if (!to || to === base) return;
      void api
        .changes(project.id, base, to)
        .then((c) => {
          const found = c.flows.find((f) => f.file === file);
          // AFS-149: the commits name their author; this person is "you", the others by name.
          const others = found?.authors.filter((a) => a !== me.name) ?? [];
          const byMe = !!found && !!me.name && found.authors.includes(me.name);
          if (found)
            setOutside({
              who: byMe
                ? `You${others.length ? ` and ${others.join(', ')}` : ''}`
                : others.join(', ') || 'Someone',
              to,
              removed: found.change === 'removed',
              mine: byMe && !others.length,
            });
        })
        .catch(() => undefined);
    };
    // `commit` comes at once and after each reconnect: the branch may have moved meanwhile.
    for (const kind of ['commit', 'moved'])
      events.addEventListener(kind, (event) => {
        const data = JSON.parse((event as MessageEvent).data) as { commit?: string; to?: string };
        moved(data.to ?? data.commit);
      });
    return () => events.close();
  }, [editing?.id, project?.id, file]);
  // AFS-113: `?edit=1` (a flow just made) opens it for editing once, then leaves the address.
  const asked = useRef(new URLSearchParams(window.location.search).get('edit') === '1');
  // AFS-160: once the project, the access and the project's flow list are all read. The list can
  // answer after the access; until it has, the flow is not known to be there and Edit was dropped.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, when all three are read
  useEffect(() => {
    // AFS-160, AFS-164: and the project's flows read, this project's (whether this one is there
    // decides who may edit it): read after the access, the address was dropped without the draft.
    if (!asked.current || !project?.commit || access === undefined) return;
    if (flows.loading || !flows.data) return;
    asked.current = false;
    window.history.replaceState(null, '', window.location.pathname);
    if (mayEdit && !editing) void edit();
  }, [project?.commit, access, flows.loading, flows.data]);
  // AFS-152: a project not there (or not shared) is the same page as on the project's address.
  if (!found.loading && !project)
    return <MissingProject workspace={workspace} project={key} error={found.error} />;
  return (
    <div className="flow-page">
      <div className="flow-head">
        <Breadcrumb>
          <Link to="/workspaces">Workspaces</Link> /{' '}
          <Link to={`/w/${workspace}`}>
            <WorkspaceName workspace={workspace} />
          </Link>{' '}
          /{' '}
          <Link to={`/w/${workspace}/${key}`}>
            <ProjectName workspace={workspace} project={key} />
          </Link>{' '}
          / <span aria-current="page">{file}</span>
        </Breadcrumb>
        <PageHead
          title={!found.loading && !project ? 'Not found' : title}
          help="web-pages.md"
          // Shown, the flow's facts are in the line under the title; editing, they are behind the
          // "i" (AFS-165): the canvas gets the room.
        >
          {editing ? <span className="draft-tools" ref={setTools} /> : null}
          {editing && project ? (
            <DraftInfo
              draft={editing}
              branch={project.gitRef}
              link={(c) => commitLink.current(c)}
            />
          ) : null}
          {mayEdit && !editing && project?.commit ? (
            <button
              type="button"
              // AFS-160: a flow with no step yet is there to be edited: Edit comes first.
              className={flow?.ok && flow.steps === 0 ? 'primary' : undefined}
              onClick={() => void edit()}
            >
              {waiting?.editors.length ? 'Open the draft' : 'Edit'}
            </button>
          ) : null}
          {/* AFS-136: a draft can be dropped from here too, without opening it. */}
          {mayEdit && !editing && waiting?.editors.length ? (
            <button
              type="button"
              className="danger"
              onClick={async () => {
                if (!window.confirm(discardQuestion(waiting.editors, me.login))) return;
                try {
                  await api.discardDraft(waiting.id);
                  setSaid('The draft is discarded.');
                } catch (e) {
                  setSaid(messageOf(e));
                }
                reloadAll.current();
              }}
            >
              Discard the draft
            </button>
          ) : null}
          {/* AFS-107: the canvas the whole screen (viewing or editing), or on a page of its own
              (with the draft while editing); icons, so the head takes little room. */}
          {viewer && !gone && (
            <button
              type="button"
              className="icon-button"
              aria-label="Full screen"
              title="Full screen (Esc to come back)"
              onClick={() => void stage.current?.requestFullscreen?.()}
            >
              <Icon name="fullscreen" />
            </button>
          )}
          {viewer && !gone && (
            <a
              href={viewer}
              target="_blank"
              rel="noreferrer"
              className="button icon-button"
              aria-label="Open on its own page"
              title={editing ? 'Open the draft on its own page' : 'Open on its own page'}
            >
              <Icon name="external" />
            </a>
          )}
          {/* AFS-152: a flow that is not there has no file to copy or delete. */}
          {project && !editing && mayChangeFiles && project.commit && !gone && (
            <FlowFileMenu onPick={setFileAction} />
          )}
        </PageHead>
        {project && !editing && mayChangeFiles && commit && fileAction && (
          <FlowFileActions
            workspace={workspace}
            project={project}
            file={file}
            name={title}
            commit={commit}
            usedBy={(configs.data ?? []).map((c) => c.name)}
            configIds={(configs.data ?? []).map((c) => c.id)}
            doing={fileAction}
            onDone={() => setFileAction(undefined)}
          />
        )}
        {/* AFS-152: a flow not there, with nothing of it left, has no facts to show. */}
        {project && !editing && !(gone && !configs.data?.length && !runs.data?.length) ? (
          <p className="statusline flow-line">
            {commit && (
              <span>
                {/* AFS-143: plain words for a flow shown and not being edited. */}
                {project.gitRef} at <code>{commit.slice(0, 12)}</code> · read only
              </span>
            )}
            {/* AFS-153: a flow with no step yet does nothing when run: it says so, and how. */}
            {flow?.ok && flow.steps === 0 && (
              <span className="warn-text" data-empty-flow>
                No steps yet{mayEdit ? ': Edit to add them' : ''}
              </span>
            )}
            {/* AFS-147: a flow that is gone offers no launch: its configurations cannot run. */}
            {gone && !!configs.data?.length && (
              <span className="warn-text">
                Its launch configurations cannot launch:{' '}
                {configs.data.map((c, i) => (
                  <span key={c.id}>
                    {i > 0 && ', '}
                    <Link to={`${here}/launch/${encodeURIComponent(c.id)}`}>{c.name}</Link>
                  </span>
                ))}
              </span>
            )}
            {!gone &&
              configs.data?.map((c) => (
                <Link key={c.id} to={`${here}/launch/${encodeURIComponent(c.id)}`}>
                  Launch: {c.name}
                </Link>
              ))}
            {configs.data?.length === 0 &&
              (mayAdd ? (
                <Link to={`${here}/launch/new?flow=${encodeURIComponent(file)}`}>
                  Add a launch configuration
                </Link>
              ) : (
                <span className="muted">No launch configuration</span>
              ))}
            {!!runs.data?.length && (
              <span>
                Latest runs:{' '}
                {runs.data.map((r, i) => (
                  <span key={r.id}>
                    {i > 0 && ', '}
                    <Link to={`/runs/${r.id}`}>
                      #{r.number} <RunWords state={r.state} against={r.decidedAgainst} />
                    </Link>
                  </span>
                ))}
              </span>
            )}
          </p>
        ) : null}
        {gone && project ? (
          // AFS-152: with nothing of it left to see (no run, no configuration), it may never have
          // been there, or not be shared: said as on every page of something not there.
          configs.data?.length || runs.data?.length ? (
            <p className="notice warn" role="status">
              There is no flow <code>{file}</code> on {project.gitRef}
              {project.commit ? (
                <>
                  {' '}
                  at <code>{project.commit.slice(0, 12)}</code>
                </>
              ) : null}
              : it was deleted or moved. Its runs stay in the history.{' '}
              <Link to={here}>Back to {project.name}</Link>
            </p>
          ) : (
            <p className="empty" data-missing="flow">
              The flow <code>{file}</code> is not here, or is not shared with you.{' '}
              <Link to={here}>Back to {project.name}</Link>
            </p>
          )
        ) : null}
        {said ? (
          <p className="notice" role="status">
            {said}
          </p>
        ) : null}
        {/* AFS-136: a draft nobody changed is not "unsaved edits" (opening it joins it). */}
        {!editing && waiting && waiting.editors.length > 0 ? (
          <p className="notice" role="status">
            Unsaved edits in the pages by{' '}
            {waiting.editors.map((e) => (e.login === me.login ? 'you' : e.name)).join(', ')} (a
            draft since <Time at={waiting.createdAt} />
            ). {/* AFS-147: a run launched from here runs the branch, never the draft. */}
            Runs use {project?.gitRef ? <code>{project.gitRef}</code> : 'the branch'}
            {project?.commit ? (
              <>
                {' '}
                at <code>{project.commit.slice(0, 12)}</code>
              </>
            ) : null}
            , not these edits: save the draft first to run them.
          </p>
        ) : null}
        {editing ? (
          <DraftBar
            draft={editing}
            me={me.login}
            tools={tools}
            tab={tab}
            frame={() => stage.current?.querySelector('iframe') ?? null}
            // AFS-136: the others; the page's list has this person too.
            people={people.filter((p) => p.login !== me.login)}
            // AFS-149: this person's other tabs, asked for their typing too.
            myTabs={people.find((p) => p.login === me.login)?.tabs ?? 1}
            edits={edits}
            onDone={stopEditing}
            stage={stageEl}
            saveNow={saveNow}
            link={(c) => commitLink.current(c)}
            {...(outside
              ? { outside: { ...outside, branch: project?.gitRef ?? 'the branch' } }
              : {})}
          />
        ) : null}
        {project?.commit ? (
          <LibraryCopies
            project={project}
            file={file}
            changed={changed}
            {...(editing ? { editing } : {})}
          />
        ) : null}
        <Loading state={found} />
      </div>
      {/* AFS-152: no canvas for a flow that is not there (it would say so in a frame of its own). */}
      {viewer && project?.commit && !gone && (
        <div
          className="flow-stage"
          ref={(el) => {
            stage.current = el;
            setStageEl(el);
          }}
        >
          {/* AFS-136: in full screen, the way back stays in sight; AFS-149: and Save. */}
          <div className="fullscreen-bar">
            {editing ? (
              <button
                type="button"
                className="primary"
                aria-label="Save the draft"
                onClick={() => saveNow.current()}
              >
                Save
              </button>
            ) : null}
            <button type="button" onClick={() => void document.exitFullscreen?.()}>
              Exit full screen
            </button>
          </div>
          <iframe
            // A new commit, theme or draft is a new page for the designer.
            key={`${project.commit}:${theme}:${editing?.id ?? ''}`}
            className="flow-frame"
            // AFS-149: the frame of a draft is this page's tab (its typing is sent for a save).
            src={editing ? `${viewer}&tab=${encodeURIComponent(tab)}` : viewer}
            title={`The flow ${title} on the designer's canvas`}
          />
          {editing && starting ? (
            <StartFrom
              draft={editing}
              what={starting}
              onDone={(words) => {
                setStarting(undefined);
                if (words) {
                  setSaid(words);
                  setChanged((n) => n + 1);
                }
              }}
            />
          ) : null}
          {editing && inserting ? (
            <InsertFromLibrary
              draft={editing}
              where={inserting}
              onDone={(words) => {
                setInserting(undefined);
                if (words) {
                  setSaid(words);
                  setChanged((n) => n + 1);
                }
              }}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}
/** AFS-149: one line of the activity: who did what, when. */
export interface Activity {
  by: string;
  what: string;
  at: string;
}

/** AFS-149: a place both the draft and the branch changed, with each side's value. */
interface Clash {
  id: string;
  label: string;
  draft?: string | null;
  branch?: string | null;
}

/**
 * AFS-149: the one question before a draft is discarded (on the flow's page and in the editor):
 * whose unsaved edits go.
 */
export function discardQuestion(editors: { login: string; name: string }[], me: string): string {
  const names = [...new Set(editors.map((e) => (e.login === me ? 'you' : e.name)))];
  if (names.includes('you')) names.sort((a, b) => (a === 'you' ? -1 : b === 'you' ? 1 : 0));
  const whose = names.length
    ? `the unsaved edits by ${names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]} go`
    : 'nobody has changed it yet';
  return `Discard the draft for everyone? It cannot be undone: ${whose}.`;
}

/**
 * AFS-136: what is being typed in the designer (a field commits when it is left) is sent before
 * a Save: the field is left, and the edit has a moment to reach the server.
 */
async function sendTyping(frame: HTMLIFrameElement | null): Promise<void> {
  const typing = frame?.contentDocument?.activeElement as HTMLElement | null | undefined;
  if (!typing || typing === frame?.contentDocument?.body) return;
  typing.blur();
  await new Promise((resolve) => setTimeout(resolve, 400));
}

/**
 * AFS-76: while a flow's draft is being edited: who is here, what the others changed lately,
 * Save (one commit, with a message) and Discard. AFS-149: a Save the branch's changes stand in the
 * way of shows each clashing place with both values and keeps the side picked per place; that
 * note, and the one saying the branch moved, lie over the canvas, so the canvas never moves.
 * AFS-165: Save, Stop editing and Discard sit in the page's head (`tools`); Save asks for the
 * commit's message over the canvas; the line about the others shows only when someone else (or
 * another tab of this person) is in the draft, so one person editing has the canvas under the head.
 */
function DraftBar({
  draft,
  me,
  tools,
  tab,
  frame,
  people,
  myTabs,
  edits,
  onDone,
  outside,
  stage,
  saveNow,
  link,
}: {
  draft: Draft;
  me: string;
  /** Where Save, Stop editing and Discard go (the head). */
  tools: HTMLElement | null;
  tab: string;
  frame(): HTMLIFrameElement | null;
  people: { login: string; name: string }[];
  /** How many tabs this person has the draft open in (this one too). */
  myTabs: number;
  edits: Activity[];
  onDone(words?: ReactNode): void;
  /** AFS-115: the flow changed on the branch since the draft began. */
  outside?: { who: string; to: string; removed: boolean; mine: boolean; branch: string };
  /** Where the notes over the canvas go. */
  stage: HTMLElement | null;
  saveNow: { current: () => void };
  /** A commit, as a link to the flow at it. */
  link(commit: string): ReactNode;
}) {
  const [message, setMessage] = useState('');
  // AFS-165: Save asks for the commit's message first.
  const [asking, setAsking] = useState(false);
  const [conflicts, setConflicts] = useState<Clash[]>();
  const [choices, setChoices] = useState<Record<string, 'draft' | 'branch'>>({});
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState<string>();
  const [earlier, setEarlier] = useState(false);
  const messageId = useId();
  const others = people.map((p) => p.name).join(', ');
  const save = async (picked?: Record<string, 'draft' | 'branch'>) => {
    if (busy) return;
    // AFS-136: saving ends the draft for everyone in it: whoever else is here is named first.
    // AFS-149: so are this person's other tabs.
    const also = [
      ...(people.length
        ? [`${others} ${people.length === 1 ? 'is' : 'are'} editing this draft too`]
        : []),
      ...(myTabs > 1 ? ['you have it open in another tab too'] : []),
    ];
    if (
      also.length &&
      !picked &&
      !window.confirm(
        `${also.join('; ').replace(/^./, (c) => c.toUpperCase())}. Saving makes the commit and ends the draft for everyone (what is being typed is sent first). Save now?`,
      )
    )
      return;
    setBusy(true);
    setError(undefined);
    try {
      await sendTyping(frame());
      const done = await api.saveDraft(draft.id, {
        ...(message.trim() ? { message: message.trim() } : {}),
        ...(picked ? { choices: picked } : {}),
        tab,
        answerConflicts: true,
      });
      setAsking(false);
      if (done.conflicts) {
        setConflicts(done.conflicts);
        setChoices(
          Object.fromEntries(done.conflicts.map((c) => [c.id, picked?.[c.id] ?? 'draft'])),
        );
        return;
      }
      onDone(
        done.unchanged ? (
          'Nothing to save: the flow is as the branch has it.'
        ) : (
          <>
            Saved as {link(done.commit)}
            {done.coAuthors?.length ? ` with ${done.coAuthors.join(', ')} as co-authors` : ''}.
          </>
        ),
      );
    } catch (e) {
      setAsking(false);
      if (e instanceof ApiError && e.details.conflicts) setConflicts(e.details.conflicts);
      else setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };
  // AFS-165: Save (in the head, in full screen, Ctrl+S) asks for the message; asked, it saves.
  saveNow.current = () => {
    if (asking) void save();
    else {
      setConflicts(undefined);
      setAsking(true);
    }
  };
  const discard = async () => {
    // AFS-149: who changed it, as the server has it now, and who is here.
    const now = (await api.drafts(draft.project).catch(() => [] as Draft[])).find(
      (d) => d.id === draft.id,
    );
    const editors = [...(now?.editors ?? draft.editors), ...people];
    if (!window.confirm(discardQuestion(editors, me))) return;
    try {
      await api.discardDraft(draft.id);
      onDone('The draft is discarded.');
    } catch (e) {
      setError(messageOf(e));
    }
  };
  /** AFS-136: leaving a draft nobody changed (and nobody else is in) drops it. */
  const leave = async () => {
    if (!people.length) {
      const now = (await api.drafts(draft.project).catch(() => [] as Draft[])).find(
        (d) => d.id === draft.id,
      );
      if (now && now.editors.length === 0) await api.discardDraft(draft.id).catch(() => undefined);
    }
    onDone();
  };
  // AFS-136: the newest edit only, on one line; the earlier ones open over the canvas.
  const newest = edits[0];
  const moved = outside && hidden !== outside.to && !conflicts;
  const notes =
    moved || conflicts || asking ? (
      <div className="draft-float">
        {asking ? (
          // AFS-165: the commit's message, asked when saving (not a field above the canvas).
          <form
            className="panel draft-save"
            aria-label="Save the draft"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <label htmlFor={messageId}>Commit message</label>
            <input
              id={messageId}
              // biome-ignore lint/a11y/noAutofocus: the one field of what Save just opened
              autoFocus
              aria-label="What changed (the commit's message)"
              placeholder={`Edit ${draft.file}`}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setAsking(false);
              }}
            />
            <small className="muted">
              Save makes one commit and ends the draft for everyone in it.
            </small>
            <div className="draft-conflict-actions">
              <button type="submit" className="primary" disabled={busy}>
                Save
              </button>
              <button type="button" onClick={() => setAsking(false)}>
                Cancel
              </button>
            </div>
          </form>
        ) : null}
        {moved ? (
          <div className="notice warn" role="status">
            <p>
              <strong>
                {outside.who} {outside.removed ? 'removed' : 'changed'} this flow on{' '}
                {outside.branch}
              </strong>{' '}
              since this draft began (now <code>{outside.to.slice(0, 12)}</code>).{' '}
              {outside.removed
                ? 'Saving puts it back with the draft’s edits.'
                : `Saving puts the draft’s edits on top of ${outside.mine ? 'that change' : 'theirs'} step by step; where both changed the same place, you choose which to keep.`}
            </p>
            <button type="button" className="link" onClick={() => setHidden(outside.to)}>
              Hide
            </button>
          </div>
        ) : null}
        {conflicts ? (
          <div className="notice error draft-conflict" role="alert">
            <p>
              <strong>The branch changed the same places</strong> since this draft began. Pick which
              to keep at each:
            </p>
            <ul className="plain draft-clashes">
              {conflicts.map((c) => (
                <li key={c.id}>
                  <code>{c.label}</code>
                  <label>
                    <input
                      type="radio"
                      name={`clash-${c.id}`}
                      checked={choices[c.id] !== 'branch'}
                      onChange={() => setChoices((now) => ({ ...now, [c.id]: 'draft' }))}
                    />{' '}
                    The draft’s: <ClashValue value={c.draft} />
                  </label>
                  <label>
                    <input
                      type="radio"
                      name={`clash-${c.id}`}
                      checked={choices[c.id] === 'branch'}
                      onChange={() => setChoices((now) => ({ ...now, [c.id]: 'branch' }))}
                    />{' '}
                    The branch’s: <ClashValue value={c.branch} />
                  </label>
                </li>
              ))}
            </ul>
            <div className="draft-conflict-actions">
              <button
                type="button"
                className="primary"
                disabled={busy}
                onClick={() =>
                  void save(
                    Object.fromEntries(conflicts.map((c) => [c.id, choices[c.id] ?? 'draft'])),
                  )
                }
              >
                Save with these
              </button>
              <button type="button" className="link" onClick={() => setConflicts(undefined)}>
                Not now
              </button>
            </div>
          </div>
        ) : null}
      </div>
    ) : null;
  const buttons = (
    <>
      <button
        type="button"
        className="primary"
        disabled={busy}
        aria-expanded={asking}
        title="Save the draft as one commit (Ctrl+S)"
        onClick={() => saveNow.current()}
      >
        Save
      </button>
      <button type="button" disabled={busy} onClick={() => void leave()}>
        Stop editing
      </button>
      <button type="button" className="danger" disabled={busy} onClick={() => void discard()}>
        Discard
      </button>
    </>
  );
  const branchMoved = !!outside && hidden === outside.to && !conflicts;
  // AFS-165: someone else (or another tab of this person) is in the draft, or was.
  const together = people.length > 0 || myTabs > 1 || edits.length > 0 || branchMoved;
  return (
    <>
      {tools ? createPortal(buttons, tools) : null}
      {notes && (stage ? createPortal(notes, stage) : notes)}
      {together ? (
        <section className="panel draft-bar" aria-label="Editing together">
          <p>
            <strong>Editing together</strong> · here now:{' '}
            {people.length ? `you, ${people.map((p) => p.name).join(', ')}` : 'only you'}
            {myTabs > 1 ? ' (you in other tabs too)' : ''}. Edits are shared at once.
          </p>
          <div className="draft-edits muted" aria-live="polite">
            {newest ? (
              <span className="draft-edits-newest">
                {newest.by} {newest.what} (<Time at={newest.at} />)
              </span>
            ) : (
              <span>What the others change shows here.</span>
            )}
            {edits.length > 1 ? (
              <button
                type="button"
                className="link"
                aria-expanded={earlier}
                onClick={() => setEarlier((open) => !open)}
              >
                {edits.length - 1} earlier
              </button>
            ) : null}
            {branchMoved ? (
              <button type="button" className="link" onClick={() => setHidden(undefined)}>
                The branch moved
              </button>
            ) : null}
            {earlier && edits.length > 1 ? (
              <ul className="plain draft-earlier panel">
                {edits.slice(1).map((e) => (
                  <li key={`${e.at}-${e.by}-${e.what}`}>
                    {e.by} {e.what} (<Time at={e.at} />)
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </section>
      ) : null}
      {error ? (
        <p className="notice error draft-error" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}

/**
 * AFS-165: "i" beside Full screen while editing: the commit the draft is of, and how editing in
 * the pages goes (shared at once, Ctrl+Z, Ctrl+S, runs use saved flows). Closes on a click
 * elsewhere or Escape.
 */
function DraftInfo({
  draft,
  branch,
  link,
}: {
  draft: Draft;
  branch: string;
  link(commit: string): ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', key);
    };
  }, [open]);
  return (
    <div className="more-menu" ref={box}>
      <button
        type="button"
        className="icon-button"
        aria-label="About this draft"
        title="The commit this draft is of, and how saving goes"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Icon name="info" />
      </button>
      {open && (
        <div className="more-menu-list draft-info" role="status">
          <p>
            A draft of {branch} at {link(draft.baseCommit)}, begun <Time at={draft.createdAt} />.
          </p>
          <p>
            Save (Ctrl+S) makes one commit on {branch} and ends the draft for everyone in it. Runs
            use saved flows: save, then launch.
          </p>
          <p>
            Edits are shared at once with anyone in the draft; Ctrl+Z takes back your own last one.
          </p>
        </div>
      )}
    </div>
  );
}

/** AFS-149: one side's value at a clashing place; none: that side removed it. */
function ClashValue({ value }: { value?: string | null }) {
  return value === null || value === undefined ? (
    <em>removed or not set</em>
  ) : (
    <code className="draft-clash-value">{value}</code>
  );
}
