// The Notifications page, with the server played by the test: the mail server form (the password
// kept unless a new one is typed), a webhook key shown once, and the delivery log with a retry.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/web/app';

const dana = { id: 'u1', login: 'dana', name: 'Dana Reyes', admin: true, groups: [] };

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

describe('the Notifications page', () => {
  it('sets the mail server, makes a webhook key shown once, and retries a message given up on', async () => {
    let settings: Record<string, unknown> = { webhookKey: false };
    let log = [
      {
        id: 'd1',
        event: 'approval.waiting',
        channel: 'webhook',
        recipient: 'omar',
        target: 'https://hooks.example.net/…',
        subject: 'Approval waits: Approve the change - Firewall upgrade, run 7',
        run: 'r1',
        status: 'failed',
        attempts: 6,
        lastError: 'HTTP 503: Service Unavailable',
        createdAt: '2026-11-13T10:00:00.000Z',
      },
    ];
    routes = {
      'GET /session': () => ({ body: dana }),
      'GET /notifications/settings': () => ({ body: settings }),
      'GET /notifications?': () => ({ body: log }),
      'PUT /notifications/smtp': (body) => {
        settings = {
          ...settings,
          smtp: { ...(body as object), port: 587, hasPassword: true },
        };
        return { body: settings };
      },
      'POST /notifications/webhook-key': () => {
        settings = { ...settings, webhookKey: true };
        return { status: 201, body: { key: 'afs_whk_example-key' } };
      },
      'POST /notifications/d1/retry': () => {
        log = [{ ...log[0], status: 'pending', attempts: 0 } as (typeof log)[number]];
        return { status: 204 };
      },
    };
    window.history.replaceState(null, '', '/admin/notifications');
    render(<App />);

    const mail = (await screen.findByRole('heading', { name: 'Email' })).closest(
      'section',
    ) as HTMLElement;
    expect(within(mail).getByText(/No mail server yet/)).toBeTruthy();
    fireEvent.change(within(mail).getByLabelText('Mail server'), {
      target: { value: 'mail.example.net' },
    });
    fireEvent.change(within(mail).getByLabelText('Sender'), {
      target: { value: 'Flow Server <flows@example.net>' },
    });
    fireEvent.change(within(mail).getByLabelText('Password'), { target: { value: 'relay-pw' } });
    fireEvent.click(within(mail).getByRole('button', { name: 'Save the mail server' }));
    await waitFor(() =>
      expect(asked.find((a) => a.key === 'PUT /notifications/smtp')?.body).toMatchObject({
        host: 'mail.example.net',
        security: 'starttls',
        password: 'relay-pw',
        from: 'Flow Server <flows@example.net>',
      }),
    );
    expect(await within(mail).findByText('Kept. Type a new one to replace it.')).toBeTruthy();

    const hooks = screen
      .getByRole('heading', { name: 'Webhooks' })
      .closest('section') as HTMLElement;
    fireEvent.click(within(hooks).getByRole('button', { name: 'Make a key' }));
    expect(await within(hooks).findByText('afs_whk_example-key')).toBeTruthy();

    const row = (await screen.findByText('HTTP 503: Service Unavailable')).closest(
      'tr',
    ) as HTMLElement;
    expect(within(row).getByText('given up')).toBeTruthy();
    fireEvent.click(within(row).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByText('being tried')).toBeTruthy());
  });
});

describe('the profile on My account', () => {
  const omar = {
    id: 'u2',
    login: 'omar',
    name: 'Omar Haddad',
    admin: false,
    groups: [],
    email: 'omar@example.net',
    webhookUrl: 'https://hooks.example.net/services/T000/secret',
  };
  const shared = (me: object) => ({
    'GET /session': () => ({ body: me }),
    'GET /tokens': () => ({ body: [] }),
    'GET /workspaces': () => ({ body: [] }),
    'PATCH /session': (body?: unknown) => ({ body: { ...me, ...(body as object) } }),
  });

  it('a person changes their own email; their webhook is shown by its host, set by an administrator', async () => {
    routes = shared(omar);
    window.history.replaceState(null, '', '/account');
    render(<App />);
    const profile = (await screen.findByRole('heading', { name: 'Profile' })).closest(
      'section',
    ) as HTMLElement;
    expect(within(profile).getByText('https://hooks.example.net/…')).toBeTruthy();
    expect(within(profile).queryByLabelText('Webhook')).toBeNull();
    expect(profile.textContent).not.toContain('secret');
    fireEvent.change(within(profile).getByLabelText('Email address'), {
      target: { value: 'omar.haddad@example.net' },
    });
    fireEvent.click(within(profile).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(asked.find((a) => a.key === 'PATCH /session')?.body).toEqual({
        name: 'Omar Haddad',
        email: 'omar.haddad@example.net',
      }),
    );
    expect(await within(profile).findByText('Saved.')).toBeTruthy();
  });

  it('an administrator sets their webhook there too', async () => {
    routes = shared({ ...dana, email: 'dana@example.net' });
    window.history.replaceState(null, '', '/account');
    render(<App />);
    const field = await screen.findByLabelText('Webhook');
    fireEvent.change(field, { target: { value: 'https://hooks.example.net/dana' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(asked.find((a) => a.key === 'PATCH /session')?.body).toMatchObject({
        webhookUrl: 'https://hooks.example.net/dana',
      }),
    );
  });
});
