// Approvals on the pages (AFS-28): the inbox of what waits for a decision, and a run's approvals
// on its page. Who may decide is the server's to say (`mayDecide`, else why not); a decision
// takes a comment, kept with it and shown to everyone who looks at the run.
import { type FormEvent, useEffect, useId, useState } from 'react';
import { decidersWords } from '../server/approvals/types';
import { api, type Gate } from './api';
import { Link } from './router';
import { ago, Loading, messageOf, PageHead, span, Time, useLoad } from './ui';

/** AFS-133: the sidebar's count and other lists read again once a decision is made. */
export const APPROVALS_CHANGED = 'afs-approvals-changed';

/**
 * Approve or reject, with a comment (required to reject). Each asks once more, naming what
 * happens next (AFS-133). Resolves when the server has it.
 */
function DecideForm({
  title,
  next,
  onDecide,
}: {
  title: string;
  /** AFS-146: where each decision sends the waiting hosts. */
  next?: Gate['next'] | undefined;
  onDecide(decision: 'approved' | 'rejected', comment: string): Promise<void>;
}) {
  const id = useId();
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [asking, setAsking] = useState<'approved' | 'rejected'>();
  const decide = async (decision: 'approved' | 'rejected') => {
    setBusy(true);
    setError(undefined);
    try {
      await onDecide(decision, comment.trim());
      window.dispatchEvent(new Event(APPROVALS_CHANGED));
    } catch (e) {
      setError(messageOf(e));
      setBusy(false);
      setAsking(undefined);
    }
  };
  const ask = (decision: 'approved' | 'rejected', event?: FormEvent) => {
    event?.preventDefault();
    if (decision === 'rejected' && !comment.trim()) {
      setError('Say why you reject it: the comment is kept with the run.');
      document.getElementById(`${id}-comment`)?.focus();
      return;
    }
    setError(undefined);
    setAsking(decision);
  };
  if (asking)
    return (
      <fieldset className="form decide" aria-label="Confirm the decision">
        <p>
          {asking === 'approved'
            ? `Approve "${title}"? The hosts waiting here go on to ${next?.approved ? `"${next.approved}"` : 'the next steps'}.`
            : `Reject "${title}"? The hosts waiting here ${next?.rejected ? `go to "${next.rejected}"` : 'take the rejected path'}, not on to the change.`}
        </p>
        {/* AFS-146: what will be kept with the decision stays in sight while it is confirmed. */}
        {comment.trim() ? (
          <p data-confirm-comment>
            Your comment: <q className="comment">{comment.trim()}</q>
          </p>
        ) : (
          <p className="muted">No comment.</p>
        )}
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
        <div className="actions">
          <button
            type="button"
            className={asking === 'approved' ? 'primary' : 'danger'}
            disabled={busy}
            onClick={() => void decide(asking)}
          >
            {asking === 'approved' ? 'Approve' : 'Reject'}
          </button>
          <button
            type="button"
            className="neutral"
            disabled={busy}
            onClick={() => setAsking(undefined)}
          >
            Keep waiting
          </button>
        </div>
      </fieldset>
    );
  return (
    <form className="form decide" onSubmit={(e) => ask('approved', e)}>
      <div className="field">
        <label htmlFor={`${id}-comment`}>Comment</label>
        <textarea
          id={`${id}-comment`}
          rows={2}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Why, for the record (required to reject)"
          maxLength={2000}
        />
      </div>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        <button type="submit" className="primary" disabled={busy}>
          Approve…
        </button>
        <button type="button" disabled={busy} onClick={() => ask('rejected')}>
          Reject…
        </button>
      </div>
    </form>
  );
}

/** How a check run went, as the evidence line says it. */
const WENT: Record<string, string> = {
  succeeded: 'went well',
  failed: 'failed',
  cancelled: 'was stopped',
  lost: 'was lost',
};

