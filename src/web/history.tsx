// AFS-123: history in the pages, as the designer's History in VS Code (AFD-320). A project's History
// tab: the commits of a branch, newest first, a filter (words in the message, author, hash or a
// changed file) and more on request; a commit opens to the files it changed, flows by their title,
// each leading to the flow as that commit left it. A flow's page lists the commits of that flow
// (its flow and scenarios files) the same way.
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { api, type CommitDetails, type CommitSummary, type Project } from './api';
import { Link } from './router';
import { Loading, messageOf, Time, useLoad } from './ui';

/** How many commits a page of the list asks for. */
const PAGE = 50;
const HASH = /^[0-9a-f]{40}$/;

/** The flow's page, at a commit when one is given. */
export const flowAt = (workspace: string, project: string, file: string, commit?: string) =>
  `/w/${encodeURIComponent(workspace)}/${encodeURIComponent(project)}/flow/${file
    .split('/')
    .map(encodeURIComponent)
    .join('/')}${commit ? `?commit=${commit}` : ''}`;

const CHANGE_TAG = {
  added: 'new',
  changed: 'changed',
  removed: 'gone',
  renamed: 'changed',
} as const;

/** AFS-190: a file's text as a commit left it, on a page of its own. */
const fileAt = (project: string, commit: string, file: string) =>
  `/api/v1/projects/${encodeURIComponent(project)}/files/content?commit=${commit}&path=${encodeURIComponent(file)}`;

