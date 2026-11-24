// Event streaming, for administrators (AFS-53): where audit entries and runs go besides the
// server's own pages: a syslog receiver (a SIEM) or an OpenTelemetry collector. Each destination
// says how it goes (what waits, since when, what was dropped, the last error), and can be tested.
import { useId, useState } from 'react';
import { api, type Sink, type SinkInput, type SinkTest } from './api';
import { ask } from './confirm';
import {
  Field,
  Form,
  Labelled,
  Loading,
  messageOf,
  PageHead,
  Scroll,
  Time,
  useLoad,
  useRefresh,
} from './ui';

type Kind = Sink['type'];

const TYPE_LABEL: Record<Kind, string> = { syslog: 'Syslog', otlp: 'OpenTelemetry' };

function Check({
  label,
  checked,
  onChange,
  name,
}: {
  label: string;
  checked: boolean;
  onChange(on: boolean): void;
  name?: string;
}) {
  return (
    <label className="check">
      <input
        type="checkbox"
        name={name}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />{' '}
      {label}
    </label>
  );
}

function CaField({
  value,
  onChange,
  name,
}: {
  value: string;
  onChange(v: string): void;
  name: string;
}) {
  return (
    <Labelled
      label="Certificate authority (PEM)"
      name={name}
      hint="Empty: the authorities the server trusts. Paste the receiver's CA when it has its own."
    >
      {(props) => (
        <textarea
          {...props}
          name={name}
          rows={4}
          className="mono"
          spellCheck={false}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="-----BEGIN CERTIFICATE-----"
        />
      )}
    </Labelled>
  );
}

interface Header {
  /** Tells rows apart while names are typed. */
  key: number;
  name: string;
  value: string;
  /** Saved before: an empty value keeps it. */
  kept: boolean;
}

