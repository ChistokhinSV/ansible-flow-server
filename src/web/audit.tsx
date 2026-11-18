// The audit log: who did what, newest first, filtered, a page at
// a time, and taken away as CSV or JSON with the same filter.
import { type FormEvent, useEffect, useState } from 'react';
import { AUDIT_KINDS as OBJECTS } from '../server/audit/kinds';
import type { AuditRef } from '../server/audit/refs';
import { type AuditEntry, type AuditFilter, api, auditExport } from './api';
import { Link } from './router';
import { Loading, messageOf, PageHead, Time } from './ui';

const SOURCE_LABEL: Record<string, string> = {
  ui: 'pages',
  api: 'API',
  mcp: 'agent (MCP)',
  git: 'git',
  cli: 'server command',
  server: 'server',
};

/** The day after a date input's day: a filter "to" a day includes that day. */
const dayAfter = (day: string) =>
  new Date(Date.parse(`${day}T00:00:00`) + 24 * 60 * 60 * 1000).toISOString();

function Who({ entry }: { entry: AuditEntry }) {
  if (entry.actor) return <span className="login">{entry.actor.login}</span>;
  const os = entry.detail?.osUser;
  if (entry.source === 'cli')
    return <span className="muted">on the server{typeof os === 'string' ? ` (${os})` : ''}</span>;
  const tried = entry.detail?.login;
  // AFS-153: nobody was signed in: the login someone typed, said as such.
  if (typeof tried === 'string')
    return (
      <>
        <span className="login">{tried}</span>
        <div className="muted">login typed, not signed in</div>
      </>
    );
  return <span className="muted">nobody</span>;
}

/** AFS-145: the token an action was done with, by its name (older entries have its id only). */
function TokenUsed({ entry }: { entry: AuditEntry }) {
  const name = entry.detail?.token;
  if (typeof name === 'string') return <div className="muted">token {name}</div>;
  if (!entry.token) return null;
  return (
    <div className="muted" title={entry.token}>
      token {entry.token.slice(0, 8)}…
    </div>
  );
}

type Refs = Record<string, AuditRef>;

/** The kinds the server names by id (server/audit/refs.ts): one missing from `refs` is gone. */
const NAMED = new Set(['workspace', 'project', 'launch-config', 'run']);

/** AFS-106: what an id names: its name, linked to its page while it exists. */
function Named({ id, type, name, refs }: { id: string; type: string; name?: string; refs: Refs }) {
  const ref = refs[id];
  if (ref) return <Link to={ref.path}>{name ?? ref.name}</Link>;
  if (name) return <>{name}</>;
  return (
    <span className="muted" title={id}>
      {`${id.slice(0, 8)}…${NAMED.has(type) ? ' (deleted)' : ''}`}
    </span>
  );
}

