// The server certificate, for administrators (AFS-54): the one in use, the one before it and a
// waiting request; make a request and download it, install the signed certificate (or replace
// with a certificate and key), make a new self-signed one, roll back; the history. A refused
// certificate is shown with every reason. And the banner every administrator sees while the
// certificate has 30 days or fewer left.
import { useEffect, useState } from 'react';
import { ApiError, api, type CertificateInfo, type CertificateState } from './api';
import { Link } from './router';
import { Field, Loading, messageOf, PageHead, Time, useLoad } from './ui';

/** Days left at which administrators are warned, on every page. */
const WARN_DAYS = 30;

const left = (info: CertificateInfo) =>
  info.daysLeft < 0
    ? `expired ${-info.daysLeft} day${info.daysLeft === -1 ? '' : 's'} ago`
    : `${info.daysLeft} day${info.daysLeft === 1 ? '' : 's'} left`;

function Details({ info, source }: { info: CertificateInfo; source?: string }) {
  return (
    <dl className="facts">
      <dt>Subject</dt>
      <dd>{info.subject}</dd>
      <dt>Names</dt>
      <dd>{info.names.join(', ') || 'none'}</dd>
      <dt>Issuer</dt>
      <dd>{info.selfSigned ? 'itself (self-signed)' : info.issuer}</dd>
      <dt>Valid</dt>
      <dd>
        <Time at={info.notBefore} /> to <Time at={info.notAfter} />{' '}
        <span className={`badge ${info.daysLeft <= WARN_DAYS ? 'bad' : 'ok'}`}>{left(info)}</span>
      </dd>
      <dt>Fingerprint</dt>
      <dd>
        <code className="wrap">{info.fingerprint}</code>
      </dd>
      {info.chain > 0 && (
        <>
          <dt>Chain</dt>
          <dd>
            {info.chain} more certificate{info.chain === 1 ? '' : 's'}
          </dd>
        </>
      )}
      {source && (
        <>
          <dt>Source</dt>
          <dd>{source === 'self-signed' ? 'made by the server (self-signed)' : 'installed'}</dd>
        </>
      )}
    </dl>
  );
}