/**
 * AFS-271 (ADR-0039 §8): what a decision lets happen, said before anyone decides: the steps the
 * hosts go through once approved, where a rejection and the timeout send them, and the last check
 * run of the same launch configuration. Worded for whoever reads it, decider or not.
 */
function Consequences({ gate }: { gate: Gate }) {
  const after = gate.after?.length ? gate.after : gate.next?.approved ? [gate.next.approved] : [];
  // ADR-0021: a gate that times out takes its timeout port, or the rejected one when it has none.
  const atTimeout = gate.next?.timeout ?? gate.next?.rejected;
  const check = gate.evidence?.checkRun;
  return (
    <dl className="gate-next" data-gate-next>
      <dt>If approved</dt>
      <dd data-gate-after>
        {after.length
          ? `The hosts go on: ${after.join(' › ')}`
          : 'The hosts go on to the next steps'}
      </dd>
      <dt>If rejected</dt>
      <dd>
        {gate.next?.rejected ? `The hosts go to "${gate.next.rejected}"` : 'The hosts do not go on'}
      </dd>
      {gate.deadline && (
        <>
          <dt>If nobody decides</dt>
          <dd>
            At <Time at={gate.deadline} /> it times out
            {atTimeout ? ` and the hosts go to "${atTimeout}"` : ''}
          </dd>
        </>
      )}
      {gate.evidence && (
        <>
          <dt>Evidence</dt>
          <dd data-gate-evidence>
            {check ? (
              <>
                <Link to={`/runs/${encodeURIComponent(check.id)}`}>Check run #{check.number}</Link>{' '}
                of this launch configuration {WENT[check.state] ?? check.state}
                {check.endedAt ? `, ${ago(check.endedAt)}` : ''},{' '}
                {check.sameCommit ? 'at the same commit' : 'at another commit'}
              </>
            ) : (
              'No check run of this launch configuration before this run'
            )}
          </dd>
        </>
      )}
    </dl>
  );
}

/** AFS-146: who may decide a gate, by name, as a phrase. */
export function decidersText(gate: Gate): string {
  return decidersWords(gate.deciders ?? gate.approvers);
}

/** AFS-146: a run's inputs as the approver reads them, secrets already shown as ***. */
function InputsLine({ inputs }: { inputs?: Record<string, unknown> | undefined }) {
  const entries = Object.entries(inputs ?? {});
  if (!entries.length) return null;
  const shown = (v: unknown) => {
    const t = typeof v === 'string' ? v : JSON.stringify(v);
    return t.length > 80 ? `${t.slice(0, 80)}…` : t;
  };
  return (
    <p className="muted" data-approval-inputs>
      Inputs:{' '}
      {entries.slice(0, 8).map(([name, value], i) => (
        <span key={name}>
          {i > 0 && ', '}
          <span className="mono">{name}</span> = {shown(value)}
        </span>
      ))}
      {entries.length > 8 ? ', …' : ''}
    </p>
  );
}

const STATUS_TONE: Record<string, string> = {
  // AFS-101: waiting is amber everywhere (a person must act), not the accent of something going.
  waiting: 'warn',
  approved: 'ok',
  rejected: 'bad',
  'timed out': 'bad',
  cancelled: '',
};

/**
 * AFS-185: a gate's status in the pages' words: a gate closed because its run was stopped says
 * so, as the run does ("cancelled" beside a run that reads "stopped" read as two things).
 */
const gateWord = (status: string): string => (status === 'cancelled' ? 'run stopped' : status);

