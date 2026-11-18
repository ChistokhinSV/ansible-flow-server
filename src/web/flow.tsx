// One flow on the designer's canvas, and editing its draft together (AFS-76). AFS-85: a slim line
// over the canvas leads to the flow's launch configurations and its latest runs.
import { useEffect, useRef, useState } from 'react';
import { flowLevel, useProjectAccess } from './access';
import { ApiError, api, type Draft, type FlowList, type LaunchConfig, type Run } from './api';
import { FlowFileActions, FlowFileMenu } from './flowFiles';
import { InsertFromLibrary, LibraryCopies } from './library';
import { Link } from './router';
import { ACTIVE, RunWords } from './runs';
import { StartFrom, type StartWhat } from './startFrom';
import type { ThemeChoice } from './theme';
import { Breadcrumb, Icon, Loading, messageOf, PageHead, Time, useLoad, WorkspaceName } from './ui';

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
  me: { login: string };
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
    async () => (project ? api.flows(project.id) : ({ flows: [] } as FlowList)),
    [project?.id, project?.commit],
  );
  const flow = flows.data?.flows.find((f) => f.file === file);
  const title = flow?.name ?? file.split('/').at(-1) ?? file;
  // AFS-76: editing the flow's draft (rw on the flow), and the drafts there are.
  const access = useProjectAccess(project?.id).data;
  // AFS-135: only a flow that is there (not a missing one) offers editing and configurations.
  const exists = !!flow;
  // AFS-147: the project's flows are read, and this one is not among them (deleted, or moved).
  const gone = !!flows.data && !flow;
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
  // AFS-110: Copy or Delete, picked in the head's More menu.
  const [fileAction, setFileAction] = useState<'copy' | 'delete'>();
  const [people, setPeople] = useState<{ login: string; name: string }[]>([]);
  const [edits, setEdits] = useState<{ by: string; steps: string[]; at: string }[]>([]);
  const [said, setSaid] = useState<string>();
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
  const stopEditing = (words?: string) => {
    setEditing(undefined);
    setPeople([]);
    setEdits([]);
    setSaid(words);
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
  useEffect(() => {
    const heard = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as {
        type?: string;
        commit?: string;
        by?: string;
        people?: { login: string; name: string }[];
        steps?: string[];
        level?: string;
        at?: { x: number; y: number };
        what?: string;
        sent?: boolean;
      } | null;
      if (data?.type === 'afs-flow-shown' && data.commit) setShown(data.commit);
      if (data?.type === 'afs-flow-runs') reloadRuns.current();
      if (data?.type === 'afs-draft-people') setPeople(data.people ?? []);
      if (data?.type === 'afs-draft-edit' && data.by) {
        const by = data.by;
        const steps = data.steps ?? [];
        setEdits((e) => [{ by, steps, at: new Date().toISOString() }, ...e].slice(0, 5));
        setChanged((n) => n + 1);
      }
      // AFS-136: a notice about the last thing done (an import) goes once it is taken back.
      if (data?.type === 'afs-draft-undone') setSaid(undefined);
      if (data?.type === 'afs-draft-saving')
        setSaid(
          `${data.by ?? 'Someone'} is saving the draft${data.sent ? ': what you were typing is in it' : ''}.`,
        );
      if (data?.type === 'afs-draft-saved')
        stop.current(
          `${data.by ?? 'Someone'} saved the draft${data.commit ? ` as ${data.commit.slice(0, 12)}` : ''}.`,
        );
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
    }&theme=${theme === 'system' ? 'auto' : theme}`;
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
  const [outside, setOutside] = useState<{ who: string; to: string; removed: boolean }>();
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
          const mine = c.flows.find((f) => f.file === file);
          if (mine)
            setOutside({
              who: mine.authors.join(', ') || 'Someone',
              to,
              removed: mine.change === 'removed',
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, when the project is known
  useEffect(() => {
    if (!asked.current || !project?.commit || access === undefined) return;
    asked.current = false;
    window.history.replaceState(null, '', window.location.pathname);
    if (mayEdit && !editing) void edit();
  }, [project?.commit, access]);
  return (
    <div className="flow-page">
      <div className="flow-head">
        <Breadcrumb>
          <Link to="/workspaces">Workspaces</Link> /{' '}
          <Link to={`/w/${workspace}`}>
            <WorkspaceName workspace={workspace} />
          </Link>{' '}
          / <Link to={`/w/${workspace}/${key}`}>{key}</Link> /{' '}
          <span aria-current="page">{file}</span>
        </Breadcrumb>
        <PageHead
          title={!found.loading && !project ? 'Not found' : title}
          help="web-pages.md"
          // Shown, the flow's facts are in the line under the title: the canvas gets the room.
          lead={
            project && editing
              ? `Editing a draft of ${project.gitRef} at ${editing.baseCommit.slice(0, 12)} · Save makes one commit`
              : undefined
          }
        >
          {mayEdit && !editing && project?.commit ? (
            <button type="button" onClick={() => void edit()}>
              {waiting?.editors.length ? 'Open the draft' : 'Edit'}
            </button>
          ) : null}
          {/* AFS-136: a draft can be dropped from here too, without opening it. */}
          {mayEdit && !editing && waiting?.editors.length ? (
            <button
              type="button"
              className="danger"
              onClick={async () => {
                const whose = waiting.editors
                  .map((e) => (e.login === me.login ? 'yours' : `${e.name}'s`))
                  .join(', ');
                if (!window.confirm(`Discard the draft? The unsaved edits go (${whose}).`)) return;
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
          {viewer && (
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
          {viewer && (
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
          {project && !editing && mayChangeFiles && project.commit && (
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
        {project && !editing ? (
          <p className="statusline flow-line">
            {commit && (
              <span>
                {/* AFS-143: plain words for a flow shown and not being edited. */}
                {project.gitRef} at <code>{commit.slice(0, 12)}</code> · read only
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
          <p className="notice warn" role="status">
            There is no flow <code>{file}</code> on {project.gitRef}
            {project.commit ? (
              <>
                {' '}
                at <code>{project.commit.slice(0, 12)}</code>
              </>
            ) : null}
            : it was deleted or moved. Its runs stay in the history.
          </p>
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
            frame={() => stage.current?.querySelector('iframe') ?? null}
            // AFS-136: the others; the page's list has this person too.
            people={people.filter((p) => p.login !== me.login)}
            edits={edits}
            onDone={stopEditing}
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
        {!found.loading && !found.error && !project && (
          // AFS-143: names what was looked for, with the way back.
          <p className="empty">
            The project <code>{key}</code> in <code>{workspace}</code> is not here, or is not shared
            with you. <Link to={`/w/${workspace}`}>Back to {workspace}</Link>
          </p>
        )}
      </div>
      {viewer && project?.commit && (
        <div className="flow-stage" ref={stage}>
          {/* AFS-136: in full screen, the way back (and to Save) stays in sight. */}
          <div className="fullscreen-bar">
            {editing ? (
              <span className="muted small">Save is under the page: come back to save.</span>
            ) : null}
            <button type="button" onClick={() => void document.exitFullscreen?.()}>
              Exit full screen
            </button>
          </div>
          <iframe
            // A new commit, theme or draft is a new page for the designer.
            key={`${project.commit}:${theme}:${editing?.id ?? ''}`}
            className="flow-frame"
            src={viewer}
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

/**
 * AFS-76: while a flow's draft is being edited: who is here, what the others changed lately,
 * Save (one commit, with a message) and Discard. A Save the branch's changes stand in the way of
 * lists the conflicts and offers to save with the draft's side.
 */
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

function DraftBar({
  draft,
  frame,
  people,
  edits,
  onDone,
  outside,
}: {
  draft: Draft;
  frame(): HTMLIFrameElement | null;
  people: { login: string; name: string }[];
  edits: { by: string; steps: string[]; at: string }[];
  onDone(words?: string): void;
  /** AFS-115: the flow changed on the branch since the draft began. */
  outside?: { who: string; to: string; removed: boolean; branch: string };
}) {
  const [message, setMessage] = useState('');
  const [conflicts, setConflicts] = useState<{ id: string; label: string }[]>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const others = people.map((p) => p.name).join(', ');
  const save = async (force = false) => {
    // AFS-136: saving ends the draft for everyone in it: whoever else is here is named first.
    if (
      people.length &&
      !window.confirm(
        `${others} ${people.length === 1 ? 'is' : 'are'} editing this draft too. Saving makes the commit and ends the draft for everyone (what they are typing is sent first). Save now?`,
      )
    )
      return;
    setBusy(true);
    setError(undefined);
    try {
      await sendTyping(frame());
      const done = await api.saveDraft(draft.id, {
        ...(message.trim() ? { message: message.trim() } : {}),
        ...(force ? { force } : {}),
      });
      onDone(
        done.unchanged
          ? 'Nothing to save: the flow is as the branch has it.'
          : `Saved as ${done.commit.slice(0, 12)}.`,
      );
    } catch (e) {
      if (e instanceof ApiError && e.details.conflicts) setConflicts(e.details.conflicts);
      else setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };
  const discard = async () => {
    const whose = people.length ? `Your edits and ${others}'s go.` : 'Your edits go.';
    if (!window.confirm(`Discard the draft for everyone? ${whose}`)) return;
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
  // AFS-136: the newest edit only, on one line, so the canvas under the bar stays where it is.
  const newest = edits[0];
  return (
    <section className="panel draft-bar" aria-label="Editing">
      <p>
        <strong>Editing</strong> · here now:{' '}
        {people.length ? `you, ${people.map((p) => p.name).join(', ')}` : 'only you'}. Edits are
        shared at once; Ctrl+Z takes back your own last one. Runs use saved flows: Save, then
        launch.
      </p>
      {newest ? (
        <p className="muted draft-edits" aria-live="polite">
          {newest.by} changed {newest.steps.length ? newest.steps.join(', ') : 'the flow'} (
          <Time at={newest.at} />){edits.length > 1 ? ` · ${edits.length - 1} earlier` : ''}
        </p>
      ) : null}
      {outside && !conflicts ? (
        <p className="notice warn" role="status">
          <strong>
            {outside.who} {outside.removed ? 'removed' : 'changed'} this flow on {outside.branch}
          </strong>{' '}
          since this draft began (now <code>{outside.to.slice(0, 12)}</code>).{' '}
          {outside.removed
            ? 'Saving puts it back with your edits.'
            : 'Saving puts your edits on top of theirs step by step; where you both changed the same place, you choose which to keep.'}
        </p>
      ) : null}
      {conflicts ? (
        // AFS-112: one compact row: what clashed, then the choices, apart from Save below.
        <div className="notice error draft-conflict" role="alert">
          <p>
            <strong>The branch changed the same places</strong> since this draft began:{' '}
            {conflicts.map((c, i) => (
              <span key={c.id}>
                {i ? ', ' : ''}
                <code>{c.label}</code>
              </span>
            ))}
            . Saving with the draft's side overwrites them; Discard drops the draft.
          </p>
          <div className="draft-conflict-actions">
            <button type="button" disabled={busy} onClick={() => void save(true)}>
              Save with the draft's side
            </button>
            <button type="button" className="link" onClick={() => setConflicts(undefined)}>
              Not now
            </button>
          </div>
        </div>
      ) : null}
      {error ? (
        <p className="notice error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="draft-actions">
        {/* AFS-102: what the field is for, seen and not only read out. */}
        <span className="muted small">Commit message</span>
        <input
          aria-label="What changed (the commit's message)"
          placeholder={`Edit ${draft.file}`}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
        <button type="button" className="primary" disabled={busy} onClick={() => void save()}>
          Save
        </button>
        <button type="button" disabled={busy} onClick={() => void leave()}>
          Stop editing
        </button>
        <button type="button" className="danger" disabled={busy} onClick={() => void discard()}>
          Discard
        </button>
      </div>
    </section>
  );
}
