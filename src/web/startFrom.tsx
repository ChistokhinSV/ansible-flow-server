// AFS-126: the designer's empty canvas offers to start from a sample, playbooks or an AWX template;
// in the pages that is picked here, over the canvas, and the server makes the draft's flow of it.
import { useEffect, useRef, useState } from 'react';
import { api, type Draft } from './api';
import { Loading, messageOf, useLoad } from './ui';

export type StartWhat = 'sample' | 'playbooks' | 'awx';

const TITLE: Record<StartWhat, string> = {
  sample: 'Start from a sample flow',
  playbooks: 'Import an Ansible playbook of this repository',
  awx: 'Import an AWX workflow or job template',
};

export function StartFrom({
  draft,
  what,
  onDone,
}: {
  draft: Draft;
  what: StartWhat;
  onDone(words?: string): void;
}) {
  const offered = useLoad(() => api.draftStartFrom(draft.id), [draft.id]);
  const [credential, setCredential] = useState('');
  const templates = useLoad(
    () => (credential ? api.draftAwxTemplates(draft.id, credential) : Promise.resolve(undefined)),
    [credential],
  );
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const start = async (body: Parameters<typeof api.draftStart>[1], name: string) => {
    setBusy(true);
    setError(undefined);
    try {
      const done = await api.draftStart(draft.id, body);
      onDone(
        // AFS-151: the server counts the steps as Readiness does (every level).
        `The flow was made from ${name}: ${done.steps} step${done.steps === 1 ? '' : 's'}.${
          done.notes.length
            ? `${'sample' in body ? ' ' : ' What did not map one to one: '}${done.notes.slice(0, 3).join(' ')}${done.notes.length > 3 ? ' …' : ''}`
            : ''
        }`,
      );
    } catch (e) {
      setError(messageOf(e));
      setBusy(false);
    }
  };
  const match = (text: string) => text.toLowerCase().includes(filter.trim().toLowerCase());
  const data = offered.data;
  // AFS-137: the picker takes the focus when it opens (it stays in the designer's frame
  // otherwise), and Escape closes it wherever the focus is: in the page or in the frame.
  const box = useRef<HTMLElement>(null);
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    // AFS-148: after the designer's menu has closed (it hands the focus back to its button in the
    // frame): focused at once, the picker lost it again.
    const t = setTimeout(() => {
      if (!box.current?.contains(document.activeElement)) box.current?.focus();
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') done.current();
    };
    const frames = [...document.querySelectorAll('iframe')]
      .map((f) => {
        try {
          return f.contentDocument;
        } catch {
          return null;
        }
      })
      .filter((d): d is Document => !!d);
    for (const d of [document, ...frames]) d.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(t);
      for (const d of [document, ...frames]) d.removeEventListener('keydown', onKey);
    };
  }, []);
  return (
    <>
      {/* AFS-148: the canvas and its side panel step back while the picker is open; a click on
          them closes it, as Cancel. */}
      <div className="library-pick-backdrop" aria-hidden="true" onClick={() => onDone()} />
      <section ref={box} tabIndex={-1} className="library-pick" aria-labelledby="start-from">
        <div className="library-pick-head">
          <h2 id="start-from">{TITLE[what]}</h2>
          <button type="button" className="link" onClick={() => onDone()}>
            {/* AFS-194: where there is nothing to pick, the box only informs: Close. */}
            {data && what === 'awx' && !data.awx.length ? 'Close' : 'Cancel'}
          </button>
        </div>
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
        <Loading state={offered} />
        {data && what === 'sample' && (
          <ul className="rows">
            {data.samples.map((s) => (
              <li key={s.key}>
                <button
                  type="button"
                  className="link"
                  disabled={busy}
                  onClick={() => void start({ sample: s.key }, `the ${s.name} sample`)}
                >
                  {s.name}
                </button>{' '}
                <span className="muted small">{s.description}</span>
              </li>
            ))}
          </ul>
        )}
        {data && what === 'playbooks' && (
          <>
            {data.playbooks.length > 6 && (
              <input
                // biome-ignore lint/a11y/noAutofocus: the picker the designer opened
                autoFocus
                aria-label="Find a playbook"
                placeholder="Find…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            )}
            {data.playbooks.length ? (
              <ul className="rows">
                {data.playbooks.filter(match).map((p) => (
                  <li key={p}>
                    <button
                      type="button"
                      className="link"
                      disabled={busy}
                      onClick={() => void start({ playbook: p }, p)}
                    >
                      {p}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted small">
                The project's repository has no playbook yet. Push playbooks (with their roles) to
                it, then import one here: each task becomes a step.
              </p>
            )}
          </>
        )}
        {data && what === 'awx' && (
          <>
            {data.awx.length ? (
              <div className="field">
                <label htmlFor="start-awx">AWX</label>
                <select
                  // biome-ignore lint/a11y/noAutofocus: the picker the designer opened (AFS-148)
                  autoFocus
                  id="start-awx"
                  value={credential}
                  onChange={(e) => setCredential(e.target.value)}
                >
                  <option value="">Choose…</option>
                  {data.awx.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({c.url})
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <p className="muted small">
                The workspace has no AWX credential. An administrator adds one under the workspace's
                Credentials: kind "AWX token", with the AWX address and a token that may read its
                templates.
              </p>
            )}
            {credential && <Loading state={templates} />}
            {templates.data && (
              <>
                {templates.data.templates.length > 6 && (
                  <input
                    aria-label="Find a template"
                    placeholder="Find…"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                  />
                )}
                <ul className="rows">
                  {templates.data.templates
                    .filter((t) => match(`${t.name} ${t.description ?? ''}`))
                    .map((t) => (
                      <li key={`${t.kind}:${t.id}`}>
                        <button
                          type="button"
                          className="link"
                          disabled={busy}
                          onClick={() =>
                            void start(
                              { awx: { credential, kind: t.kind, id: t.id } },
                              `the AWX ${t.kind === 'job' ? 'job' : 'workflow'} template ${t.name}`,
                            )
                          }
                        >
                          {t.name}
                        </button>{' '}
                        <span className="muted small">
                          {t.kind === 'job' ? 'job template' : 'workflow'}
                          {t.description ? ` · ${t.description}` : ''}
                        </span>
                      </li>
                    ))}
                </ul>
              </>
            )}
          </>
        )}
      </section>
    </>
  );
}
