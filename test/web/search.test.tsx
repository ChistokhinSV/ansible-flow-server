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
    fireEvent.keyDown(window, { key: '/' });
    expect(document.activeElement).toBe(field);
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
