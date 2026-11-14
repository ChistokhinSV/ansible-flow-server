// Sign-in with OIDC providers in the pages (AFS-30): the providers' buttons on the sign-in page,
// and the administrators' page that sets them up, with what their groups claim means here and
// who may still sign in with a password.
import { useState } from 'react';
import type { Mapping, Provider, ProviderInput } from '../server/auth/oidc/types';
import type { Group } from '../server/auth/users';
import { api } from './api';
import { Link } from './router';
import { Copyable, Field, Form, Loading, messageOf, PageHead, Time, useLoad } from './ui';

/** The sign-in page's provider buttons, and why the last sign-in failed (?error=). */
export function ProviderButtons() {
  const methods = useLoad(api.signInMethods, []);
  const error = new URLSearchParams(window.location.search).get('error');
  const back = window.location.pathname === '/signin' ? '/' : window.location.pathname;
  const providers = methods.data?.providers ?? [];
  return (
    <>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {providers.length > 0 && (
        <div className="providers">
          {providers.map((p) => (
            <a
              key={p.key}
              className="button primary"
              href={`/api/v1/auth/oidc/${encodeURIComponent(p.key)}/start?return=${encodeURIComponent(back)}`}
            >
              Sign in with {p.name}
            </a>
          ))}
        </div>
      )}
      {methods.data?.local === 'admins' && (
        <p className="muted">A password is for administrators only on this server.</p>
      )}
    </>
  );
}

type Draft = ProviderInput & { id?: string; secretNew: string; replaceSecret: boolean };

const EMPTY: Draft = {
  key: '',
  name: '',
  issuer: '',
  clientId: '',
  scopes: 'openid profile email',
  groupsClaim: 'groups',
  loginClaim: 'preferred_username',
  enabled: true,
  mappings: [],
  secretNew: '',
  replaceSecret: true,
};

const draftOf = (p: Provider): Draft => ({
  id: p.id,
  key: p.key,
  name: p.name,
  issuer: p.issuer,
  clientId: p.clientId,
  scopes: p.scopes,
  groupsClaim: p.groupsClaim,
  loginClaim: p.loginClaim,
  enabled: p.enabled,
  mappings: p.mappings,
  secretNew: '',
  replaceSecret: !p.hasSecret,
});

function MappingRows({
  mappings,
  groups,
  onChange,
}: {
  mappings: Mapping[];
  groups: Group[];
  onChange: (m: Mapping[]) => void;
}) {
  const set = (i: number, m: Mapping) => onChange(mappings.map((x, j) => (j === i ? m : x)));
  return (
    <fieldset className="mappings">
      <legend>What the groups claim means here</legend>
      <p className="muted">
        A value of the claim (as the provider sends it, e.g. <code>/netops</code>) and the server
        group it puts the person in, or administrator. Other values are ignored; a sign-in takes
        back what the provider no longer says.
      </p>
      {mappings.map((m, i) => (
        // The value is the row's name; two rows may be typed with the same one while editing.
        // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity of their own
        <div className="mapping" key={i}>
          <Field
            label="Claim value"
            value={m.value}
            onChange={(e) => set(i, { ...m, value: e.target.value })}
            required
          />
          <div className="field">
            <label htmlFor={`map-${i}`}>Here</label>
            <select
              id={`map-${i}`}
              value={m.admin ? '__admin' : (m.group ?? '')}
              onChange={(e) =>
                set(
                  i,
                  e.target.value === '__admin'
                    ? { value: m.value, admin: true }
                    : { value: m.value, group: e.target.value },
                )
              }
              required
            >
              <option value="" disabled>
                Choose…
              </option>
              <option value="__admin">Administrator</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  Group {g.name}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            onClick={() => onChange(mappings.filter((_, j) => j !== i))}
            aria-label={`Remove ${m.value || 'this value'}`}
          >
            Remove
          </button>
        </div>
      ))}
      <button type="button" onClick={() => onChange([...mappings, { value: '', group: '' }])}>
        Add a value
      </button>
    </fieldset>
  );
}

