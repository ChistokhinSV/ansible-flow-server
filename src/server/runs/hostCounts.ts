// AFS-105: a run's host counts, read from its view (the designer's RunView, or its JSON): the hosts
// it ran on, and those that failed or were not reached (as the designer's run list counts them).
// Kept beside the view, so a list of runs says them without reading every view.

interface ViewSummary {
  summary?: {
    hosts?: unknown[];
    outcome?: Record<string, unknown>;
    failures?: { host?: string }[];
  };
}

/** The counts as columns of `run`; none for a view that has no summary yet. */
export function hostCounts(
  view: unknown,
): { host_count: number; failed_count: number } | Record<string, never> {
  let v: ViewSummary | undefined;
  try {
    v = (typeof view === 'string' ? JSON.parse(view) : view) as ViewSummary | undefined;
  } catch {
    return {};
  }
  const summary = v?.summary;
  if (!summary || !Array.isArray(summary.hosts)) return {};
  const failed = new Set([
    ...Object.keys(summary.outcome ?? {}),
    ...(summary.failures ?? []).flatMap((f) => (typeof f?.host === 'string' ? [f.host] : [])),
  ]);
  return { host_count: summary.hosts.length, failed_count: failed.size };
}
