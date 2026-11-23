# Debug a run

A debug run is a step-by-step run that also shows the variables of each host where it pauses.
It pauses at your pause points and where a host fails. While it is paused you can read each host's
variables, watch expressions across hosts, evaluate Jinja, and run a failed step again. The same
engine serves the debugger in VS Code (Ansible Flow Designer), so a pause looks the same in both.

## Start one

- **Debug** beside **Launch** on a launch configuration's Launch tab starts a debug run with the
  form's inputs. It pauses at your pause points on the flow. Without pause points it pauses before
  every step.
- **Run ▾ › Debug…** on the flow's canvas opens the launch dialog. Its button says **Debug**.
- **Run again ▾ › Debug this failure…** on a failed run's page (see [Runs](runs.md#run-again))
  debugs the hosts that did not go well, at the failed run's commit.

Who may start one: read and write (rw) on the flow. Operators may too where the workspace's
administrator ticked **Operators may debug** (Workspace › Access › Debugging, off by default).
A debug run shows the hosts' variables, so it is not a plain operator's right.

## Pause points with settings

Right-click a step on the canvas and choose **Edit Pause Point…**:

- **Always:** the run pauses before the step.
- **When a condition holds:** Jinja checked for each host before the step, such as
  `vlan_id == 210`. If any host matches, all hosts pause, and the reason line names the hosts
  that matched. A condition that fails to render is reported in the run's output and does not
  pause.
- **After N arrivals:** pause when the count of hosts that reach the step gets to N.
- **Log only:** a message rendered for each host goes to the run's **Log points** (masked as
  any value is), and the run does not pause.

The popover also holds the failure filters: **A host failed** (on by default) and **A host is
unreachable**. Your points and filters are kept for you on each flow, as plain pause points are.
On a run's page they are the run's, and the run uses them from its next step.

Settings count only in debug runs. A step-by-step run that is not one pauses at the point as if
it had none.

## The Debugger panel

On a debug run's page the **Debugger** panel sits beside the canvas (below it on a phone).

- **The reason line** names the step, the count of hosts and why the run paused: a pause point,
  a step, a condition, a failure or an unreachable host. It also says when the pause stops the
  run by itself: "Paused after Apply config · 1 of 6 hosts failed (attempt 1) · stops by itself in
  52 min".
- **Retry, Continue, Step, Stop.** Retry is offered where hosts failed a step. It runs the step
  again on those hosts. The step's changes on the hosts are not undone, and the panel says so
  before you press it. A second failure pauses again (attempt 2). Retry is refused for a rolling
  subflow and for a failure outside the step's rescue; Run again offers a new run there.
- **Host:** starts at the first failed host (else the first that matched a condition). Every
  pause holds all hosts.
- **Variables:** the host's scopes. Each opens when you open it:
  - **Step inputs:** the step's inputs as the step gets them;
  - **Host variables:** inventory variables, set_fact values and registered results;
  - **Flow data:** the run's extra variables;
  - **Facts:** read only when you open them.

  A template is shown as text and is not rendered. A value longer than 64 KB is cut, and says
  where.
- **Watch:** expressions kept for you on this flow. Each shows its value for the host picked.
  **Compare across hosts** groups all paused hosts by the value they have. A watch that fails
  shows its error and stays in the list.
- **Evaluate:** a Jinja expression for the host picked (Ctrl+Enter), written with or without
  `{{ }}`. It is read-only and runs for at most 2 s. Lookups (`lookup`, `query`, `q`) and the
  vault filters are refused: "lookups are not allowed in Evaluate".

Keys: **F10** Step, **F8** Continue (or Pause while the run goes), **Ctrl+Enter** Evaluate.

### Secrets

Values leave the run masked, and a masked value says why, never its length:

- `vault`: a vaulted value, or a value from a vaulted file;
- `no_log`: the result of a `no_log` task;
- `credential`: a value of one of the run's credentials;
- `external secret`: a value read from a [secret provider](secret-providers.md);
- `secret-looking name`: a variable named like a secret (`password`, `token`, `secret`, ...).

Copies made from a secret (base64, JSON, upper case, a longer string holding it) are masked too.
One case is not caught: a plain secret under a harmless name that appears in no credential. The
server still hides the run's credential values in its output, as a second layer.

## Who sees what

- **Who launched the run, and administrators:** the buttons, the variables, Watch and Evaluate.
- **Others who may see the run:** the reason line and the canvas, and who it waits for ("Paused
  by Dana Whitfield"). They see no values and no buttons. An operator of the flow may still Stop
  the run, as any run.

Every question to a paused run is in the audit log (`run.debug.inspect`). The entry has the
question's kind and the expression of Evaluate or Watch, and never the answer.

## After the run

The scopes and watches each pause showed (masked) are kept with the run, at most 1 MB a run.
The run's page lists them under **What the pauses showed** for who could see them during the
run. They are deleted with the run.

## API and MCP

| Route                                                  | What it does                                                                                                                                                                                      | Who                          |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `POST /launch-configs/:id/launch`                      | With `"step": {"debug": true, "points": [...], "failures": {"failed": true, "unreachable": false}}`: a debug run. A point is a node id or `{"node", "condition", "hits", "log"}`                  | rw (or operator, if allowed) |
| `POST /runs/:id/inspect`                               | Ask the paused run: `{"op": "scopes"\|"vars"\|"facts"\|"eval"\|"watch", "host", "scope", "path", "start", "count", "expr", "exprs", "hosts"}`. Waits for the answer. 410 once the pause has ended | who launched it, admins      |
| `POST /runs/:id/step`                                  | `{"command": "retry"}` at a failure pause; `{"failures": {...}}` changes the filters                                                                                                              | who launched it, admins      |
| `GET /runs/:id/debug`                                  | What the run's pauses showed, kept with it                                                                                                                                                        | who launched it, admins      |
| `GET` and `PUT /projects/:id/pause-points?path=<flow>` | Your points (with settings) and your failure filters on a flow                                                                                                                                    | `operator`                   |

The answer to `inspect` comes from the run itself, usually within 100–150 ms. Only the server
that runs it answers; another server of the group answers 409.

Agents: the MCP tool `run_inspect` asks the same questions. It is listed only for tokens made to
allow run control, as `run_step` is, and an agent should use it only when you told it to.
