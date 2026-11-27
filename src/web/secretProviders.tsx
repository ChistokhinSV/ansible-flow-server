// Administration › Secret providers (AFS-241): HashiCorp Vault, CyberArk Conjur and CCP, and AWS
// Secrets Manager. Administrators add one (a form per kind), say which workspaces may use it, test
// it (a sign-in, or a read of a reference: never the value), change and remove it. Its secret
// part (token, API key, client key) goes in and is never shown again.
import { useId, useState } from 'react';
import type { Workspace } from '../server/projects/store';
import {
  PROVIDER_KIND_NAME,
  PROVIDER_KINDS,
  type ProviderKind,
  type ProviderSettings,
  REF_FIELDS,
  SECRETS,
  SETTING_LABEL,
  SETTINGS,
  type SecretProvider,
  type SecretProviderInput,
} from '../server/secrets/providers/types';
import { api } from './api';
import { ask } from './confirm';
import { followKey } from './flowFiles';
import { Field, Form, Labelled, Loading, messageOf, PageHead, useLoad } from './ui';

type Draft = {
  id?: string;
  key: string;
  name: string;
  kind: ProviderKind;
  settings: ProviderSettings;
  secret: Record<string, string>;
  workspaces: string[];
  /** A change keeps the secret part unless asked to replace it. */
  replace: boolean;
  has: string[];
};

const EMPTY: Draft = {
  key: '',
  name: '',
  kind: 'vault',
  settings: { auth: 'approle' },
  secret: {},
  workspaces: [],
  replace: true,
  has: [],
};

const HINT: Record<string, string> = {
  address: 'https://vault.example.net:8200',
  ca: "Only when its certificate is not from an authority the server trusts: the authority's PEM",
  timeoutS: 'How long to wait for it to answer; 10 if empty',
  authMount: 'approle if empty',
  namespace: 'Vault Enterprise only',
  kvMount: 'The KV version 2 mount references read by default; secret if empty',
  account: 'The Conjur account (the first part of its ids)',
  login: 'host/afs: the host this server signs in as',
  appId: 'The application id CCP knows this server by',
  clientCert:
    'Only if CCP asks for one: the certificate it knows this server by. Its key is asked for once the certificate is here',
  region: 'The code of the region the secrets are in, as eu-central-1 or us-east-1',
};
const ADDRESS_HINT: Record<ProviderKind, string> = {
  vault: 'https://vault.example.net:8200',
  conjur: 'https://conjur.example.net',
  ccp: 'https://ccp.example.net',
  aws: "Empty: the region's own address. An endpoint of a VPC or a test service otherwise",
};
const PEM = new Set(['ca', 'clientCert', 'clientKey']);

/** The secret parts the form asks for: Vault's depend on how it signs in. */
function secretsOf(kind: ProviderKind, settings: ProviderSettings): string[] {
  if (kind === 'vault') return settings.auth === 'token' ? ['token'] : ['roleId', 'secretId'];
  if (kind === 'ccp') return settings.clientCert ? ['clientKey'] : [];
  return SECRETS[kind];
}

