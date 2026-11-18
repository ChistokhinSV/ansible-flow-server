// Credentials on the pages (AFS-63): a workspace's list with what each holds and how many things
// use it; administrators add one (a form per kind), change its name, description and visible
// fields, replace its secret, and delete it (refused while in use, with the reason). A secret goes
// in and is never shown again: its fields start empty, are not filled in by the browser, and a
// private key can come from a file. And the choice of the credential a project's git source signs
// in with.
import { useId, useState } from 'react';
import {
  BECOME_METHODS,
  type CredentialKind,
  fieldProblem,
  GIT_KINDS,
  KINDS,
  privateKeyProblem,
  SPEC,
} from '../server/secrets/kinds';
import { api, type Credential } from './api';
import { Field, Form, Labelled, Loading, messageOf, refuse, useLoad } from './ui';

export const KIND_LABEL: Record<CredentialKind, string> = {
  ssh_key: 'SSH key',
  login: 'login and password',
  become: 'become password',
  vault: 'vault password',
  git_token: 'git token',
  registry: 'container registry',
  env: 'environment variables',
  awx: 'AWX token',
};
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
};
const FIELD_HINT: Record<string, string> = {
  method: 'sudo unless given',
  vaultId: 'Only for a vault with an id',
  host: 'registry.example.net',
  url: 'https://awx.example.net (to import its templates into a flow)',
};
/** Secret parts written on several lines. */
const MULTILINE = new Set(['privateKey']);

/** What a credential holds, in words: its visible fields and the names of its secret parts. */
export function holds(c: Credential): string {
  const fields = Object.entries(c.fields).map(
    ([k, v]) => `${(FIELD_LABEL[k] ?? k).toLowerCase()} ${v}`,
  );
  const secret =
    c.kind === 'env'
      ? c.has.length
        ? [`variables ${c.has.join(', ')}`]
        : []
      : c.has.map((k) => (FIELD_LABEL[k] ?? k).toLowerCase());
  return [...fields, ...secret].join(' · ');
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
function Variables({
  rows,
  onChange,
}: {
  rows: { name: string; value: string }[];
  onChange(rows: { name: string; value: string }[]): void;
}) {
  const set = (i: number, part: 'name' | 'value', v: string) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, [part]: v } : r)));
  return (
    <fieldset>
      <legend>Variables</legend>
      {rows.map((r, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity but their place
        <div key={i} className="row">
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
          <Field
            label={`Value ${i + 1}`}
            type="password"
            autoComplete="off"
            value={r.value}
            onChange={(e) => set(i, 'value', e.target.value)}
          />
          {rows.length > 1 && (
            <button
              type="button"
              aria-label={`Remove variable ${i + 1}`}
              onClick={() => onChange(rows.filter((_, j) => j !== i))}
            >
              Remove
            </button>
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
  const [variables, setVariables] = useState(
    editing?.kind === 'env'
      ? editing.has.map((n) => ({ name: n, value: '' }))
      : [{ name: '', value: '' }],
  );
  // A change keeps the secret unless asked to replace it.
  const [replace, setReplace] = useState(!editing);
  const kindId = useId();
  const becomeList = useId();
  const spec = SPEC[kind];
  const secretPart = () =>
    kind === 'env'
      ? Object.fromEntries(
          variables.filter((v) => v.name.trim()).map((v) => [v.name.trim(), v.value]),
        )
      : Object.fromEntries(Object.entries(secret).filter(([, v]) => v !== ''));
  const visible = () =>
    Object.fromEntries(spec.fields.map((f) => [f, (fields[f] ?? '').trim()]).filter(([, v]) => v));
  // AFS-140: what the server would refuse is found here first, and said at its field.
  const check = () => {
    if (!name.trim()) refuse('name', 'A name is needed.');
    for (const f of spec.fields) {
      const problem = fieldProblem(f, fields[f] ?? '');
      if (problem) refuse(f, problem);
    }
    if (!replace) return;
    if (kind === 'env') {
      const seen = new Map<string, number>();
      for (const [i, v] of variables.entries()) {
        const n = v.name.trim();
        if (!n) continue;
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
      submit={editing ? 'Save' : 'Add credential'}
      onCancel={onCancel}
      onSubmit={async () => {
        check();
        if (editing)
          await api.changeCredential(editing.id, {
            name: name.trim(),
            description: description.trim() || null,
            ...(kind === 'env' ? {} : { fields: visible() }),
            ...(replace ? { secret: secretPart() } : {}),
          });
        else
          await api.addCredential(workspace, {
            name: name.trim(),
            kind,
            ...(description.trim() ? { description: description.trim() } : {}),
            ...(kind === 'env' ? {} : { fields: visible() }),
            secret: secretPart(),
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
      {replace &&
        (kind === 'env' ? (
          <Variables rows={variables} onChange={setVariables} />
        ) : (
          spec.secret.map((f) => (
            <SecretField
              key={f}
              name={f}
              value={secret[f] ?? ''}
              onChange={(v) => setSecret({ ...secret, [f]: v })}
              required={spec.required.includes(f)}
            />
          ))
        ))}
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
        <div className="scroll">
          <table>
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
                  <td>
                    {c.name}
                    {c.description && <div className="muted">{c.description}</div>}
                  </td>
                  <td>{KIND_LABEL[c.kind] ?? c.kind}</td>
                  <td>{holds(c)}</td>
                  <td>
                    {c.usedBy === 0
                      ? 'nothing'
                      : `${c.usedBy} launch configuration${c.usedBy === 1 ? '' : 's'}`}
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
                              ? 'Launch configurations use it: take it out of them first'
                              : undefined
                          }
                          onClick={async () => {
                            if (!window.confirm(`Delete the credential "${c.name}"?`)) return;
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
        </div>
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
