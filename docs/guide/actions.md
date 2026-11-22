# Actions

[The guide](README.md)

An **action** is a launch configuration made into a short form for people who run things but do
not read flows: a manager restarting a switch, a service desk resetting a port. They see a title,
a sentence on what it does, only the values they choose, a summary of what will happen, and
**Run**. No canvas, no code, no commit or inventory. While it runs they follow it in plain words.

## Make a launch configuration an action

On the configuration's page, **Settings**, section **Action**, **Make it an action** (an
administrator, or someone with **read and write** on the workspace):

- **Title** and **What it does**: in the runners' words ("Restart the edge switch", "Restarts one
  edge switch and checks it answers again").
- **What it asks**: tick the inputs a runner chooses, each with a **label** ("Switch", not
  `devices`) and a **help line**. **Choices** (names separated by commas) limit it to those values;
  a host list without choices offers the inventory's hosts and groups by name. Every input not
  ticked runs with the configuration's value, and a runner cannot change it: the server refuses a
  value for an input the action does not ask. Secret-looking inputs are never asked: give them
  with a credential.
- **It runs** as a check or for real: the action decides, not the runner.
- **Run asks to confirm first**: the runner sees what they chose and answers **Run** or **Not
  now**.
- **On**: off, nobody can run it; its words and who may run it are kept for when it is on again.
  **Stop being an action** forgets both; the configuration stays.

Whoever saves it last is the action's **owner**: runners are told to ask them (and the server's
administrators) when something goes wrong.

## Who may run it

Under the action, **Who may run it**: a person by login or a group by name, then **Let them run
it**. That grant gives the action and nothing else of the workspace: no flows, files,
configurations, runs or search results, not even the workspace's name in the menu. **Take back**
ends it at once. Operators of the flow and administrators may run it without a grant. The
workspace's **Access** tab lists who may run each action.

Approvals in the flow still apply: the run waits at an approval step until someone allowed
decides, as for every run. The runner does not decide (unless the workspace lets whoever launched
a run decide, see [Approvals](approvals.md)).

## Running one

**Actions** in the side menu lists the actions you may run, each with your last run of it. Someone
whose only access is actions lands on Actions when they sign in, and the menu holds only Actions
and Help.

An action opens its form: the values it asks, **What will happen** (check or real, the steps it
goes through by title, the approvals it waits at and who decides them, the values the action sets
itself), and **Run**. A value that is missing or not one of the choices is said at its field.

![An action's form on a phone](images/action-form.png)

## How it goes

After **Run** the page shows the run's progress, live, at its own address
(`/actions/runs/<run>`), which can be shared with others who may run the action:

- where it is in one sentence: waiting to start, running step 2 of 3, waiting for approval at
  _Approve the change_ by _change-board_, done, failed;
- the steps by title, each done, running, waiting, failed or to do, and how many of how many are
  done;
- when it failed, why in words (which step, how many hosts, or who rejected it and their comment)
  and whom to ask: the action's owner, then the administrators;
- the values it was asked for, by their labels.

Who may see the run itself (read only on the flow) also gets **The full run page**, with the
canvas and the output. **Run it again** opens the form again once the run ended.

![A run of an action, step by step](images/action-progress.png)

## The API

| Route                                                            | What                                                  |
| ---------------------------------------------------------------- | ----------------------------------------------------- |
| `GET /api/v1/actions`                                            | The actions you may run, each with your last run      |
| `GET /api/v1/actions/<id>`                                       | Its form: the asked inputs, what will happen          |
| `GET /api/v1/actions/<id>/hosts`                                 | The inventory's hosts and groups for a host list      |
| `POST /api/v1/actions/<id>/run`                                  | `{"inputs": {"devices": "sw-edge-02"}}`: run it       |
| `GET /api/v1/actions/runs/<run>` (and `/events`, live)           | How a run of it goes, in words                        |
| `GET`, `PUT`, `DELETE /api/v1/launch-configs/<id>/action`        | The action of a configuration: read, set, stop        |
| `POST /api/v1/launch-configs/<id>/action/grants`, `DELETE …/<g>` | Who may run it: `{"user": "mia"}` or `{"group": "…"}` |

An action's id is its launch configuration's id. Setting, granting, taking back and running are in
the [audit log](audit.md) (`action.set`, `action.remove`, `action.grant`, `action.grant-remove`,
`action.run`).
