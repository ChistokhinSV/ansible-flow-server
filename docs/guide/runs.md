# Run playbooks

[The guide](README.md)

Flows run in execution environment containers (Docker or Podman) using the same runner as
[Ansible Flow Designer](https://github.com/ChistokhinSV/ansible-flow-designer), with fresh Ansible
playbooks generated from the flow at the run's Git commit.

## Launch configurations

![A launch configuration with inputs, Check/Real choice and live What will run summary](images/launch.png)

A **launch configuration** binds a flow to everything needed to run it repeatedly under a clear
name. Operators (`operator` or higher) launch it; editors (`rw` on the flow) create and change it on
the project's **Overview** (**Add a launch configuration**).

| Setting             | What it sets                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------ |
| **Flow**            | Path to `*.flow.yaml` in the project (flows with validation errors cannot launch)                      |
| **Branch / Commit** | Defaults to the newest commit on the project's branch; optionally pin a branch or commit               |
| **Inventory**       | Inventory path in the repository (defaults to what `ansible.cfg` configures)                           |
| **Environment**     | Workspace [execution environment](environments.md) or image (defaults to the server default)           |
| **Mode**            | **Check** (default) or **Real**                                                                        |
| **Limit**           | Optional Ansible `--limit` host pattern                                                                |
| **Inputs**          | Default values for the flow's inputs (secret-looking inputs are typed at launch, never saved)          |
| **Credentials**     | Workspace [credentials](credentials.md) mounted for the run (SSH, login, become, vault, env, registry) |
| **Notify**          | Users or groups [notified](notifications.md) when a run fails or whenever it ends                      |

### Launching a run

Open a launch configuration's **Launch** tab (or click **Run** directly on a flow's canvas):

- **Check vs Real**:
  - **Check** runs Ansible's `--check` mode (tasks report what they would change; tasks marked
    `check_mode: false` still execute) and passes [approval gates](approvals.md) automatically.
  - **Real** applies changes on target hosts and pauses at approval gates for human sign-off.
- **What will run**: updates live beside the form as you type — showing the flow version and commit,
  expected step path, matched inventory hosts (with group quick-pick buttons and warnings for
  unknown hosts or empty limits), image, credentials, upcoming approvals and the last run. Under
  each input, a precedence note shows which steps read it and which `group_vars` / `host_vars`
  definitions it overrides.
- Press **Launch check run** or **Launch real run** (`Ctrl+Enter` / `Cmd+Enter` from any field). Use
  **Keep as start values** (`rw`) to save non-secret form edits back to the configuration. Launching
  another branch or commit than the configuration's requires `rw`.

## Watching a run

![A run on the workbench: Details on the left, canvas in the middle, Terminal below](images/run.png)

Queued runs execute up to `AFS_MAX_RUNS` (default `4`) across the server and
`AFS_MAX_RUNS_PER_PROJECT` (`1`) per project.

| State                              | Meaning                                                                                                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `queued`                           | Waiting in the database queue (survives restarts)                                                                                    |
| `running` / `paused`               | Active on a worker (or paused at a step / debugger point)                                                                            |
| `waiting`                          | Waiting at an [approval gate](approvals.md) (holds no container or runner slot)                                                      |
| `succeeded`, `failed`, `cancelled` | Completed outcome (approvals rejected or timed out filter under **Rejected**)                                                        |
| `lost`                             | Worker stopped answering: requeued up to `3` tries if not yet started; marked `lost` and **never restarted on its own** once started |

- **Workbench**: the **canvas** updates live as hosts move along wires; **Details** (`Ctrl+B`) lists
  approvals, hosts (problem hosts first), flow outputs and what ran (including `skippedTargets` not
  present in the inventory); the bottom panel (`Ctrl+J`) streams **Terminal** output (secrets
  masked) and **Problems**.
- **SSH keys with a passphrase**: unlocked into an `ssh-agent` inside the run container, so the
  execution environment image **must contain `openssh-client`**. A wrong passphrase fails the run
  with `"The SSH key could not be unlocked"`.
- **Stop**: cancels a queued run at once, and stops a running flow immediately on the worker (or at
  the worker's next lease heartbeat), recording who stopped it and during which step. Runs exceeding
  `AFS_RUN_TIMEOUT_MINUTES` (`240`) stop automatically.

## Run again

Once a run has ended, operators can open **Run again ▾** in its header:

- **Run again**: repeats the same commit, inputs, mode and limit as a new run (approvals are asked
  again).
- **Change and run…**: opens the **Launch** tab pre-filled from this run (re-enter any secret
  inputs).
- **Only the N hosts that did not go well**: re-runs only `failed`, `unreachable` and `stopped`
  hosts via a per-host limit file (warning first that steps on `localhost` / controller groups are
  skipped unless included, and `run_once`, failure percentages and rolling batches see only the
  limited hosts).
- **Debug this failure…** (`rw`, or operators when allowed): runs those problem hosts under the
  [debugger](debugging.md), pausing before the step where they failed. Defaults to **Check** mode,
  or choose **Real run** (which asks to confirm, names the hosts, and asks approvals again).

**Rules**: every **Run again** validates against the launch configuration **as it stands now**
(current credentials and environment). **A run whose launch configuration was deleted cannot run
again** — launch from an active configuration instead. Re-running a run of another branch or commit
than the configuration names, or a dev run, requires `rw` on the flow.

## Step by step

Tick **Step by step** on the **Launch** tab (or **Run ▾ › Run Step by Step** on the canvas) to pause
before each step or at your **pause points** (`F10` Step, `F8` Continue/Pause, or Stop).

- **Resource limits while paused**: a paused run **keeps its container and its `AFS_MAX_RUNS`
  runner slot**, and counts toward `AFS_RUN_TIMEOUT_MINUTES`. With `AFS_MAX_RUNS_PER_PROJECT` at its
  default of `1`, a paused run **blocks other runs of that project** until it finishes or stops.
- Unanswered pauses stop automatically after `AFS_RUN_STEP_TIMEOUT_MINUTES` (`60` min), and paused
  runs cannot resume across a server restart.

## Dev runs

With `rw` on a workspace, **Check My Work on Server** in
[Ansible Flow Designer](https://github.com/ChistokhinSV/ansible-flow-designer) uploads uncommitted
local work as a temporary Git bundle (kept `AFS_DEV_KEEP_HOURS`, `24` h, under a hidden ref never
exposed on branches or pushed upstream) and runs it in **Check** mode only.

The [API reference](/docs/api) lists every launch, run, SSE stream, step and relaunch call and who
may make it (see also [REST API and agents](api-and-mcp.md)).
