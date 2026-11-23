// AFS-201: an action is changed on its own page (/actions/<id>/edit): its settings, the full link
// with values (checked by the link's own question, which runs nothing), and who may run it. The
// launch configuration's Settings keep one line leading there; a runner copies a link with the
// values they filled in.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigActionLine } from '../../src/web/actionEdit';
import { linkWithValues } from '../../src/web/actions';
import { App } from '../../src/web/app';

const wanda = { id: 'u1', login: 'wanda', name: 'Wanda Rossi', admin: false, groups: [] };
const action = {
  id: 'c1',
  title: 'Restart the edge switch',
  summary: 'Restarts one edge switch and checks it answers again.',
  asked: [
    { name: 'devices', label: 'Switch', choices: ['sw-edge-01', 'sw-edge-02'] },
    { name: 'reason', label: 'Why', help: 'A ticket number is enough.' },
  ],
  mode: 'real',
  confirm: true,
  enabled: true,
  updatedAt: '',
};
const place = {
  workspaceKey: 'net',
  workspaceName: 'Network',
  projectKey: 'core',
  configName: 'Edge restart',
  flowFile: 'restart.flow.yaml',
};
const launchForm = {
  commit: 'a'.repeat(40),
  mode: 'real',
  fields: [
    { name: 'devices', type: 'host_list', secret: false, text: '' },
    { name: 'reason', type: 'string', secret: false, text: '' },
    { name: 'wait_s', type: 'int', secret: false, text: '30' },
    { name: 'api_token', type: 'string', secret: true, text: '' },
  ],
};

