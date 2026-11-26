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
  any value is), and the run does not pause. The Debug Console lists the lines under **Log
  points**: the step, the host and the message, or why the message could not be rendered.

The popover also holds the failure filters: **A host failed** (on by default) and **A host is
unreachable**. Your points and filters are kept for you on each flow, as plain pause points are.
On a run's page they are the run's, and the run uses them from its next step.

Settings count only in debug runs. A step-by-step run that is not one pauses at the point as if
it had none.

## The debugger

A debug run is debugged as in VS Code: the canvas stays in the middle and the debug views open
around it. A debug run you start from the flow's canvas is debugged right there, on the flow's
page; its run's page (**The run's page** in the status line) has the same views.

- **The toolbar** over the canvas: **Continue** (F5) or **Pause** while the run goes, **Step**
  (F10), **Retry** at a failure pause, **Stop** (Shift+F5) and, once the run has ended,
  **Restart** (the run again, at the same commit, with the same inputs and pause points). F8 does
  what F5 does, as on the canvas. The canvas's own step buttons give way to this toolbar.
- **The side bar**, on the left: the activity bar beside it picks its view (**Run and Debug**,
  and on a run's page **Details**: approvals, hosts, outputs, what ran and its inputs). A second
  click on the open view folds the side bar; **Ctrl+Shift+D** does the same. Drag its edge, or
  focus the edge and use the arrow keys (Shift: further, Home and End: the ends), to size it.
- **The panel** under the canvas: **Debug Console**, **Terminal** (the run's output) and
  **Problems** (why each host failed). Size it by its top edge.
- **The status line** at the bottom names the step, the count of hosts and why the run paused,
  who paused it and when the pause stops the run by itself: "Paused after Apply config: 1 of 6
  hosts failed (attempt 1) · stops by itself in 52 min · paused by Dana Whitfield", or "Paused
  before Validate · condition held on sw-edge-03, sw-edge-04 (2 of 4 hosts)". The page's header
  says the same: "after" at a failure pause, "before" elsewhere. Stop at a failure pause reads
  "Stopped after Push baseline · 1 host failed, 3 stopped after it".

From about 1100 px wide the side bar is beside the canvas; on a laptop or a tablet held sideways
(about 1024 px) it lies over the canvas and opens when the run pauses. Up to 860 px wide (a
phone) the page has tabs, **Flow · Debug · Console**; the toolbar and the status line stay in
sight on each. The sizes you choose are kept in this browser.

**At a pause** the side bar opens on Run and Debug at the first failed host (else the first that
matched a condition), Continue takes the focus (unless you are typing in the console), the
browser tab's title starts with "⏸ Paused", and a phone shows the Debug tab. While the tab is
hidden a notification says the run paused, once you allowed notifications with **Notify me at
pauses** in the status line.

The Run and Debug view holds:

- **Variables:** the host's scopes. Each opens when you open it:
  - **Step inputs:** the step's inputs as the step gets them;
  - **Host variables:** inventory variables, set_fact values and registered results;
  - **Flow data:** the run's extra variables;
  - **Facts:** read only when you open them.

  The failed task and its message come first at a failure pause. A template is shown as its
  text, marked "(template, not rendered)". The engine's own variables (`afd_repo_root` and the
  like) are not listed. A value longer than 64 KB is cut, and says where and how big it is:
  "(cut at 64 KB of 164.9 KB)". Facts not gathered yet say so.
- **Watch:** expressions kept for you on this flow by the server: each person has their own, on
  any browser, and nobody else's run in their name. Each shows its value for the host chosen.
  The compare icon on a row groups all paused hosts by the value they have. A watch that fails
  shows its error and stays in the list.
- **Hosts:** every host the pause holds, failed and matching first, with its state and where it
  waits. Every pause holds all hosts, also after a Retry: "1 of 4 hosts failed (attempt 2)",
  with all four listed. Choosing one sets the host of Variables, Watch and the Debug Console,
  and marks the steps it ran on the canvas.
- **Pause points:** **Pause on failure** and **Pause on unreachable** on top, then the run's
  points with their settings. Clear a box to take a point off (it stays listed until you leave
  the page, to be put back); a step's name shows it on the canvas. On the flow's page they are
  your points too, as on the canvas.

**Retry** runs the step again on the hosts that failed. The step's changes on the hosts are not
undone, and the toolbar says so before you press it. A second failure pauses again (attempt 2).
Retry is refused for a rolling subflow and for a failure outside the step's rescue; Run again
offers a new run there.

The **Debug Console** evaluates a Jinja expression for the host chosen (**Enter**; Shift+Enter
for a new line), written with or without `{{ }}`. Each answer stays above the box for the pause;
the arrow up brings back what you evaluated. It is read-only and runs for at most 2 s. Lookups
(`lookup`, `query`, `q`) and the vault filters are refused: "lookups are not allowed in
Evaluate". An expression left open (`foo(`) says "a bracket or a quote is not closed". The log
points' lines are listed above it.

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
  by Dana Whitfield"). They see no values, no Step or Continue, and no Pause here on the canvas.
  An operator of the flow has **Stop** in the toolbar, as for any run; it asks first, naming whose
  run it is.
- The run's record (`GET /runs/:id`), its view (`/view`) and its live events (`/events`) give
  others the steps of its pause points, not their conditions and log messages, which may hold a
  literal value, and none of the log points' lines. In the run's output (the panel's Terminal,
  `GET /runs/:id/output`, MCP `run_output`) a log point's line reads "Log point Backup config ·
  sw-edge-01: (only who launched the run reads this)" for them.
- A refused Step or Continue says who drives the run: "Only dana (who launched it) or an
  administrator drives this debug run". Stop stays an operator's.

Every question to a paused run is in the audit log (`run.debug.inspect`). A refusal there says
who may: "Only who launched this debug run, or an administrator, looks into its variables".

The entry has the question's kind and the expression of Evaluate or Watch, and never the answer.
An expression the run refused (a lookup) is recorded as refused. Over the API and MCP an
expression may be written with or without `{{ }}`, as on the page.

## After the run

What each pause showed (masked) is kept with the run, at most 1 MB a run: the scopes, the values
of each scope you opened, and the watches. The run's page lists them in its Run and Debug view, under **What the pauses
showed** for who could see them during the run: per host, the values of the scopes opened (the
others by their count of variables), and each watch once, with its last answer. Pauses at the
same step are told apart ("pause 2 of 3 here") with the time each paused. The log points'
lines follow, each with its step.
They are deleted with the run.

## API and MCP

| Route                                                  | What it does                                                                                                                                                                                      | Who                          |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `POST /launch-configs/:id/launch`                      | With `"step": {"debug": true, "points": [...], "failures": {"failed": true, "unreachable": false}}`: a debug run. A point is a node id or `{"node", "condition", "hits", "log"}`                  | rw (or operator, if allowed) |
| `POST /runs/:id/inspect`                               | Ask the paused run: `{"op": "scopes"\|"vars"\|"facts"\|"eval"\|"watch", "host", "scope", "path", "start", "count", "expr", "exprs", "hosts"}`. Waits for the answer. 410 once the pause has ended | who launched it, admins      |
| `POST /runs/:id/step`                                  | `{"command": "retry"}` at a failure pause; `{"failures": {...}}` changes the filters                                                                                                              | who launched it, admins      |
| `GET /runs/:id/debug`                                  | What the run's pauses showed, kept with it                                                                                                                                                        | who launched it, admins      |
| `GET` and `PUT /projects/:id/pause-points?path=<flow>` | Your points (with settings) and your failure filters on a flow                                                                                                                                    | `operator`                   |
| `GET` and `PUT /projects/:id/watches?path=<flow>`      | Your watch expressions on a flow (`{"exprs": [...]}`, at most 20)                                                                                                                                 | `operator` (`GET`: `ro`)     |

The answer to `inspect` comes from the run itself, usually within 100–150 ms. Only the server
that runs it answers; another server of the group answers 409.

Agents: the MCP tool `run_inspect` asks the same questions. It is listed only for tokens made to
allow run control, as `run_step` is, and an agent should use it only when you told it to.