/** Adds or changes one destination. */
function SinkForm({ sink, onDone }: { sink?: Sink; onDone(saved?: Sink): void }) {
  const [type, setType] = useState<Kind>(sink?.type ?? 'syslog');
  const [name, setName] = useState(sink?.name ?? '');
  const [enabled, setEnabled] = useState(sink?.enabled ?? true);
  const [audit, setAudit] = useState(sink?.audit ?? true);
  const [runs, setRuns] = useState(sink?.runs ?? true);
  const sy = sink?.syslog;
  const [host, setHost] = useState(sy?.host ?? '');
  const [port, setPort] = useState(sy ? String(sy.port) : '');
  const [transport, setTransport] = useState(sy?.transport ?? 'tls');
  const [syslogCa, setSyslogCa] = useState(sy?.ca ?? '');
  const [facility, setFacility] = useState(String(sy?.facility ?? 13));
  const [enterprise, setEnterprise] = useState(String(sy?.enterprise ?? 32473));
  const [bom, setBom] = useState(sy?.bom ?? true);
  const [hostname, setHostname] = useState(sy?.hostname ?? '');
  const [framing, setFraming] = useState(sy?.framing ?? 'octet');
  const ot = sink?.otlp;
  const [endpoint, setEndpoint] = useState(ot?.endpoint ?? '');
  const [otlpCa, setOtlpCa] = useState(ot?.ca ?? '');
  const [environment, setEnvironment] = useState(ot?.environment ?? '');
  const [hostNames, setHostNames] = useState(ot?.hostNames ?? true);
  const [headers, setHeaders] = useState<Header[]>(
    ot?.headers.map((h, i) => ({ key: i, name: h, value: '', kept: true })) ?? [],
  );
  const [maxBacklog, setMaxBacklog] = useState(String(sink?.maxBacklog ?? 100000));
  const [maxAgeDays, setMaxAgeDays] = useState(String(sink?.maxAgeDays ?? 7));
  const typeId = useId();
  const transportId = useId();
  const framingId = useId();
  const number = (text: string) => (text.trim() ? Number(text) : undefined);

  const input = (): SinkInput => ({
    name,
    type,
    enabled,
    audit,
    runs,
    ...(type === 'syslog'
      ? {
          syslog: {
            host,
            transport,
            ...(number(port) !== undefined ? { port: number(port) } : {}),
            ca: syslogCa,
            facility: Number(facility),
            enterprise: Number(enterprise),
            bom,
            hostname,
            framing,
          },
        }
      : {
          otlp: {
            endpoint,
            ca: otlpCa,
            environment,
            hostNames,
            headers: headers
              .filter((h) => h.name.trim())
              .map((h) => ({
                name: h.name.trim(),
                ...(h.value || !h.kept ? { value: h.value } : {}),
              })),
          },
        }),
    maxBacklog: Number(maxBacklog),
    maxAgeDays: Number(maxAgeDays),
  });

  return (
    <Form
      open
      wide
      submit={sink ? 'Save' : 'Add the destination'}
      onCancel={() => onDone()}
      onSubmit={async () => {
        const body = input();
        onDone(
          sink
            ? await api.changeStream(sink.id, (({ type: _t, ...rest }) => rest)(body))
            : await api.addStream(body),
        );
      }}
    >
      {!sink && (
        <div className="field">
          <label htmlFor={typeId}>Type</label>
          <select id={typeId} value={type} onChange={(e) => setType(e.target.value as Kind)}>
            <option value="syslog">Syslog (RFC 5424): a SIEM or log server</option>
            <option value="otlp">OpenTelemetry (OTLP/HTTP JSON): a collector</option>
          </select>
        </div>
      )}
      <Field
        label="Name"
        name="name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
        maxLength={100}
      />
      <div className="field">
        <Check label="On" checked={enabled} onChange={setEnabled} />
        <Check
          label={type === 'syslog' ? 'Audit entries' : 'Audit entries (log records)'}
          checked={audit}
          onChange={setAudit}
        />
        <Check
          label={type === 'syslog' ? 'Runs (a line at their start and end)' : 'Runs (a trace each)'}
          checked={runs}
          onChange={setRuns}
        />
      </div>
      {type === 'syslog' ? (
        <>
          <Field
            label="Receiver"
            name="syslog.host"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="siem.example.net"
            required
          />
          <div className="field">
            <label htmlFor={transportId}>Transport</label>
            <select
              id={transportId}
              name="syslog.transport"
              value={transport}
              onChange={(e) => setTransport(e.target.value as typeof transport)}
            >
              <option value="tls">TLS (RFC 5425, port 6514)</option>
              <option value="tcp">TCP, not encrypted</option>
              <option value="udp">UDP: messages can be lost (labs only)</option>
            </select>
          </div>
          <Field
            label="Port"
            name="syslog.port"
            inputMode="numeric"
            value={port}
            onChange={(e) => setPort(e.target.value)}
            placeholder={transport === 'tls' ? '6514' : '514'}
          />
          {transport === 'tls' && (
            <CaField name="syslog.ca" value={syslogCa} onChange={setSyslogCa} />
          )}
          <Field
            label="Facility"
            name="syslog.facility"
            inputMode="numeric"
            value={facility}
            onChange={(e) => setFacility(e.target.value)}
            hint="13 is log audit; 10 authpriv and 16 to 23 local0 to local7 are common too."
          />
          <Field
            label="Enterprise number"
            name="syslog.enterprise"
            inputMode="numeric"
            value={enterprise}
            onChange={(e) => setEnterprise(e.target.value)}
            hint="In the structured data names: audit@32473. 32473 is the number for documentation."
          />
          <Field
            label="Host name in messages"
            name="syslog.hostname"
            value={hostname}
            onChange={(e) => setHostname(e.target.value)}
            hint="Empty: the server's host name."
          />
          {transport !== 'udp' && (
            <div className="field">
              <label htmlFor={framingId}>Framing</label>
              <select
                id={framingId}
                value={framing}
                onChange={(e) => setFraming(e.target.value as typeof framing)}
              >
                <option value="octet">Octet counting (RFC 5425)</option>
                <option value="lf">One message per line (older receivers)</option>
              </select>
            </div>
          )}
          <div className="field">
            <Check
              label="A byte order mark before the message (RFC 5424; some viewers show it)"
              checked={bom}
              onChange={setBom}
            />
          </div>
        </>
      ) : (
        <>
          <Field
            label="Endpoint"
            name="otlp.endpoint"
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder="https://collector.example.net:4318"
            hint="/v1/logs and /v1/traces are added to it."
            required
          />
          {endpoint.startsWith('https:') && (
            <CaField name="otlp.ca" value={otlpCa} onChange={setOtlpCa} />
          )}
          <fieldset className="field">
            <legend>Headers</legend>
            <small className="muted">
              Sent with each request, such as Authorization or api-key. Their values are kept
              encrypted and never shown.
            </small>
            {headers.map((h, i) => (
              <div className="row" key={h.key}>
                <input
                  aria-label="Header name"
                  name="otlp.headers"
                  value={h.name}
                  onChange={(e) =>
                    setHeaders(
                      headers.map((x, j) =>
                        j === i ? { ...x, name: e.target.value, kept: false } : x,
                      ),
                    )
                  }
                />
                <input
                  aria-label={`Value of ${h.name || 'the header'}`}
                  type="password"
                  autoComplete="off"
                  value={h.value}
                  placeholder={h.kept ? 'kept' : ''}
                  onChange={(e) =>
                    setHeaders(
                      headers.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)),
                    )
                  }
                />
                <button type="button" onClick={() => setHeaders(headers.filter((_, j) => j !== i))}>
                  Remove
                </button>
              </div>
            ))}
            <div>
              <button
                type="button"
                onClick={() =>
                  setHeaders([
                    ...headers,
                    {
                      key: Math.max(0, ...headers.map((x) => x.key + 1)),
                      name: '',
                      value: '',
                      kept: false,
                    },
                  ])
                }
              >
                Add a header
              </button>
            </div>
          </fieldset>
          <Field
            label="Environment"
            name="otlp.environment"
            value={environment}
            onChange={(e) => setEnvironment(e.target.value)}
            hint="deployment.environment.name, such as production."
          />
          <div className="field">
            <Check
              label="Host names in traces (off: counts only)"
              checked={hostNames}
              onChange={setHostNames}
            />
          </div>
        </>
      )}
      <Field
        label="Most rows waiting"
        name="maxBacklog"
        inputMode="numeric"
        value={maxBacklog}
        onChange={(e) => setMaxBacklog(e.target.value)}
        hint="While the destination is down, what it should get waits; past this the oldest is dropped."
      />
      <Field
        label="Most days waiting"
        name="maxAgeDays"
        inputMode="numeric"
        value={maxAgeDays}
        onChange={(e) => setMaxAgeDays(e.target.value)}
      />
    </Form>
  );
}

