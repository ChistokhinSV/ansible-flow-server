// The flow's runs as the canvas's Run panel gets them (AFS-139): a run still going says so, not
// "did not finish"; a run of the server says where it ran, not "Local skeleton run".
import { describe, expect, it } from 'vitest';
import { going, pastRunOf, type RunRecord, runnerOf } from '../../src/web/viewerRuns';

const run = (over: Partial<RunRecord>): RunRecord => ({
  id: 'r5',
  number: 5,
  mode: 'check',
  state: 'succeeded',
  createdAt: '2026-11-18T00:44:00.000Z',
  startedAt: '2026-11-18T00:44:02.000Z',
  commit: 'a'.repeat(40),
  config: { id: 'c1', name: 'Edge switches' },
  flow: { version: 3 },
  hosts: { total: 4, failed: 0 },
  ...over,
});

describe('the runs of a flow on the canvas', () => {
  it('a finished skeleton run is listed with its hosts, as finished', () => {
    expect(pastRunOf(run({}))).toEqual({
      id: 'r5',
      mode: 'check',
      startedAt: '2026-11-18T00:44:02.000Z',
      ok: true,
      hosts: 4,
      failed: 0,
      flowVersion: 3,
    });
    // Hosts failed: the run itself still finished.
    expect(pastRunOf(run({ state: 'failed', hosts: { total: 4, failed: 1 } })).ok).toBe(true);
    expect(pastRunOf(run({ state: 'cancelled' })).ok).toBe(false);
    // AFS-193: a run decided against at its approval reads rejected, not "1 failed".
    expect(
      pastRunOf(
        run({ state: 'failed', hosts: { total: 1, failed: 1 }, decidedAgainst: 'rejected' }),
      ),
    ).toMatchObject({ ok: false, ended: 'rejected' });
  });

  it('a run still going is listed as running', () => {
    for (const state of ['queued', 'running', 'waiting']) {
      expect(going(state)).toBe(true);
      expect(pastRunOf(run({ state, hosts: undefined }))).toMatchObject({ running: true });
    }
    expect(going('succeeded')).toBe(false);
    expect(pastRunOf(run({}))).not.toHaveProperty('running');
  });

  it('a run of the server says so, with its number and configuration', () => {
    expect(runnerOf(run({}))).toEqual({
      source: 'runner',
      runner: {
        runId: 'r5',
        number: 5,
        url: '/runs/r5',
        state: 'succeeded',
        commit: 'a'.repeat(40),
        config: 'Edge switches',
      },
    });
  });

  it('gives the canvas the inputs the run had, as anyone may see them (AFS-189)', () => {
    expect(runnerOf(run({ inputs: { site: 'lab', api_token: '***' } }))).toMatchObject({
      flowInputs: { site: 'lab', api_token: '***' },
    });
    expect(runnerOf(run({}))).not.toHaveProperty('flowInputs');
  });
});
