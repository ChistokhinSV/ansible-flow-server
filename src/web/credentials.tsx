// Credentials on the pages (AFS-63): a workspace's list with what each holds and how many things
// use it; administrators add one (a form per kind), change its name, description and visible
// fields, replace its secret, and delete it (refused while in use, with the reason). A secret goes
// in and is never shown again: its fields start empty, are not filled in by the browser, and a
// private key can come from a file. And the choice of the credential a project's git source signs
// in with. AFS-241: each secret part is stored here or taken from a secret provider (a reference,
// with a Test read that never shows the value).
import { useId, useState } from 'react';
import {
  BECOME_METHODS,
  type CredentialKind,
  fieldProblem,
  GIT_KINDS,
  KIND_NAME,
  KINDS,
  privateKeyProblem,
  SPEC,
} from '../server/secrets/kinds';
import {
  PROVIDER_KIND_NAME,
  type ProviderChoice,
  REF_FIELDS,
  refPath,
  refProblem,
  type SecretRef,
} from '../server/secrets/providers/types';
import { api, type Credential } from './api';
import { ask } from './confirm';
import { Link } from './router';
import { Field, Form, Labelled, Loading, messageOf, refuse, Scroll, useLoad } from './ui';

/** AFS-169: the kinds' names, as the launch form and the server's messages say them. */
export const KIND_LABEL = KIND_NAME;
const FIELD_LABEL: Record<string, string> = {
  username: 'User name',
  method: 'Become method',
  vaultId: 'Vault id',
  host: 'Registry host',
  privateKey: 'Private key',
  passphrase: 'Key passphrase',
  password: 'Password',
  token: 'Token',
  url: 'AWX address',
  address: 'Address',
};
const FIELD_HINT: Record<string, string> = {
  method: 'sudo unless given',
  vaultId: 'Only for a vault with an id',
  host: 'registry.example.net',
  url: 'https://awx.example.net (to import its templates into a flow)',
  address:
    'https://netbox.example.net or https://zabbix.example.net (where a run tells how it ended)',
};
/** Secret parts written on several lines. */
const MULTILINE = new Set(['privateKey']);

/** A field's label inside a sentence: "user name", but "AWX address" as the form says it (AFS-194). */
const inWords = (key: string) => {
  const label = FIELD_LABEL[key] ?? key;
  return /^[A-Z]{2}/.test(label) ? label : `${label.charAt(0).toLowerCase()}${label.slice(1)}`;
};

/**
 * AFS-241: where a part taken from a provider is read: "from Corp Vault", with its path for those
 * the server gives it to (the workspace's administrators).
 */
function fromWords(ref: NonNullable<Credential['refs']>[string]): string {
  const where = ref.kind && ref.path ? ` (${refPath(ref.kind, ref.path)})` : '';
  return `from ${ref.providerName ?? ref.provider}${where}`;
}

/** What a credential holds, in words: its visible fields and the names of its secret parts. */
export function holds(c: Credential): string {
  const fields = Object.entries(c.fields).map(([k, v]) => `${inWords(k)} ${v}`);
  const refs = c.refs ?? {};
  const stored = c.has.filter((n) => !refs[n]);
  const secret =
    c.kind === 'env'
      ? stored.length
        ? [`variables ${stored.join(', ')}`]
        : []
      : stored.map(inWords);
  const read = Object.entries(refs).map(
    ([n, r]) => `${c.kind === 'env' ? n : inWords(n)} ${fromWords(r)}`,
  );
  return [...fields, ...secret, ...read].join(' · ');
}

/** A reference as the form edits it, from one the server gave (with its path). */
const refOf = (shown: NonNullable<Credential['refs']>[string]): SecretRef => ({
  provider: shown.provider,
  ...(shown.path ?? {}),
});

/**
 * AFS-241: where a secret part is read from: the provider, the kind's parts of the reference, and
 * Test read, which says whether it reads and never shows the value.
 */
