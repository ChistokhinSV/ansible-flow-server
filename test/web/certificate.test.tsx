// The Server certificate page and banner (AFS-54), with the server played by the test: the
// certificate in use with its days left, a request made then downloadable, an install refused
// with every reason and then accepted, a rollback; administrators see a banner on every page while
// the certificate nears its end, and others never ask.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/web/app';

const dana = { id: 'u1', login: 'dana', name: 'Dana Reyes', admin: true, groups: [] };
const omar = { id: 'u2', login: 'omar', name: 'Omar Haddad', admin: false, groups: [] };
const info = (daysLeft: number, extra: Record<string, unknown> = {}) => ({
  subject: 'CN=flows.example.net',
  issuer: 'CN=flows.example.net',
  names: ['flows.example.net', 'localhost'],
  notBefore: '2026-01-01T00:00:00.000Z',
  notAfter: '2027-01-01T00:00:00.000Z',
  daysLeft,
  selfSigned: true,
  fingerprint: 'AA:BB:CC',
  chain: 0,
  ...extra,
});

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
const sent = (key: string) => asked.filter((a) => a.key === key).map((a) => a.body);

describe('the Server certificate page', () => {
  it('requests, refuses with every reason, installs, rolls back', async () => {
    let state: Record<string, unknown> = {
      tls: 'on',
      current: { source: 'self-signed', info: info(200) },
      host: 'flows.example.net',
      defaultNames: ['flows.example.net', 'localhost'],
    };
    routes = {
      'GET /session': () => ({ body: dana }),
      'GET /admin/certificate': () => ({ body: state }),
      'GET /admin/certificate/history': () => ({ body: [] }),
      'POST /admin/certificate/request': () => {
        state = { ...state, request: '-----BEGIN CERTIFICATE REQUEST-----' };
        return { status: 201, body: state };
      },
      'POST /admin/certificate/install': (body) => {
        if ((body as { certificate: string }).certificate === 'nonsense')
          return {
            status: 422,
            body: {
              error: 'refused',
              message: 'The certificate was not installed',
              problems: [
                'The private key does not belong to this certificate',
                'The certificate is not good for flows.example.net',
              ],
            },
          };
        state = {
          ...state,
          request: undefined,
          current: {
            source: 'installed',
            info: info(397, { selfSigned: false, issuer: 'CN=Example Issuing CA' }),
          },
          previous: info(200),
        };
        return { body: state };
      },
      'POST /admin/certificate/rollback': () => {
        state = { ...state, current: { source: 'self-signed', info: info(200) } };
        return { body: state };
      },
    };
    window.history.replaceState(null, '', '/admin/certificate');
    render(<App />);
    const inUse = (await screen.findByRole('heading', { name: 'In use' })).closest(
      'section',
    ) as HTMLElement;
    expect(within(inUse).getByText('200 days left')).toBeTruthy();
    expect(within(inUse).getByText('itself (self-signed)')).toBeTruthy();
    // No banner on this page, and none with 200 days left.
    expect(screen.queryByText(/The server certificate ends/)).toBeNull();

    fireEvent.change(screen.getByLabelText('Organization'), {
      target: { value: 'Example Networks' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Make the request' }));
    const link = await screen.findByRole('link', { name: 'Download the request' });
    expect(link.getAttribute('href')).toBe('/api/v1/admin/certificate/request.pem');
    expect(sent('POST /admin/certificate/request')).toEqual([
      { names: ['flows.example.net'], organization: 'Example Networks' },
    ]);

    const install = screen
      .getByRole('heading', { name: 'Install a certificate' })
      .closest('section') as HTMLElement;
    fireEvent.change(within(install).getByLabelText('Certificate'), {
      target: { value: 'nonsense' },
    });
    fireEvent.click(within(install).getByRole('button', { name: 'Install' }));
    const refusal = await within(install).findByRole('alert');
    expect(
      within(refusal)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([
      'The private key does not belong to this certificate',
      'The certificate is not good for flows.example.net',
    ]);

    fireEvent.change(within(install).getByLabelText('Certificate'), {
      target: { value: '-----BEGIN CERTIFICATE-----signed' },
    });
    fireEvent.click(within(install).getByRole('button', { name: 'Install' }));
    await screen.findByText(/Installed\. New connections get the certificate now/);
    expect(within(inUse).getByText('CN=Example Issuing CA')).toBeTruthy();
    // No key given: the server answers the request with its own key.
    expect(sent('POST /admin/certificate/install').at(-1)).toEqual({
      certificate: '-----BEGIN CERTIFICATE-----signed',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Roll back to it' }));
    await screen.findByText(/Done\. New connections/);
    expect(sent('POST /admin/certificate/rollback')).toHaveLength(1);
  });

  it('warns administrators on every page when the end is near; others are never asked', async () => {
    routes = {
      'GET /session': () => ({ body: dana }),
      'GET /admin/certificate': () => ({
        body: { tls: 'on', current: { source: 'installed', info: info(12) }, defaultNames: [] },
      }),
      'GET /approvals': () => ({ body: [] }),
    };
    window.history.replaceState(null, '', '/approvals');
    render(<App />);
    const banner = await screen.findByText(/The server certificate ends in 12 days/);
    expect(within(banner).getByRole('link', { name: 'Replace it' }).getAttribute('href')).toBe(
      '/admin/certificate',
    );

    cleanup();
    asked = [];
    routes = { 'GET /session': () => ({ body: omar }), 'GET /approvals': () => ({ body: [] }) };
    render(<App />);
    await screen.findByRole('heading', { name: 'Approvals' });
    expect(asked.some((a) => a.key.startsWith('GET /admin/certificate'))).toBe(false);
  });
});