function ProviderForm({
  draft,
  workspaces,
  onDone,
  onCancel,
}: {
  draft: Draft;
  workspaces: Workspace[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const [d, setD] = useState(draft);
  const set = (change: Partial<Draft>) => setD((x) => ({ ...x, ...change }));
  const setting = (name: keyof ProviderSettings, value: string | number | undefined) =>
    setD((x) => ({ ...x, settings: { ...x.settings, [name]: value } }));
  const kindId = useId();
  const authId = useId();
  const pem = (name: string, value: string, onChange: (v: string) => void, hint?: string) => (
    <Labelled label={SETTING_LABEL[name] ?? name} name={name} hint={hint}>
      {(props) => (
        <textarea
          {...props}
          name={name}
          className="mono"
          rows={4}
          spellCheck={false}
          autoComplete="off"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={
            name === 'clientKey' ? '-----BEGIN PRIVATE KEY-----' : '-----BEGIN CERTIFICATE-----'
          }
        />
      )}
    </Labelled>
  );
  return (
    <section
      className="panel sheet"
      aria-label={d.id ? `Change ${draft.name}` : 'Add a secret provider'}
    >
      {/* AFS-252: the form opens above the list; its heading says which provider it changes. */}
      <h2>{d.id ? `Change ${draft.name}` : 'Add a secret provider'}</h2>
      <Form
        submit={d.id ? 'Save' : 'Add'}
        onCancel={onCancel}
        onSubmit={async () => {
          const settings = Object.fromEntries(
            Object.entries(d.settings).filter(
              ([k, v]) =>
                SETTINGS[d.kind].includes(k as keyof ProviderSettings) &&
                !(k === 'authMount' && d.settings.auth === 'token') &&
                v !== '' &&
                v !== undefined,
            ),
          ) as ProviderSettings;
          const input: SecretProviderInput = {
            key: d.key,
            name: d.name,
            kind: d.kind,
            settings,
            workspaces: d.workspaces,
            ...(d.replace || !secretsOf(d.kind, settings).every((n) => d.has.includes(n))
              ? {
                  secret: Object.fromEntries(
                    secretsOf(d.kind, settings)
                      .map((n) => [n, d.secret[n] ?? ''])
                      .filter(([, v]) => v),
                  ),
                }
              : {}),
          };
          if (d.id) {
            const { kind: _kind, ...change } = input;
            await api.changeSecretProvider(d.id, change);
          } else await api.addSecretProvider(input);
          onDone();
        }}
      >
        {!d.id && (
          <div className="field">
            <label htmlFor={kindId}>Kind</label>
            <select
              id={kindId}
              // biome-ignore lint/a11y/noAutofocus: the form was opened by its button just now
              autoFocus
              value={d.kind}
              onChange={(e) => {
                const kind = e.target.value as ProviderKind;
                set({ kind, settings: kind === 'vault' ? { auth: 'approle' } : {}, secret: {} });
              }}
            >
              {PROVIDER_KINDS.map((k) => (
                <option key={k} value={k}>
                  {PROVIDER_KIND_NAME[k]}
                </option>
              ))}
            </select>
          </div>
        )}
        <Field
          label="Name"
          name="name"
          autoFocus={!!d.id}
          value={d.name}
          onChange={(e) =>
            set({
              name: e.target.value,
              ...(d.id ? {} : { key: followKey(e.target.value, d.name, d.key, 40) }),
            })
          }
          required
          maxLength={100}
          hint="Said in the credential form and in a run's output"
        />
        <Field
          label="Key"
          name="key"
          value={d.key}
          onChange={(e) => set({ key: e.target.value.toLowerCase() })}
          required
          pattern="[a-z0-9][a-z0-9\-]{0,39}"
          hint="What credentials name it by; it cannot change while one reads from it"
        />
        {SETTINGS[d.kind].map((name) => {
          // AFS-261: the AppRole mount is asked only of an AppRole sign-in.
          if (name === 'authMount' && d.settings.auth === 'token') return null;
          if (name === 'auth')
            return (
              <div className="field" key={name}>
                <label htmlFor={authId}>{SETTING_LABEL.auth}</label>
                <select
                  id={authId}
                  value={d.settings.auth ?? 'approle'}
                  onChange={(e) => setting('auth', e.target.value)}
                >
                  <option value="approle">AppRole (role id and secret id)</option>
                  <option value="token">A token</option>
                </select>
              </div>
            );
          if (name === 'ca' || name === 'clientCert')
            return (
              <div key={name}>
                {pem(name, String(d.settings[name] ?? ''), (v) => setting(name, v), HINT[name])}
              </div>
            );
          if (name === 'timeoutS')
            return (
              <Field
                key={name}
                label={SETTING_LABEL[name] ?? name}
                name={name}
                type="number"
                min={1}
                max={120}
                value={d.settings.timeoutS === undefined ? '' : String(d.settings.timeoutS)}
                onChange={(e) =>
                  setting('timeoutS', e.target.value ? Number(e.target.value) : undefined)
                }
                hint={HINT[name]}
              />
            );
          return (
            <Field
              key={name}
              label={SETTING_LABEL[name] ?? name}
              name={name}
              value={String(d.settings[name] ?? '')}
              onChange={(e) => setting(name, e.target.value)}
              required={
                name === 'address'
                  ? d.kind !== 'aws'
                  : ['account', 'login', 'appId', 'region'].includes(name)
              }
              hint={name === 'address' ? ADDRESS_HINT[d.kind] : HINT[name]}
              autoComplete="off"
            />
          );
        })}
        {/* AFS-261: a sign-in changed to one whose parts are not kept asks for its own. */}
        {d.replace || !secretsOf(d.kind, d.settings).every((n) => d.has.includes(n)) ? (
          secretsOf(d.kind, d.settings).map((name) =>
            PEM.has(name) ? (
              <div key={name}>
                {pem(
                  name,
                  d.secret[name] ?? '',
                  (v) => set({ secret: { ...d.secret, [name]: v } }),
                  'Kept sealed and never shown again',
                )}
              </div>
            ) : (
              <Field
                key={name}
                label={SETTING_LABEL[name] ?? name}
                name={name}
                type="password"
                autoComplete="off"
                value={d.secret[name] ?? ''}
                onChange={(e) => set({ secret: { ...d.secret, [name]: e.target.value } })}
                required={name !== 'sessionToken'}
                hint="Kept sealed and never shown again"
              />
            ),
          )
        ) : (
          <p>
            Its{' '}
            {d.has.map((h) => SETTING_LABEL[h]?.toLowerCase() ?? h).join(' and ') || 'secret part'}{' '}
            {d.has.length > 1 ? 'are' : 'is'} kept.{' '}
            <button type="button" onClick={() => set({ replace: true })}>
              Replace
            </button>
          </p>
        )}
        <fieldset>
          <legend>Workspaces that may use it</legend>
          {workspaces.length === 0 && <p className="muted">No workspace yet.</p>}
          {workspaces.map((w) => (
            <label className="check" key={w.id}>
              <input
                type="checkbox"
                checked={d.workspaces.includes(w.id)}
                onChange={(e) =>
                  set({
                    workspaces: e.target.checked
                      ? [...d.workspaces, w.id]
                      : d.workspaces.filter((x) => x !== w.id),
                  })
                }
              />{' '}
              {w.name}
            </label>
          ))}
          <small className="muted">
            Only credentials in checked workspaces may read from this provider. Workspace
            administrators see where each credential reads; others see only which provider.
          </small>
        </fieldset>
      </Form>
    </section>
  );
}

/** Test: a sign-in, or with a reference, a read. Never shows a value. */
function TestBox({ provider }: { provider: SecretProvider }) {
  const [ref, setRef] = useState<Record<string, string>>({});
  const [result, setResult] = useState<{ ok: boolean; message: string }>();
  const [busy, setBusy] = useState(false);
  const fields = REF_FIELDS[provider.kind];
  const needed = fields.filter((f) => f.required).map((f) => f.label);
  return (
    <details className="test-box">
      <summary>Test the provider</summary>
      <p className="muted">
        Signs in. Fill in {needed.join(' and ')} to test a read too (values are never shown).
      </p>
      <div className="ref-test-fields">
        {fields.map((f) => (
          <Field
            key={f.name}
            label={f.required ? f.label : `${f.label} (optional)`}
            {...(f.hint ? { hint: f.hint } : {})}
            value={ref[f.name] ?? ''}
            onChange={(e) => setRef({ ...ref, [f.name]: e.target.value })}
            autoComplete="off"
          />
        ))}
      </div>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          const given = Object.fromEntries(Object.entries(ref).filter(([, v]) => v.trim()));
          setResult(
            await api
              .testSecretProvider(provider.id, Object.keys(given).length ? given : undefined)
              .catch((e) => ({ ok: false, message: messageOf(e) })),
          );
          setBusy(false);
        }}
      >
        {busy ? 'Asking…' : 'Test'}
      </button>
      {result && (
        <p aria-live="polite" className={result.ok ? 'notice' : 'notice error'}>
          {result.message}
        </p>
      )}
    </details>
  );
}