function RefFields({
  workspace,
  providers,
  name,
  value,
  onChange,
}: {
  workspace: string;
  providers: ProviderChoice[];
  name: string;
  value: SecretRef;
  onChange(ref: SecretRef): void;
}) {
  const [result, setResult] = useState<{ ok: boolean; message: string; at: string }>();
  const [busy, setBusy] = useState(false);
  const provider = providers.find((p) => p.key === value.provider);
  return (
    <div className="ref-fields">
      <Labelled label="Provider" name={`${name}-provider`}>
        {(props) => (
          <select
            {...props}
            name={`${name}-provider`}
            value={value.provider}
            onChange={(e) => {
              setResult(undefined);
              onChange({ provider: e.target.value });
            }}
          >
            {!provider && (
              <option value={value.provider}>
                {value.provider ? `${value.provider} (not open to this workspace)` : 'Choose one'}
              </option>
            )}
            {providers.map((p) => (
              <option key={p.key} value={p.key}>
                {p.name} ({PROVIDER_KIND_NAME[p.kind]})
              </option>
            ))}
          </select>
        )}
      </Labelled>
      {provider &&
        REF_FIELDS[provider.kind].map((f) => (
          <Field
            key={f.name}
            label={f.label}
            name={`${name}-${f.name}`}
            value={value[f.name] ?? ''}
            onChange={(e) => {
              setResult(undefined);
              onChange({ ...value, [f.name]: e.target.value });
            }}
            hint={f.hint}
            autoComplete="off"
            spellCheck={false}
          />
        ))}
      <div className="test-read">
        <button
          type="button"
          disabled={busy || !provider}
          onClick={async () => {
            setBusy(true);
            const clean = Object.fromEntries(
              Object.entries(value).filter(([, v]) => v.trim()),
            ) as SecretRef;
            const answer = await api
              .testSecretRef(workspace, clean)
              .catch((e) => ({ ok: false, message: messageOf(e) }));
            setResult({
              ...answer,
              at: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            });
            setBusy(false);
          }}
        >
          {busy ? 'Reading…' : 'Test read'}
        </button>{' '}
        {result && (
          <span aria-live="polite" className={result.ok ? 'good-text' : 'bad-text'}>
            {result.ok ? `Read OK at ${result.at} (value not shown)` : result.message}
          </span>
        )}
      </div>
      <small className="muted">
        Read when a run starts; never stored. A run fails before it starts if the read fails.
      </small>
    </div>
  );
}

/** AFS-241: Stored here, or From a secret provider, for one secret part. */
function SourceChoice({
  label,
  fromProvider,
  onChange,
}: {
  label: string;
  fromProvider: boolean;
  onChange(fromProvider: boolean): void;
}) {
  const name = useId();
  return (
    <fieldset className="source-choice">
      <legend>{label}</legend>
      <label className="choice">
        <input type="radio" name={name} checked={!fromProvider} onChange={() => onChange(false)} />{' '}
        Stored here
      </label>
      <label className="choice">
        <input type="radio" name={name} checked={fromProvider} onChange={() => onChange(true)} />{' '}
        From a secret provider
      </label>
    </fieldset>
  );
}

function SecretField({
  name,
  value,
  onChange,
  required,
}: {
  name: string;
  value: string;
  onChange(v: string): void;
  required: boolean;
}) {
  const label = FIELD_LABEL[name] ?? name;
  if (MULTILINE.has(name))
    return (
      <Labelled
        label={label}
        name={name}
        hint={
          // AFS-140: the words and the file input stay on one line.
          <label className="inline file-pick">
            Or a file:{' '}
            <input
              type="file"
              aria-label={`${label} from a file`}
              onChange={(e) => void e.target.files?.[0]?.text().then(onChange)}
            />
          </label>
        }
      >
        {(props) => (
          <textarea
            {...props}
            name={name}
            rows={5}
            className="mono"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            required={required}
            autoComplete="off"
            spellCheck={false}
            placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
          />
        )}
      </Labelled>
    );
  return (
    <Field
      label={label}
      name={name}
      type="password"
      autoComplete="off"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      required={required}
    />
  );
}

/** The variables of an `env` credential: names and values, one row each. */
type VariableRow = { name: string; value: string; ref?: SecretRef };

