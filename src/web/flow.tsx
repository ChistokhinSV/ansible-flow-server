// One flow on the designer's canvas, and editing its draft together (AFS-76). AFS-85: a slim line
// over the canvas leads to the flow's launch configurations and its latest runs.
import { useEffect, useRef, useState } from 'react';
import { flowLevel, useProjectAccess } from './access';
import { ApiError, api, type Draft, type FlowList, type LaunchConfig, type Run } from './api';
import { FlowFileActions, FlowFileMenu } from './flowFiles';
import { InsertFromLibrary, LibraryCopies } from './library';
import { Link } from './router';
import { RunWords } from './runs';
import type { ThemeChoice } from './theme';
import { Breadcrumb, Icon, Loading, messageOf, PageHead, Time, useLoad } from './ui';

/**
 * One flow on the designer's canvas, read-only. The designer is a page of its own
 * (viewer.html), shown here in a frame under the application's bar.
 */
export function FlowPage({
  workspace,
  project: key,
  file,
  theme,
}: {
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
  const mayEdit = !!access && (access.admin || access.flows?.[file] === 'rw');
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
  const mayAdd = !!access && flowLevel(access, file) === 'rw';
  // AFS-109: copying and deleting the file is a change of the project's files (rw on the workspace).
  const mayChangeFiles = !!access && (access.admin || access.workspace === 'rw');
  const here = `/w/${encodeURIComponent(workspace)}/${encodeURIComponent(key)}`;
  const [editing, setEditing] = useState<Draft>();
  // AFS-107: the canvas's frame, for Full screen.
  const frame = useRef<HTMLIFrameElement>(null);
  // AFS-110: Copy or Delete, picked in the head's More menu.
  const [fileAction, setFileAction] = useState<'copy' | 'delete'>();
  const [people, setPeople] = useState<{ login: string; name: string }[]>([]);
  const [edits, setEdits] = useState<{ by: string; steps: string[]; at: string }[]>([]);
  const [said, setSaid] = useState<string>();
  const [inserting, setInserting] = useState<{ level?: string; at?: { x: number; y: number } }>();
  // AFS-79: the draft changed (an insert here, an edit by anyone): the library copies are read again.
  const [changed, setChanged] = useState(0);
  const reloadAll = useRef<() => void>(() => undefined);
  reloadAll.current = () => {
    found.reload();
    drafts.reload();
  };
  const stopEditing = (words?: string) => {
    setEditing(undefined);
    setPeople([]);
    setEdits([]);
    setSaid(words);
    reloadAll.current();
  };
  const stop = useRef(stopEditing);
  stop.current = stopEditing;
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
      } | null;
      if (data?.type === 'afs-flow-shown' && data.commit) setShown(data.commit);
      if (data?.type === 'afs-draft-people') setPeople(data.people ?? []);
      if (data?.type === 'afs-draft-edit' && data.by) {
        const by = data.by;
        const steps = data.steps ?? [];
        setEdits((e) => [{ by, steps, at: new Date().toISOString() }, ...e].slice(0, 5));
        setChanged((n) => n + 1);
      }
      if (data?.type === 'afs-draft-saved')
        stop.current(
          `${data.by ?? 'Someone'} saved the draft${data.commit ? ` as ${data.commit.slice(0, 12)}` : ''}.`,
        );
      if (data?.type === 'afs-draft-gone')
        stop.current(`${data.by ?? 'Someone'} discarded the draft.`);
      // AFS-79: Insert Shared Subflow… on the canvas picks from the library here.
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
  return (
    <div className="flow-page">
      <div className="flow-head">
        <Breadcrumb>
          <Link to="/workspaces">Workspaces</Link> / <Link to={`/w/${workspace}`}>{workspace}</Link>{' '}
          / <Link to={`/w/${workspace}/${key}`}>{key}</Link> /{' '}
          <span aria-current="page">{file}</span>
        </Breadcrumb>
        <PageHead
          title={title}
          // Shown, the flow's facts are in the line under the title: the canvas gets the room.
          lead={
            project && editing
              ? `Editing a draft of ${project.gitRef} at ${editing.baseCommit.slice(0, 12)} · Save makes one commit`
              : undefined
          }
        >
          {mayEdit && !editing && project?.commit ? (
            <button type="button" onClick={() => void edit()}>
              {waiting ? 'Open the draft' : 'Edit'}
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
              onClick={() => void frame.current?.requestFullscreen?.()}
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
            doing={fileAction}
            onDone={() => setFileAction(undefined)}
          />
        )}
        {project && !editing ? (
          <p className="statusline flow-line">
            {commit && (
              <span>
                {project.gitRef} at <code>{commit.slice(0, 12)}</code> · shown, not changed
              </span>
            )}
            {configs.data?.map((c) => (
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
                      #{r.number} <RunWords state={r.state} />
                    </Link>
                  </span>
                ))}
              </span>
            )}
          </p>
        ) : null}
        {said ? (
          <p className="notice" role="status">
            {said}
          </p>
        ) : null}
        {!editing && waiting ? (
          <p className="notice" role="status">
            Unsaved edits in the pages by{' '}
            {waiting.editors.length ? waiting.editors.map((e) => e.name).join(', ') : 'nobody yet'}{' '}
            (a draft since <Time at={waiting.createdAt} />
            ).
          </p>
        ) : null}
        {editing ? (
          <DraftBar draft={editing} people={people} edits={edits} onDone={stopEditing} />
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
          <p className="empty">There is no such project.</p>
        )}
      </div>
      {viewer && project?.commit && (
        <iframe
          ref={frame}
          // A new commit, theme or draft is a new page for the designer.
          key={`${project.commit}:${theme}:${editing?.id ?? ''}`}
          className="flow-frame"
          src={viewer}
          title={`The flow ${title} on the designer's canvas`}
        />
      )}
    </div>
  );
}

