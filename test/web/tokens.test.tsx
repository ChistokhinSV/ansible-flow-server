// Access tokens on My account (AFS-88), with the server played by the test: the list comes first,
// the form to make one opens from a button, and once a token is made the form closes and the token
// is shown this once.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Account } from '../../src/web/account';

const omar = {
  id: 'u2',
  login: 'omar',
  name: 'Omar Haddad',
  admin: false,
  groups: [],
  disabled: false,
  service: false,
  createdAt: '2026-01-12T08:15:00.000Z',
};
const made = {
  id: 't1',
  name: 'laptop git',
  hint: 'Xk3Q',
  readOnly: false,
  createdAt: '2026-11-13T09:44:37.512Z',
  expiresAt: '2027-02-11T09:44:37.512Z',
};

let asked: { key: string; body?: unknown }[];
let routes: Record<string, (body?: unknown) => { status?: number; body?: unknown }>;
beforeEach(() => {
  asked = [];
  vi.stubGlobal('confirm', () => true);
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const key = `${init.method ?? 'GET'} ${url.replace('/api/v1', '')}`;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    asked.push({ key, body });
    const answer = routes[key]?.(body) ?? {
      status: 404,
      body: { error: 'not_found', message: key },
    };
    const status = answer.status ?? 200;
    return { ok: status < 300, status, json: async () => answer.body } as Response;
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('My account', () => {
  it('shows the profile or the tokens, as the tab says', async () => {
    routes = { 'GET /tokens': () => ({ body: [made] }), 'GET /workspaces': () => ({ body: [] }) };
    render(<Account me={omar} tab="profile" />);
    const tabs = screen.getByRole('navigation', { name: 'My account' });
    const profile = within(tabs).getByRole('link', { name: 'Profile' });
    expect(profile.getAttribute('href')).toBe('/account');
    expect(profile.getAttribute('aria-current')).toBe('page');
    const tokens = within(tabs).getByRole('link', { name: /Access tokens/ });
    expect(tokens.getAttribute('href')).toBe('/account/tokens');
    // How many tokens there are is on the tab.
    await waitFor(() => expect(tokens.textContent).toBe('Access tokens1'));
    expect(screen.getByLabelText('Display name')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Make a token' })).toBeNull();

    cleanup();
    render(<Account me={omar} tab="tokens" />);
    await screen.findByText('…Xk3Q');
    expect(screen.queryByLabelText('Display name')).toBeNull();
  });

  it('Last used follows a use elsewhere when the page is looked at again (AFS-139)', async () => {
    let used: string | undefined;
    routes = {
      'GET /tokens': () => ({ body: [{ ...made, ...(used ? { lastUsedAt: used } : {}) }] }),
      'GET /workspaces': () => ({ body: [] }),
    };
    render(<Account me={omar} tab="tokens" />);
    const row = (await screen.findByText('…Xk3Q')).closest('tr') as HTMLElement;
    expect(within(row).getByText('never')).toBeTruthy();
    used = '2026-11-18T09:00:00.000Z';
    fireEvent.focus(window);
    await waitFor(() => expect(within(row).queryByText('never')).toBeNull());
    expect(
      within(row).getByText(
        (_, el) => el?.tagName === 'TIME' && el.getAttribute('datetime') === used,
      ),
    ).toBeTruthy();
  });

  it('makes a token from a button: the form closes and the token is shown once', async () => {
    let have: unknown[] = [];
    routes = {
      'GET /tokens': () => ({ body: have }),
      'GET /workspaces': () => ({ body: [] }),
      'POST /tokens': () => {
        have = [made];
        return { status: 201, body: { ...made, token: 'afs_example-token' } };
      },
      'DELETE /tokens/t1': () => {
        have = [];
        return { status: 204 };
      },
    };
    render(<Account me={omar} tab="tokens" />);
    await screen.findByText('You have no token.');
    // The list first: no form until it is asked for.
    expect(screen.queryByLabelText('Name')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Make a token' }));
    const sheet = screen.getByRole('region', { name: 'Make a token' });
    expect(screen.queryByRole('button', { name: 'Make a token' })).toBeNull();

    // Cancel closes it and nothing is sent.
    fireEvent.click(within(sheet).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('Name')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Make a token' }));

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'laptop git' } });
    fireEvent.click(screen.getByRole('button', { name: 'Make token' }));
    expect((await screen.findByRole('status')).textContent).toContain('afs_example-token');
    expect(asked.find((a) => a.key === 'POST /tokens')?.body).toEqual({
      name: 'laptop git',
      expiresInDays: 90,
      readOnly: false,
    });
    // The form is gone, the button is back, the token is in the list and counted on the tab.
    expect(screen.queryByLabelText('Name')).toBeNull();
    expect(screen.getByRole('button', { name: 'Make a token' })).toBeTruthy();
    await screen.findByText('…Xk3Q');
    const tab = screen.getByRole('link', { name: /Access tokens/ });
    await waitFor(() => expect(tab.textContent).toBe('Access tokens1'));

    fireEvent.click(screen.getByRole('button', { name: 'I have copied it' }));
    expect(document.body.textContent).not.toContain('afs_example-token');

    fireEvent.click(screen.getByRole('button', { name: 'Revoke laptop git' }));
    await screen.findByText('You have no token.');
    await waitFor(() => expect(tab.textContent).toBe('Access tokens0'));
    // AFS-194: a note says it is done.
    expect(screen.getByText('Revoked the token "laptop git": it no longer works.')).toBeTruthy();
  });
});
