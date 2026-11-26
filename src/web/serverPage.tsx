// AFS-274 (ADR-0039 §10): the Server page, Govern's last item. The parts of the server an
// administrator looks after, each with how it stands now and the page that changes it; the five
// pages keep their own addresses. It reads what those pages read: no API of its own.
import type { ReactNode } from 'react';
import { api } from './api';
import { Link } from './router';
import { PageHead, Scroll, useLoad } from './ui';

const count = (n: number | undefined, one: string, many: string) =>
  n === undefined ? 'not known' : n === 0 ? `no ${many}` : `${n} ${n === 1 ? one : many}`;

export function ServerPage() {
  const providers = useLoad(() => api.oidcProviders().catch(() => undefined), []);
  const directories = useLoad(() => api.directories().catch(() => undefined), []);
  const secrets = useLoad(() => api.secretProviders().catch(() => undefined), []);
  const certificate = useLoad(() => api.certificate().catch(() => undefined), []);
  const notify = useLoad(() => api.notifySettings().catch(() => undefined), []);
  const streams = useLoad(() => api.streams().catch(() => undefined), []);
  const image = useLoad(() => api.defaultEnvironment().catch(() => undefined), []);

  const info = certificate.data?.current?.info;
  const rows: { to: string; part: string; does: string; now: ReactNode }[] = [
    {
      to: '/admin/sign-in',
      part: 'Sign-in',
      does: 'How people sign in: passwords, single sign-on, directories',
      now: `${count(providers.data?.length, 'single sign-on provider', 'single sign-on providers')}, ${count(
        directories.data?.length,
        'directory',
        'directories',
      )}`,
    },
    {
      to: '/admin/secret-providers',
      part: 'Secret providers',
      does: 'Where credentials read their secret parts from',
      now: count(secrets.data?.length, 'provider', 'providers'),
    },
    {
      to: '/admin/certificate',
      part: 'Server certificate',
      does: 'The certificate the server speaks HTTPS with',
      now:
        certificate.data?.tls === 'off'
          ? 'HTTPS is a proxy’s: the server speaks plain HTTP'
          : info
            ? info.daysLeft <= 0
              ? 'it has ended'
              : `ends in ${info.daysLeft} ${info.daysLeft === 1 ? 'day' : 'days'}`
            : certificate.data
              ? 'none installed'
              : 'not known',
    },
    {
      to: '/admin/notifications',
      part: 'Notifications',
      does: 'Email and webhooks: who is told of approvals and runs',
      now: notify.data
        ? `${notify.data.smtp ? 'email on' : 'no email'}, webhooks ${notify.data.webhookKey ? 'signed' : 'not signed yet'}`
        : 'not known',
    },
    {
      to: '/admin/streams',
      part: 'Event streaming',
      does: 'The audit log and runs, sent on to other systems',
      now: count(streams.data?.length, 'stream', 'streams'),
    },
    {
      to: image.data?.environment?.workspaceKey
        ? `/w/${image.data.environment.workspaceKey}/environments/${image.data.environment.id}`
        : '/admin/server',
      part: 'Default image',
      does: 'The image runs get when they name none',
      now: image.data ? (
        image.data.environment ? (
          <>
            {image.data.environment.name}: <code>{image.data.image}</code>
          </>
        ) : (
          <>
            AFS_EE_IMAGE: <code>{image.data.configured}</code>
          </>
        )
      ) : (
        'not known'
      ),
    },
  ];
  return (
    <>
      <PageHead
        title="Server"
        lead="The parts of this server you look after, how each stands now, and where to change it."
      />
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
