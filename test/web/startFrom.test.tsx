// AFS-126: what an empty flow starts from, picked over the canvas, with the server played by the
// test: a sample, a playbook of the repository, an AWX template (after choosing the AWX), and the
// words when there is nothing to pick.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Draft } from '../../src/web/api';
import { StartFrom } from '../../src/web/startFrom';

const draft = {
  id: 'd1',
  project: 'p1',
  file: 'flows/new/new.flow.yaml',
  baseCommit: '9f2c1e7ab3d45c60e8a1f2b3c4d5e6f708192a3b',
  revision: 1,
  createdAt: '2026-11-18T09:00:00.000Z',
  updatedAt: '2026-11-18T09:00:00.000Z',
  editors: [],
} as Draft;

let asked: { key: string; body?: unknown }[];
let offered: unknown;
beforeEach(() => {
  asked = [];
  offered = {
    samples: [{ key: 'hello', name: 'Hello, Ansible', description: 'The smallest flow.' }],
    playbooks: ['site.yml', 'prechecks.yml'],
    awx: [{ id: 'c1', name: 'lab awx', url: 'https://awx.example.net' }],
  };
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const key = `${init.method ?? 'GET'} ${url.replace('/api/v1', '')}`;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    asked.push({ key, body });
    const answers: Record<string, unknown> = {
      'GET /drafts/d1/start-from': offered,
      'GET /drafts/d1/start-from/awx?credential=c1': {
        templates: [{ kind: 'job', id: 3, name: 'Edge baseline' }],
      },
      'POST /drafts/d1/start-from': { revision: 2, steps: 4, notes: [] },
    };
    const found = key in answers;
    return {
      ok: found,
      status: found ? 200 : 404,
      json: async () => (found ? answers[key] : { message: key }),
      text: async () => '',
    } as Response;
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const posted = () => asked.filter((a) => a.key === 'POST /drafts/d1/start-from').map((a) => a.body);

describe('starting an empty flow from something', () => {
  it('a sample', async () => {
    const done = vi.fn();
    render(<StartFrom draft={draft} what="sample" onDone={done} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Hello, Ansible' }));
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(posted()).toEqual([{ sample: 'hello' }]);
    expect(done.mock.calls[0]?.[0]).toMatch(/Hello, Ansible sample: 4 tasks became steps/);
  });

  it('a playbook of the repository', async () => {
    const done = vi.fn();
    render(<StartFrom draft={draft} what="playbooks" onDone={done} />);
    fireEvent.click(await screen.findByRole('button', { name: 'site.yml' }));
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(posted()).toEqual([{ playbook: 'site.yml' }]);
  });

  it('an AWX template, after choosing the AWX', async () => {
    const done = vi.fn();
    render(<StartFrom draft={draft} what="awx" onDone={done} />);
    fireEvent.change(await screen.findByLabelText('AWX'), { target: { value: 'c1' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Edge baseline' }));
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(posted()).toEqual([{ awx: { credential: 'c1', kind: 'job', id: 3 } }]);
  });

  it('says how to get something to pick when there is nothing', async () => {
    offered = { samples: [], playbooks: [], awx: [] };
    render(<StartFrom draft={draft} what="awx" onDone={() => undefined} />);
    expect(await screen.findByText(/no AWX credential/)).toBeTruthy();
    cleanup();
    render(<StartFrom draft={draft} what="playbooks" onDone={() => undefined} />);
    expect(await screen.findByText(/has no playbook yet/)).toBeTruthy();
  });
});
