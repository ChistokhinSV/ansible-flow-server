// One flow on the designer's canvas, and editing its draft together (AFS-76). AFS-85: a slim line
// over the canvas leads to the flow's launch configurations and its latest runs.
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { flowLevel, useProjectAccess } from './access';
import {
  ApiError,
  api,
  type Draft,
  type DraftSummary,
  type FlowAtCommit,
  type LaunchConfig,
  type Run,
} from './api';
import { ask } from './confirm';
import { FlowFileActions, FlowFileMenu } from './flowFiles';
import { MissingProject } from './help';
import { FlowHistory, flowAt } from './history';
import { InsertFromLibrary, LibraryCopies } from './library';
import { Link, navigate, useSearch } from './router';
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
  // AFS-123: `?commit=<hash>`: the flow as that commit left it, in the Changes lens.
  const search = useSearch();
  // AFS-190: any commit asked for is the flow at a commit, never the current one to edit: the
  // start of an id (as the pages show it) is looked up, and what names no commit is refused.
  const at = new URLSearchParams(search).get('commit')?.trim() || undefined;
  const wellFormed = !!at && /^[0-9a-f]{7,40}$/i.test(at);
  const past = useLoad(
    async () =>
      project && at && wellFormed
        ? api.flowAtCommit(project.id, file, at.toLowerCase())
        : undefined,
    [project?.id, file, at],
  );
  // The commit found, by its full id: what the frame shows and the address keeps.
  const full = past.data?.commit;
  // biome-ignore lint/correctness/useExhaustiveDependencies: once the commit is found
  useEffect(() => {
    if (full && at !== full) navigate(flowAt(workspace, key, file, full), { replace: true });
  }, [full]);
  // AFS-123: the flow's history, opened from the More menu.
  const [historyOpen, setHistoryOpen] = useState(false);
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
  const [people, setPeople] = useState<
    { login: string; name: string; tabs?: number; saving?: boolean; discarding?: boolean }[]
  >([]);
  // AFS-186: the draft changes something against its commit (the frame says; unknown at first).
  const [draftChanged, setDraftChanged] = useState<boolean>();
  // AFS-186: the draft ended (saved or discarded anywhere): nothing more is said to the server.
  const draftOver = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: per draft
  useEffect(() => {
    draftOver.current = false;
  }, [editing?.id]);
  const [edits, setEdits] = useState<Activity[]>([]);
  const [said, setSaid] = useState<ReactNode>();
  // AFS-190: what was said ("Saved as …", "The draft is discarded.") is about the flow shown
  // then: another commit, or the current flow again, starts without it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: on another commit only
  useEffect(() => setSaid(undefined), [at]);
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
  /**
   * AFS-186: a draft discarded a moment ago, back as the flow's draft (anyone who was in it, for
   * the server's few minutes).
   */
  const bringBack = async (id: string) => {
    if (!project) return;
    try {
      const back = await api.restoreDraft(project.id, file, id);
      setSaid(undefined);
      setEditing(back);
    } catch (e) {
      setSaid(messageOf(e));
    }
    drafts.reload();
  };
  const backButton = (id: string) => (
    <button type="button" className="link" onClick={() => void bringBack(id)}>
      Bring back
    </button>
  );
  const stopEditing = (words?: ReactNode, discarded?: boolean) => {
    const was = editing?.id;
    setEditing(undefined);
    setStep('');
    setPeople([]);
    setEdits([]);
    setDraftChanged(undefined);
    setSaid(
      discarded && was && words ? (
        <>
          {words} {backButton(was)}
        </>
      ) : (
        words
      ),
    );
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
        people?: {
          login: string;
          name: string;
          tabs?: number;
          saving?: boolean;
          discarding?: boolean;
        }[];
        steps?: string[];
        changed?: boolean;
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
        // AFS-186: the same change again (a burst of typing) is one entry, counted.
        setEdits((e) => addActivity(e, { by, what, at: new Date().toISOString() }));
        setChanged((n) => n + 1);
      }
      if (data?.type === 'afs-draft-changed') setDraftChanged(!!data.changed);
      // AFS-136: a notice about the last thing done (an import) goes once it is taken back.
      if (data?.type === 'afs-draft-undone') setSaid(undefined);
      // AFS-149: the same person saving in another tab is "you", not their name.
      // AFS-186: or discarding it (Bring back has what was being typed).
      if (data?.type === 'afs-draft-saving') {
        typingSent.current = !!data.sent;
        const doing = data.what === 'discard' ? 'discarding' : 'saving';
        setSaid(
          `${data.mine ? `You are ${doing} the draft in another tab` : `${data.by ?? 'Someone'} is ${doing} the draft`}${data.sent ? `: what you were typing here is in it` : ''}.`,
        );
      }
      if (data?.type === 'afs-draft-saved') {
        draftOver.current = true;
        const sent = typingSent.current;
        typingSent.current = false;
        stop.current(
          <>
            {data.mine
              ? 'You saved the draft in another tab'
              : `${data.by ?? 'Someone'} saved the draft`}
            {data.commit ? <> as {commitLink.current(data.commit)}</> : null}
            {coAuthorWords(data.coAuthors)}.{sent ? ' What you were typing here is in it.' : ''}
            {data.unsent ? ' What you were typing here when it was saved may not be in it.' : ''}
          </>,
        );
      }
      // AFS-186: this page's own Discard or Stop editing then says its own words.
      if (data?.type === 'afs-draft-gone') {
        draftOver.current = true;
        stop.current(
          data.mine
            ? 'You discarded the draft in another tab.'
            : `${data.by ?? 'Someone'} discarded the draft.`,
          true,
        );
      }
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
      editing && !at ? `&draft=${encodeURIComponent(editing.id)}` : ''
    }${at && full ? `&commit=${full}&history=1` : ''}${step ? `&node=${encodeURIComponent(step)}` : ''}&theme=${theme === 'system' ? 'auto' : theme}`;
  // AFS-123: at a commit, the canvas shows unless the commit removed the flow; else unless the
  // flow is gone from the branch.
  // AFS-152: gone, and nothing of it left (no run, no configuration): it may never have been here.
  const missing = gone && !at && !configs.data?.length && !runs.data?.length;
  const noCanvas = at ? !full || past.data?.change === 'removed' : gone;
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
          {/* AFS-194: the flow by its title, as the other crumbs are names; the path is its tooltip. */}
          /{' '}
          <span aria-current="page" title={file}>
            {title}
          </span>
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
          {mayEdit && !editing && !at && project?.commit ? (
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
          {mayEdit && !editing && !at && waiting?.editors.length ? (
            <button
              type="button"
              className="danger"
              onClick={async () => {
                const question = discardQuestion(waiting.editors, me.login);
                if (question && !(await ask(question, { yes: 'Discard', danger: true }))) return;
                try {
                  await api.discardDraft(waiting.id);
                  setSaid(<>The draft is discarded. {backButton(waiting.id)}</>);
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
          {viewer && !noCanvas && (
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
          {viewer && !noCanvas && (
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
          {/* AFS-123: and the flow's History, for anyone who sees the flow (a deleted one too, to
              find its last version; not one that may never have been there). */}
          {project && !editing && project.commit && !missing && (
            <FlowFileMenu
              mayChange={mayChangeFiles && !gone && !at}
              onPick={(what) => {
                if (what !== 'history') return setFileAction(what);
                setHistoryOpen(true);
                setSaid(undefined);
              }}
            />
          )}
        </PageHead>
        {project && !editing && !at && mayChangeFiles && commit && fileAction && (
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
        {at && project ? (
          <PastNote
            at={at}
            wellFormed={wellFormed}
            past={past}
            branch={project.gitRef}
            // AFS-190: back to the flow as it is now, or to the project when it is gone.
            back={
              gone ? (
                <Link to={here}>Back to {project.name}</Link>
              ) : (
                <Link to={flowAt(workspace, key, file)}>Back to the current flow</Link>
              )
            }
            history={() => setHistoryOpen(true)}
            last={(c) => flowAt(workspace, key, file, c)}
          />
        ) : null}
        {project && !editing && !at && !(gone && !configs.data?.length && !runs.data?.length) ? (
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
                {/* AFS-194: the button named as it reads. */}
                No steps yet
                {mayEdit
                  ? `: ${waiting?.editors.length ? 'Open the draft' : 'Edit'} to add them`
                  : ''}
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
        {/* AFS-190: the flow's History under the line of its facts, not between it and the title. */}
        {historyOpen && project ? (
          <FlowHistory
            workspace={workspace}
            project={project}
            file={file}
            {...(full ? { current: full } : {})}
            onClose={() => setHistoryOpen(false)}
          />
        ) : null}
        {gone && project && !at ? (
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
        {/* AFS-186: while editing, what is said goes in the line in the head: the canvas stays. */}
        {said && !editing ? (
          <p className="notice" role="status">
            {said}
          </p>
        ) : null}
        {/* AFS-136: a draft nobody changed is not "unsaved edits" (opening it joins it). */}
        {!editing && !at && waiting && waiting.editors.length > 0 ? (
          <p className="notice" role="status">
            A draft of this flow has unsaved edits by{' '}
            {waiting.editors.map((e) => (e.login === me.login ? 'you' : e.name)).join(', ')} (begun{' '}
            <Time at={waiting.createdAt} />
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
            title={title}
            me={me.login}
            tools={tools}
            tab={tab}
            frame={() => stage.current?.querySelector('iframe') ?? null}
            // AFS-136: the others; the page's list has this person too.
            people={people.filter((p) => p.login !== me.login)}
            // AFS-149: this person's other tabs, asked for their typing too.
            myTabs={people.find((p) => p.login === me.login)?.tabs ?? 1}
            edits={edits}
            news={said}
            {...(draftChanged !== undefined ? { changed: draftChanged } : {})}
            onDone={stopEditing}
            ended={draftOver}
            saveNow={saveNow}
            link={(c) => commitLink.current(c)}
            {...(outside
              ? { outside: { ...outside, branch: project?.gitRef ?? 'the branch' } }
              : {})}
          />
        ) : null}
        {project?.commit && !at ? (
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
      {viewer && project?.commit && !noCanvas && (
        <div className="flow-stage" ref={stage}>
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
            key={`${project.commit}:${theme}:${editing?.id ?? ''}:${full ?? ''}`}
            className="flow-frame"
            // AFS-149: the frame of a draft is this page's tab (its typing is sent for a save).
            src={editing && !at ? `${viewer}&tab=${encodeURIComponent(tab)}` : viewer}
            title={
              full
                ? `The flow ${title} as commit ${full.slice(0, 12)} left it, on the designer's canvas`
                : `The flow ${title} on the designer's canvas`
            }
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
/**
 * AFS-123: over the flow at a commit: whose commit, when, its message, what it did to the flow,
 * and the way back to the flow as it is now. AFS-190: the one place the commit is said (the
 * canvas does not repeat it), in two short lines; an id that names no commit, or a commit
 * without the flow, is said here with the ways on, and nothing else shows.
 */
