// AFS-265: a run's events (its record, its view, its output, its end) as one stream per page.
// The page holds the EventSource; the canvas in its frame (viewer.ts, opened with `feed=1`) asks
// for the run it shows (`afs-watch-run`) and gets the same events by postMessage
// (`afs-run-event`), so a run on the screen is followed once, not by the page and the frame each.
import type { RunView } from '@ansible-flow/core/protocol';
import { useEffect, useMemo, useState } from 'react';
import { ApiError, api, type Run } from './api';

/** The output a page keeps; the rest is in the run's output file. */
export const KEEP_OUTPUT = 2 * 1024 * 1024;

/** What a run's events are called on the stream (and in `afs-run-event`). */
export type FeedKind = 'run' | 'view' | 'output' | 'end';
type Listener = (kind: FeedKind, data: unknown) => void;

/** One run's event stream, with the last record and view kept for whoever joins later. */
export class Feed {
  private readonly source: EventSource;
  private readonly listeners = new Set<Listener>();
  private last: { run?: unknown; view?: unknown; end?: unknown } = {};
  closed = false;

  constructor(readonly id: string) {
    this.source = new EventSource(`/api/v1/runs/${encodeURIComponent(id)}/events`);
    for (const kind of ['run', 'view', 'output', 'end'] as const)
      this.source.addEventListener(kind, (event) => {
        const data = JSON.parse((event as MessageEvent).data || 'null') as unknown;
        if (kind !== 'output') this.last[kind] = data;
        for (const listener of this.listeners) listener(kind, data);
        if (kind === 'end') this.source.close();
      });
  }

  /** Listens from now on; `replay`: first the record, the view and the end heard so far. */
  listen(listener: Listener, replay = false): () => void {
    this.listeners.add(listener);
    if (replay)
      for (const kind of ['run', 'view', 'end'] as const)
        if (this.last[kind] !== undefined) listener(kind, this.last[kind]);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.closed = true;
    this.listeners.clear();
    this.source.close();
  }
}

export interface RunFeedState {
  run?: Run;
  view?: RunView;
  /** AFS-177: a step-by-step run's state, from its live view; set only when it changes. */
  step?: RunView['step'];
  output: string;
  error?: string;
  /** AFS-152: the run is not there, or not shared with this person. */
  missing: boolean;
  feed?: Feed;
}

/**
 * The run `id` followed live: its record first (asked once; AFS-152: the events only once it is
 * there, not after a 404), then everything after from its events.
 */
export function useRunFeed(id: string | undefined): RunFeedState & {
  setRun(run: Run): void;
  setView(view: RunView): void;
  setError(error: string | undefined): void;
} {
  const [state, setState] = useState<RunFeedState>({ output: '', missing: false });
  useEffect(() => {
    setState({ output: '', missing: false });
    if (!id) return;
    let live = true;
    let feed: Feed | undefined;
    api.run(id).then(
      (found) => {
        if (!live) return;
        feed = new Feed(id);
        setState((s) => ({ ...s, run: found, feed }));
        let lastStep = '';
        feed.listen((kind, data) => {
          if (kind === 'run') setState((s) => ({ ...s, run: data as Run }));
          else if (kind === 'view') {
            const said = data as RunView;
            // AFS-258: the view of a run that ended comes here (not from /view, which has none
            // for a run that never started).
            const text = JSON.stringify(said.step ?? null);
            const changed = !!found.step && text !== lastStep;
            lastStep = text;
            setState((s) => ({ ...s, view: said, ...(changed ? { step: said.step } : {}) }));
          } else if (kind === 'output') {
            const { text } = data as { text: string };
            setState((s) => ({ ...s, output: kept(s.output + text) }));
          }
        });
      },
      (e: Error) => {
        if (!live) return;
        if (e instanceof ApiError && e.status === 404) setState((s) => ({ ...s, missing: true }));
        else setState((s) => ({ ...s, error: e.message }));
      },
    );
    return () => {
      live = false;
      feed?.close();
    };
  }, [id]);
  const setters = useMemo(
    () => ({
      setRun: (run: Run) => setState((s) => ({ ...s, run })),
      setView: (view: RunView) => setState((s) => ({ ...s, view })),
      setError: (error: string | undefined) =>
        setState((s) => {
          const { error: _, ...rest } = s;
          return error ? { ...rest, error } : rest;
        }),
    }),
    [],
  );
  return { ...state, ...setters };
}

/** The end of the output, at most KEEP_OUTPUT, cut at a line's start (no colour code cut in two). */
function kept(all: string): string {
  if (all.length <= KEEP_OUTPUT) return all;
  const cut = all.indexOf(String.fromCharCode(10), all.length - KEEP_OUTPUT);
  return cut < 0 ? all.slice(all.length - KEEP_OUTPUT) : all.slice(cut + 1);
}

/** The run the canvas in `frame` asks for (`afs-watch-run`), the last one it asked. */
export function useFrameAsked(
  frame: () => HTMLIFrameElement | null | undefined,
): string | undefined {
  const [asked, setAsked] = useState<string>();
  useEffect(() => {
    const heard = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const from = frame()?.contentWindow;
      if (!from || event.source !== from) return;
      const data = event.data as { type?: string; id?: string } | null;
      if (data?.type === 'afs-watch-run' && typeof data.id === 'string') setAsked(data.id);
    };
    window.addEventListener('message', heard);
    return () => window.removeEventListener('message', heard);
  }, [frame]);
  return asked;
}

/**
 * The run `asked` for by the canvas in `frame`, fed to it: from `own` when that is the run
 * (replayed from its start), else, unless `adopt` (the page follows what the frame asks for and
 * passes that feed as `own` once it is open), from a feed of its own.
 */
export function useFrameForward(
  frame: () => HTMLIFrameElement | null | undefined,
  asked: string | undefined,
  own: Feed | undefined,
  adopt = false,
): void {
  useEffect(() => {
    if (!asked) return;
    const source = own?.id === asked ? own : adopt ? undefined : new Feed(asked);
    if (!source) return;
    const stop = source.listen((kind, data) => {
      if (kind === 'output') return;
      frame()?.contentWindow?.postMessage(
        { type: 'afs-run-event', id: asked, kind, data },
        window.location.origin,
      );
    }, true);
    return () => {
      stop();
      if (source !== own) source.close();
    };
  }, [asked, own, adopt, frame]);
}

/** A run's page: the canvas gets its run from the page's feed (another run from one of its own). */
export function useFrameFeed(
  frame: () => HTMLIFrameElement | null | undefined,
  own: Feed | undefined,
): string | undefined {
  const asked = useFrameAsked(frame);
  useFrameForward(frame, asked, own);
  return asked;
}

/** AFS-265: a message to the canvas in `frame` (the page's half of the protocol). */
export function tellFrame(
  frame: HTMLIFrameElement | null | undefined,
  message: { type: string } & Record<string, unknown>,
): void {
  frame?.contentWindow?.postMessage(message, window.location.origin);
}
