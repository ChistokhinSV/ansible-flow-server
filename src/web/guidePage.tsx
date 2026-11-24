// AFS-155: the user guide as this server shows it: docs/guide of the version it was built from,
// carried in the pages (each page loads when it is opened), so it needs no internet. Links
// between guide pages stay here; a link out says where it goes.
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { GUIDE, SOURCES } from './guide';
import { Missing } from './help';
import { parseBlocks, plain, type Render, renderBlocks } from './markdown';
import { Link } from './router';
import { Breadcrumb, Icon, PageHead, useLoad } from './ui';

const PAGES = import.meta.glob('../../docs/guide/*.md', {
  query: '?raw',
  import: 'default',
}) as Record<string, () => Promise<string>>;
const PICTURES = import.meta.glob('../../docs/guide/images/*', {
  query: '?url',
  import: 'default',
  eager: true,
}) as Record<string, string>;
const AT = '../../docs/guide/';

/** Whether `page` (`runs.md`) is a page of the guide this server carries. */
export const isGuidePage = (page: string) => `${AT}${page}` in PAGES;

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

/** Resolves `../../x/y` against docs/guide/: the path in the repository. */
function inRepository(href: string): string {
  const parts = ['docs', 'guide'];
  for (const part of href.split('/')) {
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  return parts.join('/');
}

export function GuidePage({ page }: { page: string }) {
  const name = page || 'README.md';
  const load = PAGES[`${AT}${name}`];
  const [text, setText] = useState<string | null>();
  const meta = useLoad(() => api.meta(), []);
  useEffect(() => {
    let live = true;
    setText(undefined);
    if (!load) setText(null);
    else
      load().then(
        (t) => live && setText(t),
        () => live && setText(null),
      );
    return () => {
      live = false;
    };
  }, [load]);
  // The part a link named (`web-pages.md#editing-flows-in-the-pages`), once the page is drawn.
  useEffect(() => {
    if (!text) return;
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (id) document.getElementById(id)?.scrollIntoView?.();
  }, [text]);

  const version = meta.data?.version;
  const render = useMemo<Render>(
    () => ({
      image: (src) => PICTURES[`${AT}${src.replace(/^\.\//, '')}`],
      link: (href, children, key) => {
        if (/^https?:\/\//.test(href))
          return (
            <OutLink key={key} href={href}>
              {children}
            </OutLink>
          );
        if (href.startsWith('#'))
          return (
            <a key={key} href={href}>
              {children}
            </a>
          );
        // AFS-258: a page of this server (/docs/api, /runs): there, in the application.
        if (/^\/(?!\/)/.test(href))
          return (
            <Link key={key} to={href}>
              {children}
            </Link>
          );
        const [file = '', part] = href.split('#');
        if (isGuidePage(file))
          return (
            <Link key={key} to={`${GUIDE}${file}${part ? `#${part}` : ''}`}>
              {children}
            </Link>
          );
        // A file of the repository beside the guide: on GitHub, as it is in this version.
        const ref = version ? `v${version}` : 'main';
        return (
          <OutLink key={key} href={`${SOURCES}/blob/${ref}/${inRepository(file)}`}>
            {children}
          </OutLink>
        );
      },
    }),
    [version],
  );

  if (text === null)
    return (
      <Missing
        what={
          <>
            The guide page <code>{name}</code>
          </>
        }
        back={{ to: '/help', label: 'Back to Help' }}
        help="README.md"
      />
    );
  if (text === undefined) return <p className="muted">Loading…</p>;
  const [first, ...rest] = text.replace(/\r\n?/g, '\n').split('\n');
  const titled = first?.startsWith('# ');
  const title = titled ? plain(first?.slice(2) ?? '') : 'User guide';
  // The line under each page's title that leads back to the guide's start: the Breadcrumb does.
  const body = (titled ? rest : [first ?? '', ...rest])
    .join('\n')
    .replace(/^\s*\[The guide\]\(README\.md\)\s*\n/, '');
  return (
    <>
      <Breadcrumb>
        <Link to="/help">Help</Link>
        {name !== 'README.md' && (
          <>
            {' / '}
            <Link to={GUIDE}>User guide</Link>
          </>
        )}
      </Breadcrumb>
      <PageHead title={title} />
      <article className="guide">{renderBlocks(parseBlocks(body), render)}</article>
    </>
  );
}