function PastNote({
  at,
  wellFormed,
  past,
  branch,
  back,
  history,
  last,
}: {
  /** The commit asked for, as the address has it. */
  at: string;
  /** It reads as a commit id (or the start of one). */
  wellFormed: boolean;
  past: { data?: FlowAtCommit; loading: boolean; error?: string };
  /** The project's branch. */
  branch: string;
  back: ReactNode;
  /** Opens the flow's History. */
  history(): void;
  last(commit: string): string;
}) {
  const d = past.data;
  const ways = (
    <>
      {back} ·{' '}
      <button type="button" className="link" onClick={history}>
        History of this flow
      </button>
    </>
  );
  if (!wellFormed || (!d && past.error))
    return (
      <div className="notice error past-note" role="alert" data-past="refused">
        <p>
          {wellFormed ? (
            past.error
          ) : (
            <>
              <code>{at.length > 60 ? `${at.slice(0, 59)}…` : at}</code> is not a commit id. A
              commit id is a hash such as the ones History shows.
            </>
          )}
        </p>
        <p>{ways}</p>
      </div>
    );
  if (!d) return <Loading state={past} />;
  let words: ReactNode;
  if (d.change === 'removed')
    words = (
      <>
        It removed the flow.
        {d.last ? (
          <>
            {' '}
            <Link to={last(d.last)}>Its last version</Link> ·
          </>
        ) : null}
      </>
    );
  else if (d.change === 'added') words = 'It added the flow: every step shows as new.';
  else if (d.change === 'unchanged') words = 'It did not change the flow: it shows as it was then.';
  else words = 'The Changes lens shows what it changed.';
  // AFS-190: a commit the project's branch does not have says where it is.
  const elsewhere =
    d.onBranch === false
      ? d.branches?.length
        ? ` It is not on ${branch}: it is on ${d.branches.join(', ')}.`
        : ` It is not on ${branch}, nor on another branch.`
      : '';
  return (
    <div className="notice past-note" role="status" data-past={d.change}>
      <p>
        Commit <code>{d.commit.slice(0, 12)}</code> by <strong>{d.author}</strong>,{' '}
        <Time at={d.at} />: <q>{d.subject || '(no message)'}</q>
      </p>
      <p>
        Read only. {words}
        {elsewhere} {ways}
      </p>
    </div>
  );
}

