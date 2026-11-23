// AFS-205: which run the flow page shows and lists when your own run is paused step by step and
// others launched newer ones; a paused run's state in the pages' words; the bar's keys.
import { describe, expect, it } from 'vitest';
import type { Run } from '../../src/web/api';
import { latestRuns } from '../../src/web/flow';
import { shownState } from '../../src/web/runs';
import { stepKey, stepLine, stopsIn } from '../../src/web/stepBar';
import { runToShow, whoGoesOn } from '../../src/web/viewerRuns';

const r = (id: string, state: string, login: string) =>
  ({ id, state, requestedBy: { login, name: login.toUpperCase() } }) as unknown as Run;

describe('your paused run is not lost behind newer ones', () => {
  it("the flow page's canvas shows your run that goes, else the newest", () => {
    const runs = [
      r('n3', 'succeeded', 'omar'),
      r('n2', 'running', 'dana'),
      r('n1', 'failed', 'dana'),
    ];
    expect(runToShow(runs, 'dana')?.id).toBe('n2');
    expect(runToShow(runs, 'omar')?.id).toBe('n3');
    expect(runToShow(runs, undefined)?.id).toBe('n3');
  });

  it('Latest runs keeps your run that goes, first, when it is not among the newest', () => {
    const newest = [r('n5', 'succeeded', 'omar'), r('n4', 'succeeded', 'omar')];
    expect(latestRuns(newest, [r('n1', 'running', 'dana')]).map((x) => x.id)).toEqual([
      'n1',
      'n5',
      'n4',
    ]);
    expect(latestRuns(newest, [newest[0] as Run]).map((x) => x.id)).toEqual(['n5', 'n4']);
  });

  it('a paused run reads paused; a reader is told who goes on', () => {
    expect(shownState({ state: 'running', pausedBefore: 'Push' })).toBe('paused');
    expect(shownState({ state: 'running' })).toBe('running');
    expect(shownState({ state: 'waiting', pausedBefore: 'Push' })).toBe('waiting');
    expect(whoGoesOn(r('n1', 'running', 'dana') as never)).toBe('DANA or an operator of this flow');
  });
});

describe('the bar', () => {
  it('F10 steps, F8 goes on or pauses; F5 is the browser’s', () => {
    const k = (key: string) => ({
      key,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
    });
    expect(stepKey(k('F10'), true)).toBe('step');
    expect(stepKey(k('F10'), false)).toBeUndefined();
    expect(stepKey(k('F8'), true)).toBe('continue');
    expect(stepKey(k('F8'), false)).toBe('pause');
    expect(stepKey(k('F5'), true)).toBeUndefined();
  });

  it('once it goes on, the step that runs; never more time left than the timeout', () => {
    expect(
      stepLine(
        {},
        { every: true, points: [], pauses: 1, running: { node: 'n', play: '[p] Push' } },
        0,
      ),
    ).toBe('Running Push…');
    // The record still says paused, but the view says it goes on: the view wins.
    expect(stepLine({ pausedBefore: 'Push' }, { every: true, points: [], pauses: 1 }, 0)).toBe(
      'Running a step…',
    );
    expect(stopsIn({ since: 101, timeout: 60 }, 100_000)).toBe('60 s');
  });
});
