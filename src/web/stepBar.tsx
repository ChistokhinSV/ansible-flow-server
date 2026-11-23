// AFS-177: a step-by-step run on its page, outside the canvas (and on a phone, where the canvas is
// small): where it is paused and how many hosts wait, and Step, Continue, Pause, Stop.
import type { RunStep, StepCommand } from '@ansible-flow/core/run/step';
import { stopsIn } from '@ansible-flow/core/run/step';
import { useEffect, useState } from 'react';
import { api, type Run } from './api';

/** "[precheck] Pre-checks" says Pre-checks: a step as its play is named. */
export const stepName = (play: string) => play.replace(/^\[[^\]]*\]\s*/, '') || play;

const hostsOf = (n: number) => `${n} host${n === 1 ? '' : 's'}`;

/** The line a step-by-step run shows: paused before which step, or running on. */
export function stepLine(
  run: Pick<Run, 'pausedBefore'>,
  step: RunStep | undefined,
  nowMs: number,
): string {
  const pause = step?.paused;
  if (pause)
    return `Paused before ${stepName(pause.play) || run.pausedBefore || 'the next step'} · ${hostsOf(
      pause.hosts.length,
    )} · stops by itself in ${stopsIn(pause, nowMs)}`;
  if (run.pausedBefore) return `Paused before ${run.pausedBefore}`;
  return step?.every === false
    ? 'Step by step: runs on to a pause point'
    : 'Step by step: runs this step, then pauses';
}

export function RunStepBar({
  run,
  step,
  mayDrive,
  onRun,
  onError,
}: {
  run: Run;
  step: RunStep | undefined;
  /** Operator on the run's flow (or an administrator): may press the buttons. */
  mayDrive: boolean;
  onRun(run: Run): void;
  onError(message: string): void;
}) {
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const paused = !!step?.paused || !!run.pausedBefore;
  // The minutes left tick on while it waits.
  useEffect(() => {
    if (!paused) return;
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [paused]);
  const send = async (command: StepCommand) => {
    setBusy(true);
    try {
      onRun(await api.stepRun(run.id, { command }));
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const button = (command: StepCommand, label: string, title: string, primary = false) => (
    <button
      type="button"
      className={command === 'stop' ? 'danger' : primary ? 'primary' : undefined}
      disabled={busy}
      title={title}
      data-step-command={command}
      onClick={() => void send(command)}
    >
      {label}
    </button>
  );
  return (
    <div className={`step-bar${paused ? ' paused' : ''}`} role="status" data-step-bar>
      <span className="step-line">{stepLine(run, step, now)}</span>
      {mayDrive && (
        <span className="step-actions">
          {paused ? (
            <>
              {button('step', 'Step', 'Run this step, then pause before the next one', true)}
              {button('continue', 'Continue', 'Run on; pause only at a pause point')}
            </>
          ) : (
            button('pause', 'Pause', 'Pause before the next step')
          )}
          {button('stop', 'Stop', 'End the run before its next step; what ran is kept')}
        </span>
      )}
    </div>
  );
}