/** AFS-149: one line of the activity: who did what, when. */
export interface Activity {
  by: string;
  what: string;
  at: string;
  /** AFS-186: the same change by the same person, one after another, is one entry. */
  times?: number;
}

/** AFS-186: the activity with one more entry: the same as the newest only counts once more. */
export function addActivity(list: Activity[], next: Activity): Activity[] {
  const [first, ...rest] = list;
  if (first && first.by === next.by && first.what === next.what)
    return [{ ...next, times: (first.times ?? 1) + 1 }, ...rest];
  return [next, ...list].slice(0, 20);
}

/** AFS-186: "A", "A and B", "A, B and C". */
const listWords = (names: string[]) =>
  names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : (names[0] ?? '');

/** AFS-186: " with Mia Ortega as co-author", " with A and B as co-authors", or nothing. */
export function coAuthorWords(names?: string[]): string {
  if (!names?.length) return '';
  return ` with ${listWords(names)} as co-author${names.length > 1 ? 's' : ''}`;
}

/** AFS-186: one place a draft changes, in the activity's words ("changed Ping (timeout)"). */
function changeWords(c: DraftSummary['changes'][number]): string {
  const fields = [
    ...new Set(
      c.fields.map((f) =>
        (f.split('.').at(-1) ?? f).replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2'),
      ),
    ),
  ].slice(0, 3);
  if (c.note !== undefined)
    return `${c.kind} the note “${c.note.length > 40 ? `${c.note.slice(0, 39)}…` : c.note}”`;
  if (!c.step) return `changed the flow's ${fields.join(', ') || 'settings'}`;
  if (c.kind !== 'changed') return `${c.kind} ${c.step}`;
  return fields.length ? `changed ${c.step} (${fields.join(', ')})` : `moved ${c.step}`;
}

