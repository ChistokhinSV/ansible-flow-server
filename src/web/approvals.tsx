// Approvals on the pages (AFS-28): the inbox of what waits for a decision, and a run's approvals
// on its page. Who may decide is the server's to say (`mayDecide`, else why not); a decision
// takes a comment, kept with it and shown to everyone who looks at the run.
import { type FormEvent, useEffect, useId, useState } from 'react';
import { api, type Gate } from './api';
import { Link } from './router';
import { Loading, messageOf, PageHead, Time, useLoad } from './ui';

/** Approve or reject, with a comment. Resolves when the server has it. */
function DecideForm({
  onDecide,
}: {
  onDecide(decision: 'approved' | 'rejected', comment: string): Promise<void>;
}) {
  const id = useId();
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const decide = async (decision: 'approved' | 'rejected', event?: FormEvent) => {
    event?.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await onDecide(decision, comment);
    } catch (e) {
      setError(messageOf(e));
      setBusy(false);
    }
  };
  return (
    <form className="form decide" onSubmit={(e) => void decide('approved', e)}>
      <div className="field">
        <label htmlFor={`${id}-comment`}>Comment</label>
        <textarea
          id={`${id}-comment`}
          rows={2}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Why, for the record"
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
          Approve
        </button>
        <button type="button" disabled={busy} onClick={() => void decide('rejected')}>
          Reject
        </button>
      </div>
    </form>
  );
}

const STATUS_TONE: Record<string, string> = {
  waiting: 'busy',
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
      <p className="muted">
        Waiting since <Time at={gate.createdAt} />
        {gate.deadline && (
          <>
            {' '}
            · times out <Time at={gate.deadline} />
          </>
        )}
        {gate.approvers.length > 0 && <> · approvers: {gate.approvers.join(', ')}</>}
      </p>
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
          <DecideForm onDecide={onDecide} />
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
  return (
    <section className="panel" aria-labelledby="run-approvals">
      <h2 id="run-approvals">Approvals</h2>
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
  // Runs reach approvals while the page is open: it looks again now and then.
  useEffect(() => {
    const timer = setInterval(list.reload, 15_000);
    return () => clearInterval(timer);
  }, [list.reload]);
  const mine = list.data?.filter((a) => a.mayDecide) ?? [];
  const others = list.data?.filter((a) => !a.mayDecide) ?? [];
  const card = (a: NonNullable<typeof list.data>[number]) => (
    <li key={a.gate.id} className="panel">
      <p>
        <Link to={`/runs/${a.run.id}`}>
          {a.run.flow.name} · run {a.run.number}
        </Link>{' '}
        <span className="muted">launched by {a.requestedBy}</span>
      </p>
      <GateCard
        gate={a.gate}
        mayDecide={a.mayDecide}
        {...(a.why ? { why: a.why } : {})}
        onDecide={async (decision, comment) => {
          await api.decide(a.run.id, a.gate.node.id, decision, comment);
          list.reload();
        }}
      />
    </li>
  );
  return (
    <>
      <PageHead
        title="Approvals"
        lead="Runs that wait for a person: what each asks, and the decision when it is yours."
      />
      <Loading state={list} />
      {list.data && list.data.length === 0 && <p className="empty">No run waits for a decision.</p>}
      {mine.length > 0 && (
        <section aria-labelledby="yours">
          <h2 id="yours">Yours to decide</h2>
          <ul className="rows approvals">{mine.map(card)}</ul>
        </section>
      )}
      {others.length > 0 && (
        <section aria-labelledby="others">
          <h2 id="others">Waiting for others</h2>
          <ul className="rows approvals">{others.map(card)}</ul>
        </section>
      )}
    </>
  );
}
