// AFS-78: a project's files. The tree of a branch, a file to read (and to edit, for text), and the
// changes made here, kept as a change set until Save makes one commit of them on the branch. The
// change set lives in this browser until then (a reload keeps it); the server checks it all again.
import { type ChangeEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import { changeWords, defaultMessage } from '../server/projects/changeWords';
import { atLeast, useProjectAccess } from './access';
import { ApiError, api, type FileChange, type FileEntry, type User } from './api';
import type { Editor } from './codeEditor';
import { ProjectStatus } from './pages';
import { Link, navigate } from './router';
import { kindOf, type ThemeChoice } from './theme';
import { Breadcrumb, Loading, messageOf, PageHead, Tabs, Time, useLoad } from './ui';

const FLOW = /\.flow\.ya?ml$/;
/** Text the page edits; a bigger file is downloaded (the server takes 1 MB per edited file). */
const EDIT_MAX = 1024 * 1024;

interface ChangeSet {
  /** The commit of the branch when the first change was made. */
  base?: string;
  changes: FileChange[];
}

/** A file as the page shows it: where it is now, its size, and what the change set did to it. */
interface Shown extends FileEntry {
  state?: 'new' | 'changed' | 'moved';
  from?: string;
  /** Its text in the change set (edited here); `uploaded` when new bytes came from a file. */
  text?: string;
  uploaded?: boolean;
}

const storeKey = (project: string, branch: string) => `afs.files.${project}.${branch}`;
function loadSet(project: string, branch: string): ChangeSet {
  try {
    const raw = window.localStorage.getItem(storeKey(project, branch));
    const parsed = raw ? (JSON.parse(raw) as ChangeSet) : undefined;
    return parsed && Array.isArray(parsed.changes) ? parsed : { changes: [] };
  } catch {
    return { changes: [] };
  }
}
function keepSet(project: string, branch: string, set: ChangeSet): void {
  try {
    if (set.changes.length)
      window.localStorage.setItem(storeKey(project, branch), JSON.stringify(set));
    else window.localStorage.removeItem(storeKey(project, branch));
  } catch {
    // Storage can be blocked or full: the change set lives as long as the page then.
  }
}

/** The files after the change set, as far as the page can tell (an archive's files show at Save). */
export function applyChanges(files: FileEntry[], changes: FileChange[]): Shown[] {
  const tree = new Map<string, Shown>(files.map((f) => [f.path, { ...f }]));
  const under = (path: string) =>
    [...tree.keys()].filter((p) => p === path || p.startsWith(`${path}/`));
  for (const c of changes) {
    if (c.op === 'write') {
      const size =
        c.text !== undefined
          ? new Blob([c.text]).size
          : Math.floor(((c.base64 ?? '').length * 3) / 4);
      const was = tree.get(c.path);
      tree.set(c.path, {
        ...(was ?? {}),
        path: c.path,
        size,
        state: was?.state === 'new' || !was ? 'new' : 'changed',
        text: c.text,
        uploaded: c.text === undefined,
        ...(c.executable !== undefined ? { executable: c.executable } : {}),
      });
    } else if (c.op === 'delete') for (const p of under(c.path)) tree.delete(p);
    else if (c.op === 'move')
      for (const p of under(c.from)) {
        const file = tree.get(p) as Shown;
        tree.delete(p);
        const to = c.to + p.slice(c.from.length);
        tree.set(to, {
          ...file,
          path: to,
          state: file.state === 'new' ? 'new' : file.state === 'changed' ? 'changed' : 'moved',
          from: file.from ?? p,
        });
      }
  }
  return [...tree.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/** Words for one change in the list (AFS-140: the same words the server commits with). */
const describe = changeWords;

/**
 * AFS-140: what is wrong with a path typed for a new file or a move, or undefined: it stays inside
 * the project, and does not land on a file or folder that is there (that one would be hidden).
 */
export function pathProblem(path: string, shown: Shown[], from?: string): string | undefined {
  const parts = path.split('/');
  if (!path || path.includes('\\') || parts.some((p) => p === '' || p === '.' || p === '..'))
    return 'A path inside the project, like playbooks/site.yml: no ../, no empty parts.';
  const inFrom = (p: string) => from !== undefined && (p === from || p.startsWith(`${from}/`));
  const there = shown.find(
    (f) => !inFrom(f.path) && (f.path === path || f.path.startsWith(`${path}/`)),
  );
  if (there) return `There is ${there.path === path ? 'a file' : 'a folder'} ${path} already.`;
  // A file cannot also be a folder: playbooks/site.yml/x is refused while site.yml is a file.
  const parent = parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'));
  const file = parent.find((p) => shown.some((f) => f.path === p && !inFrom(f.path)));
  if (file) return `${file} is a file, not a folder.`;
  return undefined;
}

const sizeWords = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1024 * 1024
      ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / 1024 / 1024).toFixed(1)} MB`;

async function base64Of(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let out = '';
  for (let at = 0; at < bytes.length; at += 0x8000)
    out += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(out);
}

/** A folder of the tree with what is in it, folders first. */
interface Folder {
  name: string;
  path: string;
  folders: Map<string, Folder>;
  files: Shown[];
}
function treeOf(files: Shown[]): Folder {
  const top: Folder = { name: '', path: '', folders: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split('/');
    let at = top;
    for (const part of parts.slice(0, -1)) {
      const path = at.path ? `${at.path}/${part}` : part;
      let next = at.folders.get(part);
      if (!next) {
        next = { name: part, path, folders: new Map(), files: [] };
        at.folders.set(part, next);
      }
      at = next;
    }
    at.files.push(f);
  }
  return top;
}

function FolderView({
  folder,
  open,
  toggle,
  selected,
  select,
}: {
  folder: Folder;
  open: Set<string>;
  toggle(path: string): void;
  selected?: string;
  select(path: string): void;
}) {
  const folders = [...folder.folders.values()].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <ul className="file-tree">
      {folders.map((f) => {
        const isOpen = open.has(f.path);
        return (
          <li key={f.path} className="file-item">
            <button
              type="button"
              className={`link folder${selected === f.path ? ' selected' : ''}`}
              aria-expanded={isOpen}
              onClick={() => {
                toggle(f.path);
                select(f.path);
              }}
            >
              {isOpen ? '▾' : '▸'} {f.name}/
            </button>
            {isOpen && (
              <FolderView
                folder={f}
                open={open}
                toggle={toggle}
                selected={selected}
                select={select}
              />
            )}
          </li>
        );
      })}
      {folder.files.map((f) => (
        <li key={f.path} className="file-item">
          <button
            type="button"
            className={`link file${selected === f.path ? ' selected' : ''}`}
            aria-current={selected === f.path ? 'true' : undefined}
            onClick={() => select(f.path)}
          >
            {f.path.split('/').pop()}
          </button>{' '}
          {f.state && <span className={`tag ${f.state}`}>{f.state}</span>}
          <span className="muted small size">{sizeWords(f.size)}</span>
        </li>
      ))}
    </ul>
  );
}

/** The editor, made when it is needed (the CodeMirror chunk loads with the first file opened). */
function TextView({
  path,
  text,
  editable,
  dark,
  focus,
  onChange,
}: {
  path: string;
  text: string;
  editable: boolean;
  dark: boolean;
  /** AFS-140: the cursor goes into the text once it shows (a file just made). */
  focus?: boolean;
  onChange(text: string): void;
}) {
  const box = useRef<HTMLElement>(null);
  const change = useRef(onChange);
  change.current = onChange;
  const [failed, setFailed] = useState(false);
  // The text is read once per file: later changes come from the editor itself.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    let editor: Editor | undefined;
    let gone = false;
    import('./codeEditor').then(
      ({ createEditor }) => {
        if (gone || !box.current) return;
        editor = createEditor(box.current, {
          path,
          text,
          editable,
          dark,
          label: `Text of ${path}`,
          onChange: (t) => change.current(t),
        });
        if (focus) editor.focus();
      },
      () => setFailed(true),
    );
    return () => {
      gone = true;
      editor?.destroy();
    };
  }, [path, editable, dark]);
  if (failed)
    return (
      <textarea
        className="code"
        aria-label={`Text of ${path}`}
        defaultValue={text}
        readOnly={!editable}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  // AFS-140: named outside the shadow root too, for tools that do not look inside it.
  return <section ref={box} className="code-editor" aria-label={`Text of ${path}`} />;
}

function PathForm({
  label,
  start,
  check,
  onDone,
}: {
  label: string;
  start: string;
  /** AFS-140: what is wrong with the path, said at once instead of at Save. */
  check?(path: string): string | undefined;
  onDone(path?: string): void;
}) {
  const [value, setValue] = useState(start);
  const [problem, setProblem] = useState<string>();
  const id = useId();
  return (
    <form
      className="inline-form"
      onSubmit={(e) => {
        e.preventDefault();
        const path = value.trim().replace(/^\/+/, '');
        const why = path ? check?.(path) : undefined;
        if (why) return setProblem(why);
        onDone(path || undefined);
      }}
    >
      <label>
        {label}{' '}
        <input
          // biome-ignore lint/a11y/noAutofocus: the field the button opened
          autoFocus
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setProblem(undefined);
          }}
          aria-label={label}
          aria-invalid={problem ? true : undefined}
          aria-describedby={problem ? `${id}-problem` : undefined}
          spellCheck={false}
        />
      </label>{' '}
      <button type="submit">OK</button>{' '}
      <button type="button" className="link" onClick={() => onDone()}>
        Cancel
      </button>
      {problem && (
        <p id={`${id}-problem`} className="bad-text" role="alert">
          {problem}
        </p>
      )}
    </form>
  );
}

export function FilesPage({
  me,
  workspace,
  project: key,
  theme,
}: {
  me: User;
  workspace: string;
  project: string;
  theme: ThemeChoice;
}) {
  const params = new URLSearchParams(window.location.search);
  const found = useLoad(
    async () => (await api.projects(workspace)).find((p) => p.key === key),
    [workspace, key],
  );
  const project = found.data;
  const id = project?.id;
  const access = useProjectAccess(id).data;
  const canEdit = me.admin || atLeast(access?.workspace ?? null, 'rw');
  const branch = params.get('branch') || project?.gitRef || 'main';
  const branches = useLoad(async () => (id ? (await api.branches(id)).branches : []), [id]);
  const listing = useLoad(async () => (id ? api.files(id, branch) : undefined), [id, branch]);
  const [set, setSet] = useState<ChangeSet>({ changes: [] });
  useEffect(() => {
    if (id) setSet(loadSet(id, branch));
  }, [id, branch]);
  const update = (next: ChangeSet) => {
    setSet(next);
    if (id) keepSet(id, branch, next);
  };
  // AFS-140: each change is added to the set as it is then, so several files picked at once (one
  // change each, made one after the other) are all kept.
  const change = (c: FileChange, replaceWriteOf?: string) =>
    setSet((before) => {
      const base = before.base ?? listing.data?.commit;
      const changes =
        replaceWriteOf !== undefined
          ? before.changes.filter(
              (x) => !(x.op === 'write' && x.path === replaceWriteOf && x.text !== undefined),
            )
          : before.changes;
      const next = { ...(base ? { base } : {}), changes: [...changes, c] };
      if (id) keepSet(id, branch, next);
      return next;
    });

  const shown = useMemo(
    () => applyChanges(listing.data?.files ?? [], set.changes),
    [listing.data, set.changes],
  );
  // AFS-94: with no file asked for, the page opens the one read first (README, else the first
  // file of the top folder) instead of an empty half.
  const first = useMemo(() => {
    const top = shown.filter((f) => !f.path.includes('/'));
    return (top.find((f) => /^readme(\.|$)/i.test(f.path)) ?? top[0])?.path;
  }, [shown]);
  const selected = params.get('path') ?? first;
  const select = (path: string) => {
    const q = new URLSearchParams(window.location.search);
    q.set('path', path);
    navigate(`${window.location.pathname}?${q.toString()}`, { replace: true });
    // The folders it is in open, so it shows in the tree.
    const parts = path.split('/');
    setOpen((o) => {
      const next = new Set(o);
      for (let i = 1; i < parts.length; i++) next.add(parts.slice(0, i).join('/'));
      return next;
    });
  };
  const [open, setOpen] = useState<Set<string>>(() => {
    const parts = (selected ?? '').split('/');
    return new Set(parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/')));
  });
  const toggle = (path: string) =>
    setOpen((o) => {
      const next = new Set(o);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const file = shown.find((f) => f.path === selected);
  const folder =
    !file && selected && shown.some((f) => f.path.startsWith(`${selected}/`)) ? selected : '';
  const here = file ? file.path.split('/').slice(0, -1).join('/') : (folder ?? '');
  // What the change set wrote to the file (followed through moves).
  const pending =
    file && (file.text !== undefined || file.uploaded) ? { text: file.text } : undefined;
  const original = file?.from ?? file?.path;
  const commit = listing.data?.commit;
  const content = useLoad(async () => {
    if (!id || !commit || !file || !original || pending || file.state === 'new') return undefined;
    if (file.size > EDIT_MAX || file.link) return { binary: true };
    const reply = await fetch(
      `/api/v1/projects/${encodeURIComponent(id)}/files/content?commit=${commit}&path=${encodeURIComponent(original)}`,
      { credentials: 'same-origin' },
    );
    if (!reply.ok) throw new ApiError(reply.status, 'error', 'The file cannot be read now');
    if (!/^text\/plain/.test(reply.headers.get('content-type') ?? '')) return { binary: true };
    return { text: await reply.text() };
  }, [id, commit, original, !!pending, file?.state]);
  const history = useLoad(
    async () =>
      id && commit && original && file?.state !== 'new'
        ? api.fileHistory(id, commit, original)
        : [],
    [id, commit, original],
  );

  const [asking, setAsking] = useState<'new' | 'move'>();
  // AFS-140: the file just made with New file, whose editor takes the cursor.
  const [made, setMade] = useState<string>();
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ ok?: string; error?: string; files?: string[] }>();
  const uploads = useRef<HTMLInputElement>(null);
  const archive = useRef<HTMLInputElement>(null);
  const join = (folderPath: string, name: string) => (folderPath ? `${folderPath}/${name}` : name);
  /** AFS-140: the change set deletes the path, or a folder it is in. */
  const deleting = (path: string) =>
    set.changes.some(
      (c) => c.op === 'delete' && (c.path === path || path.startsWith(`${c.path}/`)),
    );

  const onUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const picked = [...(e.target.files ?? [])];
    e.target.value = '';
    for (const f of picked)
      change({ op: 'write', path: join(here, f.name), base64: await base64Of(f) });
  };
  const onArchive = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (f) change({ op: 'unpack', path: here, base64: await base64Of(f) });
  };
  const save = async () => {
    if (!id || !set.changes.length) return;
    setBusy(true);
    setSaid(undefined);
    try {
      const done = await api.saveFiles(id, {
        branch,
        ...(set.base ? { base: set.base } : {}),
        // AFS-140: the message is what the placeholder showed when none is typed.
        message: message.trim() || defaultMessage(set.changes),
        changes: set.changes,
      });
      const n = set.changes.length;
      update({ changes: [] });
      setMessage('');
      setSaid({
        ok: done.unchanged
          ? 'Nothing to save: the branch has the files as they are.'
          : `Saved ${n} change${n === 1 ? '' : 's'} as ${done.commit.slice(0, 12)} on ${done.branch}.`,
      });
      listing.reload();
      found.reload();
    } catch (e) {
      setSaid({
        error: messageOf(e),
        ...(e instanceof ApiError && e.details.files ? { files: e.details.files } : {}),
      });
    } finally {
      setBusy(false);
    }
  };

  const crumbs = (
    <Breadcrumb>
      <Link to="/workspaces">Workspaces</Link> / <Link to={`/w/${workspace}`}>{workspace}</Link> /{' '}
      <Link to={`/w/${workspace}/${key}`}>{key}</Link> / <span aria-current="page">Files</span>
    </Breadcrumb>
  );
  if (!project)
    return (
      <>
        {crumbs}
        <PageHead title="Files" />
        <Loading state={found} />
        {!found.loading && !found.error && <p className="empty">There is no such project.</p>}
      </>
    );
  const editable =
    canEdit &&
    !!file &&
    !FLOW.test(file.path) &&
    !file.link &&
    (pending ? pending.text !== undefined : true);
  const text = pending?.text ?? content.data?.text;
  const dark = kindOf(theme) === 'dark';
  return (
    <>
      {crumbs}
      <PageHead
        title={project.name}
        lead={project.hosted ? 'Kept by this server' : `Mirror of ${project.gitUrl}`}
      />
      <ProjectStatus project={project} me={me} base={`/w/${workspace}/${key}`} />
      {/* AFS-94: Files is one of the project's tabs: the others stay a click away. */}
      <Tabs
        label="Project"
        base={`/w/${workspace}/${key}`}
        current="files"
        tabs={[
          { key: '', label: 'Overview' },
          { key: 'runs', label: 'Runs' },
          { key: 'files', label: 'Files' },
          {
            key: 'branches',
            label: 'Branches',
            ...(branches.data ? { count: branches.data.length } : {}),
          },
          { key: 'settings', label: 'Settings' },
        ]}
      />

      {said?.ok && (
        <p className="notice ok" role="status">
          {said.ok}
        </p>
      )}
      {said?.error && (
        <div className="notice error" role="alert">
          <p>{said.error}</p>
          {said.files && (
            <>
              <ul>
                {said.files.map((f) => (
                  <li key={f}>
                    <code>{f}</code>
                  </li>
                ))}
              </ul>
              <p>
                Take back your changes to these files, or make them again on the branch as it is
                now.
              </p>
            </>
          )}
        </div>
      )}

      {set.changes.length > 0 && (
        <section className="panel" aria-labelledby="changes">
          <h2 id="changes">Changes not saved ({set.changes.length})</h2>
          <ul className="change-list">
            {set.changes.map((c, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a change is its place in the set
              <li key={`${i}-${describe(c)}`}>
                {describe(c)}{' '}
                <button
                  type="button"
                  className="link"
                  aria-label={`Take back: ${describe(c)}`}
                  onClick={() => update({ ...set, changes: set.changes.filter((_, j) => j !== i) })}
                >
                  Take back
                </button>
              </li>
            ))}
          </ul>
          {canEdit ? (
            <div className="inline-form">
              <label>
                Message{' '}
                <input
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder={defaultMessage(set.changes)}
                  size={50}
                />
              </label>{' '}
              <button type="button" className="primary" onClick={save} disabled={busy}>
                {busy ? 'Saving…' : `Save to ${branch}`}
              </button>{' '}
              <button
                type="button"
                className="link"
                onClick={() => update({ changes: [] })}
                disabled={busy}
              >
                Discard all
              </button>
            </div>
          ) : (
            <p className="muted">Saving needs rw on the workspace.</p>
          )}
        </section>
      )}

      {/* AFS-94: what adds files is a bar over the tree and the file, not a pile in the tree's
          column. */}
      <div className="file-actions">
        <label>
          Branch{' '}
          <select
            value={branch}
            onChange={(e) => {
              const q = new URLSearchParams();
              if (e.target.value !== project.gitRef) q.set('branch', e.target.value);
              navigate(`${window.location.pathname}${q.size ? `?${q}` : ''}`);
            }}
          >
            {[...new Set([branch, ...(branches.data ?? [])])].map((b) => (
              <option key={b} value={b}>
                {b}
                {b === project.gitRef ? ' (runs)' : ''}
              </option>
            ))}
          </select>
        </label>
        {canEdit && (
          <>
            <button type="button" onClick={() => setAsking('new')}>
              New file
            </button>{' '}
            <button type="button" onClick={() => uploads.current?.click()}>
              Upload files
            </button>{' '}
            <button type="button" onClick={() => archive.current?.click()}>
              Upload a folder (zip)
            </button>
            <input
              ref={uploads}
              type="file"
              multiple
              hidden
              onChange={onUpload}
              aria-label="Files to upload"
            />
            <input
              ref={archive}
              type="file"
              accept=".zip,.tar.gz,.tgz"
              hidden
              onChange={onArchive}
              aria-label="Archive to unpack"
            />
            <p className="muted small">
              Added to {here ? <code>{here}/</code> : 'the top folder of the project'}
            </p>
            {asking === 'new' && (
              <PathForm
                label="New file"
                start={here ? `${here}/` : ''}
                check={(path) => pathProblem(path, shown)}
                onDone={(path) => {
                  setAsking(undefined);
                  if (path) {
                    change({ op: 'write', path, text: '' });
                    setMade(path);
                    select(path);
                  }
                }}
              />
            )}
          </>
        )}
      </div>
      <div className="files">
        <section className="panel files-tree" aria-labelledby="tree">
          <div className="panel-head">
            <h2 id="tree">Files</h2>
            {listing.data?.commit && (
              <span className="muted small">
                at <code>{listing.data.commit.slice(0, 12)}</code>
              </span>
            )}
          </div>
          <Loading state={listing} />
          {listing.data && !shown.length && <p className="empty">The branch has no files yet.</p>}
          <FolderView
            folder={treeOf(shown)}
            open={open}
            toggle={toggle}
            selected={selected}
            select={select}
          />
        </section>

        <section className="panel files-view" aria-labelledby="file">
          {!selected && (
            <p className="empty">
              Pick a file to read it{canEdit ? ' or change it' : ''}.
              {canEdit && ' New files and uploads go into the folder picked last.'}
            </p>
          )}
          {selected && !file && listing.data && !folder && (
            <p className="muted">
              {deleting(selected) ? (
                <>
                  <code>{selected}</code> is marked for deletion: it goes from {branch} when the
                  changes are saved. Take it back in Changes not saved to keep it.
                </>
              ) : (
                <>
                  There is no {selected} on {branch}.
                </>
              )}
            </p>
          )}
          {folder && (
            <>
              <h2 id="file">
                <code>{selected}/</code>
              </h2>
              {canEdit && (
                <p className="actions">
                  <button type="button" onClick={() => setAsking('move')}>
                    Rename or move
                  </button>{' '}
                  <button
                    type="button"
                    className="danger"
                    onClick={() => change({ op: 'delete', path: folder })}
                  >
                    Delete the folder
                  </button>
                </p>
              )}
            </>
          )}
          {file && (
            <>
              <div className="panel-head file-head">
                <h2 id="file">
                  <code>{file.path}</code>
                </h2>
                <p className="actions">
                  {FLOW.test(file.path) && file.state !== 'new' && (
                    <>
                      <Link to={`/w/${workspace}/${key}/flow/${file.path}`}>
                        Open in the flow editor
                      </Link>{' '}
                    </>
                  )}
                  {commit && file.state !== 'new' && original && (
                    <>
                      <a
                        className="button"
                        href={`/api/v1/projects/${encodeURIComponent(project.id)}/files/content?commit=${commit}&path=${encodeURIComponent(original)}&download=true`}
                        download
                      >
                        Download
                      </a>{' '}
                    </>
                  )}
                  {canEdit && (
                    <>
                      <button type="button" onClick={() => setAsking('move')}>
                        Rename or move
                      </button>{' '}
                      <button
                        type="button"
                        className="danger"
                        onClick={() => change({ op: 'delete', path: file.path })}
                      >
                        Delete
                      </button>
                    </>
                  )}
                </p>
              </div>
              <p className="muted">
                {sizeWords(file.size)}
                {file.executable ? ' · program' : ''}
                {file.link ? ' · link' : ''}
                {file.from && file.from !== file.path ? ` · was ${file.from}` : ''}
                {history.data?.[0] && (
                  <>
                    {' · last changed by '}
                    {history.data[0].author}, <Time at={history.data[0].at} />:{' '}
                    {history.data[0].subject}
                  </>
                )}
              </p>
            </>
          )}
          {asking === 'move' && selected && (
            <PathForm
              label="New path"
              start={selected}
              check={(to) => (to === selected ? undefined : pathProblem(to, shown, selected))}
              onDone={(to) => {
                setAsking(undefined);
                if (to && to !== selected) {
                  change({ op: 'move', from: selected, to });
                  select(to);
                }
              }}
            />
          )}
          {file && <Loading state={content} />}
          {file && content.data?.binary && !pending && (
            <p className="muted">
              {file.size > EDIT_MAX
                ? 'Larger than 1 MB: download it to read it.'
                : 'Not text: download it to read it.'}
            </p>
          )}
          {file && pending && pending.text === undefined && (
            <p className="muted">Uploaded here: it is on the branch once saved.</p>
          )}
          {file && text !== undefined && (pending || !content.loading) && (
            <>
              {FLOW.test(file.path) && (
                <p className="muted">
                  Flows are edited in the flow editor; here they are read only.
                </p>
              )}
              <TextView
                key={`${file.path}:${file.state === 'new' ? 'new' : commit}`}
                path={file.path}
                text={text}
                editable={editable}
                dark={dark}
                focus={made === file.path}
                onChange={(t) => change({ op: 'write', path: file.path, text: t }, file.path)}
              />
            </>
          )}
        </section>
      </div>
    </>
  );
}
