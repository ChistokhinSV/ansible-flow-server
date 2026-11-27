# Debug a run

[The guide](README.md)

A **debug run** pauses at your pause points and whenever a host fails, letting you inspect each
host's live variables, watch expressions across hosts, evaluate Jinja, and retry a failed step in
place. It runs on the same debug engine as
[Ansible Flow Designer](https://github.com/ChistokhinSV/ansible-flow-designer) in VS Code.

## Start a debug run

- Click **Debug** beside **Launch** on a launch configuration's **Launch** tab.
- Choose **Run ▾ › Debug…** on a flow's canvas (debugs right in place on the flow page).
- Choose **Run again ▾ › Debug this failure…** on a failed run's page to step into the failing step
  on the hosts that did not go well — in **Check** mode by default, or as a **Real** run (asks
  first, names the hosts, and re-asks any approvals).

**Who may debug**: people with **Edit** (`rw`) on the flow, administrators, and operators when an
administrator enables **Operators may debug** under **Govern › Access › Debugging** (off by default
because debugging exposes non-secret host variables). Like any [step-by-step run](runs.md#step-by-step),
a paused debug run holds its container and runner slot while waiting.

## Pause points and failure filters

Click the top-left dot on any step to toggle a pause point, or right-click a step and choose **Edit
Pause Point…**:

- **Always**: pause before the step runs.
- **When a condition holds**: evaluate a Jinja condition per host (for example `vlan_id == 210`); if
  any host matches, all hosts pause and the status line names the matching hosts.
- **After N arrivals**: pause once `N` hosts have reached the step.
- **Log only**: render a masked message per host to **Debug Console › Log points** without pausing.
- **Failure filters**: toggle **A host failed** (on by default) and **A host is unreachable**.

Your pause points, conditions and watches are saved per user and flow on the server; editing them on
a running debug page updates that run from its next step.

## The debugger

When a debug run starts, the workbench opens around the canvas (or switches to **Flow · Debug ·
Console** tabs on a phone):

- **Floating toolbar** (drag by `⋮⋮`): **Continue / Pause** (`F5` or `F8`), **Step** (`F10`),
  **Retry** (at a failure pause), **Stop** (`Shift+F5`), and **Restart** once ended.
- **Left side bar (`Run and Debug`, `Ctrl+B` / `Ctrl+Shift+D`)**:
  - **Variables**: inspect the selected host's **Step inputs**, **Host variables** (inventory,
    `set_fact`, registered results), **Flow data** (extra vars) and **Facts** (loaded on demand;
    values above `64` KB are truncated with their size noted).
  - **Watch**: type a Jinja expression and press `Enter`; click the compare icon on a row to group
    all paused hosts by value.
  - **Hosts**: all hosts held at the pause (failed or matching first). Selecting one updates
    Variables, Watch, Debug Console and canvas highlights.
  - **Pause points**: manage active points and failure filters.
- **Bottom panel (`Ctrl+J`)**:
  - **Debug Console**: evaluate read-only Jinja expressions (`Enter`, `Shift+Enter` for newline, `↑`
    for history; `2` s limit; `lookup`/`query` and vault filters are refused). Log point lines appear
    above it.
  - **Terminal** and **Problems**: full Ansible output and per-host failure messages.
- **Status line**: states why and where the run paused, who paused it, auto-stop countdown, and
  **Notify me at pauses** for background browser notifications.

**Retry** re-runs the failed step on the hosts that failed (asking first, because partial changes
from the failed attempt are not rolled back). Rolling subflows and failures outside a step's rescue
cannot retry in place — use **Run again** instead.

## Secrets, privacy and history

- **Secret masking and its boundary**: values from Ansible Vault (`vault`), `no_log` tasks
  (`no_log`), workspace credentials (`credential`), [secret providers](secret-providers.md)
  (`external secret`), secret-like variable names (`password`, `token`, `secret`, …) and copies
  derived from them (base64, JSON, case changes, substrings) are masked before leaving the runner,
  showing the reason rather than value or length. **One case is not caught**: a plain-text secret
  stored under a harmless variable name that appears in no credential, Vault or `no_log` task will
  show in Variables/Evaluate (though the server still strips known credential values from terminal
  output as a second layer).
- **Who sees what**: only the person who launched the debug run and administrators can drive it, see
  variables or read pause conditions and log-point messages (other readers see the canvas and pause
  status only; Operators can still press **Stop**). Every inspection query is recorded in the
  [audit log](audit.md) (`run.debug.inspect`, expression only, never the value).
- **After the run**: masked snapshots of opened scopes, watches and log points (up to `1` MB) stay
  under **What the pauses showed** until the run is deleted.

The [API reference](/docs/api) lists `/api/v1/runs/:id/inspect`, `/debug`, `/step`, `/pause-points`
and `/watches` and who may call each (for MCP `run_inspect`, see
[REST API and agents](api-and-mcp.md)).
