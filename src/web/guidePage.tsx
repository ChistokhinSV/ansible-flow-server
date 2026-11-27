// AFS-155: the user guide as this server shows it: docs/guide of the version it was built from,
// carried in the pages (each page loads when it is opened), so it needs no internet. Links
// between guide pages stay here; a link out says where it goes.
import { useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { GUIDE, SOURCES } from './guide';
import { Missing, OutLink } from './help';
import { parseBlocks, plain, type Render, renderBlocks } from './markdown';
import { Link } from './router';
import { Breadcrumb, PageHead, useLoad } from './ui';

export { OutLink };

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

/** AFS-279: pages merged or split keep answering at their old addresses and anchors. */
const ALIASES: Record<string, { page: string; part?: string; parts?: Record<string, string> }> = {
  'first-flow.md': { page: 'edit-flows.md' },
  'flow-editor.md': { page: 'edit-flows.md' },
  'first-project.md': { page: 'install.md', part: 'first-project' },
  'getting-started.md': { page: 'install.md' },
  'launch-configurations.md': { page: 'runs.md', part: 'launch-configurations' },
  'web-pages.md': {
    page: 'inbox-and-navigation.md',
    parts: {
      'editing-flows-in-the-pages': 'edit-flows.md#shared-drafts',
      'files-of-a-project': 'workspaces-and-projects.md#files-of-a-project',
      'history-of-a-project': 'workspaces-and-projects.md#history',
      'a-flow-at-a-commit': 'workspaces-and-projects.md#a-flow-at-a-commit',
      'flow-library': 'edit-flows.md#flow-library',
    },
  },
};

export function resolveGuide(file: string, part?: string): { page: string; part?: string } {
  const alias = ALIASES[file];
  if (!alias) return part ? { page: file, part } : { page: file };
  const mapped = part ? alias.parts?.[part] : undefined;
  if (mapped) {
    const [p = alias.page, h] = mapped.split('#');
    return h ? { page: p, part: h } : { page: p };
  }
  const targetPart = part || alias.part;
  return targetPart ? { page: alias.page, part: targetPart } : { page: alias.page };
}

/** Whether `page` (`runs.md`) is a page of the guide this server carries. */
export const isGuidePage = (page: string) => `${AT}${page}` in PAGES || page in ALIASES;

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
  const rawHash =
    typeof window === 'undefined' ? '' : decodeURIComponent(window.location.hash.slice(1));
  const resolved = resolveGuide(page || 'README.md', rawHash || undefined);
  const name = resolved.page;
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
  // The part a link named (`edit-flows.md#flow-library`), once the page is drawn.
  useEffect(() => {
    if (!text) return;
    const id = resolved.part || decodeURIComponent(window.location.hash.slice(1));
    if (id) document.getElementById(id)?.scrollIntoView?.();
  }, [text, resolved.part]);

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
        if (isGuidePage(file)) {
          const target = resolveGuide(file, part);
          return (
            <Link key={key} to={`${GUIDE}${target.page}${target.part ? `#${target.part}` : ''}`}>
              {children}
            </Link>
          );
        }
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
