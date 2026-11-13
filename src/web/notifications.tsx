// Notifications, for administrators (AFS-29): how the server sends (the mail server, the key
// webhooks are signed with), a test message, and the delivery log: each message, where it went,
// and how it went, with a retry for those given up on.
import { useEffect, useId, useState } from 'react';
import { api, type Delivery, type NotifySettings, type SmtpSecurity } from './api';
import { Link } from './router';
import { Copyable, Field, Form, Loading, messageOf, PageHead, Time, useLoad } from './ui';

const EVENT_LABEL: Record<string, string> = {
  'approval.waiting': 'approval waits',
  'approval.decided': 'approval decided',
  'run.ended': 'run ended',
  'certificate.expiring': 'certificate',
  test: 'test',
};
const TONE: Record<string, string> = { sent: 'ok', failed: 'bad', pending: 'busy' };

function SmtpForm({ settings, onSaved }: { settings: NotifySettings; onSaved(): void }) {
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

/** `turn`: a new value reads the log again (a test was just sent). */
function DeliveryLog({ turn }: { turn: number }) {
  const [status, setStatus] = useState('');
  const list = useLoad(() => api.deliveries({ ...(status ? { status } : {}) }), [status, turn]);
  // Messages go out in the background: the log is looked at again now and then.
  useEffect(() => {
    const timer = setInterval(list.reload, 15_000);
    return () => clearInterval(timer);
  }, [list.reload]);
  const statusId = useId();
  return (
    <section aria-labelledby="log">
      <h2 id="log">Delivery log</h2>
      <div className="filters">
        <label className="inline" htmlFor={statusId}>
          Status{' '}
          <select id={statusId} value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">all</option>
            <option value="pending">being tried</option>
            <option value="sent">sent</option>
            <option value="failed">given up</option>
          </select>
        </label>
      </div>
      {list.data?.length === 0 && <p className="empty">No message yet.</p>}
      {!!list.data?.length && (
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
              {list.data.map((d) => (
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
                    {d.lastError}
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
                            list.reload();
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
      <Loading state={list} />
    </section>
  );
}

export function NotificationsPage() {
  const settings = useLoad(() => api.notifySettings(), []);
  const [turn, setTurn] = useState(0);
  const s = settings.data;
  return (
    <>
      <PageHead
        title="Notifications"
        lead="Approvers are asked when a run waits for them; who launched a run is told how it was decided; a launch configuration can tell people when its runs fail or end; administrators hear when the server certificate nears its end."
      />
      <Loading state={settings} />
      {s && (
        <>
          {!s.publicUrl && (
            <p className="notice">
              Messages carry no links: set AFS_PUBLIC_URL to the address people open the server at.
            </p>
          )}
          <p className="muted">
            People and groups are told at the email address and webhook their account has (set by an
            administrator over the API); a group without either is told through its members.
          </p>
          <div className="columns">
            <section className="panel" aria-labelledby="mail">
              <h2 id="mail">Email</h2>
              {!s.smtp && <p className="muted">No mail server yet: the server sends no email.</p>}
              <SmtpForm settings={s} onSaved={settings.reload} />
              {s.smtp && (
                <button
                  type="button"
                  onClick={async () => {
                    if (!window.confirm('Send no email any more?')) return;
                    await api.clearSmtp().catch(() => undefined);
                    settings.reload();
                  }}
                >
                  Send no email
                </button>
              )}
            </section>
            <section className="panel" aria-labelledby="hooks">
              <h2 id="hooks">Webhooks</h2>
              <p className="muted">
                A webhook gets the event as JSON, with a <code>text</code> line chat tools show.
              </p>
              <WebhookKey has={s.webhookKey} onMade={settings.reload} />
            </section>
            <section className="panel" aria-labelledby="test">
              <h2 id="test">Test</h2>
              <TestForm onSent={() => setTurn((n) => n + 1)} />
            </section>
          </div>
        </>
      )}
      <DeliveryLog turn={turn} />
    </>
  );
}
