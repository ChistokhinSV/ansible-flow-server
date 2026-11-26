// AFS-265: the debug workbench, laid out as VS Code's debugger. A side bar on the left (an
// activity bar picks its view: Run and Debug, with Variables, Watch, Hosts and Pause points; and,
// on a run's page, Details), one toolbar over the canvas (Continue or Pause, Step, Retry, Stop,
// Restart), a bottom panel (Debug Console, Terminal, Problems) and a status line. The same frame
// holds a run on its page (/runs/:id) and a debug run on the flow's page, in place: the canvas stays
// where it was and the debug views open around it.
// AFS-266: the debug toolbar floats over the canvas, icons only (dragged sideways by its grip); why
// it paused is said once, in the status line. The side bar folds to its activity bar (Ctrl+B,
// Ctrl+Shift+D, or its active icon), the panel to its tab strip (Ctrl+J or its chevron); both folds
// are kept in this browser.
// At a pause the side bar opens on Variables at the first failed or matching host, Continue takes
// the focus (the page does not scroll), the window's title says "⏸ Paused", a hidden tab shows a
// notification (once the person allowed them), and a phone shows the Debug tab.
// The canvas (viewer.ts, in its frame) and the page talk by postMessage:
//   canvas → page: afs-canvas-ready, afs-node-selected {node}, afs-points {points, failures},
//                  afs-debug-key {key, shift}
//   page → canvas: afs-host-toolbar {on}, afs-host {host}, afs-reveal {node},
//                  afs-set-points {points, failures}
import type { FailureFilters, PausePoint, PointSpec } from '@ansible-flow/core/run/step';
import {
  type CSSProperties,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { Run } from './api';
import {
  ConsoleView,
  type DebugSession,
  DebugToolbar,
  debugKey,
  HostsView,
  PointsView,
  useDebugSession,
  useNarrow,
  useStepNames,
  VariablesView,
  WatchView,
} from './debugger';
import { tellFrame } from './runFeed';
import type { ShownStep } from './stepBar';
import { Icon, keepFold, keptFold, Splitter, useKeptSize } from './ui';

export type SideView = 'debug' | 'details';
export type PanelTab = 'console' | 'terminal' | 'problems';
/** Up to 860 px: one part at a time. */
export type PhoneTab = 'flow' | 'side' | 'panel';

/** Where the workbench stands: which views are open (the page may open one, as Show Terminal). */
export interface WorkbenchState {
  side: SideView;
  setSide(view: SideView): void;
  sideOpen: boolean;
  /** `keep`: the person folded or unfolded it (kept in this browser); a pause opening it is not. */
  setSideOpen(open: boolean, keep?: boolean): void;
  panel: PanelTab;
  /** Shows a tab of the panel, unfolding the panel. */
  setPanel(tab: PanelTab): void;
  /** AFS-266: the panel folded to its tab strip. */
  panelOpen: boolean;
  setPanelOpen(open: boolean): void;
  tab: PhoneTab;
  setTab(tab: PhoneTab): void;
}

/** Up to this width the side bar lies over the canvas; wider, it is beside it. */
export const NOT_WIDE = '(max-width: 1100px)';
/** Up to this width, the parts are tabs. */
export const PHONE = '(max-width: 860px)';
/** AFS-266: where this browser keeps the folds (the same on a run's page and a flow's page). */
export const SIDE_FOLDED = 'afs.workbench.sideFolded';
export const PANEL_FOLDED = 'afs.workbench.panelFolded';
export const TOOLBAR_AT = 'afs.workbench.toolbarX';

export function useWorkbenchState(debug: boolean): WorkbenchState {
  const wide = !useNarrow(NOT_WIDE);
  const wideRef = useRef(wide);
  wideRef.current = wide;
  const [side, setSide] = useState<SideView>(debug ? 'debug' : 'details');
  // Over the canvas (1100 px or less) it starts closed; beside it, as the person last left it.
  const [sideOpen, setSideShown] = useState(() => wide && !keptFold(SIDE_FOLDED));
  const [panel, setPanelTab] = useState<PanelTab>(debug ? 'console' : 'terminal');
  const [panelOpen, setPanelShown] = useState(() => !keptFold(PANEL_FOLDED));
  const [tab, setTab] = useState<PhoneTab>(debug ? 'side' : 'flow');
  const setSideOpen = useCallback((open: boolean, keep = false) => {
    setSideShown(open);
    if (keep && wideRef.current) keepFold(SIDE_FOLDED, !open);
  }, []);
  const setPanelOpen = useCallback((open: boolean) => {
    setPanelShown(open);
    keepFold(PANEL_FOLDED, !open);
  }, []);
  const setPanel = useCallback(
    (next: PanelTab) => {
      setPanelTab(next);
      setPanelOpen(true);
    },
    [setPanelOpen],
  );
  // A debug run seen after the page opened (the run's record came later): its views first.
  useEffect(() => {
    if (!debug) return;
    setSide('debug');
    setPanelTab('console');
  }, [debug]);
  // The window crossed the width: beside the canvas it is as kept, over it closed (not at first: a
  // pause may have opened it already).
  const wasWide = useRef(wide);
  useEffect(() => {
    if (wasWide.current === wide) return;
    wasWide.current = wide;
    setSideShown(wide && !keptFold(SIDE_FOLDED));
  }, [wide]);
  return {
    side,
    setSide,
    sideOpen,
    setSideOpen,
    panel,
    setPanel,
    panelOpen,
    setPanelOpen,
    tab,
    setTab,
  };
}

/** A run's pause points as the canvas has them: the ids, with the settings of those that have some. */
export function pointsOf(
  step: Pick<ShownStep, 'points' | 'settings'> | undefined,
  run: Pick<Run, 'step'>,
): PointSpec[] {
  if (!step) return run.step?.points ?? [];
  const settings = new Map((step.settings ?? []).map((p: PausePoint) => [p.node, p]));
  return step.points.map((id) => settings.get(id) ?? id);
}

/** The window's title at a pause. */
export const pausedTitle = (run: Pick<Run, 'flow' | 'number'>) =>
  `⏸ Paused · ${run.flow.name} #${run.number}`;

export function DebugWorkbench({
  run,
  step,
  active = true,
  debug: debugRun,
  going,
  mayDrive,
  mayStop = false,
  launcher,
  state,
  canvas,
  frame,
  details,
  kept,
  terminal,
  problems,
  problemCount = 0,
  toolbar,
  statusText,
  titleBase,
  statusExtra,
  sizeKey,
  onRestart,
  onRun,
  onError,
  onClose,
}: {
  run: Run;
  step: ShownStep | undefined;
  /**
   * The flow's page: false while no debug run is shown there; the canvas alone then, in the same
   * place (its frame is not loaded again when the views open around it).
   */
  active?: boolean;
  /** A debug run: the Run and Debug view, the Debug Console and the debug toolbar. */
  debug: boolean;
  going: boolean;
  mayDrive: boolean;
  mayStop?: boolean;
  launcher: string;
  state: WorkbenchState;
  /** The canvas: its frame stays put whatever the workbench shows around it. */
  canvas: ReactNode;
  frame(): HTMLIFrameElement | null | undefined;
  /** A run's page: what ran, its hosts, outputs and approvals. */
  details?: ReactNode;
  /** A debug run that ended: what its pauses showed. */
  kept?: ReactNode;
  terminal: ReactNode;
  problems?: ReactNode;
  problemCount?: number;
  /** Not a debug run: what the toolbar holds instead (a step-by-step run's bar, Stop). */
  toolbar?: ReactNode;
  /** Not a debug run: the status line. */
  statusText?: ReactNode;
  /** The window's title when the run is not paused (a run's page names the run). */
  titleBase?: string;
  /** More in the status line (the flow's page: a link to the run's page). */
  statusExtra?: ReactNode;
  /** Where the side bar's and the panel's sizes are kept. */
  sizeKey: string;
  onRestart?: (() => void) | undefined;
  onRun(run: Run): void;
  onError(message: string | undefined): void;
  /** The flow's page: closes the debug views (the canvas stays). */
  onClose?: () => void;
}) {
  const phone = useNarrow(PHONE);
  const wide = !useNarrow(NOT_WIDE);
  const debug = active && debugRun;
  const hasViews = debug || !!details;
  const s = useDebugSession({
    run,
    step,
    mayDrive: debug && mayDrive,
    mayStop: debug && mayStop,
    launcher,
    onRun,
    onError,
  });
  const drives = debug && mayDrive && going;
  const [sideSize, setSideSize] = useKeptSize(`afs.workbench.${sizeKey}.side`, 320);
  const [panelSize, setPanelSize] = useKeptSize(`afs.workbench.${sizeKey}.panel`, 220);
  const continueRef = useRef<HTMLButtonElement>(null);
  const [told, setTold] = useState<{ points: PointSpec[]; failures?: FailureFilters }>();
  const [selected, setSelected] = useState<string>();
  const points = told?.points ?? pointsOf(step, run);
  const failures = told ? told.failures : run.step?.failures;
  const names = useStepNames(run, debug && mayDrive && points.length > 0);

  // The canvas leaves its own step buttons to this toolbar (designer: config.hostToolbar).
  const hostToolbar = drives || (debug && going && mayStop);
  const tellToolbar = useCallback(
    () => tellFrame(frame(), { type: 'afs-host-toolbar', on: hostToolbar }),
    [frame, hostToolbar],
  );
  useEffect(() => {
    tellToolbar();
  }, [tellToolbar]);

  // What the canvas says.
  const sRef = useRef<DebugSession>(s);
  sRef.current = s;
  useEffect(() => {
    const heard = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const from = frame()?.contentWindow;
      if (!from || event.source !== from) return;
      const data = event.data as {
        type?: string;
        node?: string | null;
        points?: PointSpec[];
        failures?: FailureFilters;
        key?: string;
        shift?: boolean;
      } | null;
      if (data?.type === 'afs-canvas-ready') tellToolbar();
      else if (data?.type === 'afs-node-selected') setSelected(data.node ?? undefined);
      else if (data?.type === 'afs-points' && Array.isArray(data.points))
        setTold({ points: data.points, ...(data.failures ? { failures: data.failures } : {}) });
      else if (data?.type === 'afs-debug-key' && drives) {
        const command = debugKey(
          {
            key: String(data.key),
            shiftKey: !!data.shift,
            ctrlKey: false,
            metaKey: false,
            altKey: false,
          },
          !!sRef.current.pause,
        );
        if (command) void sRef.current.send(command);
      }
    };
    window.addEventListener('message', heard);
    return () => window.removeEventListener('message', heard);
  }, [frame, tellToolbar, drives]);

  // F5 Continue or Pause, F10 Step, Shift+F5 Stop (F8 too, as the canvas has it).
  const paused = !!s.pause;
  useEffect(() => {
    if (!drives) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const command = debugKey(e, paused);
      if (!command) return;
      e.preventDefault();
      if (!e.repeat) void sRef.current.send(command);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drives, paused]);

  // Ctrl+Shift+D: the Run and Debug view, as in VS Code (again: the side bar closes). AFS-266:
  // Ctrl+B folds the side bar and unfolds it, Ctrl+J the panel; the person's choice is kept.
  const stateRef = useRef(state);
  stateRef.current = state;
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      const st = stateRef.current;
      const onPhone = !!window.matchMedia?.(PHONE).matches;
      if (key === 'd' && e.shiftKey && debug) {
        e.preventDefault();
        if (onPhone) return st.setTab('side');
        if (st.sideOpen && st.side === 'debug') st.setSideOpen(false, true);
        else {
          st.setSide('debug');
          st.setSideOpen(true, true);
        }
      } else if (key === 'b' && !e.shiftKey && hasViews && !onPhone) {
        e.preventDefault();
        st.setSideOpen(!st.sideOpen, true);
      } else if (key === 'j' && !e.shiftKey && !onPhone) {
        e.preventDefault();
        st.setPanelOpen(!st.panelOpen);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [active, debug, hasViews]);

  // At a new pause: the side bar on Variables, the host marked on the canvas, the focus on Continue.
  const pauseId = s.pause?.id;
  const seen = useRef<string | undefined>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per pause
  useEffect(() => {
    if (!pauseId || seen.current === pauseId || !drives) return;
    seen.current = pauseId;
    state.setSide('debug');
    state.setSideOpen(true);
    if (phone) state.setTab('side');
    // Not revealed: that selects the step, and the canvas's own panel then takes half its room
    // (CI layout check). The canvas marks the paused step itself; Hosts and Pause points reveal.
    const typing = document.activeElement?.closest?.('textarea, input, select');
    if (!typing) continueRef.current?.focus({ preventScroll: true });
    notify(s);
  }, [pauseId, drives]);
  const host = s.host;
  // biome-ignore lint/correctness/useExhaustiveDependencies: when the host changes
  useEffect(() => {
    if (debug && mayDrive && pauseId) tellFrame(frame(), { type: 'afs-host', host: host ?? null });
  }, [host, pauseId]);

  // The window's title says the run is paused.
  const label = `${run.flow.name} #${run.number}`;
  useEffect(() => {
    if (!(debug && going && paused)) {
      if (titleBase) document.title = titleBase;
      return;
    }
    const before = document.title;
    document.title = `⏸ Paused · ${label}`;
    return () => {
      document.title = titleBase ?? before;
    };
  }, [debug, going, paused, titleBase, label]);

  const reveal = (node: string) => {
    tellFrame(frame(), { type: 'afs-reveal', node });
    if (phone) state.setTab('flow');
  };
  const setPoints = (next: PointSpec[], nextFailures?: FailureFilters) => {
    setTold({ points: next, ...(nextFailures ? { failures: nextFailures } : {}) });
    tellFrame(frame(), {
      type: 'afs-set-points',
      points: next,
      ...(nextFailures ? { failures: nextFailures } : {}),
    });
  };

  const views: { id: SideView; label: string; icon: 'debug' | 'details' }[] = [
    ...(debug ? [{ id: 'debug' as const, label: 'Run and Debug', icon: 'debug' as const }] : []),
    ...(details ? [{ id: 'details' as const, label: 'Details', icon: 'details' as const }] : []),
  ];
  const view = views.some((v) => v.id === state.side) ? state.side : views[0]?.id;
  const sideShown = phone ? state.tab === 'side' : state.sideOpen && !!view;
  const panelTabs: { id: PanelTab; label: string }[] = [
    ...(debug ? [{ id: 'console' as const, label: 'Debug Console' }] : []),
    { id: 'terminal', label: 'Terminal' },
    ...(problems ? [{ id: 'problems' as const, label: 'Problems' }] : []),
  ];
  const panel = panelTabs.some((t) => t.id === state.panel) ? state.panel : 'terminal';
  const phoneTabs: { id: PhoneTab; label: string }[] = [
    { id: 'flow', label: 'Flow' },
    ...(view ? [{ id: 'side' as const, label: debug ? 'Debug' : 'Details' }] : []),
    { id: 'panel', label: debug ? 'Console' : 'Output' },
  ];
  const shows = (t: PhoneTab) => !phone || state.tab === t;
  // A phone shows one part at a time: the panel is never folded there.
  const panelOpen = phone || state.panelOpen;
  const tools = debug && ((going && (s.mayDrive || s.mayStop)) || (!going && !!onRestart));
  const debugBar = (
    <DebugToolbar s={s} going={going} onRestart={onRestart} continueRef={continueRef} />
  );

  const status = debug ? (
    <>
      <strong>{s.reason}</strong>
      {going && mayDrive && s.pause && <span> · paused by {launcher}</span>}
      {going && !mayDrive && (
        <span className="muted">
          {' '}
          · {s.pause ? `Paused by ${launcher}` : `Debugged by ${launcher}`}: only {launcher} or an
          administrator drives it and sees its variables
        </span>
      )}
    </>
  ) : (
    statusText
  );

  return (
    <div
      className={`workbench${!active ? ' wb-off' : phone ? ' wb-phone' : wide ? ' wb-wide' : ' wb-overlay'}${
        sideShown ? ' wb-side-open' : ''
      }${s.pause ? ' wb-paused' : ''}`}
      style={
        {
          '--wb-side': `${sideSize}px`,
          '--wb-panel': `${panelSize}px`,
        } as CSSProperties
      }
      data-workbench
    >
      {active && (phone ? debug && tools : !debug && toolbar) && (
        <div className="wb-bar">{debug ? debugBar : toolbar}</div>
      )}
      {active && phone && (
        <WorkbenchTabs
          tabs={phoneTabs}
          tab={state.tab}
          onTab={state.setTab}
          label="Parts of the debugger"
          idOf={(t) => `wb-tab-${t}`}
          controls={(t) => (t === 'flow' ? 'wb-canvas' : t === 'side' ? 'wb-side' : 'wb-panel')}
        />
      )}
      <div className="wb-body">
        {active && !phone && views.length > 0 && (
          <nav className="wb-activity" aria-label="Side bar views">
            {views.map((v) => (
              <button
                key={v.id}
                type="button"
                className="icon-button"
                aria-label={v.label}
                title={`${v.label} (${v.id === 'debug' ? 'Ctrl+Shift+D' : 'Ctrl+B'})`}
                aria-pressed={sideShown && view === v.id}
                aria-controls="wb-side"
                onClick={() => {
                  if (sideShown && view === v.id) state.setSideOpen(false, true);
                  else {
                    state.setSide(v.id);
                    state.setSideOpen(true, true);
                  }
                }}
              >
                <Icon name={v.icon} />
              </button>
            ))}
          </nav>
        )}
        {active && (
          <aside
            className="wb-side"
            id="wb-side"
            aria-label={view === 'debug' ? 'Run and Debug' : 'Details'}
            hidden={!sideShown}
            {...(phone ? { role: 'tabpanel', 'aria-labelledby': 'wb-tab-side' } : {})}
          >
            {phone && views.length > 1 && (
              <fieldset className="wb-side-switch">
                <legend className="sr-only">Side bar views</legend>
                {views.map((v) => (
                  <button
                    key={v.id}
                    type="button"
                    aria-pressed={view === v.id}
                    onClick={() => state.setSide(v.id)}
                  >
                    {v.label}
                  </button>
                ))}
              </fieldset>
            )}
            <div className="wb-side-body" hidden={view !== 'debug'} id="run-debugger">
              {debug && going && mayDrive && (
                <>
                  <Section title="Variables">
                    <VariablesView s={s} />
                  </Section>
                  <Section title="Watch">
                    <WatchView s={s} />
                  </Section>
                  <Section title="Hosts">
                    <HostsView s={s} />
                  </Section>
                  <Section title="Pause points">
                    <PointsView
                      points={points}
                      failures={failures}
                      names={names}
                      onChange={setPoints}
                      onReveal={reveal}
                      selected={selected}
                    />
                  </Section>
                </>
              )}
              {debug && going && !mayDrive && (
                <p className="muted small wb-empty" data-debug-reader>
                  {s.pause ? `Paused by ${launcher}` : `Debugged by ${launcher}`}: only {launcher}{' '}
                  or an administrator drives it and sees its variables.
                </p>
              )}
              {debug && !going && kept}
            </div>
            {details && (
              <div className="wb-side-body" hidden={view !== 'details'} id="run-details">
                {details}
              </div>
            )}
          </aside>
        )}
        {active && !phone && sideShown && (
          <Splitter
            orientation="vertical"
            size={sideSize}
            min={220}
            max={640}
            label="Side bar width"
            controls="wb-side"
            onSize={setSideSize}
          />
        )}
        <div className="wb-main" hidden={active && phone && state.tab === 'side'}>
          <section
            className="wb-canvas"
            id="wb-canvas"
            aria-label="The run on the flow's canvas"
            hidden={active && !shows('flow')}
            {...(phone ? { role: 'tabpanel', 'aria-labelledby': 'wb-tab-flow' } : {})}
          >
            {canvas}
            {debug && tools && !phone && <FloatingBar>{debugBar}</FloatingBar>}
          </section>
          {active && !phone && panelOpen && (
            <Splitter
              orientation="horizontal"
              size={panelSize}
              min={96}
              max={720}
              label="Panel height"
              controls="wb-panel"
              onSize={setPanelSize}
            />
          )}
          {active && (
            <section
              className={panelOpen ? 'wb-panel' : 'wb-panel wb-panel-folded'}
              id="wb-panel"
              aria-label="Panel"
              hidden={!shows('panel')}
              {...(phone ? { role: 'tabpanel', 'aria-labelledby': 'wb-tab-panel' } : {})}
            >
              <WorkbenchTabs
                tabs={panelTabs.map((t) =>
                  t.id === 'problems' && problemCount
                    ? { ...t, label: `${t.label} ${problemCount}` }
                    : t,
                )}
                tab={panel}
                onTab={state.setPanel}
                label="Panel views"
                idOf={(t) => `wb-panel-tab-${t}`}
                controls={(t) => `wb-panel-${t}`}
                end={
                  !phone && (
                    <button
                      type="button"
                      className="icon-button wb-fold"
                      aria-label={panelOpen ? 'Fold the panel' : 'Unfold the panel'}
                      title={`${panelOpen ? 'Fold the panel' : 'Unfold the panel'} (Ctrl+J)`}
                      aria-expanded={panelOpen}
                      aria-keyshortcuts="Control+J"
                      onClick={() => state.setPanelOpen(!panelOpen)}
                    >
                      <Icon name={panelOpen ? 'chevron-down' : 'chevron-up'} />
                    </button>
                  )
                }
              />
              {debug && (
                <div
                  className="wb-panel-body"
                  id="wb-panel-console"
                  role="tabpanel"
                  aria-labelledby="wb-panel-tab-console"
                  hidden={!panelOpen || panel !== 'console'}
                >
                  {mayDrive ? (
                    <ConsoleView s={s} />
                  ) : (
                    <p className="muted small wb-empty">
                      Only {launcher} or an administrator evaluates in this run.
                    </p>
                  )}
                </div>
              )}
              <div
                className="wb-panel-body"
                id="wb-panel-terminal"
                role="tabpanel"
                aria-labelledby="wb-panel-tab-terminal"
                hidden={!panelOpen || panel !== 'terminal'}
              >
                {terminal}
              </div>
              {problems && (
                <div
                  className="wb-panel-body"
                  id="wb-panel-problems"
                  role="tabpanel"
                  aria-labelledby="wb-panel-tab-problems"
                  hidden={!panelOpen || panel !== 'problems'}
                >
                  {problems}
                </div>
              )}
            </section>
          )}
        </div>
      </div>
      {active && (
        <div className="wb-status" data-debug-status>
          <div className="debug-reason" role="status" aria-live="polite" data-debug-reason>
            {status}
          </div>
          {statusExtra}
          {drives && <NotifyOffer />}
          {onClose && !going && (
            <button type="button" className="link small" onClick={onClose}>
              Close the debugger
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** A part of the Run and Debug view, folded by its title (all open at first). */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="wb-section" open>
      <summary>
        <h3>{title}</h3>
      </summary>
      <div className="wb-section-body">{children}</div>
    </details>
  );
}

/** Tabs that are not addresses (the panel's views, a phone's parts), with the arrow keys. */
function WorkbenchTabs<T extends string>({
  tabs,
  tab,
  onTab,
  label,
  idOf,
  controls,
  end,
}: {
  tabs: { id: T; label: string }[];
  tab: T;
  onTab(tab: T): void;
  label: string;
  idOf(tab: T): string;
  controls(tab: T): string;
  /** AFS-266: after the tabs, at the strip's end (the panel's fold). */
  end?: ReactNode;
}) {
  const strip = (
    <div className="wb-tabs" role="tablist" aria-label={label}>
      {tabs.map((t, i) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          id={idOf(t.id)}
          aria-selected={tab === t.id}
          aria-controls={controls(t.id)}
          tabIndex={tab === t.id ? 0 : -1}
          onClick={() => onTab(t.id)}
          onKeyDown={(e) => {
            const to =
              e.key === 'ArrowRight'
                ? (i + 1) % tabs.length
                : e.key === 'ArrowLeft'
                  ? (i - 1 + tabs.length) % tabs.length
                  : undefined;
            if (to === undefined) return;
            e.preventDefault();
            const next = tabs[to];
            if (!next) return;
            onTab(next.id);
            document.getElementById(idOf(next.id))?.focus();
          }}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
  if (!end) return strip;
  return (
    <div className="wb-strip">
      {strip}
      {end}
    </div>
  );
}

/** Where the floating toolbar was left, as px from the canvas's centre (0 there, or none kept). */
function keptOffset(): number {
  try {
    const at = Number(window.localStorage.getItem(TOOLBAR_AT));
    return Number.isFinite(at) ? at : 0;
  } catch {
    return 0;
  }
}

/**
 * AFS-266: the debug toolbar floats over the top centre of the canvas, under the canvas's own top
 * bar, as VS Code's does over the editor. Its grip drags it sideways (a step it covers comes out
 * from under it); where it was left is kept in this browser. A double click on the grip centres it.
 */
function FloatingBar({ children }: { children: ReactNode }) {
  const [offset, setOffset] = useState(keptOffset);
  const box = useRef<HTMLDivElement>(null);
  const place = (next: number) => {
    setOffset(next);
    try {
      window.localStorage.setItem(TOOLBAR_AT, String(Math.round(next)));
    } catch {
      // Not kept: the next page has it in the centre.
    }
  };
  const onPointerDown = (e: ReactPointerEvent<HTMLSpanElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const grip = e.currentTarget;
    const from = e.clientX;
    const start = offset;
    const bar = box.current;
    const room = bar?.parentElement;
    // It stays inside the canvas: half the canvas's width less half its own each way.
    const most = room && bar ? Math.max(0, (room.clientWidth - bar.offsetWidth) / 2 - 8) : 0;
    grip.setPointerCapture?.(e.pointerId);
    const move = (m: PointerEvent) =>
      place(Math.min(most, Math.max(-most, start + m.clientX - from)));
    const up = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      grip.removeEventListener('pointercancel', up);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', up);
  };
  return (
    <div
      className="wb-float"
      ref={box}
      style={{ '--wb-float-x': `${offset}px` } as CSSProperties}
      data-debug-float
    >
      <span
        className="wb-grip"
        aria-hidden="true"
        title="Drag to move the toolbar; double-click to centre it"
        onPointerDown={onPointerDown}
        onDoubleClick={() => place(0)}
      >
        <Icon name="grip" />
      </span>
      {children}
    </div>
  );
}

/** Notifications are allowed and the tab is hidden: the pause is said there too. */
function notify(s: DebugSession): void {
  try {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    if (!document.hidden) return;
    const note = new Notification(pausedTitle(s.run), { body: s.reason, tag: `afs-${s.run.id}` });
    note.onclick = () => {
      window.focus();
      note.close();
    };
  } catch {
    // A browser that has none: the title says it.
  }
}

/** Asks once whether pauses may be told by a notification while the tab is hidden. */
function NotifyOffer() {
  const [asked, setAsked] = useState(() =>
    typeof Notification === 'undefined' ? 'denied' : Notification.permission,
  );
  const offered = useMemo(() => asked === 'default', [asked]);
  if (!offered) return null;
  return (
    <button
      type="button"
      className="link small"
      title="A notification at each pause while this tab is hidden"
      onClick={() => {
        void Notification.requestPermission().then(setAsked, () => setAsked('denied'));
      }}
    >
      Notify me at pauses
    </button>
  );
}

/** The flow's page before a debug run is shown there: the workbench holds the canvas alone. */
export const NO_RUN = {
  id: '',
  number: 0,
  project: '',
  commit: '',
  flow: { file: '', key: '', name: '', version: 0 },
  mode: 'check',
  state: 'succeeded',
  inputs: {},
  targets: [],
  credentials: [],
  requestedBy: { id: '', login: '' },
  createdAt: '',
  attempts: 0,
  cancelRequested: false,
} as unknown as Run;
