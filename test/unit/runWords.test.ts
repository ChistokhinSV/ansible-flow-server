// AFS-147: how a run that ended says why, in plain words.
import type { RunView } from '@ansible-flow/core/protocol';
import { describe, expect, it } from 'vitest';
import {
  failedWhy,
  noHostWhy,
  skippedTarget,
  stoppedBy,
  titleOf,
} from '../../src/server/runs/words';

const nodes = [
  { id: 'n1', key: 'precheck', title: 'Pre-checks' },
  { id: 'n2', key: 'upgrade', title: 'Upgrade', subflow: { nodes: [{ id: 'n3', key: 'reboot' }] } },
];
const view = (summary: Partial<NonNullable<RunView['summary']>>): RunView =>
  ({
    id: 'r',
    mode: 'real',
    state: 'done',
    startedAt: '2026-11-18T09:00:00Z',
    summary: { hosts: [], nodes: {}, outcome: {}, failures: [], unreachable: [], ...summary },
  }) as RunView;

describe('a run in words (AFS-147)', () => {
  it('names the targets Ansible skipped', () => {
    expect(
      skippedTarget('[WARNING]: Could not match supplied host pattern, ignoring: nosuchhost'),
    ).toBe('nosuchhost');
    expect(skippedTarget('ok: [fw-edge-01]')).toBeUndefined();
  });

  it('finds a step by its id, in a subflow too', () => {
    expect(titleOf(nodes, 'n1')).toBe('Pre-checks');
    expect(titleOf(nodes, 'n3')).toBe('reboot');
    expect(titleOf(nodes, 'nope')).toBeUndefined();
  });

  it('says why no host ran: the limit, the targets, the inventory', () => {
    expect(noHostWhy({ targets: ['all'], inventory: 'inventory.ini' })).toBe(
      'No host ran: none of the targets (all) is in the inventory inventory.ini',
    );
    expect(noHostWhy({ targets: ['sw-edge-01'], limit: 'nosuchhost' })).toBe(
      'No host ran: the limit nosuchhost matched none of the targets (sw-edge-01) in the inventory',
    );
    // Every target was skipped: the limit is not the reason.
    expect(noHostWhy({ targets: ['ghost'], limit: 'ghost', skipped: ['ghost'] })).toMatch(
      /none of the targets \(ghost\) is in the inventory/,
    );
  });

  it('says how many hosts failed and where, not the exit code', () => {
    const failed = view({
      hosts: ['a', 'b', 'c', 'd'],
      failures: [{ host: 'b', node: 'n1', task: 'check' }] as never,
    });
    expect(failedWhy(failed, nodes, 2)).toBe('1 of 4 hosts failed at Pre-checks');
    expect(failedWhy(view({ hosts: ['a'] }), nodes, 2)).toBe('Ansible ended with code 2');
  });

  it('says who stopped a run and during which step', () => {
    expect(stoppedBy('Stopped on request during Upgrade', 'Dana Whitfield')).toBe(
      'Stopped by Dana Whitfield during Upgrade',
    );
    expect(stoppedBy('Stopped on request', undefined)).toBe('Stopped on request');
  });
});