/** Where it goes, in a few words. */
const whereOf = (s: Sink) =>
  s.syslog
    ? `${s.syslog.transport.toUpperCase()} ${s.syslog.host}:${s.syslog.port}`
    : (s.otlp?.endpoint ?? '');

function Health({ sink }: { sink: Sink }) {
  const st = sink.status;
  const tone = !sink.enabled ? '' : st.failingSince ? 'bad' : st.lastSuccessAt ? 'ok' : 'busy';
  const word = !sink.enabled
    ? 'off'
    : st.failingSince
      ? 'failing'
      : st.lastSuccessAt
        ? 'sending'
        : 'nothing sent yet';
  return (
    <>
      <span className={`badge ${tone}`}>{word}</span>
      {st.failingSince && (
        <div className="muted">
          since <Time at={st.failingSince} />
        </div>
      )}
      {sink.enabled && st.nextTryAt && (
        <div className="muted">
          next try <Time at={st.nextTryAt} />
        </div>
      )}
      {st.lastSuccessAt && (
        <div className="muted">
          last sent <Time at={st.lastSuccessAt} />
        </div>
      )}
    </>
  );
}

export function StreamsPage() {
  const list = useLoad(() => api.streams(), []);
  useRefresh(list.reload, 15_000);
  const [editing, setEditing] = useState<Sink | 'new'>();
  const [tested, setTested] = useState<{ id: string; result: SinkTest }>();
  const [error, setError] = useState<string>();
  return (
    <>
      <PageHead
        help="event-streaming.md"
        title="Event streaming"
        lead="Audit entries and runs sent as they happen to a syslog receiver or an OpenTelemetry collector: a SIEM, a log store, a tracing backend."
      />
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {editing ? (
        <section className="panel" aria-labelledby="sink-form">
          <h2 id="sink-form">
            {editing === 'new'
              ? 'Add a destination'
              : `${TYPE_LABEL[editing.type]}: ${editing.name}`}
          </h2>
          <SinkForm
            {...(editing === 'new' ? {} : { sink: editing })}
            onDone={() => {
              setEditing(undefined);
              list.reload();
            }}
          />
        </section>
      ) : (
        <p>
          <button type="button" className="primary" onClick={() => setEditing('new')}>
            Add a destination
          </button>
        </p>
      )}
      <Loading state={list} />
      {list.data?.length === 0 && !editing && (
        <p className="empty">No destination yet: audit entries and runs stay on this server.</p>
      )}
      {!!list.data?.length && (
        <Scroll>
          <table>
            <thead>
              <tr>
                <th scope="col">Destination</th>
                <th scope="col">Gets</th>
                <th scope="col">Status</th>
                <th scope="col">Waiting</th>
                <th scope="col">Last error</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((s) => (
                <tr key={s.id}>
                  <td>
                    {s.name}
                    <div className="muted">
                      {TYPE_LABEL[s.type]}: {whereOf(s)}
                    </div>
                  </td>
                  <td>
                    {[s.audit && 'audit entries', s.runs && 'runs'].filter(Boolean).join(', ') ||
                      'nothing'}
                  </td>
                  <td>
                    <Health sink={s} />
                  </td>
                  <td>
                    {s.status.backlog}
                    {s.status.oldestAt && (
                      <div className="muted">
                        oldest <Time at={s.status.oldestAt} />
                      </div>
                    )}
                    {s.status.dropped > 0 && (
                      <div className="bad-text">{s.status.dropped} dropped</div>
                    )}
                  </td>
                  <td className="detail">
                    {s.status.lastError ?? <span className="muted">—</span>}
                    {s.status.lastErrorAt && (
                      <div className="muted">
                        <Time at={s.status.lastErrorAt} />
                      </div>
                    )}
                  </td>
                  <td>
                    <div className="actions">
                      <button
                        type="button"
                        onClick={async () => {
                          setError(undefined);
                          try {
                            setTested({ id: s.id, result: await api.testStream(s.id) });
                            // A test that reached a failing destination sends what waits now.
                            list.reload();
                          } catch (e) {
                            setError(messageOf(e));
                          }
                        }}
                      >
                        Test
                      </button>
                      <button type="button" onClick={() => setEditing(s)}>
                        Change
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          if (
                            !(await ask(
                              `Remove "${s.name}"? What waits to go to it (${s.status.backlog}) is dropped.`,
                              { yes: 'Remove', danger: true },
                            ))
                          )
                            return;
                          await api.removeStream(s.id).catch((e) => setError(messageOf(e)));
                          list.reload();
                        }}
                      >
                        Remove
                      </button>
                    </div>
                    {tested?.id === s.id && (
                      <p className={`notice ${tested.result.ok ? 'ok' : 'error'}`} role="status">
                        Test: {tested.result.message}{' '}
                        <button type="button" className="link" onClick={() => setTested(undefined)}>
                          Dismiss
                        </button>
                      </p>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Scroll>
      )}
    </>
  );
}
