// Notifications, for administrators (AFS-29): the delivery log (each message, where it went, and
// how it went, with a retry for those given up on) and, on a second tab, how the server sends (the
// mail server, the key webhooks are signed with) and a test message. The log comes first: it is
// what is looked at day to day; the settings are made once (AFS-88).
import { type ReactNode, useEffect, useId, useState } from 'react';
import { api, type Delivery, type NotifySettings, type SmtpSecurity } from './api';
import { Link } from './router';
import { Copyable, Field, Form, Loading, messageOf, PageHead, Tabs, Time, useLoad } from './ui';

const EVENT_LABEL: Record<string, string> = {
  'approval.waiting': 'approval waits',
  'approval.decided': 'approval decided',
  'run.ended': 'run ended',
  'certificate.expiring': 'certificate',
  test: 'test',
};
const TONE: Record<string, string> = { sent: 'ok', failed: 'bad', pending: 'busy' };

function SmtpForm({
  settings,
  onSaved,
  more,
}: {
  settings: NotifySettings;
  onSaved(): void;
  /** AFS-101: Send no email, in the same row as Save. */
  more?: ReactNode;
}) {
  const smtp = settings.smtp;
  const [host, setHost] = useState(smtp?.host ?? '');
  const [security, setSecurity] = useState<SmtpSecurity>(smtp?.security ?? 'starttls');
  const [port, setPort] = useState(String(smtp?.port ?? ''));
  const [user, setUser] = useState(smtp?.user ?? '');
  const [password, setPassword] = useState('');
  const [from, setFrom] = useState(smtp?.from ?? '');
  const securityId = useId();
  return (
    <Form
      more={more}
      submit="Save the mail server"
      onSubmit={async () => {
        await api.setSmtp({
          host,
          security,
          ...(port.trim() ? { port: Number(port) } : {}),
          user: user.trim() || null,
          // Left empty: the password stays as it is.
          ...(password ? { password } : {}),
          from,
        });
        setPassword('');
        onSaved();
      }}
    >
      <Field label="Mail server" value={host} onChange={(e) => setHost(e.target.value)} required />
      <div className="field">
        <label htmlFor={securityId}>Security</label>
        <select
          id={securityId}
          value={security}
          onChange={(e) => setSecurity(e.target.value as SmtpSecurity)}
        >
          <option value="starttls">STARTTLS, required (port 587)</option>
          <option value="tls">TLS from the start (port 465)</option>
          <option value="none">As the server allows (a relay on the network)</option>
        </select>
      </div>
      <Field
        label="Port"
        inputMode="numeric"
        value={port}
        onChange={(e) => setPort(e.target.value)}
        placeholder={security === 'tls' ? '465' : '587'}
      />
      <Field label="User" value={user} onChange={(e) => setUser(e.target.value)} />
      <Field
        label="Password"
        type="password"
        autoComplete="new-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        hint={smtp?.hasPassword ? 'Kept. Type a new one to replace it.' : undefined}
      />
      <Field
        label="Sender"
        value={from}
        onChange={(e) => setFrom(e.target.value)}
        placeholder="Flow Server <flows@example.net>"
        required
      />
    </Form>
  );
}

function TestForm({ onSent }: { onSent(): void }) {
  const [channel, setChannel] = useState<'email' | 'webhook'>('email');
  const [to, setTo] = useState('');
  const [result, setResult] = useState<Delivery>();
  const channelId = useId();
  return (
    <Form
      submit="Send a test"
      onSubmit={async () => {
        setResult(undefined);
        setResult(await api.testNotification(channel, to.trim() || undefined));
        onSent();
      }}
    >
      <div className="field">
        <label htmlFor={channelId}>By</label>
        <select
          id={channelId}
          value={channel}
          onChange={(e) => setChannel(e.target.value as 'email' | 'webhook')}
        >
          <option value="email">email</option>
          <option value="webhook">webhook</option>
        </select>
      </div>
      <Field
        label="To"
        value={to}
        onChange={(e) => setTo(e.target.value)}
        hint={`Empty: your own ${channel === 'email' ? 'email address' : 'webhook'}`}
      />
      {result && (
        <p className={`notice ${result.status === 'sent' ? '' : 'error'}`} role="status">
          {result.status === 'sent'
            ? `Sent to ${result.target}.`
            : `Not sent: ${result.lastError ?? 'no answer yet'}`}
        </p>
      )}
    </Form>
  );
}

