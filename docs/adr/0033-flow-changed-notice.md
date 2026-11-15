# ADR-0033: Telling people a flow they have open has changed

- Status: accepted (2026-11-15, AFS-75)
- Builds on: ADR-0008 (projects and their source), ADR-0012 (the flow viewer), ADR-0017 (run
  events as server-sent events)
- First step of several people working on one flow (AFS-48, AFS-76); the VS Code side is designer
  ticket AFD-284.

## Decision

- **The project's branch is the event.** Whatever moves it (a push through the server, a look at
  the source on a timer, on request or by a push hook, later a save from the pages) ends in the
  project's commit in the database. A watcher reads the commits of the projects someone watches,
  every 2 seconds in one query, so a move made by another server on the same database is seen
  too. No hooks in each place that moves a branch.
- **A stream says only that it moved; a read says what changed.** `GET /projects/:id/events`
  (server-sent events: `commit` at once and after a reconnect, `moved` with from and to) needs
  only to see the project. `GET /projects/:id/changes?from=&to=` lists the flow files added,
  changed or removed and the authors of the commits in between, narrowed to the flows the person
  may see; a commit the server does not have (not pushed) answers 409 `unknown_commit`. The VS
  Code extension uses the same two with its local commit.
- **The page decides, the designer shows.** The viewer compares the flow it shows with the new
  commit: no change to it, nothing is said (it follows the branch quietly); a change, a bar with
  who and how much (the designer's semantic diff) and Show changes / Update; a removal, a note
  and the flow stays. Show changes is the designer's own Changes lens with the version shown
  before as its base; the lens's base picker lists the commits that changed the flow
  (`/flows/history`). Nothing in the designer changed for this.
- **Who changed it is git's author.** Commits keep their authors; for a push through the server
  the pusher is also in the push list. A save from the pages (AFS-48) will commit as the person.

## Consequences

- A change is seen within about 2 seconds of the server knowing it; a source the server learns
  of on a timer is as late as that timer (a push hook makes it immediate).
- Each watched project costs one row read every 2 seconds per server, whatever the number of
  people watching it.
- A rename shows as a removal and an addition: a flow is known by its path.

## Alternatives considered

- **An in-process event from sync and push:** immediate, but a second server on the same
  database would not hear it, and every place that moves a branch would have to remember to emit.
- **The changes in the stream itself:** one round trip less, but the list depends on who asks
  (flow grants) and on where the client was (its own commit, possibly unpushed); a read per client
  keeps the stream the same for everyone.
- **WebSocket:** two-way is not needed yet; live editing (AFS-76) may need it.