const draftOf = (p: SecretProvider): Draft => ({
  id: p.id,
  key: p.key,
  name: p.name,
  kind: p.kind,
  settings: p.settings,
  secret: {},
  workspaces: p.workspaces,
  replace: p.has.length === 0,
  has: p.has,
});

export function SecretProvidersPage() {
  const list = useLoad(api.secretProviders, []);
  const workspaces = useLoad(api.workspaces, []);
  const [editing, setEditing] = useState<Draft>();
  const [error, setError] = useState<string>();
  const workspaceName = (id: string) =>
    workspaces.data?.find((w) => w.id === id)?.name ?? 'a removed workspace';
  return (
    <>
      <PageHead
        help="secret-providers.md"
        title="Secret providers"
        lead="A value is read when a run starts, used for that run only and never kept."
      >
        {!editing && (
          <button type="button" onClick={() => setEditing({ ...EMPTY })}>
            Add a provider
          </button>
        )}
      </PageHead>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {editing && (
        <ProviderForm
          draft={editing}
          workspaces={workspaces.data ?? []}
          onCancel={() => setEditing(undefined)}
          onDone={() => {
            setEditing(undefined);
            list.reload();
          }}
        />
      )}
      <Loading state={list} />
      {list.data?.length === 0 && !editing && <p className="empty">No secret provider yet.</p>}
      {list.data?.map((p) => (
        <article key={p.id} className="panel provider" aria-label={p.name}>
          <h2>
            {p.name} <span className="tag">{PROVIDER_KIND_NAME[p.kind]}</span>
          </h2>
          <dl className="facts">
            <dt>Key</dt>
            <dd>
              <code>{p.key}</code>
            </dd>
            <dt>{p.kind === 'aws' ? 'Region' : 'Address'}</dt>
            <dd>
              <code>
                {p.kind === 'aws'
                  ? `${p.settings.region}${p.settings.address ? ` (${p.settings.address})` : ''}`
                  : p.settings.address}
              </code>
              {p.settings.ca ? ' · its own certificate authority' : ''}
            </dd>
            {p.kind === 'vault' && (
              <>
                <dt>Signs in with</dt>
                <dd>{p.settings.auth === 'token' ? 'a token' : 'AppRole'}</dd>
              </>
            )}
            {p.kind === 'conjur' && (
              <>
                <dt>Signs in as</dt>
                <dd>
                  <code>{p.settings.login}</code> in the account <code>{p.settings.account}</code>
                </dd>
              </>
            )}
            {p.kind === 'ccp' && (
              <>
                <dt>Application</dt>
                <dd>
                  <code>{p.settings.appId}</code>
                  {p.settings.clientCert ? ', with a client certificate' : ''}
                </dd>
              </>
            )}
            <dt>Workspaces</dt>
            <dd>
              {p.workspaces.length
                ? p.workspaces.map(workspaceName).join(', ')
                : 'none: no credential may use it yet'}
            </dd>
          </dl>
          <TestBox provider={p} />
          <div className="actions">
            <button type="button" onClick={() => setEditing(draftOf(p))}>
              Change
            </button>
            <button
              type="button"
              className="danger"
              onClick={async () => {
                if (
                  !(await ask(`Remove the secret provider ${p.name}? Its secret part goes too.`, {
                    yes: 'Remove',
                    danger: true,
                  }))
                )
                  return;
                setError(undefined);
                try {
                  await api.deleteSecretProvider(p.id);
                  list.reload();
                } catch (e) {
                  setError(messageOf(e));
                }
              }}
            >
              Remove
            </button>
          </div>
        </article>
      ))}
    </>
  );
}
