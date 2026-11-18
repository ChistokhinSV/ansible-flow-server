// The search field (AFS-69), with the server played by the test: `/` and Ctrl+K put the cursor in
// it; results as you type, the fixed pages first (settings pages for administrators only); arrows
// and Enter open one; Esc closes the list.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/web/app';

const dana = { id: 'u1', login: 'dana', name: 'Dana Whitfield', admin: true, groups: [] };
const omar = { id: 'u2', login: 'omar', name: 'Omar Haddad', admin: false, groups: [] };
const HITS = [
  {
    kind: 'flow',
    title: 'Hello, Ansible',
    detail: 'net/edge · flows/hello.flow.yaml',
    to: '/w/net/edge/flow/flows/hello.flow.yaml',
  },
  { kind: 'run', title: 'Run 7 · Hello, Ansible', detail: 'net/edge · succeeded', to: '/runs/r7' },
];

let asked: string[];
let routes: Record<string, () => { status?: number; body?: unknown }>;
beforeEach(() => {
  asked = [];
  window.scrollTo = () => undefined;
  // A run's page follows its stream: here it says nothing.
  vi.stubGlobal(
    'EventSource',
    class {
      addEventListener() {}
      close() {}
    },
  );
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const key = `${init.method ?? 'GET'} ${url.replace('/api/v1', '')}`;
    asked.push(key);
    const answer = routes[key]?.() ?? { status: 404, body: { error: 'not_found', message: key } };
    const status = answer.status ?? 200;
    return { ok: status < 300, status, json: async () => answer.body } as Response;
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const open = (me: object, path = '/approvals') => {
  routes = {
    'GET /session': () => ({ body: me }),
    'GET /approvals': () => ({ body: [] }),
    'GET /search?q=hello': () => ({ body: HITS }),
    'GET /search?q=audit': () => ({ body: [] }),
    'GET /runs/r7': () => ({ status: 404, body: { error: 'not_found', message: 'gone' } }),
  };
  window.history.replaceState(null, '', path);
  render(<App />);
};

describe('the search field', () => {
  it('opens with / and Ctrl+K, finds as you type, opens a result with the keyboard', async () => {
    open(dana);
    const field = (await screen.findByRole('combobox', { name: 'Search' })) as HTMLInputElement;
    // The page listens for keys once its effect has run, a moment after the field is drawn (a
    // slow CI machine pressed the key before that).
    await waitFor(() => {
      fireEvent.keyDown(window, { key: '/' });
      expect(document.activeElement).toBe(field);
    });
    field.blur();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(document.activeElement).toBe(field);

    fireEvent.change(field, { target: { value: 'hello' } });
    const list = await screen.findByRole('listbox', { name: 'Search results' });
    await within(list).findByText('Hello, Ansible');
    const options = within(list).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual([
      'flowHello, Ansiblenet/edge · flows/hello.flow.yaml',
      'runRun 7 · Hello, Ansiblenet/edge · succeeded',
    ]);
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    expect(field.getAttribute('aria-activedescendant')).toBe(options[1]?.id);
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => expect(window.location.pathname).toBe('/runs/r7'));
    expect(field.value).toBe('');
  });

  it('settings pages are found by their words, for administrators; Esc closes the list', async () => {
    open(dana);
    const field = await screen.findByRole('combobox', { name: 'Search' });
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: 'audit' } });
    const list = await screen.findByRole('listbox');
    expect(await within(list).findByText('Audit log')).toBeTruthy();
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    cleanup();

    open(omar);
    const theirs = await screen.findByRole('combobox', { name: 'Search' });
    fireEvent.focus(theirs);
    fireEvent.change(theirs, { target: { value: 'audit' } });
    const nothing = await screen.findByRole('listbox');
    expect(await within(nothing).findByText('Nothing found')).toBeTruthy();
    // One letter asks nothing.
    fireEvent.change(theirs, { target: { value: 'h' } });
    expect(asked.some((a) => a === 'GET /search?q=h')).toBe(false);
  });
});

describe('the search field and the page (AFS-102)', () => {
  it('what was typed goes when another page opens by the menu', async () => {
    open(dana);
    const field = (await screen.findByRole('combobox', { name: 'Search' })) as HTMLInputElement;
    fireEvent.change(field, { target: { value: 'hello' } });
    await screen.findByRole('listbox', { name: 'Search results' });
    fireEvent.click(screen.getByRole('link', { name: 'Runs' }));
    await waitFor(() => expect(field.value).toBe(''));
    expect(screen.queryByRole('listbox', { name: 'Search results' })).toBeNull();
  });
});

describe('focus and keys (AFS-142)', () => {
  it('Esc empties the field and closes the list; the cursor stays in the field', async () => {
    open(dana);
    const field = (await screen.findByRole('combobox', { name: 'Search' })) as HTMLInputElement;
    field.focus();
    fireEvent.change(field, { target: { value: 'audit' } });
    await screen.findByRole('listbox');
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(field.value).toBe('');
    expect(document.activeElement).toBe(field);
  });

  it('/ or Ctrl+K pressed in the designer frame puts the cursor in the field', async () => {
    open(dana);
    const field = await screen.findByRole('combobox', { name: 'Search' });
    // A message from elsewhere is not the frame.
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'afs-search-key' },
        origin: 'https://elsewhere.example',
      }),
    );
    expect(document.activeElement).not.toBe(field);
    await waitFor(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'afs-search-key' },
          origin: window.location.origin,
        }),
      );
      expect(document.activeElement).toBe(field);
    });
  });

  it('after a page change the focus is on the new page title', async () => {
    open(dana);
    routes['GET /workspaces'] = () => ({ body: [] });
    await screen.findByRole('heading', { name: 'Approvals' });
    fireEvent.click(screen.getByRole('link', { name: 'Workspaces' }));
    const title = await screen.findByRole('heading', { level: 1, name: 'Workspaces' });
    await waitFor(() => expect(document.activeElement).toBe(title));
  });

  it('the phone menu says it is open, and Esc closes it', async () => {
    open(dana);
    const toggle = await screen.findByRole('button', { name: 'Menu' });
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.textContent).toBe('Close menu');
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toBe('Menu');
    expect(document.activeElement).toBe(toggle);
  });
});
