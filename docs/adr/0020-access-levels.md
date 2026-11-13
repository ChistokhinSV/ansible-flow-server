# ADR-0020: Access levels

- Status: accepted (2026-11-13, AFS-27). Builds on ADR-0007 (people and groups), ADR-0019 (the
  route catalog). Replaces "administrators only" for launching, stopping, managing launch
  configurations and pushing
- Context: a team shares a server: some people only look, some run what was set up for them,
  some set it up; one flow may need tighter hands than the rest of its workspace

## Decision

**A grant** (`access_grant`) gives a user or a group a level on a whole workspace, or on one
flow (a project and its flow file):

- `ro`: see the workspace, its projects, flows, launch configurations, credentials (their names)
  and runs; clone and fetch; ask what a launch would run.
- `operator`: and launch a flow as its launch configuration says; stop and run again.
- `rw`: and launch another branch or commit; add, change, delete launch configurations; push;
  look at the source now.
- `approve`: decide approval gates (AFS-28): a grant of its own, not a step of the ladder.
- Administrators may do everything; workspaces, projects, credentials and grants stay theirs.

**How grants combine:** a flow grant replaces the workspace grant for that flow, both ways (more
or less); of a person's own and their groups' grants on one place, the highest counts. One
principal has one level per place (a second is refused, not merged), and `approve` beside it.

**Git is the workspace's:** clone needs `ro` on the workspace, push `rw` on it. A repository
holds every flow of its project, so a grant on one flow does not open it.

**An operator runs what was set up:** another branch or commit than the configuration names
needs `rw`. A real run of an untested branch is a decision for whoever may change the setup.

**Enforced in one place:** each route in the catalog (ADR-0019) names the level it needs ("can
see", `ro`, `operator`, `rw`, or `ro`/`rw` on the workspace); one check before the handler
works out what the route reaches (workspace, project, flow) and the person's level there. What
depends on the body (the flow of a new configuration, another branch at launch) is checked by
the handler. Lists (workspaces, projects, flows, configurations, runs) are narrowed to what the
person may see. A test fails when a route that reaches a workspace is open to anyone merely
signed in; a matrix test checks each kind of person against each kind of route.

**Not there is not told:** a person with no grant in a workspace gets 404 for what is in it,
the same as for what does not exist; with a grant but too low a level, 403.

**The pages ask** `GET /api/v1/projects/:id/access` and show only what the person may do; the
server decides either way. Administrators give and take grants on the workspace's page, with
"who can do what" beside them.

## Not in this decision

- The MCP endpoint (AFS-24) and approval gates (AFS-28): they use the same levels when they come.
- Workspace owners who may give grants: only administrators do, for now.
- People and groups pages (AFS-56): the grant form picks from the existing ones.

## Alternatives considered

- **Roles with permission lists** (as AWX). Finer. But five levels that are steps say what a
  person may do in one word, and a team can read them.
- **A flow grant only adding to the workspace's.** Simpler to add up. But "everyone may run the
  workspace's flows, not this one" is the case that needs a flow grant most.
- **403 for everything refused.** Simpler. But it tells someone with no access what exists.

## Consequences

- After the upgrade, people who are not administrators see nothing until given grants.
- Every request of a non-administrator reads their grants once (and their groups').
- A new route names its level in the catalog, or it is open to anyone signed in, and the test
  that looks for that fails.

## Amendment (2026-11-13, AFS-28)

`approve` now lets its holder see what it covers, as `ro` (flows, runs, launch configurations,
credentials' names, clone): an approver must be able to look at what they decide. It never
lowers another grant: a person with `rw` and `approve` keeps `rw`.