function ProviderForm({
  draft,
  groups,
  onDone,
  onCancel,
}: {
  draft: Draft;
  groups: Group[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const [d, setD] = useState(draft);
  const set = (change: Partial<Draft>) => setD((x) => ({ ...x, ...change }));
  return (
    <section className="panel" aria-label={d.id ? `Change ${d.name}` : 'Add a provider'}>
      <Form
        submit={d.id ? 'Save' : 'Add'}
        onCancel={onCancel}
        onSubmit={async () => {
          const input: Partial<ProviderInput> = {
            key: d.key,
            name: d.name,
            issuer: d.issuer,
            clientId: d.clientId,
            scopes: d.scopes,
            groupsClaim: d.groupsClaim,
            loginClaim: d.loginClaim,
            enabled: d.enabled,
            mappings: d.mappings?.filter((m) => m.value.trim()),
            ...(d.replaceSecret ? { clientSecret: d.secretNew || null } : {}),
          };
          if (d.id) await api.changeOidcProvider(d.id, input);
          else await api.addOidcProvider(input as ProviderInput);
          onDone();
        }}
      >
        <Field
          label="Name"
          value={d.name}
          onChange={(e) => set({ name: e.target.value })}
          required
          hint="On the sign-in button"
        />
        <Field
          label="Key"
          value={d.key}
          onChange={(e) => set({ key: e.target.value.toLowerCase() })}
          required
          pattern="[a-z0-9][a-z0-9-]{0,39}"
          hint="In the sign-in address; lower-case letters, digits and dashes"
        />
        <Field
          label="Issuer"
          value={d.issuer}
          onChange={(e) => set({ issuer: e.target.value })}
          required
          type="url"
          hint="e.g. https://login.example.net/realms/net, or https://login.microsoftonline.com/<tenant>/v2.0"
        />
        <Field
          label="Client id"
          value={d.clientId}
          onChange={(e) => set({ clientId: e.target.value })}
          required
        />
        {d.replaceSecret ? (
          <Field
            label="Client secret"
            type="password"
            autoComplete="off"
            value={d.secretNew}
            onChange={(e) => set({ secretNew: e.target.value })}
            hint="Kept sealed and never shown again; empty for a public client"
          />
        ) : (
          <p>
            A client secret is kept.{' '}
            <button type="button" onClick={() => set({ replaceSecret: true })}>
              Replace it
            </button>
          </p>
        )}
        <Field
          label="Scopes"
          value={d.scopes}
          onChange={(e) => set({ scopes: e.target.value })}
          required
          hint="openid and what the claims need (e.g. groups)"
        />
        <Field
          label="Groups claim"
          value={d.groupsClaim}
          onChange={(e) => set({ groupsClaim: e.target.value })}
          required
        />
        <Field
          label="Login claim"
          value={d.loginClaim}
          onChange={(e) => set({ loginClaim: e.target.value })}
          required
          hint="A new person's login comes from it (else the email, else the subject)"
        />
        <label className="check">
          <input
            type="checkbox"
            checked={!!d.enabled}
            onChange={(e) => set({ enabled: e.target.checked })}
          />{' '}
          On the sign-in page
        </label>
        <MappingRows
          mappings={d.mappings ?? []}
          groups={groups}
          onChange={(mappings) => set({ mappings })}
        />
      </Form>
    </section>
  );
}

/** The administrators' page: providers, and who signs in with a password. */
export function SignInPage() {
  const providers = useLoad(api.oidcProviders, []);
  const groups = useLoad(api.groups, []);
  const local = useLoad(api.localSignIn, []);
  const [editing, setEditing] = useState<Draft>();
  const [note, setNote] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();
  const groupName = (id?: string) =>
    groups.data?.find((g) => g.id === id)?.name ?? 'a removed group';
  return (
    <>
      <PageHead
        title="Sign-in"
        lead={
          <>
            People sign in with a password here, or with your organisation&apos;s sign-in (OIDC:
            Keycloak, Entra ID, Google, and others). Their groups there can be groups here.{' '}
            <Link to="/admin">Administration</Link>
          </>
        }
      >
        {!editing && (
          <button type="button" className="primary" onClick={() => setEditing({ ...EMPTY })}>
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
          groups={groups.data ?? []}
          onCancel={() => setEditing(undefined)}
          onDone={() => {
            setEditing(undefined);
            providers.reload();
          }}
        />
      )}
      <section className="panel" aria-labelledby="providers">
        <h2 id="providers">Providers</h2>
        <Loading state={providers} />
        {providers.data?.length === 0 && (
          <p className="muted">None yet: people sign in with a password.</p>
        )}
        {providers.data?.map((p) => (
          <article key={p.id} className="provider" aria-label={p.name}>
            <h3>
              {p.name} {!p.enabled && <span className="tag">off</span>}
            </h3>
            <dl className="facts">
              <dt>Issuer</dt>
              <dd>
                <code>{p.issuer}</code>
              </dd>
              <dt>Client</dt>
              <dd>
                <code>{p.clientId}</code> {p.hasSecret ? '(with a secret)' : '(public, PKCE only)'}
              </dd>
              <dt>Register this</dt>
              <dd>
                {p.redirectUri && <Copyable text={p.redirectUri} label="the redirect address" />}
              </dd>
              <dt>Groups claim</dt>
              <dd>
                <code>{p.groupsClaim}</code>:{' '}
                {p.mappings.length
                  ? p.mappings
                      .map((m) => `${m.value} → ${m.admin ? 'administrator' : groupName(m.group)}`)
                      .join('; ')
                  : 'no values mean anything here'}
              </dd>
              <dt>Changed</dt>
              <dd>
                <Time at={p.updatedAt} />
              </dd>
            </dl>
            {note[p.id] && <p aria-live="polite">{note[p.id]}</p>}
            <div className="actions">
              <button type="button" onClick={() => setEditing(draftOf(p))}>
                Change
              </button>
              <button
                type="button"
                onClick={async () => {
                  setNote((n) => ({ ...n, [p.id]: 'Asking the provider…' }));
                  const t = await api
                    .testOidcProvider(p.id)
                    .catch((e) => ({ ok: false, message: messageOf(e) }));
                  setNote((n) => ({
                    ...n,
                    [p.id]: t.ok
                      ? `It answers: ${'issuer' in t ? t.issuer : ''}${'pkce' in t && !t.pkce ? ' (it does not say it supports PKCE)' : ''}`
                      : (t.message ?? 'It does not answer'),
                  }));
                }}
              >
                Test
              </button>
              <button
                type="button"
                className="danger"
                onClick={async () => {
                  if (
                    !window.confirm(
                      `Remove ${p.name}? Its people stay; the groups and administrator rights it gave go.`,
                    )
                  )
                    return;
                  try {
                    await api.deleteOidcProvider(p.id);
                    providers.reload();
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
      </section>
      <section className="panel" aria-labelledby="passwords">
        <h2 id="passwords">Passwords</h2>
        <Loading state={local} />
        {local.data && (
          <fieldset>
            <legend>Who may sign in with a password</legend>
            {(['all', 'admins'] as const).map((v) => (
              <label key={v} className="check">
                <input
                  type="radio"
                  name="local"
                  checked={local.data?.local === v}
                  onChange={async () => {
                    try {
                      await api.setLocalSignIn(v);
                      local.reload();
                    } catch (e) {
                      setError(messageOf(e));
                    }
                  }}
                />{' '}
                {v === 'all'
                  ? 'Everyone with one'
                  : 'Administrators only (everyone else signs in with a provider)'}
              </label>
            ))}
          </fieldset>
        )}
      </section>
    </>
  );
}
