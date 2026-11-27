// AFS-143: the Help page: the user guide's pages and the API reference, and how a page that is
// not found says what was looked for. AFS-155: the guide is this server's own (guidePage.tsx).
// AFS-279: task-first groups (edit, import, run first) and Ansible Flow Designer link.
import { Fragment, type ReactNode } from 'react';
import { api, type MyAccess } from './api';
import { DESIGNER, GUIDE_GROUPS, GUIDE_PAGES, guide } from './guide';
import { Link } from './router';
import { Breadcrumb, Icon, PageHead, useLoad, WorkspaceName } from './ui';

/** A link that leaves the server: opened beside it, and it says where it goes. */
export function OutLink({ href, children }: { href: string; children: ReactNode }) {
  let host = '';
  try {
    host = new URL(href).hostname;
  } catch {
    host = '';
  }
  const where = host === 'github.com' ? 'GitHub' : host.replace(/^www\./, '');
  return (
    <a href={href} target="_blank" rel="noreferrer" className="out-link">
      {children}
      <span className="muted"> (opens {where})</span>
      <Icon name="external" />
    </a>
  );
}

export function HelpPage() {
  return (
    <>
      <PageHead
        title="Help"
        lead={
          <>
            Runs visual Ansible playbooks built on the canvas or in{' '}
            <OutLink href={DESIGNER}>Ansible Flow Designer</OutLink>.
          </>
        }
      >
        <Link className="button" to={guide()}>
          User guide
        </Link>
      </PageHead>
      {GUIDE_PAGES.map((pages, i) => (
        <section className="panel" key={GUIDE_GROUPS[i]} aria-labelledby={`help-${i}`}>
          <h2 id={`help-${i}`}>{GUIDE_GROUPS[i]}</h2>
          <dl className="facts guide-list">
            {i === 3 && (
              <>
                <dt>
                  <Link to="/docs/api">API reference</Link>
                </dt>
                <dd>Every address of this server's REST API, with what it takes and answers</dd>
              </>
            )}
            {pages.map((p) => (
              <Fragment key={p.page}>
                <dt>
                  <Link to={guide(p.page)}>{p.title}</Link>
                </dt>
                <dd>{p.about}</dd>
              </Fragment>
            ))}
          </dl>
        </section>
      ))}
    </>
  );
}

/**
 * What was looked for and is not there, or not shared with this person (the server answers
 * both the same way), with the way back and the guide. AFS-152: the way back is to a page the
 * person can open; who gives access is named; when the person sees everything around it (an
 * administrator, or `gone`), it is said not to exist instead.
 */
export function Missing({
  what,
  back,
  help = 'workspaces-and-projects.md',
  error,
  gone = false,
  access,
}: {
  /** What was looked for: "The project edge in network". */
  what: ReactNode;
  back: { to: string; label: ReactNode };
  help?: string;
  /** What the server said, when it said more than "not found". */
  error?: string | undefined;
  /** Known not to exist: the person would see it if it were there. */
  gone?: boolean;
  /** One's own access as the page reads it already (so it is asked for once). */
  access?: { data?: MyAccess | undefined };
}) {
  const read = useLoad(async () => (access ? undefined : api.myAccess()), []);
  const mine = (access ?? read).data;
  const exists = !(gone || mine?.admin);
  const admins = mine?.administrators ?? [];
  return (
    <>
      <PageHead title="Not found" />
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <p className="empty" data-missing={exists ? 'hidden' : 'gone'}>
        {what} {exists ? 'is not here, or is not shared with you.' : 'does not exist.'}{' '}
        <Link to={back.to}>{back.label}</Link>
      </p>
      <p className="muted">
        {exists && (
          <>
            An administrator gives access
            {admins.length
              ? `: ${admins.slice(0, 3).join(', ')}${admins.length > 3 ? ', …' : ''}`
              : ''}
            .{' '}
          </>
        )}
        See <Link to={guide(help)}>the guide</Link>.
      </p>
    </>
  );
}

/**
 * AFS-152: a project of an address that is not there, with its own breadcrumbs: the workspace is
 * linked only when the person can open it (`error`: its projects could not be read). In a
 * workspace the person has a level on, every project shows: one not listed does not exist.
 */
export function MissingProject({
  workspace,
  project,
  error,
}: {
  workspace: string;
  project: string;
  /** Why the workspace's projects could not be read, if they could not. */
  error?: string | undefined;
}) {
  const access = useLoad(api.myAccess, []);
  const mine = access.data;
  const hidden = !!error;
  const level = mine?.workspaces.find((w) => w.workspace.key === workspace)?.level;
  const space = hidden ? <code>{workspace}</code> : <WorkspaceName workspace={workspace} />;
  return (
    <>
      <Breadcrumb>
        <Link to="/workspaces">Workspaces</Link> /{' '}
        {hidden ? space : <Link to={`/w/${workspace}`}>{space}</Link>} /{' '}
        <span aria-current="page">{project}</span>
      </Breadcrumb>
      <Missing
        what={
          <>
            The project <code>{project}</code> in {space}
          </>
        }
        back={
          hidden
            ? { to: '/workspaces', label: 'Back to Workspaces' }
            : { to: `/w/${workspace}`, label: <>Back to {space}</> }
        }
        gone={!hidden && !!level}
        access={access}
        error={error && !/^No such/.test(error) ? error : undefined}
      />
    </>
  );
}