/** A refusal: the server's sentence and, for a certificate, every reason. */
function Refusal({ error }: { error?: unknown }) {
  if (!error) return null;
  const problems = error instanceof ApiError ? (error.details.problems as unknown) : undefined;
  return (
    <div className="notice error" role="alert">
      <p>{messageOf(error)}</p>
      {Array.isArray(problems) && problems.length > 0 && (
        <ul>
          {problems.map((p) => (
            <li key={String(p)}>{String(p)}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One action: a button or form that sends once and shows its refusal. */
function useAction(onDone: (state: CertificateState) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const run = async (action: () => Promise<CertificateState>) => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      onDone(await action());
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

/** A file read into text, for a field that takes PEM. */
const readFile = (file: File | undefined, set: (text: string) => void) => {
  if (file) void file.text().then(set);
};

function PemField({
  label,
  value,
  onChange,
  hint,
  required,
}: {
  label: string;
  value: string;
  onChange(text: string): void;
  hint: string;
  required?: boolean;
}) {
  const id = label.toLowerCase().replace(/\W+/g, '-');
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <textarea
        id={id}
        rows={6}
        className="mono"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        spellCheck={false}
        aria-describedby={`${id}-hint`}
        placeholder="-----BEGIN …-----"
      />
      <small id={`${id}-hint`} className="muted">
        {hint}{' '}
        <label className="inline">
          Or a file:{' '}
          <input
            type="file"
            accept=".pem,.crt,.cer,.key,text/plain"
            aria-label={`${label} from a file`}
            onChange={(e) => readFile(e.target.files?.[0], onChange)}
          />
        </label>
      </small>
    </div>
  );
}

function RequestPanel({
  state,
  onDone,
}: {
  state: CertificateState;
  onDone(s: CertificateState): void;
}) {
  const [names, setNames] = useState(state.host ?? state.defaultNames[0] ?? '');
  const [organization, setOrganization] = useState('');
  const action = useAction(onDone);
  return (
    <section className="panel" aria-labelledby="request">
      <h2 id="request">Request a certificate</h2>
      <p className="muted">
        The server makes a new key, which never leaves it, and a request for your certificate
        authority to sign. Install the signed certificate below; the request's key goes with it.
      </p>
      {state.request && (
        <p className="notice" role="status">
          A request waits for its signed certificate.{' '}
          <a href="/api/v1/admin/certificate/request.pem" download>
            Download the request
          </a>
        </p>
      )}
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(() =>
            api.certificateRequest(
              names.split(/[\s,]+/).filter(Boolean),
              organization.trim() || undefined,
            ),
          );
        }}
      >
        <Field
          label="Names"
          value={names}
          onChange={(e) => setNames(e.target.value)}
          required
          hint="DNS names or IP addresses, separated by commas; the first is the common name."
        />
        <Field
          label="Organization"
          value={organization}
          onChange={(e) => setOrganization(e.target.value)}
        />
        <Refusal error={action.error} />
        <div className="actions">
          <button type="submit" className="primary" disabled={action.busy}>
            {state.request ? 'Make a new request' : 'Make the request'}
          </button>
        </div>
      </form>
    </section>
  );
}

function InstallPanel({
  state,
  onDone,
}: {
  state: CertificateState;
  onDone(s: CertificateState): void;
}) {
  const [certificate, setCertificate] = useState('');
  const [key, setKey] = useState('');
  const action = useAction((s) => {
    setCertificate('');
    setKey('');
    onDone(s);
  });
  return (
    <section className="panel" aria-labelledby="install">
      <h2 id="install">Install a certificate</h2>
      <p className="muted">
        The signed certificate, its chain after it. Without a key it answers the waiting request
        {state.current ? ', or renews for the key in use' : ''}; with a key it replaces the
        certificate outright. Nothing changes unless every check passes
        {state.host ? `, among them that it is good for ${state.host}` : ''}.
      </p>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(() => api.installCertificate(certificate, key.trim() ? key : undefined));
        }}
      >
        <PemField
          label="Certificate"
          value={certificate}
          onChange={setCertificate}
          required
          hint="PEM: BEGIN CERTIFICATE, then its chain."
        />
        <PemField
          label="Private key"
          value={key}
          onChange={setKey}
          hint="Only when replacing with a certificate made elsewhere: unencrypted PEM."
        />
        <Refusal error={action.error} />
        <div className="actions">
          <button type="submit" className="primary" disabled={action.busy}>
            Install
          </button>
        </div>
      </form>
    </section>
  );
}

function History({ turn }: { turn: number }) {
  const list = useLoad(api.certificateHistory, [turn]);
  return (
    <section aria-labelledby="history">
      <h2 id="history">History</h2>
      <Loading state={list} />
      {list.data?.length === 0 && <p className="empty">No change yet.</p>}
      {!!list.data?.length && (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">What</th>
                <th scope="col">By</th>
                <th scope="col">Certificate</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((h) => (
                <tr key={`${h.at}-${h.action}`}>
                  <td>
                    <Time at={h.at} />
                  </td>
                  <td>{h.action}</td>
                  <td>{h.by === 'cli' ? 'a command on the server' : h.by}</td>
                  <td>
                    {h.subject}
                    {h.notAfter && (
                      <div className="muted">
                        until <Time at={h.notAfter} />
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

export function CertificatePage() {
  const load = useLoad(api.certificate, []);
  const [state, setState] = useState<CertificateState>();
  const [turn, setTurn] = useState(0);
  const [done, setDone] = useState<string>();
  useEffect(() => setState(load.data), [load.data]);
  const changed = (what: string) => (next: CertificateState) => {
    setState(next);
    setTurn((n) => n + 1);
    setDone(what);
  };
  const other = useAction(changed('Done. New connections get the certificate now.'));
  return (
    <>
      <PageHead
        title="Server certificate"
        lead="What browsers, git and the VS Code extension see when they connect over HTTPS."
      />
      <Loading state={load} />
      {state && (
        <>
          {state.tls === 'off' && (
            <p className="notice">
              AFS_TLS is off: the server speaks plain HTTP behind a proxy, which holds the
              certificate people see. What is kept here is not served.
            </p>
          )}
          {done && (
            <p className="notice ok" role="status">
              {done}
            </p>
          )}
          <div className="columns">
            <section className="panel" aria-labelledby="in-use">
              <h2 id="in-use">In use</h2>
              {state.current ? (
                <Details info={state.current.info} source={state.current.source} />
              ) : (
                <p className="muted">
                  None yet: the server makes a self-signed one when it starts.
                </p>
              )}
              <Refusal error={other.error} />
              <div className="actions">
                <button
                  type="button"
                  disabled={other.busy}
                  onClick={() => {
                    if (
                      window.confirm(
                        `Replace the certificate with a new self-signed one for ${state.defaultNames.join(', ')}? Browsers will warn until people trust it.`,
                      )
                    )
                      void other.run(() => api.selfSignedCertificate());
                  }}
                >
                  New self-signed
                </button>
              </div>
            </section>
            {state.previous && (
              <section className="panel" aria-labelledby="before">
                <h2 id="before">Before it</h2>
                <Details info={state.previous} />
                <div className="actions">
                  <button
                    type="button"
                    disabled={other.busy}
                    onClick={() => {
                      if (window.confirm('Go back to this certificate?'))
                        void other.run(() => api.rollbackCertificate());
                    }}
                  >
                    Roll back to it
                  </button>
                </div>
              </section>
            )}
          </div>
          <div className="columns">
            <RequestPanel
              state={state}
              onDone={changed('The request is made. Download it for your certificate authority.')}
            />
            <InstallPanel
              state={state}
              onDone={changed('Installed. New connections get the certificate now.')}
            />
          </div>
          <History turn={turn} />
        </>
      )}
    </>
  );
}

/**
 * Shown to administrators on every page while the certificate has 30 days or fewer left. `path`:
 * looked at again on every page, so a replacement is seen at once.
 */
export function CertificateBanner({ path }: { path: string }) {
  const [info, setInfo] = useState<CertificateInfo>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again whenever the page changes
  useEffect(() => {
    let current = true;
    api.certificate().then(
      (s) => current && setInfo(s.tls === 'on' ? s.current?.info : undefined),
      () => current && setInfo(undefined),
    );
    return () => {
      current = false;
    };
  }, [path]);
  if (!info || info.daysLeft > WARN_DAYS || path === '/admin/certificate') return null;
  return (
    <p className={`notice ${info.daysLeft < 7 ? 'error' : ''}`} role="status">
      The server certificate{' '}
      {info.daysLeft < 0 ? 'has expired' : `ends in ${left(info).replace(' left', '')}`}.{' '}
      <Link to="/admin/certificate">Replace it</Link>
    </p>
  );
}
