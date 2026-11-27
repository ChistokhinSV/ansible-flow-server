// AFS-274 (ADR-0039 §10): the Server page, Govern's last item. The parts of the server an
// administrator looks after, each with how it stands now and the page that changes it; the five
// pages keep their own addresses. It reads what those pages read: no API of its own.
import type { ReactNode } from 'react';
import { api } from './api';
import { Link } from './router';
import { PageHead, Scroll, useLoad } from './ui';

const count = (n: number, one: string, many: string) =>
  n === 0 ? `no ${many}` : `${n} ${n === 1 ? one : many}`;

/**
 * How a part stands: "…" while it is read, "could not read" when its call failed (that part's
 * page says why), else its words. A failure is not the same as a part not set up.
 */
function stateOf<T>(load: { data?: T; error?: string }, words: (data: T) => ReactNode): ReactNode {
  if (load.error !== undefined) return 'could not read';
  if (load.data === undefined) return '…';
  return words(load.data);
}

export function ServerPage() {
  const providers = useLoad(api.oidcProviders, []);
  const directories = useLoad(api.directories, []);
  const secrets = useLoad(api.secretProviders, []);
  const certificate = useLoad(api.certificate, []);
  const notify = useLoad(api.notifySettings, []);
  const streams = useLoad(api.streams, []);
  const image = useLoad(api.defaultEnvironment, []);

  const rows: { to: string; part: string; does: string; now: ReactNode }[] = [
    {
      to: '/admin/sign-in',
      part: 'Sign-in',
      does: 'How people sign in: passwords, single sign-on, directories',
      now: stateOf(providers, (p) =>
        stateOf(
          directories,
          (d) =>
            `${count(p.length, 'single sign-on provider', 'single sign-on providers')}, ${count(d.length, 'directory', 'directories')}`,
        ),
      ),
    },
    {
      to: '/admin/secret-providers',
      part: 'Secret providers',
      does: 'Where credentials read their secret parts from',
      now: stateOf(secrets, (list) => count(list.length, 'provider', 'providers')),
    },
    {
      to: '/admin/certificate',
      part: 'Server certificate',
      does: 'The certificate the server speaks HTTPS with',
      now: stateOf(certificate, (c) => {
        const info = c.current?.info;
        if (c.tls === 'off') return 'HTTPS is a proxy’s: the server speaks plain HTTP';
        if (!info) return 'none installed';
        if (info.daysLeft <= 0) return 'it has ended';
        return `ends in ${info.daysLeft} ${info.daysLeft === 1 ? 'day' : 'days'}`;
      }),
    },
    {
      to: '/admin/notifications',
      part: 'Notifications',
      does: 'Email and webhooks: who is told of approvals and runs',
      now: stateOf(
        notify,
        (n) =>
          `${n.smtp ? 'email on' : 'no email'}, webhooks ${n.webhookKey ? 'signed' : 'not signed yet'}`,
      ),
    },
    {
      to: '/admin/streams',
      part: 'Event streaming',
      does: 'The audit log and runs, sent on to other systems',
      now: stateOf(streams, (list) => count(list.length, 'stream', 'streams')),
    },
    {
      to: image.data?.environment?.workspaceKey
        ? `/w/${image.data.environment.workspaceKey}/environments/${image.data.environment.id}`
        : '/admin/server',
      part: 'Default image',
      does: 'The image runs get when they name none',
      now: stateOf(image, (i) =>
        i.environment ? (
          <>
            {i.environment.name}: <code>{i.image}</code>
          </>
        ) : (
          <>
            AFS_EE_IMAGE: <code>{i.configured}</code>
          </>
        ),
      ),
    },
  ];
  return (
    <>
      <PageHead title="Server" />
      <div className="ledger">
        <div className="ledger-head">
          <h2>Parts of the server</h2>
        </div>
        <Scroll>
          <table className="server-parts">
            <thead>
              <tr>
                <th scope="col">Part</th>
                <th scope="col">What it is</th>
                <th scope="col">Now</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.part}>
                  <td>{r.to === '/admin/server' ? r.part : <Link to={r.to}>{r.part}</Link>}</td>
                  <td className="muted">{r.does}</td>
                  <td>{r.now}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Scroll>
      </div>
    </>
  );
}
