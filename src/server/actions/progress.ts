// AFS-175: how a run of an action goes, in words (ADR-0036): the steps by title, done of N, who
// an approval waits for, done or failed with the reason, whom to ask. No step keys, no Ansible
// words but those of a reason Ansible gave.
import type { FlowDocument, FlowNode } from '@ansible-flow/core/flow/types';
import type { RunView } from '@ansible-flow/core/protocol';
import { inputText } from '@ansible-flow/core/run/launch';
import type { Gate } from '../approvals/types';
import type { Run } from '../runs/queue';
import { failedWhy, stoppedBy } from '../runs/words';
import type { Action, ActionInput, ActionProgress, ActionRunLine, StepState } from './types';

/** The steps a person sees: the work, not where it goes (start, end, decisions, joins). */
const STEP_TYPES = new Set(['task', 'subflow', 'approval']);
/** Ports a host leaves by when something went wrong: off the way a run goes when all is well. */
const OFF_PATH = /fail|reject|timeout|timed|unreach|error|rescue/i;

/**
 * The top-level steps of a flow, in the order a run that goes well takes them, then the others
 * (rollback, notify on failure), marked `onPath: false`.
 */
export function flowSteps(doc: FlowDocument): { node: FlowNode; onPath: boolean }[] {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const start = doc.nodes.find((n) => n.type === 'start');
  const order: string[] = [];
  const seen = new Set<string>();
  const queue = start ? [start.id] : [];
  while (queue.length) {
    const id = queue.shift() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    order.push(id);
    for (const e of doc.edges)
      if (e.from.node === id && !OFF_PATH.test(e.from.port) && !seen.has(e.to.node))
        queue.push(e.to.node);
  }
  const shown = (n: FlowNode | undefined): n is FlowNode =>
    !!n && STEP_TYPES.has(n.type) && !n.disabled;
  const onPath = order.map((id) => byId.get(id)).filter(shown);
  const others = doc.nodes.filter((n) => shown(n) && !seen.has(n.id));
  return [
    ...onPath.map((node) => ({ node, onPath: true })),
    ...others.map((node) => ({ node, onPath: false })),
  ];
}

/** The top-level step a node is in (itself, or the subflow holding it). */
function topOf(doc: FlowDocument, id: string | undefined): string | undefined {
  if (!id) return undefined;
  const inside = (nodes: readonly FlowNode[]): boolean =>
    nodes.some((n) => n.id === id || inside(n.subflow?.nodes ?? []));
  return doc.nodes.find((n) => n.id === id || inside(n.subflow?.nodes ?? []))?.id;
}

/** A run's state in the words of a card. */
export function runWords(run: Pick<Run, 'state' | 'decidedAgainst'>): string {
  if (run.state === 'failed' && run.decidedAgainst)
    return run.decidedAgainst === 'rejected' ? 'rejected' : 'nobody decided in time';
  return (
    {
      queued: 'waiting to start',
      running: 'running',
      waiting: 'waiting for approval',
      succeeded: 'went well',
      failed: 'failed',
      cancelled: 'stopped',
      lost: 'lost',
    }[run.state] ?? run.state
  );
}

export function runLine(run: Run): ActionRunLine {
  return {
    id: run.id,
    number: run.number,
    state: run.state,
    createdAt: run.createdAt,
    ...(run.endedAt ? { endedAt: run.endedAt } : {}),
    words: runWords(run),
  };
}

const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);
const list = (names: readonly string[]) =>
  names.length <= 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;

export interface ProgressInput {
  run: Run;
  /** The run's flow at its commit; undefined when it cannot be read any more. */
  doc?: FlowDocument;
  view?: RunView;
  gates: Gate[];
  /** Who may decide the gate the run waits at, by name. */
  deciders: string[];
  /** The action as it is now (its labels); undefined when it was removed since. */
  action?: Action;
  /** The person who started it, by name. */
  startedBy: string;
  ask: string[];
  runPage?: string;
  again?: string;
}

