# ADR-0021: Approval gates

- Status: accepted (2026-11-13, AFS-28). Builds on ADR-0015 (the queue: `waiting`, `resume`),
  ADR-0016 (the executor), ADR-0020 (access levels, the `approve` grant). Uses the designer's
  `runSegments` steps (AFD-272) and approval fields (AFD-273)
- Context: a flow can stop at an approval until a person decides. AWX does this with a workflow
  of segment jobs; the server has to do it itself, without holding a container for hours, and
  across a restart

## Decision

**Segments, not a waiting process.** A flow with top-level approvals is generated in segments
(the designer's split, as for AWX). The executor runs `start`; when hosts wait at the
approval it records a **gate** (`run_gate`: the node, the segment, the host sets the segment
carried, the deadline, the approval's approvers and message as they were) and lets the run go
(`waiting`: no lease, no container, no place in the limits). A decision puts the run back in the
queue; whichever worker takes it continues with the segment the decision picks, starting from
the carried host sets. Nothing lives in memory between segments, so a restart changes nothing.

- The segments run (`segments_json` on the run: name and folder each) give the run's view as one
  (`segmentsSummary`), a step's host output, and what retention removes.
- **Timeout** is its own outcome: `settings.timeout` sets the deadline; a sweep (with the lease
  sweep, every 15 s) times the gate out (by "the server") and the hosts take the timeout port
  (`afd_gate_outcome`), else the rejected one.
- An approval nobody reaches is skipped (`finish`), as in AWX.
- **A flow whose approvals cannot be split** (inside a subflow, two that can wait at once) does
  not run: run as one playbook its approvals would pass by themselves, as a local run does.

**Who decides:** the `approve` grant on the flow or its workspace; when the approval names
`approvers` (users or groups), only they; administrators always. **Not who launched the run**,
unless the workspace allows it (`self_approve`, off by default). The first decision counts (a
second is told it is decided). A decision has a comment; the gate keeps who, when and why, the
run's view shows it (`RunView.approvals`, with `mayDecide` for the person looking), and the
audit log records it (`approval.decide`, with the decision).

**`approve` lets its holder see** what it covers (as `ro`): an approver who cannot open the run
or the flow cannot judge it. It never lowers another grant (ADR-0020 amended).

**Where:** the Approvals page (yours to decide, waiting for others with why not), the run's page,
the canvas (the approval's Run tab, the designer's `approve` message, which a viewer may send),
`GET /api/v1/approvals`, `GET|POST /api/v1/runs/:id/approvals[/:node]`.

## Not in this decision

- Telling approvers that something waits (`notify`, email, webhook): AFS-29. Until then the
  Approvals page is where they look.
- Deciding through MCP: with the MCP endpoint (AFS-24), off unless enabled on a token.
- Approvals inside subflows, or several waiting at once.

## Alternatives considered

- **One process waiting at the approval** (a task that polls for a decision). Simple, and host
  sets stay in memory. But it holds a container and a run slot for hours or days, and a restart
  loses it.
- **Approvers only from grants**, no list in the flow. Fewer places to look. But the flow's
  author knows that this change needs the change board; the flow says so in git, reviewed with
  the rest.
- **Self-approval allowed by default.** Fewer stuck runs in a small team. But an approval one can
  give oneself is not one; the workspace switch is there for small teams.

## Consequences

- Each segment of a run is a run of Ansible with its own folder and events; the run's page shows
  them as one.
- A run may wait for a long time: retention never removes a run that is going or waiting.
- Changing the approvers in the flow affects runs that reach the approval after the change; a
  waiting gate keeps the approvers it had.
