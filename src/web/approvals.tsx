// Approvals on the pages (AFS-28): the inbox of what waits for a decision, and a run's approvals
// on its page. Who may decide is the server's to say (`mayDecide`, else why not); a decision
// takes a comment, kept with it and shown to everyone who looks at the run.
import { type FormEvent, useEffect, useId, useState } from 'react';
import { api, type Gate } from './api';
import { Link } from './router';
import { Loading, messageOf, PageHead, Time, useLoad } from './ui';

/** AFS-133: the sidebar's count and other lists read again once a decision is made. */
export const APPROVALS_CHANGED = 'afs-approvals-changed';

/**
 * Approve or reject, with a comment (required to reject). Each asks once more, naming what
 * happens next (AFS-133). Resolves when the server has it.
 */
function DecideForm({
  title,
  onDecide,
}: {
  title: string;
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
            ? `Approve "${title}"? The hosts waiting here go on to the next steps.`
            : `Reject "${title}"? The hosts waiting here take the rejected path (usually a rollback or a failed end).`}
        </p>
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
          <button type="button" disabled={busy} onClick={() => setAsking(undefined)}>
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

const STATUS_TONE: Record<string, string> = {
  // AFS-101: waiting is amber everywhere (a person must act), not the accent of something going.
  waiting: 'warn',
  approved: 'ok',
  rejected: 'bad',
  'timed out': 'bad',
  cancelled: '',
};

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
          {gate.status === 'waiting' ? 'waiting for a decision' : gate.status}
        </span>
      </p>
      {gate.message && <p>{gate.message}</p>}
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
          Waiting since <Time at={gate.createdAt} />
          {gate.deadline && (
            <>
              {' '}
              · times out <Time at={gate.deadline} />
            </>
          )}
          {/* AFS-133: who may decide, always: the node's approvers, else the workspace's. */} ·
          decided by{' '}
          {gate.approvers.length > 0
            ? gate.approvers.join(', ')
            : 'whoever has approve on the flow or its workspace'}
        </p>
      ) : (
        <p className="muted">
          Asked <Time at={gate.createdAt} />
        </p>
      )}
      {gate.status !== 'waiting' && (
        <p>
          {gate.status} by {gate.decidedBy ?? 'nobody'}
          {gate.decidedAt && (
            <>
              , <Time at={gate.decidedAt} />
            </>
          )}
          {gate.comment && <q className="comment">{gate.comment}</q>}
        </p>
      )}
      {gate.status === 'waiting' &&
        (mayDecide ? (
          <DecideForm title={gate.node.title} onDecide={onDecide} />
        ) : (
          <p className="muted">{why ?? 'Someone allowed to approve decides it.'}</p>
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
  const mine = list.data?.filter((a) => a.mayDecide) ?? [];
  const others = list.data?.filter((a) => !a.mayDecide) ?? [];
  // Yours: each a tinted box with the decision in it (AFS-82). Others': plain rows with why not.
  const card = (a: NonNullable<typeof list.data>[number], yours: boolean) => (
    <li key={a.gate.id} className={yours ? 'decision' : 'approval-row'}>
      <p className="approval-run">
        <Link to={`/runs/${a.run.id}`}>
          {a.run.flow.name} #{a.run.number}
        </Link>{' '}
        <span className="muted">· launched by {a.requestedBy}</span>
      </p>
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
          list.data
            ? mine.length
              ? `${mine.length} waiting for you${others.length ? `, ${others.length} for others` : ''}.`
              : 'Nothing waits for you.'
            : undefined
        }
      />
      {decided && (
        <p className="notice ok" role="status">
          {decided.text} <Link to={`/runs/${decided.run}`}>Open the run</Link>
        </p>
      )}
      <Loading state={list} />
      {list.data && list.data.length === 0 && <p className="empty">No run waits for a decision.</p>}
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
                    {a.gate.status}
                  </span>{' '}
                  <span className="muted">
                    {a.gate.decidedBy ? `by ${a.gate.decidedBy}` : ''}
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