function Variables({
  rows,
  onChange,
  workspace,
  providers,
}: {
  rows: VariableRow[];
  onChange(rows: VariableRow[]): void;
  workspace: string;
  /** AFS-241: the providers a value may be read from (none: values are stored here). */
  providers: ProviderChoice[];
}) {
  const set = (i: number, part: 'name' | 'value', v: string) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, [part]: v } : r)));
  const setRef = (i: number, ref: SecretRef | undefined) =>
    onChange(
      rows.map((r, j) => {
        if (j !== i) return r;
        const { ref: _old, ...rest } = r;
        return ref ? { ...rest, ref } : rest;
      }),
    );
  return (
    <fieldset>
      <legend>Variables</legend>
      {rows.map((r, i) => (
        // AFS-150: a grid of fixed columns, so a problem under one field does not move the others.
        // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity but their place
        <div key={i} className="variable-row">
          <Field
            label={`Name ${i + 1}`}
            name={`variable-${i}`}
            value={r.name}
            onChange={(e) => set(i, 'name', e.target.value)}
            pattern="[A-Za-z_][A-Za-z0-9_]*"
            title="Letters, digits and underscores, not starting with a digit"
            required
            autoComplete="off"
          />
          {r.ref ? (
            <div className="field">
              <span className="label-space" aria-hidden="true">
                &nbsp;
              </span>
              <span>From a secret provider</span>
            </div>
          ) : (
            <Field
              label={`Value ${i + 1}`}
              name={`variable-value-${i}`}
              type="password"
              autoComplete="off"
              value={r.value}
              onChange={(e) => set(i, 'value', e.target.value)}
            />
          )}
          {rows.length > 1 && (
            <div className="field">
              {/* The space of a label, so the button lines up with the inputs. */}
              <span className="label-space" aria-hidden="true">
                &nbsp;
              </span>
              <button
                type="button"
                aria-label={`Remove variable ${i + 1}`}
                onClick={() => onChange(rows.filter((_, j) => j !== i))}
              >
                Remove
              </button>
            </div>
          )}
          {(providers.length > 0 || r.ref) && (
            <label className="choice variable-source">
              <input
                type="checkbox"
                checked={!!r.ref}
                onChange={(e) =>
                  setRef(i, e.target.checked ? { provider: providers[0]?.key ?? '' } : undefined)
                }
              />{' '}
              Value {i + 1} from a secret provider
            </label>
          )}
          {r.ref && (
            <RefFields
              workspace={workspace}
              providers={providers}
              name={`variable-ref-${i}`}
              value={r.ref}
              onChange={(ref) => setRef(i, ref)}
            />
          )}
        </div>
      ))}
      <button type="button" onClick={() => onChange([...rows, { name: '', value: '' }])}>
        Add a variable
      </button>
    </fieldset>
  );
}

