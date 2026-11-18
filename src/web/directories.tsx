// LDAP and Active Directory directories on the Sign-in page (AFS-31): administrators add one from
// a preset (Active Directory, OpenLDAP), map its groups to server groups or administrator, test
// it (with a login: what is found for it), and sync its people now.
import { useState } from 'react';
import {
  type Directory,
  type DirectoryInput,
  type DirectoryTest,
  PRESETS,
} from '../server/auth/ldap/types';
import type { Group } from '../server/auth/users';
import { api } from './api';
import { followKey } from './flowFiles';
import { MappingRows } from './signin';
import { Field, Form, Labelled, Loading, messageOf, Time, useLoad } from './ui';

type Draft = DirectoryInput & { id?: string; replacePassword: boolean };

const EMPTY: Draft = {
  key: '',
  name: '',
  url: 'ldaps://',
  startTls: false,
  bindDn: '',
  bindPassword: '',
  userBase: '',
  groupBase: '',
  syncMinutes: 60,
  enabled: true,
  mappings: [],
  replacePassword: true,
  ...PRESETS['active-directory'],
};

const draftOf = (d: Directory): Draft => ({
  id: d.id,
  key: d.key,
  name: d.name,
  url: d.url,
  startTls: d.startTls,
  bindDn: d.bindDn ?? '',
  bindPassword: '',
  userBase: d.userBase,
  userFilter: d.userFilter,
  idAttr: d.idAttr,
  loginAttr: d.loginAttr,
  nameAttr: d.nameAttr,
  emailAttr: d.emailAttr,
  groupMode: d.groupMode,
  groupBase: d.groupBase ?? '',
  groupFilter: d.groupFilter ?? '',
  adDisabled: d.adDisabled,
  syncMinutes: d.syncMinutes,
  enabled: d.enabled,
  mappings: d.mappings,
  replacePassword: !d.hasBindPassword,
});