/** One gate: what it asks, who decided and why, or the form to decide. */
function GateCard({
  gate,
  mayDecide,
  why,
  onDecide,
}: {
  gate: Gate;
  mayDecide: boolean;
  why?: string;
  onDecide(decision: 'approved' | 'rejected', comment: string): Promise<void>;
}) {
  return (
    <div className="gate" data-gate={gate.node.key}>
      <p>
        <strong>{gate.node.title}</strong>{' '}
        <span className={`badge ${STATUS_TONE[gate.status] ?? ''}`}>
          {gate.status === 'waiting' ? 'waiting for a decision' : gateWord(gate.status)}
        </span>
      </p>
      {/* AFS-193: what the approvers decide: the approval's message, else its step's intent. */}
      {(gate.message || gate.intent) && <p data-gate-message>{gate.message || gate.intent}</p>}
      {/* AFS-133: what is being decided: the hosts that wait here. */}
      {gate.hosts && gate.hosts.length > 0 && (
        <p data-gate-hosts>
          {gate.status === 'waiting' ? 'Hosts waiting' : 'Hosts it was for'} ({gate.hosts.length}
          ): {gate.hosts.slice(0, 12).join(', ')}
          {gate.hosts.length > 12 ? ', …' : ''}
        </p>
      )}
      {/* AFS-143: "waiting since" only while it waits; a decided one says when it was asked. */}
      {gate.status === 'waiting' ? (
        <p className="muted">
          {/* AFS-193: and for how long, as Home says it. */}
          Waiting since <Time at={gate.createdAt} /> ({span(gate.createdAt)})
          {/* AFS-133, AFS-146: who may decide, always, by name. AFS-211: as it is now, not as
              if it were decided. AFS-271: when it times out is said with what happens then. */}{' '}
          · Who decides: {decidersText(gate)}
        </p>
      ) : (
        <p className="muted">
          Asked <Time at={gate.createdAt} />
        </p>
      )}
      {gate.status !== 'waiting' && (
        <p>
          {gateWord(gate.status)} by{' '}
          <span title={gate.decidedBy}>{gate.decidedByName ?? gate.decidedBy ?? 'nobody'}</span>
          {gate.decidedAt && (
            <>
              , <Time at={gate.decidedAt} />
            </>
          )}
          {gate.comment && <q className="comment">{gate.comment}</q>}
        </p>
      )}
      {gate.status === 'waiting' && <Consequences gate={gate} />}
      {gate.status === 'waiting' &&
        (mayDecide ? (
          <DecideForm title={gate.node.title} next={gate.next} onDecide={onDecide} />
        ) : (
          // AFS-193: why not, as a sentence, and who does decide it.
          <p className="muted" data-gate-why>
            {why ? `${why}. ` : ''}
            {decidersText(gate)} decides it.
          </p>
        ))}
    </div>
  );
}

/** A run's approvals, on its page; read again whenever the run changes. */
export function RunApprovals({ run, changed }: { run: string; changed: string }) {
  const gates = useLoad(() => api.runApprovals(run), [run, changed]);
  if (!gates.data?.length) return null;
  // One that waits is the tinted thing on the run's page (AFS-64).
  const waiting = gates.data.some((g) => g.status === 'waiting');
  const yours = gates.data.some((g) => g.status === 'waiting' && g.mayDecide);
  return (
    <section className={waiting ? 'panel decision' : 'panel'} aria-labelledby="run-approvals">
      <h2 id="run-approvals">{yours ? 'Your approval' : 'Approvals'}</h2>
      {gates.data.map((g) => (
        <GateCard
          key={g.id}
          gate={g}
          mayDecide={g.mayDecide}
          {...(g.why ? { why: g.why } : {})}
          onDecide={async (decision, comment) => {
            await api.decide(run, g.node.id, decision, comment);
            gates.reload();
          }}
        />
      ))}
    </section>
  );
}

