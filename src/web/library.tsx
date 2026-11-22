// AFS-79: the flow library in the pages. The Library page lists what library projects offer; a
// flow's page shows the library subflows it has copies of, which are behind and (while its draft
// is edited) updates them; Insert Shared Subflow… in the designer picks one from the library.
import { useMemo, useState } from 'react';
import {
  api,
  type Draft,
  type FlowDocLike,
  type FlowNodeLike,
  type LibrarySubflow,
  type Project,
} from './api';
import { Link } from './router';
import { Loading, messageOf, PageHead, useLoad } from './ui';

const SCHEME = 'afs://';

/** The library copies of a flow, at every depth. */
export function libraryCopies(doc: FlowDocLike | undefined): FlowNodeLike[] {
  const out: FlowNodeLike[] = [];
  const walk = (nodes: FlowNodeLike[] | undefined) => {
    for (const n of nodes ?? []) {
      if (n?.ref?.from?.startsWith(SCHEME)) out.push(n);
      walk(n?.subflow?.nodes);
    }
  };
  walk(doc?.nodes);
  return out;
}

/** The library's subflows by library project. */
function byProject(subflows: LibrarySubflow[]): [string, LibrarySubflow[]][] {
  const groups = new Map<string, LibrarySubflow[]>();
  for (const s of subflows) {
    const k = `${s.workspace}/${s.project}`;
    groups.set(k, [...(groups.get(k) ?? []), s]);
  }
  return [...groups];
}

