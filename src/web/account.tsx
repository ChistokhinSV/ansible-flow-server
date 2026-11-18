// My account: the profile and the access tokens of who is signed in, each on its own tab (AFS-88).
import { useState } from 'react';
import { PASSWORD_RULES, passwordProblem } from '../server/auth/passwordRules';
import { accessWords, flowTitle, throughWords, useFlowTitles, useMyAccess } from './access';
import { api, type User } from './api';
import { Link } from './router';
import { TokensPanel } from './tokens';
import { Field, Form, Loading, PageHead, refuse, Tabs, useLoad } from './ui';

/** A webhook's address as a page shows it to someone who may not change it: its host only. */
const hookHost = (url: string) => {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/…`;
  } catch {
    return 'set';
  }
};

/**
 * Name and email address, which anyone changes for themself; the webhook, which only an
 * administrator sets (the server calls the address it is given). AFS-29.
 */
function Profile({ me, onSaved }: { me: User; onSaved(changed: User): void }) {
  const [name, setName] = useState(me.name);
  const [email, setEmail] = useState(me.email ?? '');
  const [webhook, setWebhook] = useState(me.webhookUrl ?? '');
  const [saved, setSaved] = useState(false);
  return (
    <section className="panel" aria-labelledby="profile">
      <h2 id="profile" className="sr-only">
        Profile
      </h2>
      <p className="muted">
        Notifications for you (approvals that wait for you, how your runs' approvals were decided)
        go to your email address{me.admin ? ' and your webhook' : ''}.
      </p>
      <Form
        submit="Save"
        onSubmit={async () => {
          setSaved(false);
          const changed = await api.changeMe({
            name: name.trim(),
            email: email.trim() || null,
            ...(me.admin ? { webhookUrl: webhook.trim() || null } : {}),
          });
          setName(changed.name);
          setEmail(changed.email ?? '');
          setWebhook(changed.webhookUrl ?? '');
          setSaved(true);
          onSaved(changed);
        }}
      >
        <Field
          label="Display name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <Field
          label="Email address"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        {me.admin ? (
          <Field
            label="Webhook"
            type="url"
            value={webhook}
            onChange={(e) => setWebhook(e.target.value)}
            hint="The event as JSON, with a text line chat tools show."
          />
        ) : (
          <p>
            <span className="muted">Webhook:</span>{' '}
            {me.webhookUrl ? hookHost(me.webhookUrl) : 'none'}{' '}
            <span className="muted">(set by an administrator)</span>
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

export function Account({ me, tab }: { me: User; tab: 'profile' | 'tokens' }) {
  // Only for the number on the tab: the tab itself reads its own list.
  const tokens = useLoad(api.tokens, []);
  // What was saved is kept here, so the form shows it again after a look at the other tab.
  const [mine, setMine] = useState(me);
  return (
    <>
      <PageHead
        help="people-and-sign-in.md#access-tokens"
        title="My account"
        lead={`${mine.name} (${mine.login})`}
      />
      <Tabs
        label="My account"
        base="/account"
        current={tab === 'tokens' ? 'tokens' : ''}
        tabs={[
          { key: '', label: 'Profile' },
          {
            key: 'tokens',
            label: 'Access tokens',
            ...(tokens.data ? { count: tokens.data.length } : {}),
          },
        ]}
      />
      {tab === 'tokens' ? (
        <TokensPanel
          load={api.tokens}
          add={api.addToken}
          revoke={api.revokeToken}
          onChanged={tokens.reload}
          none="You have no token."
          intro={
            <p className="muted">
              A program signs in with a token instead of your password: git, the VS Code extension,
              a script. A token acts as you. What a program can ask is in the{' '}
              <Link to="/docs/api">API reference</Link>.
            </p>
          }
        />
      ) : (
        <>
          <Profile me={mine} onSaved={setMine} />
          <MyAccessPanel />
          {!mine.service && <PasswordForm login={mine.login} />}
        </>
      )}
    </>
  );
}

/**
 * AFS-152: what one may do, workspace by workspace, in words: the level on the workspace, flows
 * whose own grant gives another (by title), approving, and whose grants gave it. Who gives access
 * is named for who has none.
 */
function MyAccessPanel() {
  const mine = useMyAccess();
  const titles = useFlowTitles(
    (mine.data?.workspaces ?? []).flatMap((w) => w.flows.map((f) => f.projectId)),
  );
  const admins = mine.data?.administrators ?? [];
  return (
    <section className="panel" aria-labelledby="my-access">
      <h2 id="my-access">Your access</h2>
      <Loading state={mine} />
      {mine.data?.admin && <p>Administrator: you may do everything, in every workspace.</p>}
      {mine.data && !mine.data.admin && mine.data.workspaces.length === 0 && (
        <p className="muted">
          You have no access to a workspace yet: ask an administrator for it
          {admins.length ? ` (${admins.join(', ')})` : ''}.
        </p>
      )}
      {!!mine.data?.workspaces.length && (
        <>
          <ul className="rows">
            {mine.data.workspaces.map((w) => (
              <li key={w.workspace.id}>
                <p>
                  <Link to={`/w/${w.workspace.key}`}>{w.workspace.name}</Link>:{' '}
                  {accessWords({
                    level: w.level,
                    flows: w.flows.map((f) => ({
                      title: flowTitle(titles, f.projectId, f.file),
                      level: f.level,
                    })),
                    approve: w.approve,
                  })}
                </p>
                <p className="muted">
                  Through{' '}
                  {w.through
                    .map((t) => (t.startsWith('user:') ? 'your own grant' : throughWords(t)))
                    .join(', ')}
                </p>
              </li>
            ))}
          </ul>
          <p className="muted">
            An administrator changes it{admins.length ? ` (${admins.join(', ')})` : ''}.
          </p>
        </>
      )}
    </section>
  );
}

/**
 * AFS-104: your own password (people an administrator was told can change it here). Directory and
 * organisation sign-ins change theirs where they come from.
 */
function PasswordForm({ login }: { login: string }) {
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [done, setDone] = useState(false);
  const [mismatch, setMismatch] = useState(false);
  return (
    <section className="panel" aria-labelledby="password">
      <h2 id="password">Password</h2>
      <p className="muted">
        Your other sessions end when it changes. If you sign in with your directory or your
        organisation's sign-in, change your password there.
      </p>
      <Form
        submit="Change the password"
        onSubmit={async () => {
          setDone(false);
          setMismatch(password !== again);
          if (password !== again) return;
          // AFS-140: the rules are checked here first.
          const problem = passwordProblem(password, login);
          if (problem) refuse('password', `${problem}.`);
          await api.changePassword(current, password);
          setCurrent('');
          setPassword('');
          setAgain('');
          setDone(true);
        }}
      >
        <Field
          label="Current password"
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          required
        />
        <Field
          label="New password"
          name="password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => {
            setDone(false);
            setPassword(e.target.value);
          }}
          required
          hint={PASSWORD_RULES}
        />
        <Field
          label="New password again"
          type="password"
          autoComplete="new-password"
          value={again}
          onChange={(e) => setAgain(e.target.value)}
          required
        />
        {mismatch && (
          <p className="notice error" role="alert">
            The two new passwords are not the same
          </p>
        )}
        {done && (
          <p className="notice ok" role="status">
            Changed. Your other sessions are signed out.
          </p>
        )}
      </Form>
    </section>
  );
}
