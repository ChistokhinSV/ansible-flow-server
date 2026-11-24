// AFS-214 (ADR-0038 §2): Run again ▾ on a run's page: Run again (as it was), Change and run (the
// launch form, filled from the run), Only the N hosts that did not go well, and Debug this
// failure (a check run of those hosts, step by step, pausing before the step they failed at and
// when a host fails). The run's offer (GET /runs/:id/relaunch) says the host sets, the risks of a
// host limit and the flow's approvals.
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import type { HostAt, HostSets, RelaunchBody, RelaunchOffer, Run } from './api';
import { ask } from './confirm';

const list = (names: readonly string[], max = 5) =>
  names.length > max
    ? `${names.slice(0, max).join(', ')} and ${names.length - max} more`
    : names.join(', ');
const hostsWord = (n: number) => (n === 1 ? '1 host' : `${n} hosts`);

/** The hosts that did not go well, each with the step it went wrong at, in the run's order. */
export function notOkHosts(sets: HostSets): HostAt[] {
  const all = [...sets.failed, ...sets.unreachable, ...sets.stopped];
  return sets.notOk.flatMap((h) => all.filter((a) => a.host === h).slice(0, 1));
}

/**
 * AFS-256: the hosts Debug this failure is for: those that did not go well, but not one an
 * approval did not let on (nobody saw it fail: debugging it shows nothing).
 */
export function debuggable(sets: HostSets): HostAt[] {
  return notOkHosts(sets).filter((h) => !h.notApproved);
}

/**
 * Where Debug this failure pauses: before each step a host that did not go well went wrong at
 * (their ids and titles); none known (a host stopped before the run said where): every step.
 */
export function debugPoints(sets: HostSets): { points: string[]; titles: string[] } {
  const points: string[] = [];
  const titles: string[] = [];
  // AFD-375: a host stopped after a step did not go wrong there: no pause before it for that.
  // AFS-256: nor at an approval it waited at (a check run passes it by itself).
  for (const h of debuggable(sets))
    if (h.node && !h.after && !h.waiting && !points.includes(h.node)) {
      points.push(h.node);
      titles.push(h.title ?? h.node);
    }
  return { points, titles };
}

/** The body of Debug this failure: the hosts that did not go well, at the run's commit. */
export function debugBody(sets: HostSets, real: boolean): RelaunchBody {
  const { points } = debugPoints(sets);
  // AFS-256: hosts an approval did not let on are left out by name; else the set itself.
  const leftOut = notOkHosts(sets).some((h) => h.notApproved);
  return {
    hosts: leftOut ? debuggable(sets).map((h) => h.host) : 'not-ok',
    mode: real ? 'real' : 'check',
    commit: 'same',
    step: {
      every: points.length === 0,
      ...(points.length ? { points } : {}),
      debug: true,
      pauseOnFailure: true,
    },
  };
}

/** The question before Only the N hosts that did not go well. */
export function onlyQuestion(run: Run, offer: RelaunchOffer): string {
  const hosts = offer.sets?.notOk ?? [];
  const real = run.mode === 'real' ? ' for real' : ' as a check run';
  const risks = offer.risks.length ? ` ${offer.risks.join('. ')}.` : '';
  const changes = run.mode === 'real' ? ' It changes the hosts it reaches.' : '';
  return `Run #${run.number} again${real} on ${hostsWord(hosts.length)}: ${list(hosts)} (commit ${run.commit.slice(0, 12)}, the same inputs, the credentials of its configuration)?${changes}${steppedWords(run)} Approvals are asked again.${risks}`;
}

/** AFS-251: a run again keeps step by step: the question says so, as Launch's does. */
export function steppedWords(run: Pick<Run, 'number' | 'step'>): string {
  const s = run.step;
  if (!s) return '';
  const where = s.every || !s.points.length ? 'before each step' : 'at its pause points';
  return s.debug
    ? ` It is a debug run, as run #${run.number} was: it pauses ${where} and when a host fails.`
    : ` It runs step by step, as run #${run.number} did: it pauses ${where} until someone says Step, Continue or Stop.`;
}

/** AFS-251: the hosts that did not go well, each with its set: "sw-02 (failed), sw-05 (stopped)". */
export function namedSets(sets: HostSets, max = 5): string {
  const bad = notOkHosts(sets);
  const named = bad.slice(0, max).map((h) => {
    const why = sets.unreachable.some((u) => u.host === h.host)
      ? 'unreachable'
      : sets.stopped.some((s) => s.host === h.host)
        ? 'stopped'
        : h.notApproved === 'rejected'
          ? 'not approved'
          : h.notApproved
            ? 'not decided in time'
            : 'failed';
    return `${h.host} (${why})`;
  });
  return `${named.join(', ')}${bad.length > max ? ` and ${bad.length - max} more` : ''}`;
}

