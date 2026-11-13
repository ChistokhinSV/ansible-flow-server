# ADR-0017: Watching runs: the live stream, the run pages, keeping runs

- Status: accepted (2026-11-13, AFS-21). Builds on ADR-0015 (runs), ADR-0016 (the executor),
  ADR-0012 (the designer as a viewer)
- Context: a person who launched a run wants to see it go, step by step on the flow's canvas
  and as Ansible's output, stop it, and run it again; and the server must not keep every run
  for ever

## Decision

**One live stream per run, as server-sent events** (`GET /api/v1/runs/:id/events`): `run` (the
record, when it changes), `view` (the designer's own view of the run, about twice a second while
it goes), `output` (new output, with `next`, the offset to resume from after a reconnect) and
`end`. It is plain HTTP: the same sign-in, proxies pass it, a browser's `EventSource` and a
script read it alike.

- The executor publishes views and output in the process (`RunHub`); the stream also looks at
  the run's record every second, so a cancel, a run ending, or a run another server has, is
  seen.
- A first look at a long output gets its last megabyte, and is told how much it does not get.
- A stream of an ended run sends everything at once and ends. A server that closes ends its
  streams.

**The canvas shows a run** the way it does in VS Code: the viewer page (ADR-0012) takes
`commit` (the flow as the run ran it) and `run`, and passes the stream's views to the designer.
The designer's own run controls do what they say: its list of earlier runs is the flow's runs on
the server, picking one shows it, Stop cancels, a step's host output is read from the run's
events (`GET /api/v1/runs/:id/hosts/:node/:host`).

**Run pages:** `/runs` (every run, filter by state) and `/runs/:id` (what ran, the canvas, the
output following its end, Stop and Run again for administrators). A project's page lists its
recent runs.

**Run again** (`POST /api/v1/runs/:id/relaunch`) queues the same run: commit, flow, mode,
inputs (secrets too, sealed again to the new run) and credentials. It is the same run, not "the
configuration again": a configuration may have changed since.

**Output is plain text**: colours are taken out as it is written.

**Keeping runs:** an ended run is removed after `AFS_RUNS_KEEP_DAYS` (90), and beyond the newest
`AFS_RUNS_KEEP_PER_FLOW` (200) ended runs of its flow in its project, with its output and its
events; at start and every hour. A run that is going is never removed.

## Not in this decision

- The audit record of who launched, stopped and ran again (AFS-22).
- Launching from the pages (AFS-65), and from the canvas's own Run buttons, which say to use a
  launch configuration.
- Streams across servers sharing one database: a watcher on one server sees another server's
  run by its record (state), without live views or output.

## Alternatives considered

- **A WebSocket per viewer**, as AFS-16 first planned. Both ways. But a watcher only listens; a
  stream of events is simpler for proxies, sign-in and scripts, and reconnects on its own.
- **Polling the run and its output.** No streaming code. But a run's view changes twice a
  second, and many watchers polling a growing file is what a stream avoids.
- **"Run again" as a new launch of the configuration.** Picks up fixes. But it is not the run
  the person looked at; that is "Launch", which the configuration page will have.

## Consequences

- An open run page holds one connection to the server while the run goes.
- Removing runs removes their output and events: what is kept longer must be kept elsewhere
  (the audit log, AFS-22).