export function LibraryPage({ admin = false }: { admin?: boolean }) {
  const listed = useLoad(() => api.library(), []);
  const subflows = listed.data?.subflows ?? [];
  return (
    <>
      <PageHead
        help="web-pages.md#flow-library"
        title="Library"
        lead="Subflows that library projects offer to every project. A flow takes a copy, pinned to the library flow's version."
      />
      <Loading state={listed} />
      {listed.data && !subflows.length && (
        <p className="empty">
          {/* AFS-194: how to make one is said to who can (an administrator), not to everyone. */}
          {admin
            ? "No library yet. Make a project a library on its Settings tab (Library, Make it a library); its flows' subflows are then offered here, to every project."
            : "No library yet, or none you may read. An administrator can make a project a library; its flows' subflows are then offered here."}
        </p>
      )}
      {byProject(subflows).map(([project, list]) => {
        const [workspace, key] = project.split('/');
        return (
          <section className="panel" key={project} aria-labelledby={`lib-${project}`}>
            <h2 id={`lib-${project}`}>
              <Link to={`/w/${workspace}/${key}`}>{project}</Link>
            </h2>
            <ul className="rows">
              {list.map((s) => (
                <li key={s.from}>
                  <strong>{s.title}</strong>{' '}
                  <span className="muted">
                    in <Link to={`/w/${workspace}/${key}/flow/${s.file}`}>{s.flow}</Link>, version{' '}
                    {s.version} at {s.commit.slice(0, 12)}
                  </span>
                  {s.intent && <p className="lib-intent">{s.intent}</p>}
                  <code className="lib-ref">{s.from}</code>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      <p className="muted">
        In a flow, <strong>Insert Shared Subflow…</strong> on the canvas (while editing it in the
        pages, or in VS Code with this server set) offers these. The copy stays in the flow; a newer
        version offers an update.
      </p>
    </>
  );
}

/** The flow's library copies and which are behind; Update while its draft is edited. */
export function LibraryCopies({
  project,
  file,
  editing,
  changed = 0,
}: {
  project: Project;
  file: string;
  editing?: Draft;
  /** Goes up when the draft changed: the copies are read again. */
  changed?: number;
}) {
  const [turn, setTurn] = useState(0);
  const doc = useLoad(
    async () =>
      editing
        ? (await api.draft(editing.id)).snapshot.doc
        : (await api.flowView(project.id, file)).snapshot.doc,
    [project.id, project.commit, file, editing?.id, turn, changed],
  );
  const copies = useMemo(() => libraryCopies(doc.data), [doc.data]);
  const library = useLoad(
    async () => (copies.length ? (await api.library()).subflows : []),
    [copies.length],
  );
  const [busy, setBusy] = useState<string>();
  const [said, setSaid] = useState<string>();
  if (!copies.length) return null;
  const offered = new Map((library.data ?? []).map((s) => [s.from, s]));
  const update = async (copy: FlowNodeLike) => {
    if (!editing || !copy.ref) return;
    setBusy(copy.id);
    setSaid(undefined);
    try {
      const got = await api.librarySubflow(copy.ref.from);
      await api.draftCommand(editing.id, {
        kind: 'updateReference',
        id: copy.id,
        version: got.version,
        source: got.node,
        commit: got.commit,
      });
      setSaid(`${copy.title} is at version ${got.version} of the library now.`);
      setTurn((t) => t + 1);
      library.reload();
    } catch (e) {
      setSaid(messageOf(e));
    } finally {
      setBusy(undefined);
    }
  };
  // AFS-114: a line per copy, so the canvas keeps the room; the address is in the tooltip.
  return (
    <section className="library-copies" aria-label="From the library">
      {copies.map((copy) => {
        const ref = copy.ref as NonNullable<FlowNodeLike['ref']>;
        const now = offered.get(ref.from);
        const behind = !!now && now.version > ref.version;
        return (
          <p key={copy.id} className="library-copy">
            <span className="muted">From the library:</span>{' '}
            <strong title={ref.from}>{copy.title}</strong>{' '}
            <span className="muted">
              version {ref.version}
              {ref.commit ? ` at ${ref.commit.slice(0, 12)}` : ''}
            </span>{' '}
            {library.loading ? null : !now ? (
              <span className="tag gone">not offered now</span>
            ) : behind ? (
              <>
                <span className="tag behind">library has version {now.version}</span>{' '}
                {editing ? (
                  <button
                    type="button"
                    className="small"
                    onClick={() => void update(copy)}
                    disabled={busy === copy.id}
                  >
                    {busy === copy.id ? 'Updating…' : 'Update'}
                  </button>
                ) : (
                  <span className="muted small">Edit the flow to update it.</span>
                )}
              </>
            ) : (
              <span className="tag current">up to date</span>
            )}
          </p>
        );
      })}
      {said && (
        <p className="library-copy" role="status">
          {said}
        </p>
      )}
    </section>
  );
}

/** Insert Shared Subflow… from the designer: the library to pick from; the copy goes in the draft. */
export function InsertFromLibrary({
  draft,
  where,
  onDone,
}: {
  draft: Draft;
  where: { level?: string; at?: { x: number; y: number } };
  onDone(words?: string): void;
}) {
  const listed = useLoad(() => api.library(), []);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const shown = (listed.data?.subflows ?? []).filter((s) =>
    `${s.title} ${s.flow} ${s.from}`.toLowerCase().includes(filter.trim().toLowerCase()),
  );
  const pick = async (s: LibrarySubflow) => {
    setBusy(true);
    setError(undefined);
    try {
      const got = await api.librarySubflow(s.from);
      await api.draftCommand(draft.id, {
        kind: 'addReference',
        ...(where.level && where.level !== 'root' ? { parent: where.level } : {}),
        from: got.from,
        version: got.version,
        source: got.node,
        commit: got.commit,
        ...(where.at ? { position: where.at } : {}),
      });
      onDone(`${s.title} copied from the library (version ${got.version}).`);
    } catch (e) {
      setError(messageOf(e));
      setBusy(false);
    }
  };
  return (
    // AFS-114: a card over the canvas (in full screen too), closed with Cancel or Escape.
    <section
      className="library-pick"
      aria-labelledby="library-pick"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onDone();
      }}
    >
      <div className="library-pick-head">
        <h2 id="library-pick">Insert a subflow from the library</h2>
        <button type="button" className="link" onClick={() => onDone()}>
          Cancel
        </button>
      </div>
      <input
        // biome-ignore lint/a11y/noAutofocus: the picker the designer opened
        autoFocus
        aria-label="Find a library subflow"
        placeholder="Find…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <Loading state={listed} />
      {listed.data && !shown.length && (
        <p className="muted small">
          {listed.data.subflows.length
            ? 'Nothing matches.'
            : // AFS-114: how a library comes to be, where the person looks for one.
              "No library subflow you may read yet. A library is a project whose flows' subflows are offered to every project: an administrator turns it on in the project's Settings (Library), and each subflow of its flows is offered here."}
        </p>
      )}
      <ul className="rows">
        {shown.map((s) => (
          <li key={s.from}>
            <button type="button" className="link" disabled={busy} onClick={() => void pick(s)}>
              {s.title}
            </button>{' '}
            <span className="muted small">
              {s.workspace}/{s.project} · {s.flow}, version {s.version}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