/** The form for one credential: new (a kind to choose), or a change to one that exists. */
function CredentialForm({
  workspace,
  editing,
  onDone,
  onCancel,
}: {
  workspace: string;
  editing?: Credential;
  onDone(): void;
  onCancel(): void;
}) {
  const [kind, setKind] = useState<CredentialKind>(editing?.kind ?? 'ssh_key');
  const [name, setName] = useState(editing?.name ?? '');
  const [description, setDescription] = useState(editing?.description ?? '');
  const [fields, setFields] = useState<Record<string, string>>(editing?.fields ?? {});
  const [secret, setSecret] = useState<Record<string, string>>({});
  const [variables, setVariables] = useState<VariableRow[]>(
    editing?.kind === 'env'
      ? editing.has.map((n) => {
          const shown = editing.refs?.[n];
          return shown ? { name: n, value: '', ref: refOf(shown) } : { name: n, value: '' };
        })
      : [{ name: '', value: '' }],
  );
  // AFS-241: the secret parts taken from a provider, by name.
  const [refs, setRefs] = useState<Record<string, SecretRef>>(
    editing?.kind === 'env'
      ? {}
      : Object.fromEntries(Object.entries(editing?.refs ?? {}).map(([n, r]) => [n, refOf(r)])),
  );
  const providers = useLoad(() => api.workspaceSecretProviders(workspace), [workspace]);
  const choices = providers.data ?? [];
  // A change keeps the secret unless asked to replace it.
  const [replace, setReplace] = useState(!editing);
  const kindId = useId();
  const becomeList = useId();
  const spec = SPEC[kind];
  const secretPart = () =>
    kind === 'env'
      ? Object.fromEntries(
          variables.filter((v) => v.name.trim() && !v.ref).map((v) => [v.name.trim(), v.value]),
        )
      : Object.fromEntries(Object.entries(secret).filter(([f, v]) => v !== '' && !refs[f]));
  const refPart = (): Record<string, SecretRef> =>
    kind === 'env'
      ? Object.fromEntries(
          variables
            .filter((v) => v.name.trim() && v.ref)
            .map((v) => [v.name.trim(), v.ref as SecretRef]),
        )
      : refs;
  /** A reference's problem, said at its provider's field. */
  const checkRef = (field: string, ref: SecretRef) => {
    const provider = choices.find((p) => p.key === ref.provider);
    if (!provider) refuse(`${field}-provider`, 'Choose a secret provider open to this workspace.');
    const problem = provider ? refProblem(provider.kind, ref) : undefined;
    if (problem) refuse(`${field}-provider`, `${problem}.`);
  };
  const visible = () =>
    Object.fromEntries(spec.fields.map((f) => [f, (fields[f] ?? '').trim()]).filter(([, v]) => v));
  // AFS-140: what the server would refuse is found here first, and said at its field.
  const check = () => {
    if (!name.trim()) refuse('name', 'A name is needed.');
    for (const f of spec.fields) {
      // AFS-150: said at the field, not as the browser's tooltip.
      if (spec.required.includes(f) && !(fields[f] ?? '').trim())
        refuse(f, `${FIELD_LABEL[f] ?? f} is needed.`);
      const problem = fieldProblem(f, fields[f] ?? '');
      if (problem) refuse(f, problem);
    }
    if (kind !== 'env') for (const [f, ref] of Object.entries(refs)) checkRef(f, ref);
    if (!replace) return;
    for (const f of spec.secret)
      if (spec.required.includes(f) && !secret[f] && !refs[f])
        refuse(f, `${FIELD_LABEL[f] ?? f} is needed.`);
    if (kind === 'env') {
      const seen = new Map<string, number>();
      for (const [i, v] of variables.entries()) {
        const n = v.name.trim();
        if (!n) {
          if (v.value || v.ref) refuse(`variable-${i}`, 'A name is needed for this value.');
          continue;
        }
        if (v.ref) checkRef(`variable-ref-${i}`, v.ref);
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n))
          refuse(`variable-${i}`, 'Letters, digits and underscores, not starting with a digit.');
        // AFS-150: an empty value is most likely one forgotten (a Replace gives them all again).
        if (!v.value && !v.ref)
          refuse(`variable-value-${i}`, `${n} has no value: give one, or remove it.`);
        const before = seen.get(n);
        if (before !== undefined)
          refuse(
            `variable-${i}`,
            `${n} is given twice (also as variable ${before + 1}): one value would be lost.`,
          );
        seen.set(n, i);
      }
    }
    const keyProblem = secret.privateKey ? privateKeyProblem(secret.privateKey) : undefined;
    if (keyProblem) refuse('privateKey', keyProblem);
  };
  return (
    <Form
      open
      noValidate
      submit={editing ? 'Save' : 'Add credential'}
      onCancel={onCancel}
      onSubmit={async () => {
        check();
        const refsGiven = refPart();
        if (editing)
          await api.changeCredential(editing.id, {
            name: name.trim(),
            description: description.trim() || null,
            ...(kind === 'env' ? {} : { fields: visible() }),
            ...(replace ? { secret: secretPart() } : {}),
            // AFS-241: the references go whole; an env credential's with its variables.
            ...((kind !== 'env' || replace) && (Object.keys(refsGiven).length || editing.refs)
              ? { refs: Object.keys(refsGiven).length ? refsGiven : null }
              : {}),
          });
        else
          await api.addCredential(workspace, {
            name: name.trim(),
            kind,
            ...(description.trim() ? { description: description.trim() } : {}),
            ...(kind === 'env' ? {} : { fields: visible() }),
            secret: secretPart(),
            ...(Object.keys(refsGiven).length ? { refs: refsGiven } : {}),
          });
        onDone();
      }}
    >
      {!editing && (
        <div className="field">
          <label htmlFor={kindId}>Kind</label>
          <select
            id={kindId}
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as CredentialKind);
              setFields({});
              setSecret({});
            }}
          >
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
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
        autoComplete="off"
      />
      <Field
        label="Description"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        maxLength={1000}
      />
      {spec.fields.map((f) => (
        <Field
          key={f}
          label={FIELD_LABEL[f] ?? f}
          name={f}
          list={f === 'method' ? becomeList : undefined}
          value={fields[f] ?? ''}
          onChange={(e) => setFields({ ...fields, [f]: e.target.value })}
          required={spec.required.includes(f)}
          hint={FIELD_HINT[f]}
          autoComplete="off"
        />
      ))}
      {editing && (
        <label className="choice">
          <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
          Replace the secret
          {kind === 'env' ? ' (every variable: give them all again)' : ''}
        </label>
      )}
      {kind === 'env'
        ? replace && (
            <Variables
              rows={variables}
              onChange={setVariables}
              workspace={workspace}
              providers={choices}
            />
          )
        : spec.secret.map((f) => {
            // AFS-241: each secret part: stored here, or read from a provider when a run starts.
            const offered = choices.length > 0 || !!refs[f];
            const fromProvider = !!refs[f];
            return (
              <div key={f} className="secret-part">
                {offered && (
                  <SourceChoice
                    label={FIELD_LABEL[f] ?? f}
                    fromProvider={fromProvider}
                    onChange={(yes) => {
                      if (yes) setRefs({ ...refs, [f]: { provider: choices[0]?.key ?? '' } });
                      else {
                        const { [f]: _gone, ...rest } = refs;
                        setRefs(rest);
                        // A part read from a provider until now needs its value here.
                        if (editing) setReplace(true);
                      }
                    }}
                  />
                )}
                {fromProvider ? (
                  <RefFields
                    workspace={workspace}
                    providers={choices}
                    name={f}
                    value={refs[f] as SecretRef}
                    onChange={(ref) => setRefs({ ...refs, [f]: ref })}
                  />
                ) : (
                  replace && (
                    <SecretField
                      name={f}
                      value={secret[f] ?? ''}
                      onChange={(v) => setSecret({ ...secret, [f]: v })}
                      required={spec.required.includes(f)}
                    />
                  )
                )}
              </div>
            );
          })}
      {replace && (
        <p className="muted">
          Kept encrypted on the server; nobody can read it back, here or over the API.
        </p>
      )}
      {spec.fields.includes('method') && (
        <datalist id={becomeList}>
          {BECOME_METHODS.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      )}
    </Form>
  );
}

