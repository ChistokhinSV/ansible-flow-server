// My account: the profile and the access tokens of who is signed in, each on its own tab (AFS-88).
import { useState } from 'react';
import { api, type User } from './api';
import { Link } from './router';
import { TokensPanel } from './tokens';
import { Field, Form, PageHead, Tabs, useLoad } from './ui';

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
      <h2 id="profile">Profile</h2>
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
      <PageHead title="My account" lead={`${mine.name} (${mine.login})`} />
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
        <Profile me={mine} onSaved={setMine} />
      )}
    </>
  );
}