/**
 * AFS-76: while a flow's draft is being edited: who is here, what the others changed lately,
 * Save (one commit, with a message) and Discard. A Save the branch's changes stand in the way of
 * lists the conflicts and offers to save with the draft's side.
 */
function DraftBar({
  draft,
  people,
  edits,
  onDone,
}: {
  draft: Draft;
  people: { login: string; name: string }[];
  edits: { by: string; steps: string[]; at: string }[];
  onDone(words?: string): void;
}) {
  const [message, setMessage] = useState('');
  const [conflicts, setConflicts] = useState<{ id: string; label: string }[]>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const save = async (force = false) => {
    setBusy(true);
    setError(undefined);
    try {
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
    if (!window.confirm("Discard the draft? Everyone's unsaved edits go.")) return;
    try {
      await api.discardDraft(draft.id);
      onDone('The draft is discarded.');
    } catch (e) {
      setError(messageOf(e));
    }
  };
  return (
    <section className="panel draft-bar" aria-label="Editing">
      <p>
        <strong>Editing</strong> · here now:{' '}
        {people.length ? people.map((p) => p.name).join(', ') : 'only you'}. Edits are shared at
        once; Ctrl+Z takes back your own last one.
      </p>
      {edits.length ? (
        <ul className="muted draft-edits">
          {edits.map((e) => (
            <li key={`${e.at}${e.by}`}>
              {e.by} changed {e.steps.length ? e.steps.join(', ') : 'the flow'} (<Time at={e.at} />)
            </li>
          ))}
        </ul>
      ) : null}
      {conflicts ? (
        <div className="notice error" role="alert">
          <p>The branch changed the same places since this draft began:</p>
          <ul>
            {conflicts.map((c) => (
              <li key={c.id}>{c.label}</li>
            ))}
          </ul>
          <button type="button" disabled={busy} onClick={() => void save(true)}>
            Save with the draft's side
          </button>
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
        <button type="button" disabled={busy} onClick={() => onDone()}>
          Stop editing
        </button>
        <button type="button" className="danger" disabled={busy} onClick={() => void discard()}>
          Discard
        </button>
      </div>
    </section>
  );
}
