# ADR-0036: Actions: run approved things without the canvas or code

- Status: accepted (2026-11-22, AFS-175)
- Builds on: ADR-0012 (launch configurations), ADR-0020 (access levels and approvals)
- Extended by: ADR-0037 (AFS-176: links from NetBox and Zabbix, signed links, the result back; a
  host list narrowed to a group; fixed values no longer named in "What will happen"; the progress
  view for who sees the flow's runs and who started the run, not every runner of the action)

## Context

Managers and other people who run things but do not read flows need one page: a short form with
the few values they choose, Run, and a plain view of how it goes. Today launching needs operator
on the flow, and the launch page shows the flow's inputs as the flow names them, its commit, its
inventory and a canvas.

## Decision

- **An action is a launch configuration marked as one**, not a second object: one configuration,
  one action, under the configuration's id (`/actions/:id` is the configuration's id). Its
  settings are kept beside the configuration (`launch_action`, one row per configuration): a
  plain title, one sentence on what it does, the inputs it asks (each with a label, a help line
  and optionally a list of choices; a host list is offered from the inventory by name), the mode
  it runs in (check or real, fixed by the action, apart from the configuration's own mode), and
  whether Run asks to confirm. Every input not asked runs with the configuration's value, and
  cannot be set through the action: a value for it is refused (400, at its name). A secret-looking
  input cannot be asked (an action is for values one chooses, a secret is a credential).
- **On and off:** `enabled` turns the action off and keeps its words and its grants; deleting the
  action removes both; deleting the configuration removes the action. The person who last set it
  is its **owner** (whom the progress view says to ask, with the server's administrators).
- **Who sets it:** an administrator or someone with rw on the workspace (`rw on the workspace`
  on the configuration's routes), on the configuration's Settings tab.
- **Access: a grant of its own.** "May run this action" is a row of `action_grant` (a user or a
  group, per action), not a level of `access_grant`. `Access` (what every other route checks) does
  not read it, so a person whose only grant is an action reaches nothing else: no workspace, flow,
  file, configuration or run route, no list, no search hit. Who may run an action: an
  administrator, operator or more on its flow, or someone with its grant (themself or a group);
  and the action is on. Approval steps in the flow apply as they do to every run: the approvers
  decide, the runner cannot decide unless the workspace lets them as now.
- **Runs:** a run started through an action keeps the action's title (`run.action_title`). Its
  plain progress view (`/actions/runs/:id`) is for whoever may run that action (the address can
  be shared among them) and whoever may see the run; it shows only the action's title, the steps
  by title (done of N), who an approval waits for, done or failed with the reason in words, whom
  to ask, and the asked inputs with their labels. The full run page is linked only for who may
  see the run (ro on the flow). The view is live: `GET /api/v1/actions/runs/:id/events` sends it
  again whenever the run's view (the same hub the run page's stream hears) or record changes.
- **API:** `GET /api/v1/actions` (the actions I may run, each with my last run of it),
  `GET /api/v1/actions/:id` (its form), `GET /api/v1/actions/:id/hosts` (the inventory's hosts and
  groups for a host list, from the repository's static inventory: no container is started),
  `POST /api/v1/actions/:id/run`, `GET /api/v1/actions/runs/:id` and its `/events`; on the
  configuration: `GET|PUT|DELETE /api/v1/launch-configs/:id/action` and
  `POST|DELETE /api/v1/launch-configs/:id/action/grants[/:grant]`, and the workspace's action
  grants for its Access tab. The action routes are `may run the action` in the catalog: the
  handler checks, as the access-level hook cannot (it does not know action grants). Audited:
  `action.set`, `action.remove`, `action.grant`, `action.grant-remove`, `action.run`.
- **The fill seam (for AFS-176):** `fillAction(form, given)` takes values by input name, refuses
  names the action does not ask and values outside the choices, and says which asked inputs are
  still empty. The run route and the form use it; a link's query will use it the same way.
- **Pages:** an Actions item in the side menu for anyone with an action; a person whose only
  access is actions lands on Actions (Home is the Actions page; the menu shows Actions and Help
  only). Cards; a form with only the asked inputs, a summary in words of what will happen, Run
  (asks first when the action says so); the progress view. All usable at 390 px.

## Where this differs from the brief

- The action's **id is the configuration's id**: one configuration, one action, so a second key
  would only need a lookup. AFS-176's links use the same id (`/a/<id>`), or later a slug field.
- **Turning off keeps the grants** (`enabled: false`) instead of removing them: an administrator
  who switches an action off for a change window should not have to give the grants again.
- **Host lists come from the static inventory** of the repository, not the facts probe in the
  run's image: the probe starts a container per question, which is too much for a form opened by
  many people. A dynamic inventory's hosts are typed (the form says so).
- **MCP:** no `action_list` / `action_run` tools yet: an agent with operator already launches with
  `launch`; a tool pair for action-only people is left for when an agent needs it.

## Consequences

- An action-only person is safe by construction: no existing route changed what it checks.
- A run's record shows it came from an action (its title), so lists and the audit log say so.
- Actions do not show the flow's canvas, commit or inventory to their runners; whoever needs those
  needs ro on the flow.
