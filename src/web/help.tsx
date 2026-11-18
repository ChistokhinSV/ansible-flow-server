// AFS-143: the Help page: the user guide's pages and the API reference, and how a page that is
// not found says what was looked for.
import { Fragment, type ReactNode } from 'react';
import { GUIDE_PAGES, guide } from './guide';
import { Link } from './router';
import { PageHead } from './ui';

const GROUPS = ['Running flows', 'For administrators', 'Programs and agents'];

export function HelpPage() {
  return (
    <>
      <PageHead
        title="Help"
        lead={
          <>
            The <a href={guide()}>user guide</a> explains every page; the pages link their part of
            it with <strong>Help</strong> beside the title.
          </>
        }
      />
      {GUIDE_PAGES.map((pages, i) => (
        <section className="panel" key={GROUPS[i]} aria-labelledby={`help-${i}`}>
          <h2 id={`help-${i}`}>{GROUPS[i]}</h2>
          <dl className="facts">
            {pages.map((p) => (
              <Fragment key={p.page}>
                <dt>
                  <a href={guide(p.page)} target="_blank" rel="noreferrer">
                    {p.title}
                  </a>
                </dt>
                <dd>{p.about}</dd>
              </Fragment>
            ))}
            {i === 2 && (
              <>
                <dt>
                  <Link to="/docs/api">API reference</Link>
                </dt>
                <dd>Every address of this server's REST API, with what it takes and answers</dd>
              </>
            )}
          </dl>
        </section>
      ))}
    </>
  );
}

/**
 * What was looked for and is not there, or not shared with this person (the server answers
 * both the same way), with the way back and the guide.
 */
export function Missing({
  what,
  back,
  help = 'workspaces-and-projects.md',
  error,
}: {
  /** What was looked for: "The project edge in network". */
  what: ReactNode;
  back: { to: string; label: string };
  help?: string;
  /** What the server said, when it said more than "not found". */
  error?: string | undefined;
}) {
  return (
    <>
      <PageHead title="Not found" />
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <p className="empty">
        {what} is not here, or is not shared with you. <Link to={back.to}>{back.label}</Link>
      </p>
      <p className="muted">
        An administrator of the workspace gives access. See{' '}
        <a href={guide(help)} target="_blank" rel="noreferrer">
          the guide
        </a>
        .
      </p>
    </>
  );
}
