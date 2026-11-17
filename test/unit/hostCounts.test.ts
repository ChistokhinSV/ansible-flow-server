// AFS-105: a run's host counts, from its view, as a list of runs (the canvas's earlier runs) says them.
import { describe, expect, it } from 'vitest';
import { hostCounts } from '../../src/server/runs/hostCounts';

describe('hostCounts', () => {
  it('counts the hosts and those that failed or were not reached, once each', () => {
    const view = {
      summary: {
        hosts: ['edge-r1', 'edge-r2', 'edge-r3'],
        outcome: { 'edge-r2': 'failed' },
        failures: [{ host: 'edge-r2' }, { host: 'edge-r3' }],
      },
    };
    expect(hostCounts(view)).toEqual({ host_count: 3, failed_count: 2 });
    // As kept in the database.
    expect(hostCounts(JSON.stringify(view))).toEqual({ host_count: 3, failed_count: 2 });
  });

  it('gives nothing for a view without a summary, or one that does not parse', () => {
    expect(hostCounts({ state: 'running' })).toEqual({});
    expect(hostCounts('{not json')).toEqual({});
    expect(hostCounts(undefined)).toEqual({});
  });
});
