// AFS-155: the user guide served by the server for its own version (no internet), its Markdown,
// and Get Started. AFS-154: table cells named by their column for a phone, and the note of a field
// cut at its length. AFS-279: task-first pages and backward-compatible aliases.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/web/app';
import { GUIDE_PAGES, guide } from '../../src/web/guide';
import { isGuidePage, resolveGuide } from '../../src/web/guidePage';
import { type Block, parseBlocks, slug } from '../../src/web/markdown';
import { labelCells, limitNote } from '../../src/web/ui';
import { GET_STARTED } from '../../src/web/viewerDraft';

const dana = { id: 'u1', login: 'dana', name: 'Dana Whitfield', admin: true, groups: [] };

beforeEach(() => {
  window.localStorage.clear();
  window.scrollTo = () => undefined;
  Element.prototype.scrollIntoView = () => undefined;
  vi.stubGlobal('fetch', async (url: string) => {
    const key = url.replace('/api/v1', '');
    const body =
      key === '/session'
        ? dana
        : key === '/workspaces'
          ? []
          : key === '/meta'
            ? { name: 'ansible-flow-server', version: '1.0.1' }
            : undefined;
    const status = body === undefined ? 404 : 200;
    return {
      ok: status < 300,
      status,
      json: async () => body ?? { error: 'not_found', message: 'Not found' },
    } as Response;
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the guide the server serves', () => {
  it('has every page the Help page lists, and Get Started opens Edit flows', () => {
    for (const p of GUIDE_PAGES.flat()) expect(isGuidePage(p.page), p.page).toBe(true);
    expect(guide('runs.md')).toBe('/help/guide/runs.md');
    expect(GET_STARTED).toBe('/help/guide/edit-flows.md');
    expect(resolveGuide('first-flow.md')).toEqual({ page: 'edit-flows.md' });
    expect(resolveGuide('launch-configurations.md')).toEqual({
      page: 'runs.md',
      part: 'launch-configurations',
    });
    expect(resolveGuide('web-pages.md', 'files-of-a-project')).toEqual({
      page: 'workspaces-and-projects.md',
      part: 'files-of-a-project',
    });
  });

  it('every internal link, anchor and image in docs/guide resolves', () => {
    const dir = 'docs/guide';
    const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
    const images = new Set(readdirSync(join(dir, 'images')));
    const headingsOf = (blocks: Block[], out = new Set<string>()): Set<string> => {
      for (const b of blocks) {
        if (b.t === 'heading') out.add(slug(b.text));
        else if (b.t === 'quote') headingsOf(b.blocks, out);
        else if (b.t === 'list') for (const item of b.items) headingsOf(item, out);
      }
      return out;
    };
    const anchors = new Map<string, Set<string>>();
    for (const file of files) {
      const text = readFileSync(join(dir, file), 'utf8');
      anchors.set(file, headingsOf(parseBlocks(text)));
    }
    for (const file of files) {
      const text = readFileSync(join(dir, file), 'utf8').replace(/```[\s\S]*?```/g, '');
      for (const m of text.matchAll(/!\[[^\]]*\]\(\s*([^)\s]+)\s*\)/g)) {
        const img = (m[1] ?? '').replace(/^\.?\/?images\//, '');
        expect(images.has(img), `${file} image ${m[1]}`).toBe(true);
      }
      for (const m of text.matchAll(/(?<!!)\[(?:[^[\]]|\[[^\]]*\])*\]\(\s*([^)\s]+)\s*\)/g)) {
        const href = m[1] ?? '';
        if (/^https?:\/\/|^\.\.\//.test(href) || href.startsWith('/')) continue;
        const [rawPage = '', part] = href.split('#');
        const target = rawPage ? resolveGuide(rawPage, part) : { page: file, part };
        expect(anchors.has(target.page), `${file} -> ${href} (${target.page})`).toBe(true);
        if (target.part)
          expect(
            anchors.get(target.page)?.has(target.part),
            `${file} -> ${href} (#${target.part} in ${target.page})`,
          ).toBe(true);
      }
    }
  });

  it('shows a page with its title, links within the guide here, and an alias opens the merged page', async () => {
    window.history.replaceState(null, '', '/help/guide/first-flow.md');
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Edit flows' });
    const inside = screen.getAllByRole('link', { name: 'Import playbooks' })[0];
    expect(inside?.getAttribute('href')).toBe('/help/guide/import-playbooks.md');
    expect(inside?.getAttribute('target')).toBeNull();
    const designer = screen.getAllByRole('link', { name: /Ansible Flow Designer/ })[0];
    expect(designer?.getAttribute('href')).toBe(
      'https://github.com/ChistokhinSV/ansible-flow-designer',
    );
    expect(designer?.getAttribute('target')).toBe('_blank');
    expect(screen.getByRole('heading', { name: 'Shared drafts' }).id).toBe('shared-drafts');
  });

  it('a file of the repository outside the guide opens on GitHub at this version', async () => {
    window.history.replaceState(null, '', '/help/guide/configuration.md');
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Configuration' });
    // Not by role: the page's long table makes a role query slow in jsdom.
    const out = document.querySelector('article a.out-link') as HTMLAnchorElement;
    expect(out.textContent).toBe('.env.example (opens GitHub)');
    expect(out.getAttribute('target')).toBe('_blank');
    await vi.waitFor(() =>
      expect(out.getAttribute('href')).toBe(
        'https://github.com/ChistokhinSV/ansible-flow-server/blob/v1.0.1/.env.example',
      ),
    );
  });

  it('a page the guide does not have is not found, with the way back to Help', async () => {
    window.history.replaceState(null, '', '/help/guide/nothing.md');
    render(<App />);
    await screen.findByRole('heading', { name: 'Not found' });
    expect(screen.getByRole('link', { name: 'Back to Help' }).getAttribute('href')).toBe('/help');
  });
});

