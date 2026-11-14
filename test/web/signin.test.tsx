// Sign-in with OIDC providers on the pages (AFS-30), with the server played by the test: the
// sign-in page offers the providers and says why the last sign-in failed; an administrator adds
// a provider with what its groups claim means here, sees the address to register, tests it, and
// keeps passwords for administrators only.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/web/app';

const dana = { id: 'u1', login: 'dana', name: 'Dana Whitfield', admin: true, groups: [] };
const netops = { id: 'g1', name: 'netops', members: [] };
const keycloak = {
  id: 'p1',
  key: 'keycloak',
  name: 'Keycloak',
  issuer: 'https://login.example.net/realms/net',
  clientId: 'flows',
  hasSecret: true,
  scopes: 'openid profile email',
  groupsClaim: 'groups',
  loginClaim: 'preferred_username',
  enabled: true,
  mappings: [
    { value: '/netops', group: 'g1' },
    { value: 'flows-admins', admin: true },
  ],
  createdAt: '2026-11-14T09:00:00.000Z',
  updatedAt: '2026-11-14T09:00:00.000Z',
  redirectUri: 'https://flows.example.net/api/v1/auth/oidc/keycloak/callback',
};

let asked: { key: string; body?: unknown }[];
let routes: Record<string, (body?: unknown) => { status?: number; body?: unknown }>;
beforeEach(() => {
  asked = [];
  window.scrollTo = () => undefined;
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

describe('sign-in with a provider', () => {
  it('the sign-in page offers the providers and says why the last one failed', async () => {
    routes = {
      'GET /session': () => ({
        status: 401,
        body: { error: 'unauthorized', message: 'Sign in first' },
      }),
      'GET /setup': () => ({ body: { needed: false } }),
      'GET /auth/methods': () => ({
        body: { local: 'admins', providers: [{ key: 'keycloak', name: 'Keycloak' }] },
      }),
    };
    window.history.replaceState(null, '', '/signin?error=This%20sign-in%20has%20expired');
    render(<App />);
    const go = await screen.findByRole('link', { name: 'Sign in with Keycloak' });
    expect(go.getAttribute('href')).toBe('/api/v1/auth/oidc/keycloak/start?return=%2F');
    expect(screen.getByRole('alert').textContent).toContain('This sign-in has expired');
    expect(screen.getByText(/password is for administrators only/)).toBeTruthy();
  });

  it('an administrator adds a provider with its groups, sees what to register, and tests it', async () => {
    let providers: unknown[] = [];
    routes = {
      'GET /session': () => ({ body: dana }),
      'GET /approvals': () => ({ body: [] }),
      'GET /admin/oidc-providers': () => ({ body: providers }),
      'GET /groups': () => ({ body: [netops] }),
      'GET /admin/sign-in': () => ({ body: { local: 'all' } }),
      'POST /admin/oidc-providers': () => {
        providers = [keycloak];
        return { status: 201, body: keycloak };
      },
      'POST /admin/oidc-providers/p1/test': () => ({
        body: { ok: true, issuer: keycloak.issuer, pkce: true },
      }),
      'PUT /admin/sign-in': (body) => ({ body }),
    };
    window.history.replaceState(null, '', '/admin/sign-in');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add a provider' }));
    const form = screen.getByRole('region', { name: 'Add a provider' });
    const type = (label: RegExp, value: string) =>
      fireEvent.change(within(form).getByLabelText(label), { target: { value } });
    type(/^Name/, 'Keycloak');
    type(/^Key/, 'keycloak');
    type(/^Issuer/, keycloak.issuer);
    type(/^Client id/, 'flows');
    type(/^Client secret/, 's3cret-client');
    expect((within(form).getByLabelText(/^Client secret/) as HTMLInputElement).type).toBe(
      'password',
    );
    fireEvent.click(within(form).getByRole('button', { name: 'Add a value' }));
    type(/^Claim value/, '/netops');
    fireEvent.change(within(form).getByLabelText('Here'), { target: { value: 'g1' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add' }));

    const card = await screen.findByRole('article', { name: 'Keycloak' });
    expect(within(card).getByText(keycloak.redirectUri)).toBeTruthy();
    expect(within(card).getByText(/\/netops → netops; flows-admins → administrator/)).toBeTruthy();
    expect(asked.find((a) => a.key === 'POST /admin/oidc-providers')?.body).toMatchObject({
      key: 'keycloak',
      issuer: keycloak.issuer,
      clientSecret: 's3cret-client',
      mappings: [{ value: '/netops', group: 'g1' }],
    });

    fireEvent.click(within(card).getByRole('button', { name: 'Test' }));
    expect(await within(card).findByText(/It answers: https:\/\/login.example.net/)).toBeTruthy();

    // Passwords for administrators only.
    fireEvent.click(screen.getByLabelText(/Administrators only/));
    await waitFor(() =>
      expect(asked.find((a) => a.key === 'PUT /admin/sign-in')?.body).toEqual({ local: 'admins' }),
    );
  });
});
