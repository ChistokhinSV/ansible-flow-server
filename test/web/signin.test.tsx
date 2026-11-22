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
      'GET /admin/ldap-directories': () => ({ body: [] }),
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
    // AFS-195: the form opened takes the focus.
    expect(document.activeElement).toBe(within(form).getByLabelText(/^Name/));
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

  it('an administrator adds an Active Directory from its preset, tests a login and syncs', async () => {
    const ad = {
      id: 'd1',
      key: 'corp-ad',
      name: 'Corp AD',
      position: 0,
      url: 'ldaps://dc1.corp.example.net',
      startTls: false,
      bindDn: 'CN=svc-flows,OU=Services,DC=corp,DC=example,DC=net',
      hasBindPassword: true,
      userBase: 'OU=Staff,DC=corp,DC=example,DC=net',
      userFilter: '(&(objectCategory=person)(objectClass=user)(sAMAccountName={login}))',
      idAttr: 'objectGUID',
      loginAttr: 'sAMAccountName',
      nameAttr: 'displayName',
      emailAttr: 'mail',
      groupMode: 'search',
      groupBase: 'DC=corp,DC=example,DC=net',
      groupFilter: '(&(objectClass=group)(member:1.2.840.113556.1.4.1941:={dn}))',
      adDisabled: true,
      syncMinutes: 60,
      enabled: true,
      mappings: [{ value: 'netops', group: 'g1' }],
      createdAt: '2026-11-14T09:00:00.000Z',
      updatedAt: '2026-11-14T09:00:00.000Z',
    };
    let directories: unknown[] = [];
    routes = {
      'GET /session': () => ({ body: dana }),
      'GET /approvals': () => ({ body: [] }),
      'GET /admin/oidc-providers': () => ({ body: [] }),
      'GET /admin/ldap-directories': () => ({ body: directories }),
      'GET /groups': () => ({ body: [netops] }),
      'GET /admin/sign-in': () => ({ body: { local: 'all' } }),
      'POST /admin/ldap-directories': () => {
        directories = [ad];
        return { status: 201, body: ad };
      },
      'POST /admin/ldap-directories/d1/test': () => ({
        body: {
          ok: true,
          message: 'It answers; the service account searches',
          person: {
            dn: 'CN=Mia Ortega,OU=Staff,DC=corp,DC=example,DC=net',
            name: 'Mia Ortega',
            disabled: false,
            groups: ['CN=netops,OU=Groups,DC=corp,DC=example,DC=net'],
            mapped: ['netops'],
          },
        },
      }),
      'POST /admin/ldap-directories/d1/sync': () => ({
        body: { checked: 4, disabled: 1, message: '4 people checked; 1 disabled' },
      }),
    };
    window.history.replaceState(null, '', '/admin/sign-in');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add a directory' }));
    const form = screen.getByRole('region', { name: 'Add a directory' });
    // AFS-156: the form takes the focus, on its first field.
    expect(document.activeElement).toBe(within(form).getByLabelText('Kind'));
    const type = (label: RegExp, value: string) =>
      fireEvent.change(within(form).getByLabelText(label), { target: { value } });
    // The Active Directory preset fills the filters.
    expect((within(form).getByLabelText(/^Person filter/) as HTMLInputElement).value).toContain(
      'sAMAccountName={login}',
    );
    type(/^Name(?! attribute)/, 'Corp AD');
    type(/^Key/, 'corp-ad');
    type(/^Address/, ad.url);
    type(/^Service account DN/, ad.bindDn);
    type(/^Service account password/, 'svc-s3cret');
    type(/^Where people are/, ad.userBase);
    type(/^Where groups are/, ad.groupBase);
    fireEvent.click(within(form).getByRole('button', { name: 'Add a value' }));
    type(/^Directory group/, 'netops');
    fireEvent.change(within(form).getByLabelText('Here'), { target: { value: 'g1' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add' }));

    const card = await screen.findByRole('article', { name: 'Corp AD' });
    expect(asked.find((a) => a.key === 'POST /admin/ldap-directories')?.body).toMatchObject({
      key: 'corp-ad',
      bindPassword: 'svc-s3cret',
      idAttr: 'objectGUID',
      adDisabled: true,
      mappings: [{ value: 'netops', group: 'g1' }],
    });
    fireEvent.change(within(card).getByLabelText(/^Test with a login/), {
      target: { value: 'mia' },
    });
    fireEvent.click(within(card).getByRole('button', { name: 'Test' }));
    expect(await within(card).findByText(/OU=Staff/)).toBeTruthy();
    expect(asked.find((a) => a.key === 'POST /admin/ldap-directories/d1/test')?.body).toEqual({
      login: 'mia',
    });
    fireEvent.click(within(card).getByRole('button', { name: 'Sync now' }));
    expect(await within(card).findByText('4 people checked; 1 disabled')).toBeTruthy();
  });
});
