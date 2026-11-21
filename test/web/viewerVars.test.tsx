// AFS-183: the pages' canvas gets the repository's variables (where a value comes from): the
// inventory the flow's runs use, the index posted to the designer for the commit shown, the
// snapshot's findings with the repository's part, and a definition's file:line opened on the Files
// tab at that line.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { samplesDir } from '@ansible-flow/assets';
import { parseFlow } from '@ansible-flow/core/flow/document';
import type { VarIndex } from '@ansible-flow/core/inventory/varIndex';
import type { HostMessage, Snapshot } from '@ansible-flow/core/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  filesAddress,
  flowInventory,
  openCodeIn,
  repoVars,
  type VarsAsk,
} from '../../src/web/viewerVars';

const doc = parseFlow(readFileSync(join(samplesDir, 'hello.flow.yaml'), 'utf8')).doc;
if (!doc) throw new Error('the sample flow did not parse');
const say = doc.nodes.find((n) => n.key === 'say-hello');
if (!say) throw new Error('fixture');
// The step reads a name the repository sets, and nothing in the flow does.
say.impl = { kind: 'module', ref: 'ansible.builtin.debug', params: { msg: '{{ syslog_host }}' } };
const snapshot: Snapshot = {
  docVersion: 4,
  doc,
  stale: false,
  findings: [
    {
      code: 'binding-unknown-var',
      severity: 'warning',
      message: 'reads "syslog_host", which is not an input of this node',
      node: say.id,
      subject: 'syslog_host',
      path: ['nodes', 4, 'impl', 'params'],
    },
  ] as Snapshot['findings'],
  openPorts: [],
  autoPositions: {},
};
const INDEX: VarIndex = {
  defs: {
    syslog_host: [
      {
        name: 'syslog_host',
        scope: { kind: 'group', group: 'all' },
        file: 'inventory/group_vars/all.yml',
        line: 2,
        rank: 22,
        value: '198.51.100.5',
      },
    ],
  },
  groups: { all: { parents: [], hosts: ['sw-01'] } },
  hosts: ['sw-01'],
} as VarIndex;

const settle = () => new Promise((r) => setTimeout(r, 0));
afterEach(() => vi.unstubAllGlobals());

describe('the inventory of the flow’s runs', () => {
  it('the one its launch configurations name when they agree; else ansible.cfg’s', () => {
    const c = (flowFile: string, inventory?: string | null) => ({ flowFile, inventory });
    expect(
      flowInventory([c('a.flow.yaml', 'inv/prod.yml'), c('b.flow.yaml', 'x')], 'a.flow.yaml'),
    ).toBe('inv/prod.yml');
    expect(
      flowInventory(
        [c('a.flow.yaml', 'inv/prod.yml'), c('a.flow.yaml', 'inv/lab.yml')],
        'a.flow.yaml',
      ),
    ).toBe('');
    expect(flowInventory([c('a.flow.yaml', null)], 'a.flow.yaml')).toBe('');
    expect(flowInventory([], 'a.flow.yaml')).toBe('');
  });
});

describe('the repository’s variables on the canvas', () => {
  it('reads them for the commit and the flow’s steps, posts them, and adds their findings', async () => {
    const sent: HostMessage[] = [];
    const asks: VarsAsk[] = [];
    const vars = repoVars({
      project: 'p1',
      commit: 'a'.repeat(40),
      inventory: async () => 'inventory/hosts.yml',
      send: (m) => sent.push(m),
      read: async (_p, ask) => {
        asks.push(ask);
        return INDEX;
      },
    });
    // Before the index is in, the snapshot goes as it is.
    expect(vars.snapshot(snapshot)).toBe(snapshot);
    await settle();
    expect(asks).toEqual([
      { commit: 'a'.repeat(40), inventory: 'inventory/hosts.yml', roles: [], files: [] },
    ]);
    expect(sent[0]).toEqual({ type: 'varIndex', index: INDEX, openFiles: true });
    // Then the same version again, its unknown read now information naming the file.
    const again = sent[1] as Extract<HostMessage, { type: 'snapshot' }>;
    expect(again.snapshot.docVersion).toBe(4);
    expect(again.snapshot.findings[0]).toMatchObject({ severity: 'info' });
    expect(again.snapshot.findings[0]?.message).toContain('inventory/group_vars/all.yml:3');
    // The same steps again: not read again, merged at once.
    const next = vars.snapshot({ ...snapshot, docVersion: 5 });
    expect(next.findings[0]).toMatchObject({ severity: 'info' });
    await settle();
    expect(asks).toHaveLength(1);
    // The branch moved: read for the new commit.
    vars.at('b'.repeat(40));
    await settle();
    expect(asks.at(-1)?.commit).toBe('b'.repeat(40));
  });

  it('no index (no access to the files): the canvas answers from the flow alone', async () => {
    const sent: HostMessage[] = [];
    const vars = repoVars({
      project: 'p1',
      commit: 'a'.repeat(40),
      inventory: async () => '',
      send: (m) => sent.push(m),
      read: async () => undefined,
    });
    expect(vars.snapshot(snapshot)).toBe(snapshot);
    await settle();
    expect(sent).toEqual([{ type: 'varIndex', index: null, openFiles: false }]);
  });

  it('an answer that comes after a newer ask is dropped', async () => {
    const sent: HostMessage[] = [];
    const answers: ((i: VarIndex) => void)[] = [];
    const vars = repoVars({
      project: 'p1',
      commit: 'a'.repeat(40),
      inventory: async () => '',
      send: (m) => sent.push(m),
      read: () => new Promise((resolve) => answers.push(resolve)),
    });
    vars.snapshot(snapshot);
    await settle();
    vars.at('b'.repeat(40));
    await settle();
    answers[1]?.({ ...INDEX, hosts: ['new'] });
    await settle();
    answers[0]?.({ ...INDEX, hosts: ['old'] });
    await settle();
    const posted = sent.filter((m) => m.type === 'varIndex') as Extract<
      HostMessage,
      { type: 'varIndex' }
    >[];
    expect(posted.map((m) => m.index?.hosts)).toEqual([['new']]);
  });
});

describe('a definition’s file:line', () => {
  it('opens the Files tab at that line, in a new tab', () => {
    expect(
      filesAddress({ workspace: 'net', project: 'core' }, 'inventory/group_vars/all.yml', 3),
    ).toBe('/w/net/core/files?path=inventory%2Fgroup_vars%2Fall.yml&line=3');
    const open = vi.fn();
    vi.stubGlobal('open', open);
    const fallback = vi.fn();
    openCodeIn({ workspace: 'net', project: 'core' }, 'group_vars/web.yml', 7, fallback);
    expect(open).toHaveBeenCalledWith(
      '/w/net/core/files?path=group_vars%2Fweb.yml&line=7',
      '_blank',
      'noopener',
    );
    // The keys not read yet: the page's own way.
    openCodeIn(undefined, 'group_vars/web.yml', 7, fallback);
    expect(fallback).toHaveBeenCalledWith('group_vars/web.yml', 7);
  });
});
