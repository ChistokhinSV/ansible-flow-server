// AFS-155: the user guide served by the server for its own version (no internet), its Markdown,
// and Get Started. AFS-154: table cells named by their column for a phone, and the note of a field
// cut at its length.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/web/app';
import { GUIDE_PAGES, guide } from '../../src/web/guide';
import { isGuidePage } from '../../src/web/guidePage';
import { parseBlocks, slug } from '../../src/web/markdown';
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
  it('has every page the Help page lists, and Get Started opens the first flow', () => {
    for (const p of GUIDE_PAGES.flat()) expect(isGuidePage(p.page), p.page).toBe(true);
    expect(guide('runs.md')).toBe('/help/guide/runs.md');
    expect(GET_STARTED).toBe('/help/guide/first-flow.md');
  });

  it('shows a page with its title, links within the guide here, and a link out says so', async () => {
    window.history.replaceState(null, '', '/help/guide/first-flow.md');
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Your first flow' });
    const inside = screen.getAllByRole('link', { name: 'Editing flows in the pages' })[0];
    expect(inside?.getAttribute('href')).toBe(
      '/help/guide/web-pages.md#editing-flows-in-the-pages',
    );
    expect(inside?.getAttribute('target')).toBeNull();
    expect(screen.getByRole('heading', { name: '2. Add two steps' }).id).toBe('2-add-two-steps');
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