export function progressOf(p: ProgressInput): ActionProgress {
  const { run, doc, view, gates } = p;
  const summary = view?.summary;
  const ended = !['queued', 'running', 'waiting'].includes(run.state);
  const gateOf = new Map(gates.map((g) => [g.node.id, g]));
  const ran = new Set<string>();
  const failedAt = new Set<string>();
  if (doc && summary) {
    for (const id of [...Object.keys(summary.nodes), ...Object.keys(summary.timings ?? {})]) {
      const top = topOf(doc, id);
      if (top) ran.add(top);
    }
    const lost = new Set([
      ...Object.keys(summary.outcome),
      ...summary.failures.map((f) => f.host),
      ...summary.unreachable,
    ]);
    for (const f of summary.failures) {
      const top = topOf(doc, f.node);
      if (top) failedAt.add(top);
    }
    for (const [node, hosts] of Object.entries(summary.problems ?? {}))
      if (Object.keys(hosts).some((h) => lost.has(h))) {
        const top = topOf(doc, node);
        if (top) failedAt.add(top);
      }
  }
  const running = doc && !ended ? topOf(doc, summary?.running) : undefined;
  const steps: ActionProgress['steps'] = [];
  for (const { node, onPath } of doc ? flowSteps(doc) : []) {
    const gate = gateOf.get(node.id);
    let state: StepState;
    if (gate)
      state =
        gate.status === 'approved'
          ? 'done'
          : gate.status === 'waiting'
            ? 'waiting'
            : gate.status === 'cancelled'
              ? 'not run'
              : 'failed';
    else if (failedAt.has(node.id)) state = 'failed';
    else if (node.id === running) state = 'running';
    else if (ran.has(node.id)) state = 'done';
    else state = ended ? 'not run' : 'to do';
    // A step off the way a good run goes is shown only when it ran.
    if (!onPath && (state === 'to do' || state === 'not run')) continue;
    steps.push({ id: node.id, title: node.title || node.key, state });
  }
  // A run that went well and did not say each step (an old view): its way is done.
  if (run.state === 'succeeded' && !summary)
    for (const s of steps) if (s.state === 'not run') s.state = 'done';
  const counted = ended ? steps.filter((s) => s.state !== 'not run') : steps;
  const done = steps.filter((s) => s.state === 'done').length;
  const total = counted.length;

  const waitingGate = gates.find((g) => g.status === 'waiting');
  const waiting =
    run.state === 'waiting' && waitingGate
      ? { step: waitingGate.node.title, by: p.deciders, since: waitingGate.createdAt }
      : undefined;
  const decided = gates.find((g) => g.status === 'rejected' || g.status === 'timed out');

  let failed: string | undefined;
  if (run.state === 'failed' && decided) {
    const who = decided.decidedByName ?? decided.decidedBy;
    failed =
      decided.status === 'rejected'
        ? `${decided.node.title} was rejected${who ? ` by ${who}` : ''}${decided.comment ? `: ${decided.comment}` : ''}`
        : `Nobody decided ${decided.node.title} in time`;
  } else if (run.state === 'failed' || run.state === 'lost')
    failed =
      view?.summary && doc
        ? failedWhy(view, doc.nodes, view.rc, view.error ?? run.error)
        : (run.error ?? 'It stopped on an error');

  const step = steps.findIndex((s) => s.state === 'running');
  const headline = ((): string => {
    switch (run.state) {
      case 'queued':
        return 'Waiting to start: it starts as soon as the server has room for it.';
      case 'running':
        // AFS-177: actions never start step by step; a step-by-step run of one says where it waits.
        if (run.pausedBefore)
          return `Paused before ${run.pausedBefore}: it goes on when someone says Step or Continue on its page.`;
        return step >= 0
          ? `Running step ${step + 1} of ${total}: ${steps[step]?.title}.`
          : `Running: ${done} of ${total} steps done.`;
      case 'waiting':
        return waiting
          ? `Waiting for approval at ${waiting.step}${waiting.by.length ? ` by ${list(waiting.by)}` : ''}.`
          : 'Waiting for approval.';
      case 'succeeded':
        return run.mode === 'check'
          ? 'Done: the check went well. Nothing was changed.'
          : 'Done: it went well.';
      case 'cancelled':
        return sentence(
          stoppedBy(run.error, run.cancelledBy) ??
            `Stopped${run.cancelledBy ? ` by ${run.cancelledBy}` : ''}`,
        );
      case 'lost':
        return sentence(`Lost: the server stopped while it ran. ${failed ?? ''}`.trim());
      default:
        return sentence(`Failed: ${failed ?? 'it stopped on an error'}`);
    }
  })();

  const labels = new Map<string, ActionInput>((p.action?.asked ?? []).map((a) => [a.name, a]));
  const inputs = [...labels.values()]
    .filter((a) => a.name in run.inputs)
    .map((a) => ({ label: a.label, value: inputText(run.inputs[a.name]) }));

  return {
    action: { id: run.config?.id ?? '', title: run.action ?? p.action?.title ?? run.flow.name },
    run: {
      ...runLine(run),
      mode: run.mode,
      startedBy: p.startedBy,
      ...(run.startedAt ? { startedAt: run.startedAt } : {}),
    },
    headline,
    steps,
    done,
    total,
    ...(waiting ? { waiting } : {}),
    ...(failed && (run.state === 'failed' || run.state === 'lost') ? { failed } : {}),
    ask: p.ask,
    inputs,
    ...(p.runPage ? { runPage: p.runPage } : {}),
    ...(p.again ? { again: p.again } : {}),
  };
}
