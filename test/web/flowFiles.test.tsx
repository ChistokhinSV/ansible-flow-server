// AFS-109: a flow made, copied or deleted in the pages, each one commit (the files save).
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../../src/web/api';
import { copiedFlowText, FlowFileActions, keyOf, NewFlowForm } from '../../src/web/flowFiles';

const project = {
  id: 'p1',
  workspace: 'w1',
  key: 'edge',
  name: 'Edge switches',
  gitRef: 'main',
  commit: 'a'.repeat(40),
} as unknown as Project;
const FLOW = `schema_version: 2
flow:
  id: 01M7JQ53Z6FGM544A25BK8ZHMZ
  key: patch-web
  name: Patch web servers
  version: 4
  inputs:
    devices:
      type: host_list
nodes:
- id: 01M7JQ53Z73PPGSK4K54EEM7BN
  key: start
  type: start
`;

let saved: unknown[];
beforeEach(() => {
  saved = [];
  window.history.replaceState(null, '', '/w/net/edge');
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    if (url.includes('/files/content'))
      return { ok: true, status: 200, text: async () => FLOW } as Response;
    saved.push(JSON.parse(String(init.body)));
    return {
      ok: true,
      status: 200,
      json: async () => ({ branch: 'main', commit: 'b'.repeat(40), files: [] }),
    } as Response;
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('flows in the pages', () => {
  it('a copy gets its own id, key, name and version 1; the nodes stay', () => {
    const copy = copiedFlowText(FLOW, 'Patch db servers', 'patch-db', '01M7NEWIDNEWIDNEWIDNEWIDNE');
    expect(copy).toContain(
      '  id: 01M7NEWIDNEWIDNEWIDNEWIDNE\n  key: patch-db\n  name: "Patch db servers"\n  version: 1',
    );
    expect(copy).toContain('- id: 01M7JQ53Z73PPGSK4K54EEM7BN');
    expect(keyOf('Patch DB servers!')).toBe('patch-db-servers');
  });

  it('New flow writes the template at flows/<key>.flow.yaml and opens it', async () => {
    render(<NewFlowForm workspace="net" project={project} onCancel={() => undefined} />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Patch web servers' } });
    expect((screen.getByLabelText('File') as HTMLInputElement).value).toBe(
      'flows/patch-web-servers.flow.yaml',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Make the flow' }));
    await waitFor(() =>
      expect(window.location.pathname).toBe('/w/net/edge/flow/flows/patch-web-servers.flow.yaml'),
    );
    const body = saved[0] as {
      branch: string;
      message: string;
      changes: { op: string; path: string; text: string }[];
    };
    expect(body.branch).toBe('main');
    expect(body.message).toBe('Add the flow Patch web servers');
    expect(body.changes[0]).toMatchObject({
      op: 'write',
      path: 'flows/patch-web-servers.flow.yaml',
    });
    expect(body.changes[0]?.text).toMatch(/key: patch-web-servers\n {2}name: Patch web servers/);
  });

  it('Copy writes the copy beside it; Delete says who runs it and deletes the file', async () => {
    render(
      <FlowFileActions
        workspace="net"
        project={project}
        file="flows/patch-web.flow.yaml"
        name="Patch web servers"
        commit={project.commit as string}
        usedBy={['Nightly patch']}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Copy…' }));
    const copy = screen.getByRole('region', { name: 'Copy the flow' });
    fireEvent.change(within(copy).getByLabelText('Name'), {
      target: { value: 'Patch db servers' },
    });
    expect((within(copy).getByLabelText('File') as HTMLInputElement).value).toBe(
      'flows/patch-db-servers.flow.yaml',
    );
    fireEvent.click(within(copy).getByRole('button', { name: 'Make the copy' }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]).toMatchObject({
      changes: [{ op: 'write', path: 'flows/patch-db-servers.flow.yaml' }],
    });

    fireEvent.click(screen.getByRole('button', { name: 'Delete…' }));
    const del = screen.getByRole('region', { name: 'Delete the flow' });
    expect(del.textContent).toContain('Nightly patch');
    fireEvent.click(within(del).getByRole('button', { name: 'Delete the flow' }));
    await waitFor(() => expect(saved).toHaveLength(2));
    expect(saved[1]).toMatchObject({
      message: 'Delete the flow Patch web servers',
      changes: [{ op: 'delete', path: 'flows/patch-web.flow.yaml' }],
    });
  });
});