/** Everything that waits for a decision, that this person may see. */
export function ApprovalsPage() {
  const list = useLoad(() => api.approvals(), []);
  // AFS-133: what was just decided here, said until the next decision.
  const [decided, setDecided] = useState<{ text: string; run: string }>();
  // Runs reach approvals while the page is open: it looks again now and then.
  useEffect(() => {
    const timer = setInterval(list.reload, 15_000);
    return () => clearInterval(timer);
  }, [list.reload]);
  const decidedList = useLoad(() => api.decidedApprovals().catch(() => []), [decided]);
  // AFS-146: the sidebar's count follows what this page reads (a run that arrived, one decided
  // elsewhere), not its own slower look.
  const count = list.data?.filter((a) => a.mayDecide).length;
  useEffect(() => {
    if (count !== undefined) window.dispatchEvent(new Event(APPROVALS_CHANGED));
  }, [count]);
  const mine = list.data?.filter((a) => a.mayDecide) ?? [];
  const others = list.data?.filter((a) => !a.mayDecide) ?? [];
  // Yours: each a tinted box with the decision in it (AFS-82). Others': plain rows with why not.
  const card = (a: NonNullable<typeof list.data>[number], yours: boolean) => (
    <li key={a.gate.id} className={yours ? 'decision' : 'approval-row'}>
      <p className="approval-run">
        <Link to={`/runs/${a.run.id}`}>
          {a.run.flow.name} #{a.run.number}
        </Link>{' '}
        <span className="muted">
          · launched by <span title={a.requestedBy}>{a.requestedByName ?? a.requestedBy}</span>
          {a.run.projectName && (
            <>
              {' '}
              · {a.run.workspaceName ? `${a.run.workspaceName} / ` : ''}
              {a.run.projectName}
            </>
          )}
          {a.run.mode && <> · {a.run.mode === 'real' ? 'real run' : 'check run'}</>}
        </span>
      </p>
      <InputsLine inputs={a.run.inputs} />
      <GateCard
        gate={a.gate}
        mayDecide={a.mayDecide}
        {...(a.why ? { why: a.why } : {})}
        onDecide={async (decision, comment) => {
          await api.decide(a.run.id, a.gate.node.id, decision, comment);
          setDecided({
            text: `You ${decision} "${a.gate.node.title}" of ${a.run.flow.name} #${a.run.number}.`,
            run: a.run.id,
          });
          list.reload();
        }}
      />
    </li>
  );
  return (
    <>
      <PageHead
        help="approvals.md"
        title="Approvals"
        lead={
          // AFS-211: one sentence when nothing waits, not two.
          list.data
            ? mine.length
              ? `${mine.length} waiting for you${others.length ? `, ${others.length} for others` : ''}.`
              : others.length
                ? `Nothing waits for you; ${others.length} for others.`
                : 'No run waits for a decision.'
            : undefined
        }
      />
      {decided && (
        <p className="notice ok" role="status">
          {decided.text} <Link to={`/runs/${decided.run}`}>Open the run</Link>
        </p>
      )}
      <Loading state={list} />
      {mine.length > 0 && (
        <section aria-labelledby="yours">
          <h2 id="yours">Yours to decide</h2>
          <ul className="approvals mine">{mine.map((a) => card(a, true))}</ul>
        </section>
      )}
      {others.length > 0 && (
        <section aria-labelledby="others">
          <h2 id="others">Waiting for others</h2>
          <ul className="approvals list">{others.map((a) => card(a, false))}</ul>
        </section>
      )}
      {decidedList.data && decidedList.data.length > 0 && (
        <section aria-labelledby="decided">
          <h2 id="decided">Decided lately</h2>
          <ul className="approvals list">
            {decidedList.data.slice(0, 20).map((a) => (
              <li key={a.gate.id} className="approval-row" data-decided={a.gate.status}>
                <p className="approval-run">
                  <Link to={`/runs/${a.run.id}`}>
                    {a.run.flow.name} #{a.run.number}
                  </Link>{' '}
                  <span className="muted">· {a.gate.node.title}</span>{' '}
                  <span className={`badge ${STATUS_TONE[a.gate.status] ?? ''}`}>
                    {gateWord(a.gate.status)}
                  </span>{' '}
                  <span className="muted">
                    {a.gate.decidedBy ? `by ${a.gate.decidedByName ?? a.gate.decidedBy}` : ''}
                    {a.gate.decidedAt && (
                      <>
                        , <Time at={a.gate.decidedAt} />
                      </>
                    )}
                  </span>
                </p>
                {a.gate.comment && <q className="comment">{a.gate.comment}</q>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