/** A pushed branch: `main: 37e668ed → 71595cb5`, made or deleted. */
const refLine = (r: { ref?: unknown; from?: unknown; to?: unknown }) => {
  const short = (v: unknown) => (typeof v === 'string' ? v.slice(0, 8) : undefined);
  const ref = String(r.ref ?? '').replace(/^refs\/heads\//, '');
  const from = short(r.from);
  const to = short(r.to);
  return `${ref}: ${from && to ? `${from} → ${to}` : to ? `new at ${to}` : from ? `deleted (was ${from})` : '?'}`;
};

/** One value of an entry's detail, as words: names for ids, branches for a push, lists joined. */
function Value({ k, v, refs }: { k: string; v: unknown; refs: Refs }) {
  if (typeof v === 'string' && (refs[v] || (NAMED.has(k) && /^[0-9a-f-]{36}$/i.test(v))))
    return <Named id={v} type={k} refs={refs} />;
  if (k === 'refs' && Array.isArray(v))
    return (
      <>
        {v.map((r, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a push's branches, in order.
          <div key={i} className="mono">
            {refLine(r as Record<string, unknown>)}
          </div>
        ))}
      </>
    );
  // AFS-141: an empty list (nobody added, no field changed) says so.
  if (Array.isArray(v) && v.length === 0) return <span className="muted">none</span>;
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return <>{v.join(', ')}</>;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
    return <>{String(v)}</>;
  return <>{JSON.stringify(v)}</>;
}

/**
 * The detail of an entry, short (`key: value`, names for ids), and all of it on demand: a cell
 * cut the long ones at its edge.
 */
function Detail({ detail, refs }: { detail?: Record<string, unknown>; refs: Refs }) {
  if (!detail) return null;
  // The token is said beside the source (TokenUsed).
  const shown = Object.entries(detail).filter(
    ([k]) => k !== 'osUser' && k !== 'login' && k !== 'token',
  );
  if (shown.length === 0) return null;
  return (
    // AFS-141: a box of its own width, so a long detail wraps instead of leaving the page.
    <div className="audit-detail">
      {shown.map(([k, v]) => (
        <div key={k}>
          <span className="muted">{k}:</span> <Value k={k} v={v} refs={refs} />
        </div>
      ))}
      <details className="audit-all">
        <summary>All of it</summary>
        <pre>{JSON.stringify(detail, null, 2)}</pre>
      </details>
    </div>
  );
}

/** AFS-153: the filter in the address, so it stays on a reload and in a shared link. */
const KEYS = ['who', 'about', 'result', 'from', 'since', 'until'] as const;
type Choices = Record<(typeof KEYS)[number], string>;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function choicesInAddress(): Choices {
  const query = new URLSearchParams(window.location.search);
  const one = (k: string) => (query.get(k) ?? '').slice(0, 64);
  const day = (k: string) => (DAY.test(one(k)) ? one(k) : '');
  return {
    who: one('who'),
    about: Object.hasOwn(OBJECTS, one('about')) ? one('about') : '',
    result: ['ok', 'refused', 'failed'].includes(one('result')) ? one('result') : '',
    from: Object.hasOwn(SOURCE_LABEL, one('from')) ? one('from') : '',
    since: day('since'),
    until: day('until'),
  };
}

const filterOf = (c: Choices): AuditFilter => ({
  ...(c.who.trim() ? { actor: c.who.trim().toLowerCase() } : {}),
  ...(c.about ? { action: c.about } : {}),
  ...(c.result ? { result: c.result as AuditFilter['result'] } : {}),
  ...(c.from ? { source: c.from as AuditFilter['source'] } : {}),
  ...(c.since ? { from: new Date(`${c.since}T00:00:00`).toISOString() } : {}),
  ...(c.until ? { to: dayAfter(c.until) } : {}),
});

export function AuditPage() {
  const [choices, setChoices] = useState<Choices>(choicesInAddress);
  const filter = filterOf(choices);
  const [who, setWho] = useState(choices.who);
  const [from, setFrom] = useState(choices.since);
  const [to, setTo] = useState(choices.until);
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [refs, setRefs] = useState<Refs>({});
  const [next, setNext] = useState<string | undefined>();
  const [state, setState] = useState<{ loading: boolean; error?: string }>({ loading: true });

  const load = async (before?: string) => {
    setState({ loading: true });
    try {
      const page = await api.audit({ ...filter, ...(before ? { before } : {}), limit: 100 });
      setEntries((shown) => (before ? [...shown, ...page.entries] : page.entries));
      setRefs((known) => (before ? { ...known, ...page.refs } : (page.refs ?? {})));
      setNext(page.next);
      setState({ loading: false });
    } catch (e) {
      setState({ loading: false, error: messageOf(e) });
    }
  };
  const key = JSON.stringify(choices);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new filter is a new first page
  useEffect(() => {
    void load();
    // The router reads the path only, so the filter can live in the query.
    const query = new URLSearchParams(
      Object.entries(choices).filter(([, v]) => v !== ''),
    ).toString();
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}${query ? `?${query}` : ''}`,
    );
  }, [key]);

  const set = (k: keyof Choices, value: string) => setChoices((c) => ({ ...c, [k]: value }));
  const apply = (event: FormEvent) => {
    event.preventDefault();
    setChoices((c) => ({ ...c, who: who.trim(), since: from, until: to }));
  };

  return (
    <>
      <PageHead
        help="audit.md"
        title="Audit log"
        lead="Everything that changed something, or tried to, on this server: the newest first."
      >
        <a className="button" href={auditExport({ ...filter, format: 'csv' })} download>
          Export CSV
        </a>
        <a className="button" href={auditExport({ ...filter, format: 'json' })} download>
          Export JSON
        </a>
      </PageHead>
      <form className="filters" onSubmit={apply} aria-label="Filter the audit log">
        <label className="inline">
          Who{' '}
          <input
            value={who}
            onChange={(e) => setWho(e.target.value)}
            placeholder="login or name, or part of one"
          />
        </label>
        <label className="inline">
          About{' '}
          <select value={choices.about} onChange={(e) => set('about', e.target.value)}>
            <option value="">everything</option>
            {Object.entries(OBJECTS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="inline">
          Result{' '}
          <select value={choices.result} onChange={(e) => set('result', e.target.value)}>
            <option value="">all</option>
            <option value="ok">ok</option>
            <option value="refused">refused</option>
            <option value="failed">failed</option>
          </select>
        </label>
        <label className="inline">
          From{' '}
          <select value={choices.from} onChange={(e) => set('from', e.target.value)}>
            <option value="">anywhere</option>
            {Object.entries(SOURCE_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {/* AFS-101: the dates of one range stay on one line when the row wraps. */}
        <span className="range">
          <label className="inline">
            Since <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="inline">
            Until <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
        </span>
        <button type="submit">Show</button>
      </form>
      {!state.loading && !state.error && entries.length === 0 && (
        <p className="empty">Nothing in the log matches.</p>
      )}
      {entries.length > 0 && (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Who</th>
                <th scope="col">From</th>
                <th scope="col">What</th>
                <th scope="col">To what</th>
                <th scope="col">Result</th>
                <th scope="col">Detail</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td>
                    <Time at={e.at} />
                  </td>
                  <td className="audit-who">
                    <Who entry={e} />
                  </td>
                  <td>
                    {SOURCE_LABEL[e.source] ?? e.source}
                    <TokenUsed entry={e} />
                    {e.ip && <div className="muted">{e.ip}</div>}
                  </td>
                  <td>
                    <code>{e.action}</code>
                  </td>
                  <td className="long">
                    {e.object.id ? (
                      <Named
                        id={e.object.id}
                        type={e.object.type}
                        refs={refs}
                        // A run's entry names it by number: its flow and number say more.
                        {...(e.object.name && e.object.type !== 'run'
                          ? { name: e.object.name }
                          : {})}
                      />
                    ) : (
                      (e.object.name ?? '')
                    )}
                  </td>
                  <td>
                    <span
                      className={`badge ${e.result === 'ok' ? 'ok' : e.result === 'failed' ? 'bad' : 'busy'}`}
                    >
                      {e.result}
                      {e.status && e.result !== 'ok' ? ` ${e.status}` : ''}
                    </span>
                  </td>
                  <td className="detail">
                    <Detail detail={e.detail} refs={refs} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Loading state={state} />
      {next && !state.loading && (
        <button type="button" onClick={() => void load(next)}>
          Older entries
        </button>
      )}
    </>
  );
}
