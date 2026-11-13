# ADR-0003: A project's flows live in git

- Status: accepted (2026-11-13, AFS-9; product-owner decision "both modes per project"). Not
  implemented yet (AFS-13, AFS-14)
- Context: people design flows in VS Code and will later edit them in the browser; the server runs
  them. All three must agree on which text of a flow is the flow

## Decision

- **A project is a git repository.** Either an external one (a URL and a credential; the server
  keeps a mirror and pulls on a timer and on a push webhook), or one the server hosts itself (a bare
  repository served over HTTPS with token sign-in, so `git clone` and `git push` work from VS Code).
  Everything after the repository is one code path.
- **A run names a commit.** The server runs only commits on the project's branch that may run
  (`main` unless set otherwise). The run's record keeps the commit, so a run can be read against
  the exact flow it ran.
- **The database holds what git does not:** runs and their events, who may do what, secrets,
  schedules, environments. A flow, an inventory or a script is never copied into it as the truth.
- **Work that is not pushed** can be tried: a person with edit access uploads it as a git bundle
  for a check-mode run (AFS-26). A real run needs a commit on the branch that may run.
- **Editing in the browser, when it comes,** is a commit by that person on a branch. Two people
  changing one flow is a git conflict, solved with git's tools, not a second versioning system.

## Alternatives considered

- **Flows in the database, git as an export.** No git needed to start. But the designer's history,
  review and diff are git's, and two sources of truth for one flow drift apart.
- **External repositories only.** Simpler. But a small team without a git host would need one
  before it could run a first flow.

## Consequences

- The server needs `git` on its machine and treats repository content as untrusted input.
- Access to a hosted repository follows the workspace's access levels: reading is cloning, editing
  is pushing.
- A flow's version number is the designer's (`flow.version`, raised once per commit); the server
  does not number flows itself.
