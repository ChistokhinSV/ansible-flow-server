// Administration: its index, and the audit log: who did what, newest first, filtered, a page at
// a time, and taken away as CSV or JSON with the same filter.
import { type FormEvent, useEffect, useState } from 'react';
import { type AuditEntry, type AuditFilter, api, auditExport } from './api';
import { Link } from './router';
import { Loading, messageOf, PageHead, Time } from './ui';

export function AdminPage() {
  return (
    <>
      <PageHead title="Administration" />
      <ul className="cards">
        <li>
          <Link to="/admin/people" className="card">
            <strong>People and groups</strong>
            <span className="muted">
              Accounts, administrators, service accounts and their tokens, passwords, and the groups
              access levels and approvals name.
            </span>
          </Link>
        </li>
        <li>
          <Link to="/admin/certificate" className="card">
            <strong>Server certificate</strong>
            <span className="muted">
              The certificate in use and its days left; request one from your certificate authority,
              install it, make a self-signed one, roll back.
            </span>
          </Link>
        </li>
        <li>
          <Link to="/admin/audit" className="card">
            <strong>Audit log</strong>
            <span className="muted">
              Who did what and when: sign-ins, launches, stops, pushes, changes to people, projects,
              credentials and the certificate.
            </span>
          </Link>
        </li>
        <li>
          <Link to="/admin/notifications" className="card">
            <strong>Notifications</strong>
            <span className="muted">
              The mail server, the key webhooks are signed with, a test message, and what was sent
              to whom.
            </span>
          </Link>
        </li>
      </ul>
    </>
  );
}

/** What an action is about, for the filter. */
const OBJECTS = [
  'session',
  'user',
  'token',
  'group',
  'workspace',
  'project',
  'credential',
  'launch-config',
  'run',
  'git',
  'certificate',
  'master-key',
  'notification',
  'audit',
];
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
  if (entry.actor) return <>{entry.actor.login}</>;
  const os = entry.detail?.osUser;
  if (entry.source === 'cli')
    return <span className="muted">on the server{typeof os === 'string' ? ` (${os})` : ''}</span>;
  const tried = entry.detail?.login;
  return <span className="muted">{typeof tried === 'string' ? `${tried}?` : 'nobody'}</span>;
}

/** The detail of an entry, short: `key: value`, lists and objects as JSON. */
function Detail({ detail }: { detail?: Record<string, unknown> }) {
  if (!detail) return null;
  const shown = Object.entries(detail).filter(([k]) => k !== 'osUser' && k !== 'login');
  return (
    <>
      {shown.map(([k, v]) => (
        <div key={k}>
          <span className="muted">{k}:</span>{' '}
          {typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
            ? String(v)
            : JSON.stringify(v)}
        </div>
      ))}
    </>
  );
}

export function AuditPage() {
  const [filter, setFilter] = useState<AuditFilter>({});
  const [who, setWho] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [next, setNext] = useState<string | undefined>();
  const [state, setState] = useState<{ loading: boolean; error?: string }>({ loading: true });

  const load = async (before?: string) => {
    setState({ loading: true });
    try {
      const page = await api.audit({ ...filter, ...(before ? { before } : {}), limit: 100 });
      setEntries((shown) => (before ? [...shown, ...page.entries] : page.entries));
      setNext(page.next);
      setState({ loading: false });
    } catch (e) {
      setState({ loading: false, error: messageOf(e) });
    }
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new filter is a new first page
  useEffect(() => {
    void load();
  }, [filter]);

  const set = (key: keyof AuditFilter, value: string) =>
    setFilter(({ [key]: _, ...rest }) => (value ? { ...rest, [key]: value } : rest));
  const apply = (event: FormEvent) => {
    event.preventDefault();
    setFilter(({ actor: _a, from: _f, to: _t, ...rest }) => ({
      ...rest,
      ...(who.trim() ? { actor: who.trim().toLowerCase() } : {}),
      ...(from ? { from: new Date(`${from}T00:00:00`).toISOString() } : {}),
      ...(to ? { to: dayAfter(to) } : {}),
    }));
  };

  return (
    <>
      <PageHead
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
          Who <input value={who} onChange={(e) => setWho(e.target.value)} placeholder="login" />
        </label>
        <label className="inline">
          About{' '}
          <select value={filter.action ?? ''} onChange={(e) => set('action', e.target.value)}>
            <option value="">everything</option>
            {OBJECTS.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </label>
        <label className="inline">
          Result{' '}
          <select value={filter.result ?? ''} onChange={(e) => set('result', e.target.value)}>
            <option value="">all</option>
            <option value="ok">ok</option>
            <option value="refused">refused</option>
            <option value="failed">failed</option>
          </select>
        </label>
        <label className="inline">
          From{' '}
          <select value={filter.source ?? ''} onChange={(e) => set('source', e.target.value)}>
            <option value="">anywhere</option>
            {Object.entries(SOURCE_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="inline">
          Since <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="inline">
          Until <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
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
                  <td>
                    <Who entry={e} />
                  </td>
                  <td>
                    {SOURCE_LABEL[e.source] ?? e.source}
                    {e.ip && <div className="muted">{e.ip}</div>}
                  </td>
                  <td>
                    <code>{e.action}</code>
                  </td>
                  <td>
                    {e.object.type === 'run' && e.object.id ? (
                      <Link to={`/runs/${e.object.id}`}>{e.object.name ?? 'run'}</Link>
                    ) : (
                      (e.object.name ?? e.object.id ?? '')
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
                    <Detail detail={e.detail} />
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