function WebhookKey({ has, onMade }: { has: boolean; onMade(): void }) {
  const [made, setMade] = useState<string>();
  const [error, setError] = useState<string>();
  return (
    <>
      <p>
        {has
          ? 'Webhooks are signed: receivers check the X-AFS-Signature header with the key.'
          : 'Webhooks go unsigned until there is a key.'}
      </p>
      {made && (
        <p className="notice" role="status">
          The new key, shown this once: <Copyable text={made} label="the key" />
        </p>
      )}
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <button
        type="button"
        onClick={async () => {
          if (has && !window.confirm('Make a new key? Receivers checking the old one will refuse.'))
            return;
          try {
            setMade(await api.newWebhookKey());
            onMade();
          } catch (e) {
            setError(messageOf(e));
          }
        }}
      >
        {has ? 'Make a new key' : 'Make a key'}
      </button>
    </>
  );
}

const BASE = '/admin/notifications';
const SETTINGS = `${BASE}/settings`;

/** In a few words: can the server send at all, and can a receiver trust what it gets. */
function Standing({ settings }: { settings: NotifySettings }) {
  return (
    <p className="statusline">
      {settings.smtp ? (
        <span>Email goes through {settings.smtp.host}</span>
      ) : (
        <span>
          Email is not set up: no email is sent. <Link to={SETTINGS}>Set it up</Link>
        </span>
      )}
      <span>{settings.webhookKey ? 'Webhooks are signed' : 'Webhooks are not signed'}</span>
      {!settings.publicUrl && <span>Messages carry no links</span>}
    </p>
  );
}

