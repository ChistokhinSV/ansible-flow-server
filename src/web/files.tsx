// AFS-78: a project's files. The tree of a branch, a file to read (and to edit, for text), and the
// changes made here, kept as a change set until Save makes one commit of them on the branch. The
// change set lives in this browser until then (a reload keeps it); the server checks it all again.
import { type ChangeEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import { changeWords, defaultMessage, whereAfter } from '../server/projects/changeWords';
import { atLeast, ProjectYourAccess, useProjectAccess } from './access';
import { ApiError, api, type FileChange, type FileEntry, type User } from './api';
import type { Editor } from './codeEditor';
import { ask } from './confirm';
import { MissingProject } from './help';
import { ProjectStatus } from './pages';
import { Link, navigate } from './router';
import { kindOf, type ThemeChoice } from './theme';
import {
  Breadcrumb,
  Loading,
  messageOf,
  PageHead,
  ProjectName,
  Tabs,
  Time,
  useLoad,
  WorkspaceName,
} from './ui';

const FLOW = /\.flow\.ya?ml$/;
/** Text the page edits; a bigger file is downloaded (the server takes 1 MB per edited file). */
const EDIT_MAX = 1024 * 1024;

export interface ChangeSet {
  /** The commit of the branch when the first change was made. */
  base?: string;
  changes: FileChange[];
  /**
   * AFS-232: the files a Save was refused over (the branch changed them since `base`) and the
   * branch's commit then. Once no change touches them, the change set begins at `head`.
   */
  conflict?: { files: string[]; head?: string };
}

/** A file as the page shows it: where it is now, its size, and what the change set did to it. */
interface Shown extends FileEntry {
  /** AFS-192: `deleted` stays in the tree, struck through, until the change set is saved. */
  state?: 'new' | 'changed' | 'moved' | 'deleted';
  from?: string;
  /** Its text in the change set (edited here); `uploaded` when new bytes came from a file. */
  text?: string;
  uploaded?: boolean;
  /** AFS-192: the uploaded bytes, for a preview of a text file. */
  base64?: string;
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
  // A file marked for deletion is not moved again, nor deleted twice.
  const under = (path: string) =>
    [...tree.keys()].filter((p) => within(p, path) && tree.get(p)?.state !== 'deleted');
  for (const c of changes) {
    if (c.op === 'write') {
      const size = c.text !== undefined ? new Blob([c.text]).size : base64Size(c.base64 ?? '');
      const was = tree.get(c.path);
      const { base64: _, ...kept } = was ?? ({} as Shown);
      tree.set(c.path, {
        ...kept,
        path: c.path,
        size,
        state: was?.state === 'new' || !was ? 'new' : 'changed',
        text: c.text,
        uploaded: c.text === undefined,
        ...(c.base64 !== undefined ? { base64: c.base64 } : {}),
        ...(c.executable !== undefined ? { executable: c.executable } : {}),
      });
    } else if (c.op === 'delete')
      for (const p of under(c.path)) {
        const file = tree.get(p) as Shown;
        // AFS-192: a file the branch has stays listed, struck through; a new one just goes.
        tree.delete(p);
        // Where the branch has it (a file moved first is deleted where it was).
        const was = file.from ?? p;
        if (file.state !== 'new') tree.set(was, { path: was, size: file.size, state: 'deleted' });
      }
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

const within = (path: string, base: string) =>
  base === '' || path === base || path.startsWith(`${base}/`);

/**
 * AFS-192: the change set with one more change. A move or delete of files that exist only in the
 * change set (uploaded or made here, not on the branch) changes those writes instead: an upload
 * moved is one "Upload <new path>", an upload deleted is taken back.
 */
export function addChange(
  changes: readonly FileChange[],
  c: FileChange,
  listed: readonly FileEntry[],
): FileChange[] {
  const path = c.op === 'move' ? c.from : c.op === 'delete' ? c.path : undefined;
  if (path === undefined || !path) return [...changes, c];
  const touches = (p: string) => within(p, path) || within(path, p);
  const onlyNew =
    !listed.some((f) => within(f.path, path)) &&
    changes.some((x) => x.op === 'write' && within(x.path, path)) &&
    changes.every((x) =>
      x.op === 'write'
        ? true
        : x.op === 'move'
          ? !touches(x.from) && !touches(x.to)
          : !touches(x.path),
    );
  if (!onlyNew) return [...changes, c];
  if (c.op === 'delete') return changes.filter((x) => !(x.op === 'write' && within(x.path, path)));
  const to = (c as { to: string }).to;
  return changes.map((x) =>
    x.op === 'write' && within(x.path, path) ? { ...x, path: to + x.path.slice(path.length) } : x,
  );
}

/** AFS-232: whether a change writes, moves or deletes `file` (or a folder it is in). */
function touchesFile(c: FileChange, file: string): boolean {
  const paths = c.op === 'move' ? [c.from, c.to] : [c.path];
  return paths.some((p) => within(file, p.replace(/\/+$/, '')));
}

/**
 * AFS-232: the change set without its change at `index`. When the changes left touch none of the
 * files a Save was refused over, it begins at the branch's commit of that refusal: they are made
 * on the branch as it is now (the old beginning refused them again however often they were
 * redone). With no change left it begins anew at the next change.
 */
export function takeBack(set: ChangeSet, index: number): ChangeSet {
  const changes = set.changes.filter((_, j) => j !== index);
  if (!changes.length) return { changes: [] };
  const { conflict, ...rest } = set;
  if (!conflict || changes.some((c) => conflict.files.some((f) => touchesFile(c, f))))
    return { ...set, changes };
  return { ...rest, ...(conflict.head ? { base: conflict.head } : {}), changes };
}

/** AFS-192: the text of uploaded bytes, when they are UTF-8 text small enough to show. */
export function uploadedText(base64: string): string | undefined {
  if (base64Size(base64) > EDIT_MAX) return undefined;
  try {
    const raw = atob(base64);
    const bytes = Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
    if (bytes.includes(0)) return undefined;
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** AFS-150: the bytes base64 stands for: its padding (= at the end) stands for none. */
export function base64Size(base64: string): number {
  const clean = base64.replace(/\s+/g, '');
  const pad = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((clean.length * 3) / 4) - pad);
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
            className={`link file${selected === f.path ? ' selected' : ''}${f.state === 'deleted' ? ' deleted' : ''}`}
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
  line,
  onChange,
}: {
  path: string;
  text: string;
  editable: boolean;
  dark: boolean;
  /** AFS-140: the cursor goes into the text once it shows (a file just made). */
  focus?: boolean;
  /** AFS-183: the line to show (where a value is defined: `?line=`). */
  line?: number;
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
          ...(line ? { line } : {}),
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

/** AFS-192: a file or folder marked for deletion, with a way to keep it. */
function DeletedNote({
  path,
  branch,
  onKeep,
}: {
  path: string;
  branch: string;
  onKeep?: ((path: string) => void) | undefined;
}) {
  return (
    <p className="muted">
      <code>{path}</code> is marked for deletion: it goes from {branch} when the changes are saved.{' '}
      {onKeep && (
        <button type="button" className="link" onClick={() => onKeep(path)}>
          Keep it
        </button>
      )}
    </p>
  );
}

/** AFS-210: a launch configuration that runs a flow the change set moves or deletes. */
interface FlowUser {
  config: { id: string; name: string; flowFile: string };
  /** Where the flow is once saved; null: deleted. */
  to: string | null;
  /** It is still a flow file there, so the configuration can follow it. */
  follows: boolean;
  /** Its schedules that are on. */
  schedules: string[];
}

const scheduleWords = (names: string[]) =>
  names.length === 1 ? `the schedule ${names[0]}` : `the schedules ${names.join(', ')}`;

/**
 * AFS-210: before Save, as Delete does on a flow's page: the configurations that run a flow the
 * change set moves or deletes, and their schedules; those of a moved flow may follow it.
 */
function FlowUsers({
  users,
  repoint,
  setRepoint,
}: {
  users: FlowUser[];
  repoint: boolean;
  setRepoint(on: boolean): void;
}) {
  const moved = users.filter((u) => u.follows);
  const gone = users.filter((u) => !u.follows);
  const offIfLeft = moved.flatMap((u) => u.schedules);
  return (
    <div className="notice warn" data-flow-users>
      {moved.length > 0 && (
        <>
          <p>
            {moved.length === 1
              ? 'A launch configuration runs a flow'
              : 'Launch configurations run flows'}{' '}
            these changes move:
          </p>
          <ul>
            {moved.map((u) => (
              <li key={u.config.id}>
                <strong>{u.config.name}</strong> runs <code>{u.config.flowFile}</code>, which moves
                to <code>{u.to}</code>
                {u.schedules.length
                  ? `; ${scheduleWords(u.schedules)} fire${u.schedules.length === 1 ? 's' : ''} it`
                  : ''}
              </li>
            ))}
          </ul>
          <label>
            <input
              type="checkbox"
              checked={repoint}
              onChange={(e) => setRepoint(e.target.checked)}
            />{' '}
            Point {moved.length === 1 ? 'it' : 'them'} at the new file in the same save
          </label>
          {!repoint && (
            <p>
              Left as {moved.length === 1 ? 'it is, it cannot' : 'they are, they cannot'} launch
              {offIfLeft.length
                ? `, and ${scheduleWords(offIfLeft)} ${offIfLeft.length === 1 ? 'is' : 'are'} turned off`
                : ''}
              .
            </p>
          )}
        </>
      )}
      {gone.length > 0 && (
        <>
          <p>
            {gone.length === 1
              ? 'A launch configuration runs a flow'
              : 'Launch configurations run flows'}{' '}
            these changes take away: {gone.length === 1 ? 'it cannot' : 'they cannot'} launch once
            saved.
          </p>
          <ul>
            {gone.map((u) => (
              <li key={u.config.id}>
                <strong>{u.config.name}</strong> runs <code>{u.config.flowFile}</code>
                {u.to === null ? (
                  ', which is deleted'
                ) : (
                  <>
                    , moved to <code>{u.to}</code>, which is not a flow file
                  </>
                )}
                {u.schedules.length
                  ? `; ${scheduleWords(u.schedules)} ${u.schedules.length === 1 ? 'is' : 'are'} turned off`
                  : ''}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
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
  // AFS-152: the titles of the flows a grant of one's own names, for the access line.
  const ownFlows =
    !!access && !access.admin && Object.values(access.flows).some((l) => l !== access.workspace);
  const titled = useLoad(
    async () => (id && ownFlows ? (await api.flows(id)).flows : undefined),
    [id, ownFlows],
  );
  const branch = params.get('branch') || project?.gitRef || 'main';
  // AFS-159: read again when a save moves the branch (the first one makes it).
  const branches = useLoad(
    async () => (id ? (await api.branches(id)).branches : []),
    [id, project?.commit],
  );
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
  const change = (c: FileChange, replaceWriteOf?: string) => {
    // AFS-150: what the last save said goes once a new change starts.
    setSaid(undefined);
    setSet((before) => {
      const base = before.base ?? listing.data?.commit;
      const changes =
        replaceWriteOf !== undefined
          ? before.changes.filter(
              (x) => !(x.op === 'write' && x.path === replaceWriteOf && x.text !== undefined),
            )
          : before.changes;
      const next = {
        ...(base ? { base } : {}),
        changes: addChange(changes, c, listing.data?.files ?? []),
      };
      if (id) keepSet(id, branch, next);
      return next;
    });
  };

  // AFS-153: a file the listing does not have is added, not edited, in the change's words.
  const existed = useMemo(() => {
    const had = new Set((listing.data?.files ?? []).map((f) => f.path));
    return (path: string) => had.has(path);
  }, [listing.data]);
  const shown = useMemo(
    () => applyChanges(listing.data?.files ?? [], set.changes),
    [listing.data, set.changes],
  );
  // AFS-192: the files there once saved (the tree also lists those marked for deletion).
  const live = useMemo(() => shown.filter((f) => f.state !== 'deleted'), [shown]);
  // AFS-94: with no file asked for, the page opens the one read first (README, else the first
  // file of the top folder) instead of an empty half.
  const first = useMemo(() => {
    const top = live.filter((f) => !f.path.includes('/'));
    return (top.find((f) => /^readme(\.|$)/i.test(f.path)) ?? top[0])?.path;
  }, [live]);
  const selected = params.get('path') ?? first;
  // AFS-183: `?line=` (where a value is defined, from the canvas): that line of the file named.
  const lineAsked = Number(params.get('line')) || undefined;
  const select = (path: string) => {
    const q = new URLSearchParams(window.location.search);
    q.set('path', path);
    // AFS-183: a line asked for is of the file the address named first.
    q.delete('line');
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
  const gone = file?.state === 'deleted';
  const folder =
    !file && selected && shown.some((f) => f.path.startsWith(`${selected}/`)) ? selected : '';
  const folderGone = !!folder && !live.some((f) => f.path.startsWith(`${folder}/`));
  const here = file ? file.path.split('/').slice(0, -1).join('/') : (folder ?? '');
  // What the change set wrote to the file (followed through moves).
  const pending =
    file && (file.text !== undefined || file.uploaded)
      ? {
          text: file.text,
          // AFS-192: an uploaded text file is shown (read only) before it is saved.
          preview: file.text === undefined && file.base64 ? uploadedText(file.base64) : undefined,
        }
      : undefined;
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
  const [said, setSaid] = useState<{
    ok?: string;
    error?: string;
    files?: string[];
    /** AFS-150: `files` are what an archive would replace, asked about before it does. */
    replaces?: boolean;
  }>();
  // AFS-210: the launch configurations that run a flow the change set moves or deletes (those that
  // follow this branch, not pinned to a commit), with their schedules that are on, named before
  // Save; those of a moved flow may follow it to its new file in the same save.
  const takes = set.changes.filter((c) => c.op === 'move' || c.op === 'delete');
  const users = useLoad(async () => {
    if (!id || !project || !takes.length) return [];
    const configs = await api.launchConfigs(id);
    const hit = configs
      .filter((c) => !c.commit && (c.gitRef ?? project.gitRef) === branch)
      .map((config) => ({ config, to: whereAfter(config.flowFile, set.changes) }))
      .filter((x) => x.to !== x.config.flowFile);
    return Promise.all(
      hit.map(async (x) => ({
        ...x,
        follows: x.to !== null && FLOW.test(x.to),
        schedules: (await api.schedules(x.config.id).catch(() => []))
          .filter((s) => s.enabled)
          .map((s) => s.name),
      })),
    );
  }, [id, branch, project?.gitRef, JSON.stringify(takes)]).data;
  const [repoint, setRepoint] = useState(true);
  const canFollow = !!users?.some((u) => u.follows);
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
    // AFS-192: the upload is what is shown next, so Rename or move is about it.
    if (picked[0]) select(join(here, picked[0].name));
  };
  /** AFS-192: the deletes that take `path` away, taken back. */
  const keep = (path: string) => {
    setSaid(undefined);
    update({
      ...set,
      changes: set.changes.filter((c) => !(c.op === 'delete' && within(path, c.path))),
    });
  };
  const onArchive = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (f) change({ op: 'unpack', path: here, base64: await base64Of(f) });
  };
  const save = async (replace = false) => {
    if (!id || !set.changes.length) return;
    setBusy(true);
    setSaid(undefined);
    try {
      const done = await api.saveFiles(id, {
        branch,
        ...(set.base ? { base: set.base } : {}),
        // AFS-232: no message when none is typed: the server writes the placeholder's words as the
        // subject and lists every change in the body (sending the placeholder read as typed).
        ...(message.trim() ? { message: message.trim() } : {}),
        ...(canFollow && repoint ? { repoint: true } : {}),
        // AFS-150: an archive replaces files that are there only once the person said it may.
        changes: replace
          ? set.changes.map((c) => (c.op === 'unpack' ? { ...c, replace: true } : c))
          : set.changes,
      });
      const n = set.changes.length;
      // AFS-154: a file or folder this save deleted is no longer shown as picked.
      const gone = set.changes.some(
        (c) =>
          c.op === 'delete' &&
          !!selected &&
          (selected === c.path || selected.startsWith(`${c.path}/`)),
      );
      if (gone) {
        const q = new URLSearchParams(window.location.search);
        q.delete('path');
        const rest = q.toString();
        // The same page: the address changes in place, and the update below draws it again.
        window.history.replaceState(
          null,
          '',
          `${window.location.pathname}${rest ? `?${rest}` : ''}`,
        );
      }
      update({ changes: [] });
      setMessage('');
      // AFS-210: what the save did to the configurations and schedules of the flows it took.
      const followed = (done.repointed ?? []).map((c) => `${c.name} now runs ${c.to}.`);
      const off = (done.turnedOff ?? []).map(
        (o) => `The schedule ${o.name} is turned off: ${o.why.replace(/^Its/, 'its')}.`,
      );
      setSaid({
        ok: done.unchanged
          ? 'Nothing to save: the branch has the files as they are.'
          : [
              `Saved ${n} change${n === 1 ? '' : 's'} as ${done.commit.slice(0, 12)} on ${done.branch}.`,
              ...followed,
              ...off,
            ].join(' '),
      });
      listing.reload();
      found.reload();
    } catch (e) {
      // AFS-232: the files main changed are kept with the change set (a reload keeps them too),
      // and the list shows the branch as it is now, where the changes are made again.
      if (e instanceof ApiError && e.code === 'conflict' && e.details.files) {
        update({
          ...set,
          conflict: {
            files: e.details.files,
            ...(e.details.head ? { head: e.details.head } : {}),
          },
        });
        listing.reload();
        // AFS-232: and the header's commit and "looked at", as the server read them again.
        found.reload();
      }
      setSaid({
        error: messageOf(e),
        ...(e instanceof ApiError && e.details.files ? { files: e.details.files } : {}),
        ...(e instanceof ApiError && e.code === 'replaces' ? { replaces: true } : {}),
      });
    } finally {
      setBusy(false);
    }
  };

  const crumbs = (
    <Breadcrumb>
      <Link to="/workspaces">Workspaces</Link> /{' '}
      <Link to={`/w/${workspace}`}>
        <WorkspaceName workspace={workspace} />
      </Link>{' '}
      /{' '}
      <Link to={`/w/${workspace}/${key}`}>
        <ProjectName workspace={workspace} project={key} />
      </Link>{' '}
      / <span aria-current="page">Files</span>
    </Breadcrumb>
  );
  if (!project)
    return found.loading ? (
      <>
        {crumbs}
        <PageHead title="Files" />
        <Loading state={found} />
      </>
    ) : (
      // AFS-143, AFS-152: what was looked for, with a way back to a page the person can open.
      <MissingProject workspace={workspace} project={key} error={found.error} />
    );
  // AFS-206: grants on some flows only reach those flows and their runs, not the files.
  if (!me.admin && access?.flowOnly)
    return (
      <>
        {crumbs}
        <PageHead title={project.name} />
        <Tabs
          label="Project"
          base={`/w/${workspace}/${key}`}
          current="files"
          tabs={[
            { key: '', label: 'Overview' },
            { key: 'runs', label: 'Runs' },
          ]}
        />
        <p className="empty">
          You see only the flows you were given here and their runs. The project's files are for who
          has access to the whole workspace: ask an administrator for it.
        </p>
      </>
    );
  const editable =
    canEdit &&
    !!file &&
    !FLOW.test(file.path) &&
    !file.link &&
    !gone &&
    (pending ? pending.text !== undefined : true);
  const text = pending?.text ?? content.data?.text;
  const dark = kindOf(theme) === 'dark';
  return (
    <>
      {crumbs}
      <PageHead
        help="web-pages.md#files-of-a-project"
        title={project.name}
        lead={
          <>
            {project.hosted ? 'Kept by this server' : `Mirror of ${project.gitUrl}`}
            {/* AFS-152: one's own access on every tab of the project, as on the others. */}
            {access && (
              <>
                {' · '}
                <ProjectYourAccess access={access} flows={titled.data} />
              </>
            )}
          </>
        }
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
          // AFS-123: as on the project's other tabs.
          ...(project.commit && (me.admin || atLeast(access?.workspace ?? null, 'ro'))
            ? [{ key: 'history', label: 'History' }]
            : []),
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
          {said.files && said.replaces ? (
            <>
              <ul>
                {said.files.map((f) => (
                  <li key={f}>
                    <code>{f}</code>
                  </li>
                ))}
              </ul>
              <p>Nothing is saved yet. Replace them with the archive's files, or take it back.</p>
              <p className="actions">
                <button type="button" onClick={() => void save(true)} disabled={busy}>
                  Replace them and save
                </button>
              </p>
            </>
          ) : said.files ? (
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
          ) : null}
        </div>
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
                check={(path) => pathProblem(path, live)}
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
              {folderGone ? (
                <DeletedNote path={folder} branch={branch} onKeep={canEdit ? keep : undefined} />
              ) : (
                canEdit && (
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
                )
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
                  {canEdit && !gone && (
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
                {file.from && file.from !== file.path && !gone ? ` · was ${file.from}` : ''}
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
          {gone && (
            <DeletedNote path={file.path} branch={branch} onKeep={canEdit ? keep : undefined} />
          )}
          {asking === 'move' && selected && (
            <PathForm
              label="New path"
              start={selected}
              check={(to) => (to === selected ? undefined : pathProblem(to, live, selected))}
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
            <p className="muted">
              {/* AFS-210: an upload over a file the branch has says it replaces it. */}
              {existed(file.from ?? file.path)
                ? `Uploaded here: it replaces ${file.from ?? file.path} on ${branch} once saved.`
                : 'Uploaded here: it is on the branch once saved.'}
            </p>
          )}
          {file && pending?.preview !== undefined && (
            <TextView
              key={`${file.path}:upload`}
              path={file.path}
              text={pending.preview}
              editable={false}
              dark={dark}
              onChange={() => undefined}
            />
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
                {...(lineAsked ? { line: lineAsked } : {})}
                onChange={(t) => change({ op: 'write', path: file.path, text: t }, file.path)}
              />
            </>
          )}
        </section>
      </div>
      {/* AFS-169: the changes come after the files and stay at the window's foot: the first
          keystroke does not push the editor down. */}
      {set.changes.length > 0 && (
        <section className="panel files-changes" aria-labelledby="changes">
          <h2 id="changes">Changes not saved ({set.changes.length})</h2>
          <ul className="change-list">
            {set.changes.map((c, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a change is its place in the set
              <li key={`${i}-${describe(c, existed)}`}>
                {describe(c, existed)}{' '}
                <button
                  type="button"
                  className="link"
                  aria-label={`Take back: ${describe(c, existed)}`}
                  onClick={() => {
                    setSaid(undefined);
                    update(takeBack(set, i));
                    // AFS-232: after a refused Save, the files as the branch has them now.
                    if (set.conflict) listing.reload();
                  }}
                >
                  Take back
                </button>
              </li>
            ))}
          </ul>
          {canEdit && !!users?.length && (
            <FlowUsers users={users} repoint={repoint} setRepoint={setRepoint} />
          )}
          {canEdit ? (
            <div className="inline-form">
              <label>
                Message{' '}
                <input
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder={defaultMessage(set.changes, existed)}
                  size={50}
                />
              </label>{' '}
              <button type="button" className="primary" onClick={() => void save()} disabled={busy}>
                {busy ? 'Saving…' : `Save to ${branch}`}
              </button>{' '}
              <button
                type="button"
                className="link"
                onClick={async () => {
                  // AFS-150: every change goes, and cannot be brought back: asked first.
                  const n = set.changes.length;
                  if (
                    !(await ask(
                      `Discard ${n === 1 ? 'the change' : `all ${n} changes`} not saved? ${n === 1 ? 'It' : 'They'} cannot be brought back.`,
                      { yes: 'Discard', danger: true },
                    ))
                  )
                    return;
                  setSaid(undefined);
                  update({ changes: [] });
                }}
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
    </>
  );
}