/**
 * AFS-186: what the Save dialog says a draft changes, a line per place with who changed it, and
 * the commit message made of it (what it changes, three places at most).
 */
export function summaryWords(summary: DraftSummary): { lines: string[]; subject: string } {
  const lines = summary.changes.map(
    (c) => `${changeWords(c)}${c.by.length ? ` (${listWords(c.by)})` : ''}`,
  );
  if (summary.wires) lines.push(`changed ${summary.wires} wire${summary.wires === 1 ? '' : 's'}`);
  const parts = summary.changes.map(changeWords);
  if (!parts.length && summary.wires) parts.push('change the wires');
  let subject = parts.slice(0, 3).join('; ');
  if (parts.length > 3) subject += ` and ${parts.length - 3} more`;
  subject = subject.replace(/^./, (c) => c.toUpperCase());
  return { lines, subject: subject.length > 72 ? `${subject.slice(0, 71)}…` : subject };
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
 * whose unsaved edits go. AFS-186: none for a draft that changes nothing and has nobody else in it
 * (nothing is lost); one that changes nothing names who is in it; Bring back keeps the edits a
 * while.
 */
export function discardQuestion(
  editors: { login: string; name: string }[],
  me: string,
  changed = true,
  here: string[] = [],
): string | undefined {
  if (!changed)
    return here.length
      ? `Discard the draft? It changes nothing, but ${listWords(here)} ${here.length === 1 ? 'is' : 'are'} in it: their editing stops.`
      : undefined;
  const names = [...new Set(editors.map((e) => (e.login === me ? 'you' : e.name)))];
  if (names.includes('you')) names.sort((a, b) => (a === 'you' ? -1 : b === 'you' ? 1 : 0));
  const whose = names.length ? `The unsaved edits by ${listWords(names)} go` : 'Its edits go';
  return `Discard the draft for everyone? ${whose} (Bring back restores them for ${KEPT_MINUTES} minutes).`;
}

/** AFS-186: how long the server keeps a discarded draft to bring back (drafts.ts). */
const KEPT_MINUTES = 15;

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

/** AFS-186: a modal dialog of the page's own, shown while `open`; Escape calls `onClose`. */
function Modal({
  open,
  label,
  onClose,
  children,
}: {
  open: boolean;
  label: string;
  onClose(): void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d || !open) return;
    if (typeof d.showModal === 'function') {
      try {
        d.showModal();
      } catch {
        d.setAttribute('open', '');
      }
    } else d.setAttribute('open', '');
    return () => {
      if (typeof d.close === 'function' && d.open) d.close();
      d.removeAttribute('open');
    };
  }, [open]);
  if (!open) return null;
  return (
    <dialog
      ref={ref}
      className="confirm draft-dialog"
      aria-label={label}
      aria-modal="true"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      {children}
    </dialog>
  );
}