function DirectoryForm({
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
  const text = (label: string, key: keyof Draft, hint?: string, required = true) => (
    <Field
      label={label}
      value={String(d[key] ?? '')}
      onChange={(e) => set({ [key]: e.target.value } as Partial<Draft>)}
      required={required}
      {...(hint ? { hint } : {})}
    />
  );
  // AFS-140: a filter is long (Active Directory's person filter): several lines, the whole width.
  const filter = (label: string, key: 'userFilter' | 'groupFilter', hint: string) => (
    <Labelled label={label} hint={hint} name={key}>
      {(props) => (
        <textarea
          {...props}
          name={key}
          className="mono filter-text"
          rows={3}
          spellCheck={false}
          value={String(d[key] ?? '')}
          onChange={(e) => set({ [key]: e.target.value } as Partial<Draft>)}
          required
        />
      )}
    </Labelled>
  );
  return (
    <section className="panel sheet" aria-label={d.id ? `Change ${d.name}` : 'Add a directory'}>
      <Form
        submit={d.id ? 'Save' : 'Add'}
        onCancel={onCancel}
        onSubmit={async () => {
          const { id, replacePassword, bindPassword, ...rest } = d;
          const input: Partial<DirectoryInput> = {
            ...rest,
            bindDn: d.bindDn || null,
            groupBase: d.groupMode === 'search' ? d.groupBase || null : null,
            groupFilter: d.groupMode === 'search' ? d.groupFilter || null : null,
            mappings: d.mappings?.filter((m) => m.value.trim()),
            ...(replacePassword ? { bindPassword: bindPassword || null } : {}),
          };
          if (id) await api.changeDirectory(id, input);
          else await api.addDirectory(input as DirectoryInput);
          onDone();
        }}
      >
        {!d.id && (
          <div className="field">
            <label htmlFor="dir-preset">Kind</label>
            <select
              id="dir-preset"
              onChange={(e) => set({ ...PRESETS[e.target.value as keyof typeof PRESETS] })}
              defaultValue="active-directory"
            >
              <option value="active-directory">Active Directory</option>
              <option value="openldap">OpenLDAP</option>
            </select>
          </div>
        )}
        <Field
          label="Name"
          value={d.name ?? ''}
          onChange={(e) =>
            set({
              name: e.target.value,
              // AFS-125: a new directory's key follows its name until typed.
              ...(d.id ? {} : { key: followKey(e.target.value, d.name ?? '', d.key ?? '', 40) }),
            })
          }
          required
          hint="Said where people see it"
        />
        <Field
          label="Key"
          value={d.key}
          onChange={(e) => set({ key: e.target.value.toLowerCase() })}
          required
          pattern="[a-z0-9][a-z0-9-]{0,39}"
        />
        {text('Address', 'url', 'ldaps://dc1.example.net:636; ldap:// only with StartTLS')}
        <label className="check">
          <input
            type="checkbox"
            checked={!!d.startTls}
            onChange={(e) => set({ startTls: e.target.checked })}
          />{' '}
          StartTLS (for an ldap:// address)
        </label>
        {text(
          'Service account DN',
          'bindDn',
          'The account that searches; empty: an anonymous search',
          false,
        )}
        {d.replacePassword ? (
          <Field
            label="Service account password"
            type="password"
            autoComplete="off"
            value={d.bindPassword ?? ''}
            onChange={(e) => set({ bindPassword: e.target.value })}
            hint="Kept sealed and never shown again"
          />
        ) : (
          <p>
            A service account password is kept.{' '}
            <button type="button" onClick={() => set({ replacePassword: true })}>
              Replace it
            </button>
          </p>
        )}
        {text('Where people are', 'userBase', 'OU=Staff,DC=example,DC=net')}
        {filter('Person filter', 'userFilter', '{login} is where the typed login goes')}
        {text(
          'Id attribute',
          'idAttr',
          'Stays the same when a person is renamed: objectGUID, entryUUID',
        )}
        {text('Login attribute', 'loginAttr')}
        {text('Name attribute', 'nameAttr')}
        {text('Email attribute', 'emailAttr')}
        <div className="field">
          <label htmlFor="dir-groups">Groups from</label>
          <select
            id="dir-groups"
            value={d.groupMode}
            onChange={(e) => set({ groupMode: e.target.value as 'memberof' | 'search' })}
          >
            <option value="search">A search of the groups (nested groups too in AD)</option>
            <option value="memberof">The person's memberOf</option>
          </select>
        </div>
        {d.groupMode === 'search' && (
          <>
            {text('Where groups are', 'groupBase')}
            {filter('Group filter', 'groupFilter', "{dn} is where the person's DN goes")}
          </>
        )}
        <label className="check">
          <input
            type="checkbox"
            checked={!!d.adDisabled}
            onChange={(e) => set({ adDisabled: e.target.checked })}
          />{' '}
          Accounts disabled in Active Directory cannot sign in
        </label>
        <Field
          label="Sync every (minutes)"
          type="number"
          min={0}
          max={10080}
          value={String(d.syncMinutes ?? 60)}
          onChange={(e) => set({ syncMinutes: Number(e.target.value) })}
          hint="Names, groups and administrator follow the directory; those it no longer has are disabled, signed in or not. 0: only at sign-in"
        />
        <label className="check">
          <input
            type="checkbox"
            checked={!!d.enabled}
            onChange={(e) => set({ enabled: e.target.checked })}
          />{' '}
          People may sign in with it
        </label>
        <MappingRows
          mappings={d.mappings ?? []}
          groups={groups}
          onChange={(mappings) => set({ mappings })}
          legend="What the directory's groups are here"
          valueLabel="Directory group"
          help={
            <>
              A group's name (<code>netops</code>) or its DN, and the server group it puts the
              person in, or administrator. Other groups are ignored; each sign-in and sync takes
              back what the directory no longer says.
            </>
          }
        />
      </Form>
    </section>
  );
}

function TestBox({ id }: { id: string }) {
  const [login, setLogin] = useState('');
  const [result, setResult] = useState<DirectoryTest>();
  const [busy, setBusy] = useState(false);
  return (
    <div className="test-box">
      <Field
        label="Test with a login (optional)"
        value={login}
        onChange={(e) => setLogin(e.target.value)}
        hint="Shows the entry found and its groups; no password is asked"
      />
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setResult(
            await api
              .testDirectory(id, login.trim() || undefined)
              .catch((e) => ({ ok: false, message: messageOf(e) })),
          );
          setBusy(false);
        }}
      >
        {busy ? 'Asking…' : 'Test'}
      </button>
      {result && (
        <div aria-live="polite" className={result.ok ? '' : 'notice error'}>
          <p>{result.message}</p>
          {result.person && (
            <dl className="facts">
              <dt>Entry</dt>
              <dd>
                <code>{result.person.dn}</code>
                {result.person.disabled ? ' (disabled in the directory)' : ''}
              </dd>
              <dt>Name</dt>
              <dd>
                {result.person.name ?? '—'} {result.person.email ? `· ${result.person.email}` : ''}
              </dd>
              <dt>Groups</dt>
              <dd>{result.person.groups.length ? result.person.groups.join('; ') : 'none'}</dd>
              <dt>Here</dt>
              <dd>
                {result.person.mapped.length
                  ? result.person.mapped.join(', ')
                  : 'no group, not an administrator'}
              </dd>
            </dl>
          )}
        </div>
      )}
    </div>
  );
}

