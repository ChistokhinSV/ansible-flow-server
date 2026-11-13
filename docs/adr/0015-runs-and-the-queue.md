# ADR-0015: Runs, and the queue they wait in

- Status: accepted (2026-11-13, AFS-19). Builds on ADR-0014 (a settled launch), ADR-0013
  (sealing)
- Context: a launch must outlive the request that made it and the process that runs it; two
  servers on one database must never run the same run; a real run must never be started twice
  by accident; later, a remote agent takes runs over the network

## Decision

**A run is a row** (`run`, `src/server/runs/queue.ts`) made from a settled launch: project,
configuration (its name kept as text), commit, branch, flow and its version, mode, inventory,
image, limit, inputs, hosts, credentials, who asked. It has a number in its project (1, 2, 3…).

**Inputs are sealed** with the master key, bound to the run (`run:<id>`); a copy with
secret-looking values as `***` is what anyone sees. Only the worker that takes the run gets the
inputs in full.

**States:** `queued`, `running`, `waiting` (for a decision: AFS-28), and the ends `succeeded`,
`failed`, `cancelled`, `lost`.

**The queue is pull-style.** A worker asks for a run (`claim`) and gets one with a lease: a
token and a time it is good until (60 seconds). Every later word from the worker carries the
token: `heartbeat` (keeps the lease; answers whether someone asked to stop), `start`, `wait`,
`finish`. A worker whose lease ran out, or was given away, is not believed. The same calls are
what a remote agent will make over HTTP (AFS-50); they are not offered over HTTP yet, since
nothing outside the server may take runs until agents can sign in.

**A worker that goes away** (lease run out, checked every 15 seconds):

- before the run **started**: the run goes back in the queue, for another worker; after 3 such
  attempts it is `lost`: something about it stops workers;
- after it started: `lost`, with the reason. It is **never started again**: a real run may have
  changed machines halfway, and only a person can decide to run it again.

**Limits:** at most `AFS_MAX_RUNS` (4) runs at once on the server, and
`AFS_MAX_RUNS_PER_PROJECT` (1) of one project: two runs on the same devices at once is rarely
meant. The queue gives out the oldest run that fits; a project at its limit does not hold back
other projects' runs. A waiting run takes no place and has no lease.

**One at a time where it matters.** Numbering and claiming run in a transaction that has the
queue to itself: on PostgreSQL an advisory lock, on SQLite its single writer. Ten workers asking
at once get no more than the limits allow (tested on both).

**Cancel:** a run no worker has (queued, waiting) is cancelled at once; a running one is asked
to stop and its worker hears it at the next heartbeat. Asked before it started and its worker
went away: cancelled, not given out again.

**A project with a run going is not deleted**; its ended runs go with it. A launch
configuration that is deleted leaves its runs, which keep its name.

**Who** (until AFS-27): everyone signed in sees runs; administrators launch and cancel.

## Not in this decision

- The worker that runs flows (AFS-20), output and live status (AFS-21), the audit record of who
  launched and cancelled (AFS-22), approvals (AFS-28), remote agents (AFS-50).
- How long ended runs are kept (AFS-21: history and retention).

## Alternatives considered

- **A queue outside the database** (Redis, a message broker). Fast, familiar. But one more
  thing to install and back up, for a few runs a minute, and the run's record and its place in
  the queue would be in two places that can disagree.
- **Starting a run again after its worker went away.** Nothing is lost. But a real run that
  halted after changing half the devices would change them again; Ansible being idempotent is a
  goal of playbooks, not a promise.
- **`SELECT … FOR UPDATE SKIP LOCKED`** on PostgreSQL. Workers would not wait for one another.
  But the limits are counts across rows, which row locks do not protect; and SQLite has no such
  clause. One lock for a short transaction is enough at this scale.

## Consequences

- A run in the queue survives a restart of the server.
- Until AFS-20 nothing takes runs: they stay queued.