let asked: { key: string; body?: unknown }[];
let routes: Record<string, (body?: unknown) => { status?: number; body?: unknown }>;
beforeEach(() => {
  asked = [];
  window.scrollTo = () => undefined;
  vi.stubGlobal(
    'EventSource',
    class {
      addEventListener() {}
      close() {}
    },
  );
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

const linkAnswer = (query: string) => {
  const values = Object.fromEntries(new URLSearchParams(query));
  const missing = ['devices', 'reason'].filter((n) => !values[n]);
  return {
    form: { id: 'c1', fields: [] },
    values,
    given: Object.keys(values),
    missing,
    problems:
      values.devices === 'sw-core-01' ? [{ field: 'devices', message: 'Pick a switch' }] : [],
    ready: missing.length === 0,
  };
};

const pageRoutes = (mayManage: boolean) => ({
  'GET /session': () => ({ body: wanda }),
  'GET /workspaces': () => ({ body: [{ key: 'net', name: 'Network' }] }),
  'GET /workspaces/net/projects': () => ({ body: [{ key: 'core', name: 'Core network' }] }),
  'GET /actions': () => ({ body: [] }),
  'GET /approvals': () => ({ body: [] }),
  'GET /launch-configs/c1/action': () => ({
    body: {
      action,
      place,
      mayManage,
      ...(mayManage ? { grants: [], tokens: [], people: { users: [], groups: [] } } : {}),
    },
  }),
  'GET /launch-configs/c1/form?': () => ({ body: launchForm }),
  'GET /workspaces/net/credentials': () => ({ body: [] }),
});

describe("an action's own page", () => {
  it('shows its settings, the values it runs with, the links and who may run it', async () => {
    routes = {
      ...pageRoutes(true),
      'GET /actions/c1/link': () => ({ body: linkAnswer('') }),
    };
    for (const q of [
      'devices=sw-edge-02',
      'devices=sw-edge-02&reason=CHG-1042',
      'devices=sw-core-01&reason=CHG-1042',
    ])
      routes[`GET /actions/c1/link?${q}`] = () => ({ body: linkAnswer(q) });
    window.history.replaceState(null, '', '/actions/c1/edit');
    render(<App />);
    expect(await screen.findByRole('heading', { level: 1, name: action.title })).toBeTruthy();
    // Where it is: the crumbs lead back to its configuration.
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(crumbs.textContent).toContain('Edge restart');
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeTruthy();
    // The inputs it does not ask run with the configuration's values; a secret is never shown.
    await screen.findByText('Runs with');
    expect(document.body.textContent).toContain('wait_s = 30');
    expect(document.body.textContent).toContain("(secret, the configuration's)");
    expect(screen.getByRole('heading', { name: 'Who may run it' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Links from NetBox and Zabbix' })).toBeTruthy();

    // The link with values: the empty ones are left for the person; it says what they see.
    expect(await screen.findByText(/The short form, asking only for Switch, Why/)).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox', { name: 'Switch' }), {
      target: { value: 'sw-edge-02' },
    });
    expect(await screen.findByText(/The short form, asking only for Why\./)).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Why' }), {
      target: { value: 'CHG-1042' },
    });
    expect(await screen.findByText(/A confirm page with these values and Run/)).toBeTruthy();
    expect(document.body.textContent).toContain(
      `${window.location.origin}/a/c1?devices=sw-edge-02&reason=CHG-1042`,
    );
    // Nothing ran: only the link's own question was asked.
    expect(asked.some((a) => a.key.startsWith('POST /actions'))).toBe(false);
  });

  it('says a wrong value at its field, as the form would', async () => {
    routes = {
      ...pageRoutes(true),
      'GET /actions/c1/link': () => ({ body: linkAnswer('') }),
      'GET /actions/c1/link?reason=x': () => ({
        body: {
          ...linkAnswer('reason=x'),
          problems: [{ field: 'reason', message: 'Why: at most 80 characters' }],
        },
      }),
    };
    window.history.replaceState(null, '', '/actions/c1/edit');
    render(<App />);
    fireEvent.change(await screen.findByRole('textbox', { name: 'Why' }), {
      target: { value: 'x' },
    });
    expect(await screen.findByText('Why: at most 80 characters')).toBeTruthy();
    expect(await screen.findByText(/A value is not right/)).toBeTruthy();
  });

  it('read only for who may see the flow but not change it', async () => {
    routes = pageRoutes(false);
    window.history.replaceState(null, '', '/actions/c1/edit');
    render(<App />);
    expect(await screen.findByText(/Changing it needs rw on the workspace Network/)).toBeTruthy();
    await screen.findByRole('heading', { name: 'Settings' });
    expect(screen.queryByRole('button', { name: 'Change the action' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Who may run it' })).toBeNull();
  });

  it('refused for who may not see where it is', async () => {
    routes = {
      ...pageRoutes(false),
      'GET /launch-configs/c1/action': () => ({ body: { action, mayManage: false } }),
    };
    window.history.replaceState(null, '', '/actions/c1/edit');
    render(<App />);
    expect(await screen.findByText(/No such action, or it is not yours to see/)).toBeTruthy();
  });

  it('an empty sentence is said by the field\'s label, not "Summary"', async () => {
    routes = pageRoutes(true);
    window.history.replaceState(null, '', '/actions/c1/edit');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Change the action' }));
    fireEvent.change(screen.getByRole('textbox', { name: /What it does/ }), {
      target: { value: '  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save the action' }));
    expect(await screen.findByText(/What it does is needed/)).toBeTruthy();
    expect(asked.some((a) => a.key === 'PUT /launch-configs/c1/action')).toBe(false);
  });
});

describe("a launch configuration's Settings", () => {
  it('keep one line that leads to the action', async () => {
    routes = { 'GET /launch-configs/c1/action': () => ({ body: { action, mayManage: true } }) };
    render(<ConfigActionLine config="c1" />);
    const to = await screen.findByRole('link', { name: 'its own page' });
    expect(to.getAttribute('href')).toBe('/actions/c1/edit');
    expect(screen.queryByRole('button', { name: 'Change the action' })).toBeNull();
  });

  it('offer to make one, for who may', async () => {
    routes = {
      'GET /launch-configs/c1/action': () => ({ body: { action: null, mayManage: true } }),
    };
    render(<ConfigActionLine config="c1" />);
    const to = await screen.findByRole('link', { name: 'Make it an action' });
    expect(to.getAttribute('href')).toBe('/actions/c1/edit');
  });
});

describe('a runner', () => {
  it('copies a link with the values they filled in', async () => {
    const copied: string[] = [];
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText: async (t: string) => void copied.push(t) },
    });
    routes = {
      'GET /session': () => ({ body: wanda }),
      'GET /workspaces': () => ({ body: [] }),
      'GET /actions': () => ({ body: [] }),
      'GET /approvals': () => ({ body: [] }),
      'GET /actions/c1': () => ({
        body: {
          id: 'c1',
          title: action.title,
          summary: action.summary,
          mode: 'real',
          confirm: true,
          fields: [
            { name: 'reason', label: 'Why', type: 'string', required: true, text: '' },
            { name: 'site', label: 'Site', type: 'string', required: false, text: '' },
          ],
          happens: [],
          ask: [],
          editPage: '/actions/c1/edit',
        },
      }),
    };
    window.history.replaceState(null, '', '/actions/c1');
    render(<App />);
    fireEvent.change(await screen.findByRole('textbox', { name: /Why/ }), {
      target: { value: 'CHG 1042 & more' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Copy a link with these values' }));
    expect(await screen.findByText(/Copied: the link opens this action/)).toBeTruthy();
    expect(copied).toEqual([`${window.location.origin}/a/c1?reason=CHG+1042+%26+more`]);
    // Who may change it finds its page from the form.
    expect(screen.getByRole('link', { name: 'Change this action' }).getAttribute('href')).toBe(
      '/actions/c1/edit',
    );
  });

  it('a link leaves out the empty values and has no query when none is given', () => {
    expect(linkWithValues('https://afs.example.net', 'c 1', { a: ' ', b: 'x' })).toBe(
      'https://afs.example.net/a/c%201?b=x',
    );
    expect(linkWithValues('https://afs.example.net', 'c1', {})).toBe(
      'https://afs.example.net/a/c1',
    );
  });
});
