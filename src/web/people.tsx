// People and groups, for administrators (AFS-56): the list of accounts and groups with forms to
// add them, a person's page (profile, administrator, disabled, password, groups, tokens, delete)
// and a group's page (name, contacts, members, delete). The server keeps the rules (the last
// administrator stays one, no one deletes themself); a refusal is shown as the server words it.
import { useEffect, useId, useState } from 'react';
import { api, type Group, type User } from './api';
import { Link, navigate } from './router';
import { TokensPanel } from './tokens';
import { Field, Form, Loading, messageOf, PageHead, Time, useLoad } from './ui';

type Kind = 'person' | 'admin' | 'service';

const kindOf = (u: User): string =>
  u.service ? 'service account' : u.admin ? 'administrator' : 'person';

/** A webhook's address shown in a list: its host only (the path can be its secret). */
const hookHost = (url?: string) => {
  if (!url) return '';
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/…`;
  } catch {
    return 'set';
  }
};

function AddPerson({ onAdded }: { onAdded(): void }) {
  const [input, setInput] = useState({
    login: '',
    name: '',
    kind: 'person' as Kind,
    password: '',
    email: '',
  });
  const kindId = useId();
  const set = (key: keyof typeof input) => (e: { target: { value: string } }) =>
    setInput((before) => ({ ...before, [key]: e.target.value }));
  return (
    <Form
      submit="Add"
      onSubmit={async () => {
        const user = await api.addUser({
          login: input.login.trim(),
          name: input.name.trim(),
          ...(input.kind === 'admin' ? { admin: true } : {}),
          ...(input.kind === 'service' ? { service: true } : {}),
          ...(input.kind !== 'service' && input.password ? { password: input.password } : {}),
          ...(input.email.trim() ? { email: input.email.trim() } : {}),
        });
        setInput({ login: '', name: '', kind: input.kind, password: '', email: '' });
        onAdded();
        navigate(`/admin/people/${user.id}`);
      }}
    >
      <Field
        label="Login"
        value={input.login}
        onChange={set('login')}
        required
        maxLength={64}
        autoComplete="off"
      />
      <Field label="Display name" value={input.name} onChange={set('name')} maxLength={200} />
      <div className="field">
        <label htmlFor={kindId}>Kind</label>
        <select
          id={kindId}
          value={input.kind}
          onChange={(e) => setInput({ ...input, kind: e.target.value as Kind })}
        >
          <option value="person">person</option>
          <option value="admin">administrator</option>
          <option value="service">service account (a program, tokens only)</option>
        </select>
      </div>
      {input.kind !== 'service' && (
        <Field
          label="Password"
          type="password"
          autoComplete="new-password"
          value={input.password}
          onChange={set('password')}
          hint="Without one they cannot sign in until you set it on their page."
        />
      )}
      <Field
        label="Email address"
        type="email"
        value={input.email}
        onChange={set('email')}
        autoComplete="off"
      />
    </Form>
  );
}

function AddGroup({ onAdded }: { onAdded(): void }) {
  const [name, setName] = useState('');
  return (
    <Form
      submit="Add group"
      onSubmit={async () => {
        const group = await api.addGroup({ name: name.trim() });
        setName('');
        onAdded();
        navigate(`/admin/groups/${group.id}`);
      }}
    >
      <Field
        label="Group name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
        maxLength={64}
      />
    </Form>
  );
}

export function PeoplePage() {
  const users = useLoad(api.users, []);
  const groups = useLoad(api.groups, []);
  return (
    <>
      <PageHead
        title="People and groups"
        lead="Who can sign in, who are administrators, and the groups that access levels and approvals name."
      />
      <section aria-labelledby="people">
        <h2 id="people">People</h2>
        <Loading state={users} />
        {!!users.data?.length && (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Kind</th>
                  <th scope="col">State</th>
                  <th scope="col">Groups</th>
                  <th scope="col">Last sign-in</th>
                </tr>
              </thead>
              <tbody>
                {users.data.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <Link to={`/admin/people/${u.id}`}>{u.name || u.login}</Link>
                      <div className="muted">{u.login}</div>
                    </td>
                    <td>{kindOf(u)}</td>
                    <td>
                      <span className={`badge ${u.disabled ? 'bad' : 'ok'}`}>
                        {u.disabled ? 'disabled' : 'active'}
                      </span>
                    </td>
                    <td>{u.groups.join(', ')}</td>
                    <td>
                      {u.service ? (
                        <span className="muted">tokens only</span>
                      ) : (
                        <Time at={u.lastLoginAt} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <div className="columns">
        <section className="panel" aria-labelledby="add-person">
          <h2 id="add-person">Add a person or service account</h2>
          <AddPerson onAdded={users.reload} />
        </section>
        <section className="panel" aria-labelledby="add-group">
          <h2 id="add-group">Add a group</h2>
          <AddGroup onAdded={groups.reload} />
        </section>
      </div>
      <section aria-labelledby="groups">
        <h2 id="groups">Groups</h2>
        <Loading state={groups} />
        {groups.data?.length === 0 && <p className="empty">No group yet.</p>}
        {!!groups.data?.length && (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Group</th>
                  <th scope="col">Members</th>
                  <th scope="col">Email</th>
                  <th scope="col">Webhook</th>
                </tr>
              </thead>
              <tbody>
                {groups.data.map((g) => (
                  <tr key={g.id}>
                    <td>
                      <Link to={`/admin/groups/${g.id}`}>{g.name}</Link>
                    </td>
                    <td>{g.members.length}</td>
                    <td>{g.email}</td>
                    <td>{hookHost(g.webhookUrl)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

// --- one person

function UserProfile({ user, me, onSaved }: { user: User; me: User; onSaved(u: User): void }) {
  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email ?? '');
  const [webhook, setWebhook] = useState(user.webhookUrl ?? '');
  const [admin, setAdmin] = useState(user.admin);
  const [saved, setSaved] = useState(false);
  return (
    <section className="panel" aria-labelledby="profile">
      <h2 id="profile">Profile</h2>
      <Form
        submit="Save"
        onSubmit={async () => {
          setSaved(false);
          const changed = await api.changeUser(user.id, {
            name: name.trim(),
            email: email.trim() || null,
            webhookUrl: webhook.trim() || null,
            ...(user.service ? {} : { admin }),
          });
          setSaved(true);
          onSaved(changed);
        }}
      >
        <Field label="Display name" value={name} onChange={(e) => setName(e.target.value)} />
        <Field
          label="Email address"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="off"
        />
        <Field
          label="Webhook"
          type="url"
          value={webhook}
          onChange={(e) => setWebhook(e.target.value)}
          hint="Their notifications as JSON, with a text line chat tools show."
        />
        {!user.service && (
          <label className="choice">
            <input type="checkbox" checked={admin} onChange={(e) => setAdmin(e.target.checked)} />
            Administrator (everything on the server)
          </label>
        )}
        {!user.service && user.id === me.id && !admin && (
          <p className="notice" role="status">
            Saved like this, you stop being an administrator at once and leave these pages.
          </p>
        )}
        {saved && (
          <p className="notice ok" role="status">
            Saved.
          </p>
        )}
      </Form>
    </section>
  );
}

function SetPassword({ user }: { user: User }) {
  const [password, setPassword] = useState('');
  const [done, setDone] = useState(false);
  return (
    <section className="panel" aria-labelledby="password">
      <h2 id="password">Password</h2>
      <Form
        submit="Set password"
        onSubmit={async () => {
          setDone(false);
          await api.setUserPassword(user.id, password);
          setPassword('');
          setDone(true);
        }}
      >
        <Field
          label="New password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            setDone(false);
          }}
          required
          hint="Their sessions end. Tell them the password; they can change it on My account."
        />
        {done && (
          <p className="notice ok" role="status">
            Password set.
          </p>
        )}
      </Form>
    </section>
  );
}

/** Disable or enable, and delete; the reasons the server refuses are shown as it words them. */
function Standing({ user, me, onChanged }: { user: User; me: User; onChanged(u: User): void }) {
  const [error, setError] = useState<string>();
  const self = user.id === me.id;
  const act = async (what: () => Promise<void>) => {
    setError(undefined);
    try {
      await what();
    } catch (e) {
      setError(messageOf(e));
    }
  };
  return (
    <section className="panel" aria-labelledby="standing">
      <h2 id="standing">Access to the server</h2>
      <p>
        {user.disabled
          ? 'Disabled: cannot sign in, and their tokens do not work. Their grants are kept.'
          : user.service
            ? 'Active: signs in with its tokens.'
            : 'Active: can sign in.'}
      </p>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {self ? (
        <p className="muted">This is you: you cannot disable or delete your own account.</p>
      ) : (
        <div className="actions">
          <button
            type="button"
            onClick={() =>
              act(async () =>
                onChanged(await api.changeUser(user.id, { disabled: !user.disabled })),
              )
            }
          >
            {user.disabled ? 'Enable' : 'Disable'}
          </button>
          <button
            type="button"
            className="danger"
            onClick={() =>
              act(async () => {
                if (
                  !window.confirm(
                    `Delete ${user.login}? Their tokens and grants go with them; the audit log keeps what they did.`,
                  )
                )
                  return;
                await api.deleteUser(user.id);
                navigate('/admin/people');
              })
            }
          >
            Delete
          </button>
        </div>
      )}
    </section>
  );
}

export function UserPage({ id, me }: { id: string; me: User }) {
  const load = useLoad(() => api.user(id), [id]);
  const [user, setUser] = useState<User>();
  useEffect(() => setUser(load.data), [load.data]);
  return (
    <>
      <p>
        <Link to="/admin/people">People and groups</Link>
      </p>
      <Loading state={load} />
      {user && (
        <>
          <PageHead
            title={user.name || user.login}
            lead={`${user.login} · ${kindOf(user)}${user.disabled ? ' · disabled' : ''}`}
          />
          <div className="columns">
            <UserProfile key={`p-${user.id}`} user={user} me={me} onSaved={setUser} />
            <Standing user={user} me={me} onChanged={setUser} />
            {!user.service && <SetPassword user={user} />}
            <section className="panel" aria-labelledby="member-of">
              <h2 id="member-of">Groups</h2>
              {user.groups.length === 0 ? (
                <p className="muted">In no group.</p>
              ) : (
                <ul>
                  {user.groups.map((g) => (
                    <li key={g}>{g}</li>
                  ))}
                </ul>
              )}
              <p className="muted">Members are chosen on a group's page.</p>
            </section>
          </div>
          <TokensPanel
            key={`t-${user.id}`}
            load={() => api.userTokens(user.id)}
            add={user.service ? (input) => api.addUserToken(user.id, input) : undefined}
            revoke={(token) => api.revokeUserToken(user.id, token)}
            none={user.service ? 'No token: the account cannot sign in.' : 'No token.'}
            intro={
              <p className="muted">
                {user.service
                  ? 'A service account signs in only with tokens, made here. A token acts as the account, with its grants.'
                  : 'People make their own tokens on My account. You can see them here and revoke one.'}
              </p>
            }
          />
        </>
      )}
    </>
  );
}

// --- one group

function GroupProfile({ group, onSaved }: { group: Group; onSaved(g: Group): void }) {
  const [name, setName] = useState(group.name);
  const [email, setEmail] = useState(group.email ?? '');
  const [webhook, setWebhook] = useState(group.webhookUrl ?? '');
  const [saved, setSaved] = useState(false);
  return (
    <section className="panel" aria-labelledby="group-profile">
      <h2 id="group-profile">Name and contacts</h2>
      <Form
        submit="Save"
        onSubmit={async () => {
          setSaved(false);
          onSaved(
            await api.changeGroup(group.id, {
              name: name.trim(),
              email: email.trim() || null,
              webhookUrl: webhook.trim() || null,
            }),
          );
          setSaved(true);
        }}
      >
        <Field
          label="Group name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          maxLength={64}
          hint="Approvals name groups by this name: renaming it changes who those approvals ask."
        />
        <Field
          label="Email address"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          hint="Empty: the group is told through its members."
        />
        <Field
          label="Webhook"
          type="url"
          value={webhook}
          onChange={(e) => setWebhook(e.target.value)}
        />
        {saved && (
          <p className="notice ok" role="status">
            Saved.
          </p>
        )}
      </Form>
    </section>
  );
}

function Members({ group, onSaved }: { group: Group; onSaved(g: Group): void }) {
  const users = useLoad(api.users, []);
  const [chosen, setChosen] = useState(new Set(group.members));
  const [filter, setFilter] = useState('');
  const [saved, setSaved] = useState(false);
  const shown = (users.data ?? []).filter((u) =>
    `${u.login} ${u.name}`.toLowerCase().includes(filter.trim().toLowerCase()),
  );
  return (
    <section className="panel" aria-labelledby="members">
      <h2 id="members">Members ({chosen.size})</h2>
      <Loading state={users} />
      {users.data && (
        <Form
          submit="Save members"
          onSubmit={async () => {
            setSaved(false);
            const ids = (users.data ?? []).filter((u) => chosen.has(u.login)).map((u) => u.id);
            onSaved(await api.setMembers(group.id, ids));
            setSaved(true);
          }}
        >
          <Field
            label="Find"
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <fieldset className="choices">
            <legend className="sr-only">Members</legend>
            {shown.map((u) => (
              <label key={u.id} className="choice">
                <input
                  type="checkbox"
                  checked={chosen.has(u.login)}
                  onChange={(e) => {
                    const next = new Set(chosen);
                    if (e.target.checked) next.add(u.login);
                    else next.delete(u.login);
                    setChosen(next);
                    setSaved(false);
                  }}
                />
                {u.name || u.login} <span className="muted">({u.login})</span>
              </label>
            ))}
          </fieldset>
          {saved && (
            <p className="notice ok" role="status">
              Saved.
            </p>
          )}
        </Form>
      )}
    </section>
  );
}

export function GroupPage({ id }: { id: string }) {
  const load = useLoad(() => api.group(id), [id]);
  const [group, setGroup] = useState<Group>();
  const [error, setError] = useState<string>();
  useEffect(() => setGroup(load.data), [load.data]);
  return (
    <>
      <p>
        <Link to="/admin/people">People and groups</Link>
      </p>
      <Loading state={load} />
      {group && (
        <>
          <PageHead
            title={group.name}
            lead={`Group · ${group.members.length} member${group.members.length === 1 ? '' : 's'}`}
          >
            <button
              type="button"
              className="danger"
              onClick={async () => {
                if (
                  !window.confirm(
                    `Delete the group ${group.name}? Its grants go with it; its members stay.`,
                  )
                )
                  return;
                try {
                  await api.deleteGroup(group.id);
                  navigate('/admin/people');
                } catch (e) {
                  setError(messageOf(e));
                }
              }}
            >
              Delete group
            </button>
          </PageHead>
          {error && (
            <p className="notice error" role="alert">
              {error}
            </p>
          )}
          <div className="columns">
            <GroupProfile key={`g-${group.id}`} group={group} onSaved={setGroup} />
            <Members key={`m-${group.id}`} group={group} onSaved={setGroup} />
          </div>
        </>
      )}
    </>
  );
}