function DeliveryLog({
  list,
  status,
  onStatus,
  onChanged,
}: {
  list?: Delivery[];
  status: string;
  onStatus(status: string): void;
  onChanged(): void;
}) {
  const statusId = useId();
  return (
    <section aria-labelledby="log">
      <h2 id="log" className="sr-only">
        Delivery log
      </h2>
      <div className="filters">
        <label className="inline" htmlFor={statusId}>
          Status{' '}
          <select id={statusId} value={status} onChange={(e) => onStatus(e.target.value)}>
            <option value="">all</option>
            <option value="pending">being tried</option>
            <option value="sent">sent</option>
            <option value="failed">given up</option>
          </select>
        </label>
      </div>
      {list?.length === 0 && (
        <p className="empty">{status ? 'No such message.' : 'No message yet.'}</p>
      )}
      {!!list?.length && (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">What</th>
                <th scope="col">To</th>
                <th scope="col">Status</th>
                <th scope="col">Why</th>
              </tr>
            </thead>
            <tbody>
              {list.map((d) => (
                <tr key={d.id}>
                  <td>
                    <Time at={d.createdAt} />
                  </td>
                  <td>
                    {EVENT_LABEL[d.event] ?? d.event}
                    <div className="muted">
                      {d.run ? <Link to={`/runs/${d.run}`}>{d.subject}</Link> : d.subject}
                    </div>
                  </td>
                  <td>
                    {d.recipient}
                    <div className="muted">
                      {d.channel}: {d.target}
                    </div>
                  </td>
                  <td>
                    <span className={`badge ${TONE[d.status] ?? ''}`}>
                      {d.status === 'pending'
                        ? 'being tried'
                        : d.status === 'failed'
                          ? 'given up'
                          : 'sent'}
                    </span>
                    {d.attempts > 1 && <div className="muted">{d.attempts} tries</div>}
                  </td>
                  <td className="detail">
                    {d.lastError ?? (d.status === 'sent' ? <span className="muted">—</span> : null)}
                    {d.status === 'pending' && d.nextAt && d.attempts > 0 && (
                      <div className="muted">
                        Next try <Time at={d.nextAt} />
                      </div>
                    )}
                    {d.status === 'failed' && (
                      <div>
                        <button
                          type="button"
                          onClick={async () => {
                            await api.retryDelivery(d.id).catch(() => undefined);
                            onChanged();
                          }}
                        >
                          Try again
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Settings({
  settings,
  onChanged,
  onSent,
}: {
  settings: NotifySettings;
  onChanged(): void;
  onSent(): void;
}) {
  return (
    <>
      {!settings.publicUrl && (
        <p className="notice">
          Messages carry no links: set AFS_PUBLIC_URL to the address people open the server at.
        </p>
      )}
      <p className="muted">
        People are told at the email address and webhook of their account. Everyone sets their own
        email address on My account; an administrator sets webhooks. A group without either is told
        through its members.
      </p>
      <div className="columns">
        <section className="panel" aria-labelledby="mail">
          <h2 id="mail">Email</h2>
          {!settings.smtp && (
            <p className="muted">No mail server yet: the server sends no email.</p>
          )}
          <SmtpForm
            settings={settings}
            onSaved={onChanged}
            more={
              settings.smtp && (
                <button
                  type="button"
                  onClick={async () => {
                    if (!window.confirm('Send no email any more?')) return;
                    await api.clearSmtp().catch(() => undefined);
                    onChanged();
                  }}
                >
                  Send no email
                </button>
              )
            }
          />
        </section>
        <section className="panel" aria-labelledby="hooks">
          <h2 id="hooks">Webhooks</h2>
          <p className="muted">
            A webhook gets the event as JSON, with a <code>text</code> line chat tools show.
          </p>
          <WebhookKey has={settings.webhookKey} onMade={onChanged} />
        </section>
        <section className="panel" aria-labelledby="test">
          <h2 id="test">Test</h2>
          <p className="muted">
            How it went is in the <Link to={BASE}>delivery log</Link>.
          </p>
          <TestForm onSent={onSent} />
        </section>
      </div>
    </>
  );
}

export function NotificationsPage({ tab }: { tab: 'log' | 'settings' }) {
  const settings = useLoad(() => api.notifySettings(), []);
  // The log is read on both tabs: its tab is marked while a message was given up on.
  const [status, setStatus] = useState('');
  const list = useLoad(() => api.deliveries({ ...(status ? { status } : {}) }), [status]);
  // Messages go out in the background: the log is looked at again now and then.
  useEffect(() => {
    const timer = setInterval(list.reload, 15_000);
    return () => clearInterval(timer);
  }, [list.reload]);
  // A filter that leaves the given-up ones out says nothing about them: the mark stays as it was.
  const [gaveUp, setGaveUp] = useState(false);
  useEffect(() => {
    if (list.data && (status === '' || status === 'failed'))
      setGaveUp(list.data.some((d) => d.status === 'failed'));
  }, [list.data, status]);
  const s = settings.data;
  return (
    <>
      <PageHead
        help="notifications.md"
        title="Notifications"
        lead="What the server told people, and how it sends: approvals that wait and how they were decided, runs that fail or end, the server certificate nearing its end."
      />
      <Tabs
        label="Notifications"
        base={BASE}
        current={tab === 'settings' ? 'settings' : ''}
        tabs={[
          { key: '', label: 'Delivery log', alert: gaveUp },
          { key: 'settings', label: 'Settings' },
        ]}
      />
      <Loading state={settings} />
      {tab === 'settings' ? (
        s && <Settings settings={s} onChanged={settings.reload} onSent={list.reload} />
      ) : (
        <>
          {s && <Standing settings={s} />}
          <DeliveryLog
            list={list.data}
            status={status}
            onStatus={setStatus}
            onChanged={list.reload}
          />
          <Loading state={list} />
        </>
      )}
    </>
  );
}