/** A list of commits read a page at a time: the first page anew when `key` changes. */
function useCommitPages(
  key: string,
  read: (page: { skip?: number; commit?: string }) => ReturnType<typeof api.commits> | undefined,
) {
  const [state, setState] = useState<{
    commits: CommitSummary[];
    tip?: string;
    next?: number;
    loading: boolean;
    error?: string;
  }>({ commits: [], loading: true });
  // Answers to an older question (another filter typed since) are dropped.
  const asked = useRef(0);
  const readRef = useRef(read);
  readRef.current = read;
  const load = async (more: boolean) => {
    const turn = ++asked.current;
    setState((s) => ({
      ...s,
      loading: true,
      error: undefined,
      ...(more ? {} : { next: undefined }),
    }));
    try {
      const page = await readRef.current(
        more && state.next !== undefined ? { skip: state.next, commit: state.tip } : {},
      );
      if (turn !== asked.current) return;
      setState((s) => ({
        commits: more ? [...s.commits, ...(page?.commits ?? [])] : (page?.commits ?? []),
        tip: page?.commit,
        next: page?.next,
        loading: false,
      }));
    } catch (e) {
      if (turn === asked.current)
        setState((s) => ({
          ...s,
          ...(more ? {} : { commits: [] }),
          loading: false,
          error: messageOf(e),
        }));
    }
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: anew when what is asked changes
  useEffect(() => {
    void load(false);
  }, [key]);
  return { ...state, more: () => void load(true) };
}

/** One commit's line: its subject, then who, when and its short hash. */
/**
 * AFS-186: a commit's message body as the page shows it: a co-author trailer names the person,
 * not their e-mail address (git keeps it; the page does not spread it).
 */
export function bodyWords(body: string): string {
  return body.replace(/^Co-authored-by:[ \t]*(.*?)[ \t]*<[^>]*>[ \t]*$/gim, 'Co-author: $1');
}

function CommitLine({ commit, children }: { commit: CommitSummary; children?: ReactNode }) {
  return (
    <>
      <span className="commit-subject">{commit.subject || '(no message)'}</span>
      <span className="commit-meta muted">
        {/* AFS-190: 12 characters, as every page shows a commit. */}
        {commit.author} · <Time at={commit.at} /> · <code>{commit.commit.slice(0, 12)}</code>
        {children}
      </span>
    </>
  );
}

/**
 * The files a commit changed, flows by their title leading to the flow at that commit. AFS-190:
 * every other file opens as the commit left it (a removed one as it was before), and a file moved
 * is one line.
 */
function CommitFiles({
  workspace,
  project,
  commit,
}: {
  workspace: string;
  project: Project;
  commit: string;
}) {
  const details = useLoad(
    async (): Promise<CommitDetails> => api.commit(project.id, commit),
    [project.id, commit],
  );
  const d = details.data;
  return (
    <div className="commit-files">
      <Loading state={details} />
      {d?.body ? <p className="commit-body">{bodyWords(d.body)}</p> : null}
      {d && d.parents.length > 1 ? (
        <p className="muted small">A merge: the files it brought to its first parent.</p>
      ) : null}
      {d && d.files.length === 0 ? <p className="muted small">No file changed.</p> : null}
      {d?.files.length ? (
        <ul className="plain commit-file-list">
          {d.files.map((f) => (
            <li key={f.file}>
              <span className={`tag ${CHANGE_TAG[f.change]}`}>{f.change}</span>{' '}
              {f.from ? (
                <span className="muted small">
                  from <code>{f.from}</code> to{' '}
                </span>
              ) : null}
              {f.flow ? (
                <>
                  <Link
                    to={flowAt(workspace, project.key, f.file, commit)}
                    title={
                      f.change === 'removed'
                        ? 'This commit removed the flow'
                        : 'The flow as this commit left it, with what it changed'
                    }
                  >
                    {f.title ?? f.file}
                  </Link>
                  {f.title ? <span className="muted small"> {f.file}</span> : null}
                </>
              ) : (
                <a
                  href={fileAt(
                    project.id,
                    f.change === 'removed' ? (d.parents[0] ?? commit) : commit,
                    f.file,
                  )}
                  target="_blank"
                  rel="noreferrer"
                  title={
                    f.change === 'removed'
                      ? 'The file as it was before this commit removed it, on a page of its own'
                      : 'The file as this commit left it, on a page of its own'
                  }
                >
                  <code>{f.file}</code>
                </a>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {d?.more ? <p className="muted small">And {d.more} more files.</p> : null}
    </div>
  );
}

/** AFS-210: a commit opened from the address that the list does not show: its line and files. */
function AskedCommit({
  workspace,
  project,
  commit,
}: {
  workspace: string;
  project: Project;
  commit: string;
}) {
  const details = useLoad(() => api.commit(project.id, commit), [project.id, commit]);
  const d = details.data;
  return (
    <div className="commit-row" data-commit={commit}>
      <Loading state={details} />
      {d ? <CommitLine commit={{ ...d, files: [] }} /> : null}
      <CommitFiles workspace={workspace} project={project} commit={commit} />
    </div>
  );
}

/** The address's choices: branch, filter and the open commit. */
function choicesInAddress() {
  const q = new URLSearchParams(window.location.search);
  const commit = q.get('commit') ?? '';
  return {
    branch: q.get('branch') ?? '',
    q: q.get('q') ?? '',
    // AFS-210: a short id (as the pages show it) or a wrong one is looked up, not dropped.
    asked: commit.trim(),
  };
}

/** A project's History tab. */
export function ProjectHistory({ workspace, project }: { workspace: string; project: Project }) {
  const [start] = useState(choicesInAddress);
  const [branch, setBranch] = useState(start.branch || project.gitRef);
  const [typed, setTyped] = useState(start.q);
  const [q, setQ] = useState(start.q.trim());
  // AFS-210: one commit open at a time; the address names it.
  const [open, setOpen] = useState(HASH.test(start.asked) ? start.asked : '');
  const [askedWrong, setAskedWrong] = useState<string>();
  useEffect(() => {
    if (!start.asked || HASH.test(start.asked)) return;
    let live = true;
    api
      .commit(project.id, start.asked)
      .then((d) => live && setOpen(d.commit))
      .catch((e) => live && setAskedWrong(messageOf(e)));
    return () => {
      live = false;
    };
  }, [project.id, start.asked]);
  // The filter asks once typing pauses.
  useEffect(() => {
    const timer = setTimeout(() => setQ(typed.trim()), 300);
    return () => clearTimeout(timer);
  }, [typed]);
  const branches = useLoad(
    async () => (await api.branches(project.id)).branches,
    [project.id, project.commit],
  );
  const list = useCommitPages(
    // The branch that runs is read again when it moves.
    `${project.id}|${branch}|${q}|${branch === project.gitRef ? project.commit : ''}`,
    (page) =>
      api.commits(project.id, {
        ...(branch !== project.gitRef ? { branch } : {}),
        ...(q ? { q } : {}),
        ...page,
        limit: PAGE,
      }),
  );
  // The address keeps the choices, so the list can be shared and comes back on Back.
  useEffect(() => {
    const query = new URLSearchParams();
    if (branch !== project.gitRef) query.set('branch', branch);
    if (q) query.set('q', q);
    if (open) query.set('commit', open);
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}${query.size ? `?${query}` : ''}`,
    );
  }, [branch, q, open, project.gitRef]);
  const toggle = (commit: string) => {
    setAskedWrong(undefined);
    setOpen((now) => (now === commit ? '' : commit));
  };
  // AFS-210: the commit the address opened, when it is not among the ones listed (older, or on
  // another branch): shown above the list.
  const outside = !!open && !list.loading && !list.commits.some((c) => c.commit === open);
  return (
    <section aria-label="History of the project" className="history">
      <div className="run-filters history-filters">
        <label>
          Branch
          <select value={branch} onChange={(e) => setBranch(e.target.value)}>
            {[...new Set([branch, project.gitRef, ...(branches.data ?? [])])].map((b) => (
              <option key={b} value={b}>
                {b}
                {b === project.gitRef ? ' (runs)' : ''}
              </option>
            ))}
          </select>
        </label>
        <label>
          Find
          <input
            type="search"
            className="run-find"
            value={typed}
            placeholder="message, author, hash or file"
            onChange={(e) => setTyped(e.target.value)}
            spellCheck={false}
          />
        </label>
      </div>
      {list.error ? (
        <p className="notice error" role="alert">
          {list.error}
        </p>
      ) : null}
      {askedWrong ? (
        <p className="notice warn" role="status">
          {askedWrong} The list shows the newest commits of {branch}.
        </p>
      ) : null}
      {outside ? (
        <div className="commit-asked">
          <p className="muted small">
            Commit from address (not in the list below):{' '}
            <button type="button" className="link" onClick={() => setOpen('')}>
              Close it
            </button>
          </p>
          <AskedCommit workspace={workspace} project={project} commit={open} />
        </div>
      ) : null}
      {list.loading && !list.commits.length ? (
        <p className="muted" aria-live="polite">
          Loading…
        </p>
      ) : null}
      {!list.loading && !list.error && !list.commits.length ? (
        <p className="empty">
          {q
            ? list.next !== undefined
              ? 'No commit matches in the newest ones read.'
              : 'No commit matches.'
            : `${branch} has no commits yet.`}
        </p>
      ) : null}
      {list.commits.length ? (
        <ul className="rows commit-rows">
          {list.commits.map((c) => {
            const isOpen = open === c.commit;
            return (
              <li key={c.commit} className="commit-row" data-commit={c.commit}>
                <button
                  type="button"
                  className="commit-toggle"
                  aria-expanded={isOpen}
                  onClick={() => toggle(c.commit)}
                >
                  <CommitLine commit={c} />
                </button>
                {isOpen ? (
                  <CommitFiles workspace={workspace} project={project} commit={c.commit} />
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {list.next !== undefined ? (
        <p className="actions">
          <button type="button" disabled={list.loading} onClick={list.more}>
            {list.loading ? 'Loading…' : q ? 'Look further back' : 'More commits'}
          </button>
        </p>
      ) : null}
    </section>
  );
}

/** What a commit did to the flow's files, in a few words. */
function touched(c: CommitSummary): string {
  return (c.files ?? [])
    .map((f) => `${/\.scenarios\.yaml$/.test(f.file) ? 'scenarios' : 'flow'} ${f.change}`)
    .join(', ');
}

/** A flow's history: the commits that changed its flow or scenarios file, each to open. */
export function FlowHistory({
  workspace,
  project,
  file,
  current,
  onClose,
}: {
  workspace: string;
  project: Project;
  file: string;
  /** The commit shown now, if one is. */
  current?: string;
  onClose(): void;
}) {
  const list = useCommitPages(`${project.id}|${file}|${project.commit ?? ''}`, (page) =>
    api.commits(project.id, { path: file, ...page, limit: 30 }),
  );
  return (
    <section className="panel flow-history" aria-labelledby="flow-history">
      <div className="panel-head">
        <h2 id="flow-history">History of this flow</h2>
        <button type="button" className="link" onClick={onClose}>
          Close
        </button>
      </div>
      {list.error ? (
        <p className="notice error" role="alert">
          {list.error}
        </p>
      ) : null}
      {list.loading && !list.commits.length ? <p className="muted">Loading…</p> : null}
      {!list.loading && !list.error && !list.commits.length ? (
        <p className="muted">No commit changed this flow on {project.gitRef}.</p>
      ) : null}
      <ul className="plain flow-history-list">
        {list.commits.map((c) => (
          <li key={c.commit} aria-current={c.commit === current ? 'true' : undefined}>
            <Link
              to={flowAt(workspace, project.key, file, c.commit)}
              className="flow-history-item"
              title="The flow as this commit left it, with what it changed"
            >
              <CommitLine commit={c}>{touched(c) ? <> · {touched(c)}</> : null}</CommitLine>
            </Link>
          </li>
        ))}
      </ul>
      {list.next !== undefined ? (
        <button type="button" className="link" disabled={list.loading} onClick={list.more}>
          {list.loading ? 'Loading…' : 'Earlier commits'}
        </button>
      ) : null}
    </section>
  );
}