/** The directories, in the order sign-in tries them. */
export function DirectoriesSection({ groups }: { groups: Group[] }) {
  const list = useLoad(api.directories, []);
  const [editing, setEditing] = useState<Draft>();
  const [note, setNote] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();
  const groupName = (id?: string) => groups.find((g) => g.id === id)?.name ?? 'a removed group';
  return (
    <section className="panel" aria-labelledby="directories">
      {/* AFS-102: the section's action at its head, as Add a provider is at the page's. */}
      <div className="section-head">
        <h2 id="directories">Directories (LDAP, Active Directory)</h2>
        {!editing && (
          <button type="button" onClick={() => setEditing({ ...EMPTY })}>
            Add a directory
          </button>
        )}
      </div>
      <p className="muted">
        People type their directory login and password in the sign-in form. An account here with a
        password signs in here; any other login is tried with these directories, in this order.
      </p>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {editing && (
        <DirectoryForm
          draft={editing}
          groups={groups}
          onCancel={() => setEditing(undefined)}
          onDone={() => {
            setEditing(undefined);
            list.reload();
          }}
        />
      )}
      <Loading state={list} />
      {list.data?.length === 0 && <p className="muted">None yet.</p>}
      {list.data?.map((d) => (
        <article key={d.id} className="provider" aria-label={d.name}>
          <h3>
            {d.name} {!d.enabled && <span className="tag">off</span>}
          </h3>
          <dl className="facts">
            <dt>Address</dt>
            <dd>
              <code>{d.url}</code> {d.startTls ? '(StartTLS)' : ''}
            </dd>
            <dt>People</dt>
            <dd>
              <code>{d.userBase}</code>
            </dd>
            <dt>Groups</dt>
            <dd>
              {d.mappings.length
                ? d.mappings
                    .map((m) => `${m.value} → ${m.admin ? 'administrator' : groupName(m.group)}`)
                    .join('; ')
                : 'no group means anything here'}
            </dd>
            <dt>Last sync</dt>
            <dd>
              {d.lastSyncAt ? (
                <>
                  <Time at={d.lastSyncAt} />: {d.lastSyncResult}
                </>
              ) : d.syncMinutes ? (
                `every ${d.syncMinutes} minutes; not yet`
              ) : (
                'only at sign-in'
              )}
            </dd>
          </dl>
          <TestBox id={d.id} />
          {note[d.id] && <p aria-live="polite">{note[d.id]}</p>}
          <div className="actions">
            <button type="button" onClick={() => setEditing(draftOf(d))}>
              Change
            </button>
            <button
              type="button"
              onClick={async () => {
                setNote((n) => ({ ...n, [d.id]: 'Syncing…' }));
                const r = await api.syncDirectory(d.id).catch((e) => ({ message: messageOf(e) }));
                setNote((n) => ({ ...n, [d.id]: r.message }));
                list.reload();
              }}
            >
              Sync now
            </button>
            <button
              type="button"
              className="danger"
              onClick={async () => {
                if (
                  !window.confirm(
                    `Remove ${d.name}? Its people stay; the groups, rights and disabling it gave go.`,
                  )
                )
                  return;
                try {
                  await api.deleteDirectory(d.id);
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
    </section>
  );
}
