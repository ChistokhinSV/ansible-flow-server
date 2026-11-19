// People and groups, for administrators (AFS-56): the accounts and the groups, a person's page
// and a group's page. The server keeps the rules (the last administrator stays one, no one deletes
// themself); a refusal is shown as the server words it.
// AFS-87: people and groups are two tabs, each a table first with its add form behind a button; a
// person's page starts with what they reach and ends with disable and delete; a group's page
// starts with its members and the workspaces that name it.
import { Fragment, useEffect, useId, useState } from 'react';
import { PASSWORD_RULES, passwordProblem } from '../server/auth/passwordRules';
import { flowTitle, LEVEL_NAME, throughWords, useFlowTitles } from './access';
import { api, type Group, type User } from './api';
import { Link, navigate, noteHere } from './router';
import { TokensPanel } from './tokens';
import {
  Breadcrumb,
  Field,
  Form,
  Loading,
  messageOf,
  PageHead,
  refuse,
  Scroll,
  Tabs,
  Time,
  useLoad,
} from './ui';

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

function AddPerson({ onAdded, onCancel }: { onAdded(user: User): void; onCancel(): void }) {
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
      onCancel={onCancel}
      onSubmit={async () => {
        // AFS-140: the rules are checked here first, all said under the field.
        const problem =
          input.kind !== 'service' && input.password
            ? passwordProblem(input.password, input.login.trim())
            : undefined;
        if (problem) refuse('password', `${problem}.`);
        onAdded(
          await api.addUser({
            login: input.login.trim(),
            name: input.name.trim(),
            ...(input.kind === 'admin' ? { admin: true } : {}),
            ...(input.kind === 'service' ? { service: true } : {}),
            ...(input.kind !== 'service' && input.password ? { password: input.password } : {}),
            ...(input.email.trim() ? { email: input.email.trim() } : {}),
          }),
        );
      }}
    >
      <Field
        label="Login"
        value={input.login}
        onChange={set('login')}
        required
        maxLength={64}
        autoComplete="off"
        autoFocus
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
          name="password"
          type="password"
          autoComplete="new-password"
          value={input.password}
          onChange={set('password')}
          hint={`${PASSWORD_RULES} Without one they cannot sign in until you set it on their page.`}
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

function AddGroup({ onAdded, onCancel }: { onAdded(group: Group): void; onCancel(): void }) {
  const [name, setName] = useState('');
  return (
    <Form
      submit="Add group"
      onCancel={onCancel}
      onSubmit={async () => onAdded(await api.addGroup({ name: name.trim() }))}
    >
      <Field
        label="Group name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
        maxLength={64}
        autoFocus
      />
    </Form>
  );
}

/** Which accounts the people table shows. */
type Show = '' | 'person' | 'admin' | 'service' | 'disabled';
const SHOWS: [Show, string][] = [
  ['', 'All'],
  ['person', 'People'],
  ['admin', 'Administrators'],
  ['service', 'Service accounts'],
  ['disabled', 'Disabled'],
];
const showsUser = (u: User, show: Show) =>
  show === ''
    ? true
    : show === 'disabled'
      ? u.disabled
      : show === 'service'
        ? u.service
        : show === 'admin'
          ? u.admin && !u.service
          : !u.admin && !u.service;

function PeopleTable({ users }: { users: User[] }) {
  const [find, setFind] = useState('');
  const [show, setShow] = useState<Show>('');
  const words = find.trim().toLowerCase();
  const rows = users.filter(
    (u) => showsUser(u, show) && `${u.login} ${u.name}`.toLowerCase().includes(words),
  );
  return (
    <>
      <div className="filter-row">
        <Field
          label="Find"
          type="search"
          placeholder="Name or login"
          value={find}
          onChange={(e) => setFind(e.target.value)}
        />
        <fieldset className="chips">
          <legend className="sr-only">Show</legend>
          {SHOWS.map(([key, label]) => (
            <label key={key || 'all'} className={show === key ? 'chip on' : 'chip'}>
              <input
                type="radio"
                name="people-show"
                value={key}
                checked={show === key}
                onChange={() => setShow(key)}
              />
              {label}
            </label>
          ))}
        </fieldset>
      </div>
      {rows.length === 0 ? (
        <p className="empty" role="status">
          No one matches.
        </p>
      ) : (
        <Scroll>
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
              {rows.map((u) => (
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
        </Scroll>
      )}
    </>
  );
}

function GroupsTable({ groups }: { groups: Group[] }) {
  return (
    <Scroll>
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
          {groups.map((g) => (
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
    </Scroll>
  );
}

export function PeoplePage({ tab }: { tab: 'people' | 'groups' }) {
  // Both are read on either tab: the tabs show how many each holds.
  const users = useLoad(api.users, []);
  const groups = useLoad(api.groups, []);
  // The tab whose add form is open; going to the other tab leaves it closed there.
  const [adding, setAdding] = useState<'people' | 'groups'>();
  const [added, setAdded] = useState<{ to: string; name: string }>();
  // AFS-153: what was done on the page before (a person or group deleted).
  const [deleted, setDeleted] = useState(noteHere);
  // AFS-144: the "Added" note belongs to the tab it was added on: another tab clears it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the tab changes
  useEffect(() => {
    setAdded(undefined);
    setDeleted(noteHere());
  }, [tab]);
  const open = adding === tab;
  const done = (to: string, name: string, reload: () => void) => {
    setAdding(undefined);
    setAdded({ to, name });
    reload();
  };
  return (
    <>
      <PageHead
        help="people-and-sign-in.md"
        title="People and groups"
        lead="Who can sign in, who are administrators, and the groups that access levels and approvals name."
      >
        {!open && (
          <button
            type="button"
            className="primary"
            onClick={() => {
              setAdded(undefined);
              setAdding(tab);
            }}
          >
            {tab === 'people' ? 'Add a person' : 'Add a group'}
          </button>
        )}
      </PageHead>
      <Tabs
        label="People and groups"
        base="/admin"
        current={tab}
        tabs={[
          { key: 'people', label: 'People', count: users.data?.length },
          { key: 'groups', label: 'Groups', count: groups.data?.length },
        ]}
      />
      {open && tab === 'people' && (
        <section className="panel sheet" aria-label="Add a person or service account">
          <AddPerson
            onCancel={() => setAdding(undefined)}
            onAdded={(u) => done(`/admin/people/${u.id}`, u.name || u.login, users.reload)}
          />
        </section>
      )}
      {open && tab === 'groups' && (
        <section className="panel sheet" aria-label="Add a group">
          <AddGroup
            onCancel={() => setAdding(undefined)}
            onAdded={(g) => done(`/admin/groups/${g.id}`, g.name, groups.reload)}
          />
        </section>
      )}
      {added && (
        <p className="notice ok" role="status">
          Added <Link to={added.to}>{added.name}</Link>.
        </p>
      )}
      {deleted && !added && (
        <p className="notice ok" role="status">
          {deleted}
        </p>
      )}
      {tab === 'people' ? (
        <section aria-label="People">
          <Loading state={users} />
          {users.data && <PeopleTable users={users.data} />}
        </section>
      ) : (
        <section aria-label="Groups">
          <Loading state={groups} />
          {groups.data?.length === 0 && <p className="empty">No group yet.</p>}
          {!!groups.data?.length && <GroupsTable groups={groups.data} />}
        </section>
      )}
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
          const problem = passwordProblem(password, user.login);
          if (problem) refuse('password', `${problem}.`);
          await api.setUserPassword(user.id, password);
          setPassword('');
          setDone(true);
        }}
      >
        <Field
          label="New password"
          name="password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            setDone(false);
          }}
          required
          hint={`${PASSWORD_RULES} Their sessions end. Tell them the password; they can change it on My account.`}
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
            onClick={() => {
              // AFS-134: disabling signs them out and stops their tokens: asked first.
              if (
                !user.disabled &&
                !window.confirm(
                  `Disable ${user.name || user.login}? They are signed out at once, cannot sign in, and their tokens stop working. Their grants are kept.`,
                )
              )
                return;
              act(async () =>
                onChanged(await api.changeUser(user.id, { disabled: !user.disabled })),
              );
            }}
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
                navigate('/admin/people', { note: `Deleted ${user.name || user.login}.` });
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

/** AFS-153: a person's groups by name, each linked to its page. */
function GroupLinks({ names }: { names: string[] }) {
  const groups = useLoad(api.groups, []);
  const idOf = new Map((groups.data ?? []).map((g) => [g.name, g.id]));
  return (
    <>
      {names.map((name, i) => {
        const id = idOf.get(name);
        return (
          <Fragment key={name}>
            {i > 0 && ', '}
            {id ? <Link to={`/admin/groups/${id}`}>{name}</Link> : name}
          </Fragment>
        );
      })}
    </>
  );
}

/**
 * What a person reaches: their row of each workspace's "Who can do what", in one answer of the
 * server. An administrator's answer is known without asking.
 */
function Reach({ user }: { user: User }) {
  const load = useLoad(
    () => api.userAccess(user.id),
    // Their groups decide it too: a change of them is read again.
    [user.id, user.groups.join(',')],
  );
  const rows = load.data?.workspaces ?? [];
  // AFS-152: flows by their titles, levels in words.
  const titles = useFlowTitles(rows.flatMap((r) => r.flows.map((f) => f.projectId)));
  return (
    <>
      <Loading state={load} />
      {load.data && rows.length === 0 && <p className="muted">No access to any workspace.</p>}
      {rows.length > 0 && (
        <Scroll>
          <table>
            <thead>
              <tr>
                <th scope="col">Workspace</th>
                <th scope="col">Level</th>
                <th scope="col">Flows of their own</th>
                <th scope="col">Approves</th>
                <th scope="col">Through</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ workspace, ...who }) => (
                <tr key={workspace.id}>
                  <td>
                    <Link to={`/w/${workspace.key}`}>{workspace.name || workspace.key}</Link>
                  </td>
                  <td>{who.level && <span className="badge">{LEVEL_NAME[who.level]}</span>}</td>
                  <td>
                    {who.flows.map((f) => (
                      <div key={`${f.project}/${f.file}`}>
                        {flowTitle(titles, f.projectId, f.file)}:{' '}
                        {f.level ? LEVEL_NAME[f.level] : 'none'}{' '}
                        <span className="muted">in {f.project}</span>
                      </div>
                    ))}
                  </td>
                  <td>{who.approve ? 'yes' : ''}</td>
                  <td className="muted">{who.through.map(throughWords).join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Scroll>
      )}
    </>
  );
}

export function UserPage({ id, me }: { id: string; me: User }) {
  const load = useLoad(() => api.user(id), [id]);
  const [user, setUser] = useState<User>();
  useEffect(() => setUser(load.data), [load.data]);
  const name = user ? user.name || user.login : undefined;
  return (
    <>
      <Breadcrumb>
        <Link to="/admin/people">People and groups</Link> /{' '}
        <span aria-current="page">{name ?? 'person'}</span>
      </Breadcrumb>
      <Loading state={load} />
      {user && name && (
        <>
          <PageHead title={name} lead={user.login === name ? undefined : user.login} />
          <p className="statusline">
            <span>{kindOf(user)}</span>
            <span className={`badge ${user.disabled ? 'bad' : 'ok'}`}>
              {user.disabled ? 'disabled' : 'active'}
            </span>
            {user.service ? (
              <span>signs in with tokens only</span>
            ) : (
              <span>
                last sign-in <Time at={user.lastLoginAt} />
              </span>
            )}
          </p>
          <section className="panel" aria-labelledby="member-of">
            <h2 id="member-of">Groups</h2>
            {user.groups.length === 0 ? (
              <p className="muted">In no group. Members are chosen on a group's page.</p>
            ) : (
              <p>
                <GroupLinks names={user.groups} />{' '}
                <span className="muted">· members are chosen on a group's page</span>
              </p>
            )}
          </section>
          <section className="panel" aria-labelledby="reach">
            <h2 id="reach">What they reach</h2>
            {user.admin ? (
              <p>Administrators may do everything.</p>
            ) : (
              <Reach key={`r-${user.id}`} user={user} />
            )}
          </section>
          <div className="columns">
            <UserProfile key={`p-${user.id}`} user={user} me={me} onSaved={setUser} />
            {!user.service && <SetPassword user={user} />}
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
          {/* Last on the page: the part that takes access away. */}
          <Standing user={user} me={me} onChanged={setUser} />
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

/** The workspaces whose grants name the group, with the level and what it is on. */
function NamedIn({ group }: { group: Group }) {
  const load = useLoad(() => api.groupGrants(group.id), [group.id]);
  const rows = load.data ?? [];
  // AFS-152: flows by their titles.
  const titles = useFlowTitles(rows.flatMap((r) => (r.flow ? [r.flow.project] : [])));
  return (
    <section className="panel" aria-labelledby="named-in">
      <h2 id="named-in">Access this group gives</h2>
      <Loading state={load} />
      {load.data && rows.length === 0 && (
        <p className="muted">No workspace gives this group a level.</p>
      )}
      {rows.length > 0 && (
        <Scroll>
          <table>
            <thead>
              <tr>
                <th scope="col">Workspace</th>
                <th scope="col">Level</th>
                <th scope="col">On</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ workspace, ...grant }) => (
                <tr key={grant.id}>
                  <td>
                    <Link to={`/w/${workspace.key}`}>{workspace.name || workspace.key}</Link>
                  </td>
                  <td>
                    <span className="badge">{LEVEL_NAME[grant.level]}</span>
                  </td>
                  <td>
                    {grant.flow ? (
                      <>
                        {flowTitle(titles, grant.flow.project, grant.flow.file)}{' '}
                        <span className="muted">in {grant.flow.projectKey}</span>
                      </>
                    ) : (
                      'the whole workspace'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Scroll>
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
      <Breadcrumb>
        <Link to="/admin/groups">People and groups</Link> /{' '}
        <span aria-current="page">{group?.name ?? 'group'}</span>
      </Breadcrumb>
      <Loading state={load} />
      {group && (
        <>
          <PageHead
            help="people-and-sign-in.md"
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
                  navigate('/admin/groups', { note: `Deleted the group ${group.name}.` });
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
            <Members key={`m-${group.id}`} group={group} onSaved={setGroup} />
            <NamedIn key={`n-${group.id}`} group={group} />
          </div>
          <GroupProfile key={`g-${group.id}`} group={group} onSaved={setGroup} />
        </>
      )}
    </>
  );
}
