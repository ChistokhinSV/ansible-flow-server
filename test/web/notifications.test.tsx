// The Notifications page, with the server played by the test: the delivery log first, with a
// retry, and on the Settings tab the mail server form (the password kept unless a new one is
// typed) and a webhook key shown once (AFS-88). The tabs are shown as the page is given them:
// which address is which tab is the application's.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/web/app';
import { NotificationsPage } from '../../src/web/notifications';
import { mayLeave } from '../../src/web/router';

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

    // The log is what the page opens on: how sending stands in a line, then the messages.
    const tabs = await screen.findByRole('navigation', { name: 'Notifications' });
    const logTab = within(tabs).getByRole('link', { name: /Delivery log/ });
    expect(logTab.getAttribute('href')).toBe('/admin/notifications');
    expect(logTab.getAttribute('aria-current')).toBe('page');
    expect(within(tabs).getByRole('link', { name: 'Settings' }).getAttribute('href')).toBe(
      '/admin/notifications/settings',
    );
    const standing = (await screen.findByText(/Email is not set up/)).closest('p') as HTMLElement;
    expect(standing.textContent).toContain('Webhooks are not signed');
    expect(within(standing).getByRole('link', { name: 'Set it up' }).getAttribute('href')).toBe(
      '/admin/notifications/settings',
    );
    expect(screen.getByLabelText('Status')).toBeTruthy();
    await screen.findByText('HTTP 503: Service Unavailable');
    // A message given up on marks the tab.
    expect(await within(logTab).findByRole('img', { name: 'needs a look' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Email' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send a test' })).toBeNull();

    cleanup();
    render(<NotificationsPage tab="settings" />);
    expect(
      within(screen.getByRole('navigation', { name: 'Notifications' }))
        .getByRole('link', { name: 'Settings' })
        .getAttribute('aria-current'),
    ).toBe('page');
    expect(screen.queryByLabelText('Status')).toBeNull();
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
    expect(screen.getByRole('button', { name: 'Send a test' })).toBeTruthy();
    // AFS-150: an address typed for a test is not kept anywhere: leaving does not ask.
    const test = screen.getByRole('heading', { name: 'Test' }).closest('section') as HTMLElement;
    fireEvent.change(within(test).getByLabelText('To'), { target: { value: 'a8@example.net' } });
    const questions: string[] = [];
    vi.stubGlobal('confirm', (text: string) => {
      questions.push(text);
      return false;
    });
    expect(mayLeave('/runs')).toBe(true);
    expect(questions).toEqual([]);

    cleanup();
    render(<NotificationsPage tab="log" />);
    expect(await screen.findByText('Email goes through mail.example.net')).toBeTruthy();
    expect(screen.getByText('Webhooks are signed')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Set it up' })).toBeNull();
    const row = (await screen.findByText('HTTP 503: Service Unavailable')).closest(
      'tr',
    ) as HTMLElement;
    expect(within(row).getByText('given up')).toBeTruthy();
    fireEvent.click(within(row).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(within(row).getByText('being tried')).toBeTruthy());
    // Nothing is given up on any more: the mark goes.
    await waitFor(() => expect(screen.queryByRole('img', { name: 'needs a look' })).toBeNull());
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

  it('Turn email off says what it does and asks first (AFS-153)', async () => {
    let settings: Record<string, unknown> = {
      webhookKey: false,
      smtp: { host: 'smtp.example.net', port: 587, security: 'starttls', from: 'afs@example.net' },
    };
    let answer = false;
    const questions: string[] = [];
    vi.stubGlobal('confirm', (q: string) => {
      questions.push(q);
      return answer;
    });
    routes = {
      'GET /session': () => ({ body: dana }),
      'GET /notifications/settings': () => ({ body: settings }),
      'DELETE /notifications/smtp': () => {
        settings = { webhookKey: false };
        return { status: 204 };
      },
    };
    window.history.replaceState(null, '', '/admin/notifications/settings');
    render(<App />);
    const off = await screen.findByRole('button', { name: 'Turn email off' });
    expect(off.getAttribute('title')).toMatch(/sends no email to anyone/);
    fireEvent.click(off);
    expect(questions[0]).toMatch(/for the whole server/);
    expect(asked.some((a) => a.key === 'DELETE /notifications/smtp')).toBe(false);
    answer = true;
    fireEvent.click(off);
    await screen.findByText(/No mail server yet/);
    expect(asked.filter((a) => a.key === 'DELETE /notifications/smtp')).toHaveLength(1);
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