/**
 * AFS-76: while a flow's draft is being edited: who is here, what the others changed lately,
 * Save (one commit, with a message) and Discard. AFS-165: Save, Stop editing and Discard sit in the
 * page's head (`tools`). AFS-186: so does one line (`line`) of who is here and what happened last,
 * the same height whoever comes and goes: nothing over or above the canvas moves it or covers it.
 * Save opens a dialog: what the draft changes and who changed each place, the commit's message
 * made of it, a note when the branch moved, and the places both changed, each with both values
 * (the draft's as they are when chosen: a change since asks again). Save is off while the draft
 * changes nothing.
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
  news,
  changed,
  onDone,
  ended,
  outside,
  saveNow,
  link,
  title,
}: {
  draft: Draft;
  me: string;
  /** AFS-194: the flow's title, for the commit message offered. */
  title?: string;
  /** Where Save, Stop editing and Discard go (the head). */
  tools: HTMLElement | null;
  tab: string;
  frame(): HTMLIFrameElement | null;
  people: { login: string; name: string; saving?: boolean; discarding?: boolean }[];
  /** How many tabs this person has the draft open in (this one too). */
  myTabs: number;
  edits: Activity[];
  /** AFS-186: the newest thing said while editing (a save coming, what an import added). */
  news?: ReactNode;
  /** AFS-186: the draft changes something (unknown: as if it did). */
  changed?: boolean;
  onDone(words?: ReactNode, discarded?: boolean): void;
  /** AFS-186: the draft ended elsewhere (saved, discarded): nothing more is said to the server. */
  ended: { current: boolean };
  /** AFS-115: the flow changed on the branch since the draft began. */
  outside?: { who: string; to: string; removed: boolean; mine: boolean; branch: string };
  saveNow: { current: () => void };
  /** A commit, as a link to the flow at it. */
  link(commit: string): ReactNode;
}) {
  const [message, setMessage] = useState('');
  // AFS-165: Save asks for the commit's message first (AFS-186: in a dialog).
  const [asking, setAsking] = useState(false);
  const [summary, setSummary] = useState<DraftSummary>();
  const [conflicts, setConflicts] = useState<Clash[]>();
  const [conflictNote, setConflictNote] = useState<string>();
  const seen = useRef<number | undefined>(undefined);
  const [choices, setChoices] = useState<Record<string, 'draft' | 'branch'>>({});
  const [error, setError] = useState<string>();
  const [hint, setHint] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [earlier, setEarlier] = useState(false);
  const [branchOpen, setBranchOpen] = useState(false);
  const messageId = useId();
  const others = listWords(people.map((p) => p.name));
  // AFS-171: while this page asks for the commit's message, the others are told a save is coming
  // (it ends the draft for everyone), before it is made. AFS-186: not once the draft ended.
  const told = useRef(false);
  const over = useRef(false);
  useEffect(() => {
    if (asking === told.current || over.current) return;
    told.current = asking;
    void api.draftSaving(draft.id, tab, asking).catch(() => undefined);
  }, [asking, draft.id, tab]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: on leaving the draft only
  useEffect(
    () => () => {
      if (told.current && !over.current && !ended.current)
        void api.draftSaving(draft.id, tab, false).catch(() => undefined);
    },
    [draft.id],
  );
  // AFS-186: what it changes, read when Save opens; the message is made of it until typed in.
  const typed = useRef(false);
  useEffect(() => {
    if (!asking) return;
    let live = true;
    void api
      .draftSummary(draft.id)
      .then((s) => {
        if (!live) return;
        setSummary(s);
        if (!typed.current) setMessage(summaryWords(s).subject);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [asking, draft.id]);
  useEffect(() => {
    if (!hint) return;
    const t = setTimeout(() => setHint(undefined), 5000);
    return () => clearTimeout(t);
  }, [hint]);
  const savers = people.filter((p) => p.saving).map((p) => p.name);
  const discarders = people.filter((p) => p.discarding).map((p) => p.name);
  const nothing = changed === false;
  const finish = (words?: ReactNode, discarded?: boolean) => {
    over.current = true;
    told.current = false;
    onDone(words, discarded);
  };
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
      !(await ask(
        `${also.join('; ').replace(/^./, (c) => c.toUpperCase())}. Saving makes the commit and ends the draft for everyone (what is being typed is sent first). Save now?`,
        { yes: 'Save' },
      ))
    )
      return;
    setBusy(true);
    setError(undefined);
    try {
      await sendTyping(frame());
      const done = await api.saveDraft(draft.id, {
        ...(message.trim() ? { message: message.trim() } : {}),
        ...(picked ? { choices: picked } : {}),
        ...(picked && seen.current !== undefined ? { seen: seen.current } : {}),
        tab,
        answerConflicts: true,
      });
      if (done.conflicts) {
        // AFS-186: the choices are for the draft as it is now; asked again when it changed.
        seen.current = done.revision;
        setConflicts(done.conflicts);
        setConflictNote(picked ? done.message : undefined);
        setChoices(
          Object.fromEntries(done.conflicts.map((c) => [c.id, picked?.[c.id] ?? 'draft'])),
        );
        return;
      }
      setAsking(false);
      finish(
        done.unchanged ? (
          'Nothing to save: the flow is as the branch has it.'
        ) : (
          <>
            Saved as {link(done.commit)}
            {done.added?.length
              ? `, with the sample's ${done.added.length} file${done.added.length === 1 ? '' : 's'}`
              : ''}
            {coAuthorWords(done.coAuthors)}.
          </>
        ),
      );
    } catch (e) {
      if (e instanceof ApiError && e.details.conflicts) setConflicts(e.details.conflicts);
      else setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };
  // AFS-165: Save (in the head, in full screen, Ctrl+S) asks for the message; asked, it saves.
  // AFS-186: a draft that changes nothing has nothing to save: said, not asked.
  saveNow.current = () => {
    if (asking) void save();
    else if (nothing && !outside) setHint('Nothing to save: the draft changes nothing yet.');
    else {
      setConflicts(undefined);
      setConflictNote(undefined);
      setError(undefined);
      setAsking(true);
    }
  };
  const closeSave = () => {
    setAsking(false);
    setConflicts(undefined);
    setConflictNote(undefined);
  };
  const discard = async () => {
    // AFS-149: who changed it, as the server has it now, and who is here. AFS-186: the others are
    // told while the question is open; a draft that changes nothing goes without one.
    const now = (await api.drafts(draft.project).catch(() => [] as Draft[])).find(
      (d) => d.id === draft.id,
    );
    const editors = [...(now?.editors ?? draft.editors), ...people];
    const question = discardQuestion(
      editors,
      me,
      !nothing,
      people.map((p) => p.name),
    );
    if (question) {
      void api.draftDiscarding(draft.id, tab, true).catch(() => undefined);
      const yes = await ask(question, { yes: 'Discard', danger: true });
      if (!yes) {
        void api.draftDiscarding(draft.id, tab, false).catch(() => undefined);
        return;
      }
    }
    try {
      await api.discardDraft(draft.id, tab);
      finish(nothing && !people.length ? undefined : 'The draft is discarded.', true);
    } catch (e) {
      setError(messageOf(e));
    }
  };
  /**
   * AFS-136: leaving a draft nobody changed (and nobody else is in) drops it. AFS-186: one that
   * changes nothing too (its edits taken back): the server decides, as it knows who is in it.
   */
  const leave = async () => {
    await api.leaveDraft(draft.id, tab).catch(() => undefined);
    finish();
  };
  const newest = edits[0];
  const say = (e: Activity) => (
    <>
      {e.by} {e.what}
      {e.times && e.times > 1 ? `, ${e.times} times` : ''} (<Time at={e.at} />)
    </>
  );
  const branchWords = outside ? (
    <>
      <strong>
        {outside.who} {outside.removed ? 'removed' : 'changed'} this flow on {outside.branch}
      </strong>{' '}
      since this draft began (now <code>{outside.to.slice(0, 12)}</code>).{' '}
      {outside.removed
        ? 'Saving puts it back with the draft’s edits.'
        : `Saving puts the draft’s edits on top of ${outside.mine ? 'that change' : 'theirs'} step by step; where both changed the same place, you choose which to keep.`}
    </>
  ) : null;
  // AFS-186: the one line in the head: a save or discard coming first, then what was said here,
  // then the newest of the others' edits.
  const coming = savers.length
    ? `${listWords(savers)} ${savers.length === 1 ? 'is' : 'are'} about to save: your editing stops then; what you type is sent first.`
    : discarders.length
      ? `${listWords(discarders)} ${discarders.length === 1 ? 'is' : 'are'} about to discard the draft: your editing stops then; Bring back restores it.`
      : undefined;
  const whoWords = `${people.length ? `Here now: you, ${others}` : 'Only you here'}${myTabs > 1 ? ' (and your other tabs)' : ''}`;
  const line = (
    <section
      className="draft-line"
      aria-label="Editing together"
      data-together={people.length > 0 || myTabs > 1 ? '' : undefined}
    >
      <span className="draft-line-who" title={whoWords}>
        {whoWords}
      </span>
      <span
        className={`draft-line-news${coming || error ? ' warn-text' : ''}`}
        role="status"
        // A long note (what an import did not map) is cut on the line: whole on hover.
        title={
          (coming ?? error ?? hint ?? (typeof news === 'string' ? news : undefined)) || undefined
        }
      >
        {coming ? (
          <strong>{coming}</strong>
        ) : error ? (
          error
        ) : hint ? (
          hint
        ) : news ? (
          news
        ) : newest ? (
          say(newest)
        ) : (
          'Edits are shared at once.'
        )}
      </span>
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
      {outside ? (
        <button
          type="button"
          className="link warn-text"
          aria-expanded={branchOpen}
          onClick={() => setBranchOpen((open) => !open)}
        >
          {outside.branch} moved
        </button>
      ) : null}
      {earlier && edits.length > 1 ? (
        <ul className="plain draft-popover">
          {edits.slice(1).map((e) => (
            <li key={`${e.at}-${e.by}-${e.what}`}>{say(e)}</li>
          ))}
        </ul>
      ) : null}
      {branchOpen && branchWords ? (
        <div className="draft-popover" role="note">
          <p>{branchWords}</p>
        </div>
      ) : null}
    </section>
  );
  const buttons = (
    <>
      {line}
      <button
        type="button"
        className="primary"
        disabled={busy || (nothing && !outside)}
        aria-expanded={asking}
        title={
          nothing && !outside
            ? 'Nothing to save: the draft changes nothing yet'
            : 'Save the draft as one commit (Ctrl+S)'
        }
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
  const summaryText = summary ? summaryWords(summary) : undefined;
  return (
    <>
      {tools ? createPortal(buttons, tools) : buttons}
      <Modal open={asking} label="Save the draft" onClose={closeSave}>
        {conflicts ? (
          <div className="draft-conflict" role="alert">
            <p>
              <strong>The branch changed the same places</strong> since this draft began. Pick which
              to keep at each:
            </p>
            {conflictNote ? <p className="warn-text">{conflictNote}.</p> : null}
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
              <button type="button" className="link" onClick={closeSave}>
                Not now
              </button>
            </div>
          </div>
        ) : (
          <form
            className="draft-save"
            aria-label="Save the draft"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            {branchWords ? <p className="notice warn">{branchWords}</p> : null}
            {summaryText?.lines.length ? (
              <div className="draft-summary">
                <p>What the draft changes, and who changed it:</p>
                <ul>
                  {summaryText.lines.map((l) => (
                    <li key={l}>{l}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            <label htmlFor={messageId}>Commit message</label>
            <input
              id={messageId}
              // biome-ignore lint/a11y/noAutofocus: the one field of what Save just opened
              autoFocus
              aria-label="What changed (the commit's message)"
              placeholder={`Edit ${title ?? draft.file}`}
              value={message}
              onChange={(e) => {
                typed.current = true;
                setMessage(e.target.value);
              }}
            />
            <small className="muted">
              Save makes one commit and ends the draft for everyone in it; whoever else changed it
              is named as a co-author.
            </small>
            {error ? <p className="notice error">{error}</p> : null}
            <div className="draft-conflict-actions">
              <button type="submit" className="primary" disabled={busy}>
                Save
              </button>
              <button type="button" onClick={closeSave}>
                Cancel
              </button>
            </div>
          </form>
        )}
      </Modal>
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
            Edits are shared at once with anyone in the draft; Ctrl+Z takes back your own last one,
            Ctrl+Y brings it back.
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
