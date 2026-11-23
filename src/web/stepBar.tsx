// AFS-177: a step-by-step run on its page, outside the canvas (and on a phone, where the canvas is
// small): where it is paused and how many hosts wait, and Step, Continue, Pause, Stop.
// AFS-205: the same bar as the canvas's: "Running X…" with Pause once it goes on, the hosts that
// wait, the pause points and whose they are, who may go on, keys (F10, F8), and the focus kept.
import type { RunStep, StepCommand } from '@ansible-flow/core/run/step';
import { useEffect, useRef, useState } from 'react';
import { api, type Run } from './api';
import { ask } from './confirm';
import { typingInField } from './typing';

/**
 * What the run's view says of it. `running` and `who` came with designer 1.1.0 (AFS-205): typed
 * loosely, so this builds against a designer before it.
 */
export type ShownStep = RunStep & {
  /** The step that runs now, after Step or Continue answered its pause. */
  running?: { node: string; play: string };
};

/** "[precheck] Pre-checks" says Pre-checks: a step as its play is named. */
export const stepName = (play: string) => play.replace(/^\[[^\]]*\]\s*/, '') || play;

const hostsOf = (n: number) => `${n} host${n === 1 ? '' : 's'}`;

/**
 * "59 min", "40 s": how long until a pause stops the run by itself; never more than its timeout
 * ("61 s" of a 60 s one: the run's clock may be a little ahead of the page's).
 */
export function stopsIn(pause: { since: number; timeout: number }, nowMs: number): string {
  const left = Math.min(
    pause.timeout,
    Math.max(0, Math.round(pause.since + pause.timeout - nowMs / 1000)),
  );
  return left >= 120 ? `${Math.round(left / 60)} min` : `${left} s`;
}

/**
 * The line a step-by-step run shows: paused before which step (by its path: the run's record
 * names a step inside a subflow as "Pre-checks › Read device status"), or the step running now.
 */
export function stepLine(
  run: Pick<Run, 'pausedBefore'>,
  step: ShownStep | undefined,
  nowMs: number,
): string {
  const pause = step?.paused;
  if (pause)
    return `Paused before ${run.pausedBefore || stepName(pause.play) || 'the next step'} · ${hostsOf(
      pause.hosts.length,
    )} · stops by itself in ${stopsIn(pause, nowMs)}`;
  // The view of the run says it goes on before its record does: the view wins.
  if (run.pausedBefore && !step) return `Paused before ${run.pausedBefore}`;
  if (step?.running) return `Running ${stepName(step.running.play)}…`;
  return step?.every === false ? 'Running on to the next pause point…' : 'Running a step…';
}

/** AFS-205: the command a key gives the run (F10 Step, F8 Continue or Pause); none for others. */
export function stepKey(
  e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>,
  paused: boolean,
): StepCommand | undefined {
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return undefined;
  if (e.key === 'F10') return paused ? 'step' : undefined;
  if (e.key === 'F8') return paused ? 'continue' : 'pause';
  return undefined;
}

/** AFS-205: whose pause point the run is paused at, in words; none when it is not one. */
export function pointWords(
  run: Pick<Run, 'step' | 'requestedBy'>,
  step: ShownStep | undefined,
  launcher: string,
): string | undefined {
  const at = step?.paused?.node;
  const points = step?.points?.length ? step.points : (run.step?.points ?? []);
  if (!at || !points.includes(at)) return undefined;
  const by = run.step?.pointsBy;
  return by && by !== run.requestedBy.login
    ? `a pause point set by ${by}`
    : `${launcher}'s pause point`;
}

export function RunStepBar({
  run,
  step,
  mayDrive,
  launcher,
  mine,
  onRun,
  onError,
}: {
  run: Run;
  step: ShownStep | undefined;
  /** Operator on the run's flow (or an administrator): may press the buttons. */
  mayDrive: boolean;
  /** Who launched the run, by name. */
  launcher: string;
  /** The person looking launched it. */
  mine: boolean;
  onRun(run: Run): void;
  onError(message: string | undefined): void;
}) {
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  // The view (live) says whether it waits; the record only until the view is there.
  const paused = step ? !!step.paused : !!run.pausedBefore;
  // The minutes left tick on while it waits.
  useEffect(() => {
    if (!paused) return;
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [paused]);
  const send = async (command: StepCommand) => {
    if (busy) return;
    // AFS-205: Stop of someone else's run asks first, naming whose it is.
    if (
      command === 'stop' &&
      !mine &&
      !(await ask(
        paused
          ? `Stop ${launcher}'s run #${run.number}? It is paused before ${run.pausedBefore ?? 'a step'}: its hosts stop there and the run cannot go on.`
          : `Stop ${launcher}'s run #${run.number}? It stops before its next step and cannot go on.`,
        { yes: 'Stop the run', danger: true },
      ))
    )
      return;
    setBusy(true);
    try {
      onRun(await api.stepRun(run.id, { command }));
      // AFS-205: a refusal said before (409) goes once the run is driven again.
      onError(undefined);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const sendRef = useRef(send);
  sendRef.current = send;
  // AFS-205: F10 and F8 while the bar shows (F5 reloads a page, so it is not one of them).
  useEffect(() => {
    if (!mayDrive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || typingInField(e)) return;
      const command = stepKey(e, paused);
      if (!command) return;
      e.preventDefault();
      if (!e.repeat) void sendRef.current(command);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [mayDrive, paused]);
  // AFS-205: buttons are never taken away or disabled under the focus: one that cannot be
  // pressed now says why (aria-disabled), and Continue and Pause share one place.
  const button = (
    command: StepCommand,
    label: string,
    title: string,
    options: { primary?: boolean; key?: string; off?: string } = {},
  ) => (
    <button
      type="button"
      className={command === 'stop' ? 'danger' : options.primary ? 'primary' : undefined}
      aria-disabled={busy || options.off ? true : undefined}
      title={`${options.off ?? title}${options.key ? ` (${options.key})` : ''}`}
      aria-keyshortcuts={options.key}
      data-step-command={command}
      onClick={() => {
        if (!options.off) void send(command);
      }}
    >
      {label}
    </button>
  );
  const pause = step?.paused;
  const point = pointWords(run, step, launcher);
  const points = step?.points?.length ? step.points.length : (run.step?.points.length ?? 0);
  return (
    <div className={`step-bar${paused ? ' paused' : ''}`} data-step-bar>
      <div className="step-says">
        <span className="step-line" role="status" aria-live="polite">
          {stepLine(run, step, now)}
          {point ? ` · ${point}` : ''}
        </span>
        <span className="step-more muted">
          {pause?.hosts.length ? `Waiting there: ${pause.hosts.join(', ')}. ` : ''}
          {points
            ? `${points} pause point${points === 1 ? '' : 's'}: Continue runs on to the next one. `
            : 'No pause point: Continue runs to the end. '}
          {mayDrive
            ? 'Keys: F10 Step, F8 Continue or Pause.'
            : paused
              ? `Waiting for ${launcher} or an operator of this flow to go on.`
              : ''}
        </span>
      </div>
      {mayDrive && (
        <span className="step-actions">
          {button('step', 'Step', 'Run this step, then pause before the next one', {
            primary: true,
            key: 'F10',
            ...(paused ? {} : { off: 'The run is going: Step answers its next pause' }),
          })}
          {paused
            ? button('continue', 'Continue', 'Run on; pause only at a pause point', { key: 'F8' })
            : button('pause', 'Pause', 'Pause before the next step', { key: 'F8' })}
          {button('stop', 'Stop', 'End the run before its next step; what ran is kept')}
        </span>
      )}
    </div>
  );
}