/**
 * AFS-150: what uses a credential: named and linked when the server names them (to
 * administrators), else counted.
 */
function UsedBy({ credential: c, workspace }: { credential: Credential; workspace: string }) {
  if (c.usedBy === 0) return <>nothing</>;
  if (!c.uses?.length) return <>{`${c.usedBy} ${c.usedBy === 1 ? 'use' : 'uses'}`}</>;
  return (
    <ul className="plain">
      {c.uses.map((u) => (
        <li key={`${u.kind}-${u.id ?? u.project}`}>
          {u.kind === 'launch' && u.id ? (
            <Link
              to={`/w/${encodeURIComponent(workspace)}/${encodeURIComponent(u.project)}/launch/${encodeURIComponent(u.id)}/settings`}
            >
              {u.name}
            </Link>
          ) : (
            <Link
              to={`/w/${encodeURIComponent(workspace)}/${encodeURIComponent(u.project)}/settings`}
            >
              {u.name}
            </Link>
          )}{' '}
          <span className="muted">
            {u.kind === 'launch' ? `launch configuration in ${u.project}` : 'its repository'}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** A workspace's credentials. Shown to whoever may see the workspace; changed by administrators. */
export function WorkspaceCredentials({ workspace, admin }: { workspace: string; admin: boolean }) {
  const list = useLoad(() => api.credentials(workspace), [workspace]);
  const [open, setOpen] = useState<'new' | string>();
  const [error, setError] = useState<string>();
  const done = () => {
    setOpen(undefined);
    list.reload();
  };
  // Someone who may not see the credentials does not see the section either.
  if (list.error && !list.data) return null;
  return (
    <section className="panel" aria-labelledby="credentials">
      <div className="panel-head">
        <h2 id="credentials">Credentials</h2>
        {admin && open !== 'new' && (
          <button type="button" onClick={() => setOpen('new')}>
            Add credential
          </button>
        )}
      </div>
      <p className="muted">
        What runs sign in to machines and registries with, and what a project signs in to its
        repository with. Their secrets never leave the server.
      </p>
      {open === 'new' && (
        <CredentialForm workspace={workspace} onDone={done} onCancel={() => setOpen(undefined)} />
      )}
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <Loading state={list} />
      {/* AFS-135: who can change that, for whoever reads it. */}
      {list.data?.length === 0 && (
        <p className="empty">
          No credential yet.{admin ? '' : ' An administrator adds the credentials of a workspace.'}
        </p>
      )}
      {!!list.data?.length && (
        <Scroll>
          <table className="credential-list">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Kind</th>
                <th scope="col">Holds</th>
                <th scope="col">Used by</th>
                {admin && (
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {list.data.map((c) => (
                <tr key={c.id}>
                  <td className="credential-name">
                    {c.name}
                    {c.description && <div className="muted">{c.description}</div>}
                  </td>
                  <td className="kind">{KIND_LABEL[c.kind] ?? c.kind}</td>
                  <td className="long">{holds(c)}</td>
                  <td>
                    <UsedBy credential={c} workspace={workspace} />
                  </td>
                  {admin && (
                    <td>
                      <div className="actions">
                        <button
                          type="button"
                          aria-label={`Change ${c.name}`}
                          onClick={() => setOpen(open === c.id ? undefined : c.id)}
                        >
                          Change
                        </button>
                        <button
                          type="button"
                          className="danger"
                          aria-label={`Delete ${c.name}`}
                          // AFS-134: one in use cannot go: the configurations name it.
                          disabled={c.usedBy > 0}
                          title={
                            c.usedBy > 0
                              ? 'In use (see Used by): take it out of what uses it first'
                              : undefined
                          }
                          onClick={async () => {
                            if (
                              !(await ask(
                                `Delete the credential "${c.name}"? It cannot be brought back.`,
                                {
                                  yes: 'Delete',
                                  danger: true,
                                },
                              ))
                            )
                              return;
                            setError(undefined);
                            try {
                              await api.deleteCredential(c.id);
                              list.reload();
                            } catch (e) {
                              setError(messageOf(e));
                            }
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </Scroll>
      )}
      {admin &&
        list.data?.map(
          (c) =>
            open === c.id && (
              <section key={c.id} aria-label={`Change ${c.name}`}>
                <h3>Change {c.name}</h3>
                <CredentialForm
                  workspace={workspace}
                  editing={c}
                  onDone={done}
                  onCancel={() => setOpen(undefined)}
                />
              </section>
            ),
        )}
    </section>
  );
}

/** Which credential a project's git source signs in with over HTTPS: a git token or a login. */
export function GitCredentialChoice({
  workspace,
  value,
  onChange,
  ssh = false,
}: {
  workspace: string;
  value: string;
  onChange(id: string): void;
  /** AFS-60: an ssh source signs in with an SSH key; an https one with a token or a login. */
  ssh?: boolean;
}) {
  const list = useLoad(() => api.credentials(workspace), [workspace]);
  const id = useId();
  const usable = (list.data ?? []).filter((c) =>
    ssh ? c.kind === 'ssh_key' : GIT_KINDS.includes(c.kind),
  );
  return (
    <div className="field">
      <label htmlFor={id}>Signs in with</label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-describedby={`${id}-hint`}
      >
        <option value="">
          {ssh ? "the server's own SSH key" : 'nothing (a public repository)'}
        </option>
        {usable.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name} ({KIND_LABEL[c.kind]})
          </option>
        ))}
      </select>
      <small id={`${id}-hint`} className="muted">
        {ssh
          ? 'For an ssh address: an SSH key of this workspace'
          : 'For an https:// address: a git token or a login and password of this workspace'}
        {list.data && usable.length === 0 ? ' (it has none yet: add one under Credentials)' : ''}.
      </small>
    </div>
  );
}

/** A source that could not be read because it asks for a sign-in. */
export const needsSignIn = (error?: string) =>
  !!error &&
  /could not read Username|Authentication failed|authentication required|returned error: 40[13]|Invalid username or password/i.test(
    error,
  );