describe('Markdown', () => {
  it('reads nested lists, tables, code and headings as GitHub anchors them', () => {
    const blocks = parseBlocks(
      [
        '## Editing flows in the pages',
        '',
        '- **One** item',
        '  goes on here',
        '  - nested `a | b`',
        '',
        '| A | B |',
        '| - | -: |',
        '| `x\\|y` | 2 |',
        '',
        '```sh',
        'echo hi',
        '```',
      ].join('\n'),
    );
    expect(blocks.map((b) => b.t)).toEqual(['heading', 'list', 'table', 'code']);
    expect(slug('Editing flows in the pages')).toBe('editing-flows-in-the-pages');
    expect(slug('1. Make the `first` administrator')).toBe('1-make-the-first-administrator');
    const list = blocks[1];
    expect(list?.t === 'list' && list.items[0]?.map((b) => b.t)).toEqual(['para', 'list']);
    const table = blocks[2];
    expect(table?.t === 'table' && table.rows[0]).toEqual(['`x|y`', '2']);
    expect(table?.t === 'table' && table.align).toEqual([undefined, 'right']);
  });
});

describe('layout helpers', () => {
  it('names each cell by its column, not a column whose heading is for screen readers', () => {
    const box = document.createElement('div');
    box.innerHTML =
      '<table><thead><tr><th>Name</th><th>Holds</th><th><span class="sr-only">Actions</span></th></tr></thead>' +
      '<tbody><tr><td>a</td><td>b</td><td><button>Delete</button></td></tr>' +
      '<tr><td colspan="3">None</td></tr></tbody></table>';
    labelCells(box);
    const cells = [...box.querySelectorAll('td')].map((td) => td.dataset.label ?? null);
    expect(cells).toEqual(['Name', 'Holds', null, null]);
  });

  it('a field at its length says the rest is left out', () => {
    expect(limitNote('x'.repeat(100), 100)).toBe(
      'At most 100 characters: anything after that is left out.',
    );
    expect(limitNote('short', 100)).toBeUndefined();
  });
});