/** A modal dialog of the page's own (Escape closes it), focus back where it was. */
function Dialog({
  label,
  onClose,
  children,
}: {
  label: string;
  onClose(): void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    // AFS-250: the menu item that opened it is gone with the menu: focus goes back to the menu's
    // button (Run again), not to the page's body.
    const was = document.activeElement as HTMLElement | null;
    const menu = d.parentElement
      ?.closest('.run-again')
      ?.querySelector<HTMLElement>('button[aria-haspopup]');
    const back = was && was !== document.body && was.isConnected ? was : menu;
    if (typeof d.showModal === 'function') {
      try {
        d.showModal();
      } catch {
        d.setAttribute('open', '');
      }
    } else d.setAttribute('open', '');
    return () => {
      if (typeof d.close === 'function' && d.open) d.close();
      const to = back?.isConnected ? back : menu;
      if (to?.isConnected) to.focus({ preventScroll: true });
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="confirm run-again-dialog"
      aria-label={label}
      aria-modal="true"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      {children}
    </dialog>
  );
}

/** Debug this failure: check (default) or real, the hosts, where it pauses, what it risks. */
export function DebugDialog({
  run,
  offer,
  onStart,
  onClose,
}: {
  run: Run;
  offer: RelaunchOffer & { sets: HostSets };
  onStart(body: RelaunchBody): void;
  onClose(): void;
}) {
  const [real, setReal] = useState(false);
  const hosts = debuggable(offer.sets).map((h) => h.host);
  const { titles } = debugPoints(offer.sets);
  const start = async () => {
    if (
      real &&
      !(await ask(
        `Debug run #${run.number} for real on ${list(hosts)}? It changes these hosts. Approvals are asked again: a failure after an approval means passing that approval again.`,
        { yes: 'Debug for real', danger: true },
      ))
    )
      return;
    onStart(debugBody(offer.sets, real));
  };
  return (
    <Dialog label="Debug this failure" onClose={onClose}>
      <h2>Debug this failure</h2>
      <p data-debug-hosts>
        Hosts: {list(hosts, 8)} · commit <code>{run.commit.slice(0, 12)}</code> (the failed run's)
      </p>
      <p>
        {titles.length
          ? `Pauses before ${list(titles, 3)}, where they went wrong, and when a host fails.`
          : 'Pauses before each step (the run did not say where they went wrong) and when a host fails.'}{' '}
        Step by step, with the debugger.
      </p>
      <fieldset className="run-again-mode">
        <legend>Mode</legend>
        <label>
          <input type="radio" name="debug-mode" checked={!real} onChange={() => setReal(false)} />{' '}
          Check mode: changes nothing on the hosts; the failure may not show
        </label>
        <label>
          <input type="radio" name="debug-mode" checked={real} onChange={() => setReal(true)} />{' '}
          Real run: changes the hosts; asks for confirmation
        </label>
      </fieldset>
      {real && offer.approvals.length > 0 && (
        <p className="warn-text">
          A real run waits again at {list(offer.approvals, 3)}: approvals are asked again.
        </p>
      )}
      {offer.risks.length > 0 && (
        <ul className="run-again-risks">
          {offer.risks.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
      <div className="actions confirm-actions">
        <button type="button" className={real ? 'danger' : 'primary'} onClick={() => void start()}>
          Start debugging
        </button>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Dialog>
  );
}

const items = (box: HTMLElement | null) => [
  ...(box?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []),
];

/**
 * Run again ▾: the menu. `again`: Run again's title and question (the run as it was); `change`:
 * where Change and run goes (the launch form, filled from the run), when the run has a
 * configuration this person can open; `mayDebug`: rw on the flow.
 */
export function RunAgainMenu({
  run,
  offer,
  again,
  change,
  mayDebug,
  busy,
  onAgain,
  onChange,
}: {
  run: Run;
  offer?: RelaunchOffer;
  again: { title: string; confirm?: string; yes: string };
  change?: string;
  mayDebug: boolean;
  busy: boolean;
  onAgain(body?: RelaunchBody): void;
  onChange(to: string): void;
}) {
  const [open, setOpen] = useState(false);
  const [debugging, setDebugging] = useState(false);
  // AFS-251: an item is named by its label; the line under it describes it.
  const uid = useId();
  const named = (item: string) => ({
    'aria-labelledby': `${uid}${item}`,
    'aria-describedby': `${uid}${item}-note`,
  });
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    items(box.current)[0]?.focus();
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (box.current?.contains(document.activeElement)) button.current?.focus();
      setOpen(false);
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', key);
    };
  }, [open]);
  const sets = offer?.sets;
  const bad = sets?.notOk.length ?? 0;
  const pick = async (what: 'again' | 'change' | 'only' | 'debug') => {
    setOpen(false);
    if (what === 'again') {
      if (
        againConfirm &&
        !(await ask(againConfirm, { yes: again.confirm ? again.yes : 'Run again' }))
      )
        return;
      onAgain();
    } else if (what === 'change' && change) onChange(change);
    else if (what === 'only' && offer) {
      if (
        !(await ask(onlyQuestion(run, offer), {
          yes: run.mode === 'real' ? 'Run for real' : 'Run again',
        }))
      )
        return;
      onAgain({ hosts: 'not-ok' });
    } else if (what === 'debug') setDebugging(true);
  };
  const notOkNames = sets ? namedSets(sets) : '';
  // AFS-253: only what the server would let this person do (all of it before the offer says).
  const may = offer?.may ?? { again: true, change: true, debug: true };
  const showChange = !!change && may.change;
  const showOnly = bad > 0 && may.again;
  const showDebug = !!sets && debuggable(sets).length > 0 && mayDebug && may.debug;
  if (!may.again && !showChange && !showDebug)
    return (
      <p className="muted run-again-who" data-run-again-who>
        {may.why ?? 'You may not run it again'}
      </p>
    );
  // AFS-257: Run again of a step-by-step or debug run runs as it did: its item and question say so.
  const stepped = steppedWords(run);
  const againNote = run.step?.debug
    ? `All its hosts, the same commit and inputs: a debug run, as #${run.number} was`
    : run.step
      ? `All its hosts, the same commit and inputs: step by step, as #${run.number} ran`
      : 'All its hosts, the same commit and inputs';
  const againConfirm = stepped
    ? `${again.confirm ?? `Run #${run.number} again, at the same commit with the same inputs?`}${stepped}`
    : again.confirm;
  return (
    <div className="more-menu run-again" ref={box}>
      <button
        ref={button}
        type="button"
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        Run again ▾
      </button>
      {open && (
        <div
          className="more-menu-list"
          role="menu"
          tabIndex={-1}
          onKeyDown={(e) => {
            const all = items(box.current);
            const at = all.indexOf(document.activeElement as HTMLElement);
            const to =
              e.key === 'ArrowDown'
                ? (at + 1) % all.length
                : e.key === 'ArrowUp'
                  ? (at - 1 + all.length) % all.length
                  : e.key === 'Home'
                    ? 0
                    : e.key === 'End'
                      ? all.length - 1
                      : undefined;
            if (to !== undefined) {
              e.preventDefault();
              all[to]?.focus();
            } else if (e.key === 'Tab') setOpen(false);
          }}
        >
          {may.again ? (
            <button
              type="button"
              role="menuitem"
              title={again.title}
              {...named('again')}
              onClick={() => pick('again')}
            >
              <span id={`${uid}again`}>Run again</span>
              <small id={`${uid}again-note`} className="menu-note" data-again-note>
                {againNote}
              </small>
            </button>
          ) : (
            // AFS-257: who may run it again, where Run again would be.
            <button
              type="button"
              role="menuitem"
              aria-disabled="true"
              className="menu-disabled"
              {...named('again')}
              onClick={(e) => e.preventDefault()}
            >
              <span id={`${uid}again`}>Run again</span>
              <small id={`${uid}again-note`} className="menu-note" data-run-again-who>
                {may.why ?? 'You may not run it again'}
              </small>
            </button>
          )}
          {showChange && (
            <button
              type="button"
              role="menuitem"
              title="The launch form, filled from this run: change what you need, then launch"
              {...named('change')}
              onClick={() => pick('change')}
            >
              <span id={`${uid}change`}>Change and run…</span>
              <small id={`${uid}change-note`} className="menu-note">
                The launch form, filled from this run
              </small>
            </button>
          )}
          {showOnly && (
            <button
              type="button"
              role="menuitem"
              title={notOkNames}
              {...named('only')}
              onClick={() => pick('only')}
            >
              <span id={`${uid}only`}>
                Only the {bad === 1 ? 'host' : `${bad} hosts`} that did not go well
              </span>
              <small id={`${uid}only-note`} className="menu-note" data-not-ok-hosts>
                {notOkNames}
              </small>
            </button>
          )}
          {showDebug && (
            <button
              type="button"
              role="menuitem"
              title="A check run of those hosts, step by step, that pauses before the step they failed at"
              {...named('debug')}
              onClick={() => pick('debug')}
            >
              <span id={`${uid}debug`}>Debug this failure…</span>
              <small id={`${uid}debug-note`} className="menu-note">
                Those hosts step by step, with the debugger
              </small>
            </button>
          )}
        </div>
      )}
      {debugging && offer?.sets && (
        <DebugDialog
          run={run}
          offer={{ ...offer, sets: offer.sets }}
          onClose={() => setDebugging(false)}
          onStart={(body) => {
            setDebugging(false);
            onAgain(body);
          }}
        />
      )}
    </div>
  );
}

/** "Run again of #41 on 3 hosts that did not go well": what a run again is, for its page. */
export function relaunchWords(of: NonNullable<Run['relaunchOf']>): string {
  const which =
    of.hosts === 'all' || of.count === undefined
      ? ''
      : of.hosts === 'not-ok'
        ? ` on the ${hostsWord(of.count)} that did not go well`
        : of.hosts === 'chosen'
          ? ` on ${hostsWord(of.count)}`
          : ` on the ${hostsWord(of.count)} that ${of.hosts === 'failed' ? 'failed' : of.hosts === 'unreachable' ? 'could not be reached' : 'stopped before the end'}`;
  return `Run again of #${of.number}${which}`;
}
