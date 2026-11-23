# Runs

[The guide](README.md)

![A finished run on the flow's canvas, with its hosts and what ran](images/run.png)

A launch makes a run and puts it in the queue. The server takes runs from the queue and runs
them with Ansible in an execution environment container (docker or podman), the way the same
run from VS Code would.

```sh
curl ... -X POST https://flows.example.net:8443/api/v1/launch-configs/<id>/launch \
  -d '{"mode":"real","inputs":{"target_version":"7.4.1"}}'
```

```json
{
  "id": "9b2f3c4d-1e5a-4f6b-8c7d-0e1f2a3b4c5d",
  "number": 12,
  "project": "2a968c91-1ac7-4654-94c8-2eb24a28b10b",
  "config": { "id": "0f3d6f0e-6a53-4d4e-8a55-9d2f0c1b7e21", "name": "Upgrade edge firewalls" },
  "commit": "59b2575163b54f0c8a1e7d9b3f2a6c8e1d0b5741",
  "ref": "main",
  "flow": {
    "file": "flows/firewall-upgrade.flow.yaml",
    "key": "firewall-upgrade",
    "name": "Firewall firmware upgrade",
    "version": 1
  },
  "mode": "real",
  "inputs": { "devices": ["fw-edge-01", "fw-edge-02"], "target_version": "7.4.1" },
  "targets": ["fw-edge-01", "fw-edge-02"],
  "credentials": [],
  "state": "queued",
  "requestedBy": { "id": "5c1d2e3f-4a5b-6c7d-8e9f-0a1b2c3d4e5f", "login": "dana" },
  "createdAt": "2026-11-13T14:53:51.120Z",
  "attempts": 0,
  "cancelRequested": false
}
```

| State                              | Means                                                                   |
| ---------------------------------- | ----------------------------------------------------------------------- |
| `queued`                           | Waiting for a worker (and for a place under the limits)                 |
| `running`                          | A worker has it                                                         |
| `waiting`                          | Waiting for a decision (approvals, to come)                             |
| `succeeded`, `failed`, `cancelled` | How it ended                                                            |
| `lost`                             | Its worker stopped answering after it started: what it did is not known |

| Address (under `/api/v1`)                                       | Does                                                          | Who          |
| --------------------------------------------------------------- | ------------------------------------------------------------- | ------------ |
| `GET /runs?project=&flow=&state=&config=&by=&q=&limit=&before=` | Runs, the newest first, narrowed and a page at a time (below) | what you see |
| `GET /runs/:id`                                                 | One run                                                       | `ro`         |
| `POST /runs/:id/cancel`                                         | Stop it: at once when queued, else at the worker's next word  | `operator`   |

- **Filters:** `project` (its id), `flow` (the flow's file), `state` (`rejected`: failed because
  an approval was rejected or not decided in time; `failed` leaves those out; `paused`: a
  step-by-step run paused before a step, whose state is `running`; `waiting` has those too, as
  both wait for a person; `going`: queued, or running and not paused), `config` (a launch
  configuration's id), `by` (the login of who asked for the run; your own for your runs) and
  `q` (words in the flow's name or file, the configuration's name or a login, or `#12` for a
  run's number; the Runs page's **Find** box).
  They narrow what you may see and never add to it. A token made for one workspace names a
  `project` or a `config` of that workspace.
- **Pages:** `limit` runs at a time (50, at most 200). For the next page, pass the last run of
  a page as `before=<createdAt>,<number>,<id>`: the list goes on after that run, also when
  other runs were made in the same millisecond. A time alone (`before=<createdAt>`) still gives
  the runs made before it.
- **Limits:** `AFS_MAX_RUNS` runs at once on the server (4), `AFS_MAX_RUNS_PER_PROJECT` of one
  project (1). A run over a limit waits; another project's runs do not wait behind it.
- **A worker that goes away:** a run it had not started goes back in the queue (lost after 3
  tries); one it had started is `lost` and is never started again on its own.
- A secret typed at launch is kept sealed and shown as `***`.
- A project with a run going is not deleted; its ended runs go with it.
- Runs in the queue survive a restart.

**How a run is run:**

- The repository at the run's commit; the flow's code is generated fresh from the flow at that
  commit (a hand-edited `generated/` file has no effect).
- In the launch's image, else the server's default image (an environment an administrator picked,
  else `AFS_EE_IMAGE`; see [Execution environments](environments.md)). Without a container engine (or with
  `AFS_CONTAINER_ENGINE=off`) runs wait in the queue.
- **The repository's files and config:** before Ansible starts, the designer's probe reads the
  repository's `ansible.cfg` in the run's image (for a moment, without the run's credentials).
  The run keeps the callbacks it enables and the paths it gives, and adds the repository's own
  `library/` (with `module_utils/`), `filter_plugins/`, `lookup_plugins/`, `test_plugins/`,
  `action_plugins/` and its root `group_vars/` and `host_vars/`, as a run from VS Code does. A
  relative file a step reads (`templates/motd.j2`) is the repository's. When the config cannot be
  read, the run goes on without these and the server's log says why.
- Credentials: SSH key (mounted read-only for the run; a key with a passphrase is unlocked into
  an ssh-agent inside the run, so the image needs `openssh-client`), login and become
  passwords, the vault password, environment variables, and a registry sign-in: before the run
  the server signs in to the image's registry with it and pulls the image, with sign-in data of
  the run's own that is removed right after. Secret values are hidden in the output. A wrong
  passphrase fails the run with "The SSH key could not be unlocked".
- Ended: `succeeded` when Ansible ended well and wrote its events; `failed` otherwise, with
  the reason in plain words ("1 of 4 hosts failed at Pre-checks (Ansible ended with code 2: one
  or more hosts failed)", "No host ran: the limit sw-edge-09 matched none of the targets
  (sw-edge-01) in the inventory inventory.ini", "1 of 3 hosts could not be reached: sw-edge-02
  (Ansible ended with code 4: one or more hosts could not be reached)"). When only Ansible's exit
  code tells, the run says what it means, with Ansible's last error line when there is one:
  "Ansible could not read the playbook or the inventory, or found no host to run on: the role
  'baseline' was not found in /runner/project/roles (Ansible ended with code 4)". The codes: 1 an
  error, 2 a host failed, 3 hosts could not be reached, 4 the playbook or inventory could not be read or no host was
  found, 5 options Ansible does not accept, 99 interrupted, 250 an unexpected error;
  `cancelled` when stopped on request, saying who stopped it and during which step ("Stopped by
  Dana Whitfield during Upgrade", "Stopped by Dana Whitfield while it waited for approval at
  Change approval"); its page adds when. On the canvas that step reads **stopped** and the steps
  after it **not reached**. **Stop** on a real run asks first; a check run stops at once. Stopping a
  run that waits for approval tells those its approval asked that it no longer waits. A run whose
  steps had all ended when the stop reached it is recorded as it ended, and its output says so. A
  run longer than `AFS_RUN_TIMEOUT_MINUTES` (240) is stopped.
- **Targets not in the inventory:** Ansible skips them. The run names them
  (`skippedTargets` on `GET /runs/:id`, and on its page), also when it went well.

| Address (under `/api/v1`)         | Answers                                                                                                                    | Who        |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `GET /runs/:id/output`            | What Ansible wrote, secrets hidden (text)                                                                                  | signed in  |
| `GET /runs/:id/view`              | How the run went, step by step, as the designer shows it                                                                   | signed in  |
| `GET /runs/:id/events`            | The run as it goes, as server-sent events: `run`, `view`, `output` (with `next`), `end`; `?from=<next>` resumes the output | signed in  |
| `GET /runs/:id/hosts/:node/:host` | What one host did in one step, from the run's events                                                                       | signed in  |
| `GET /runs/:id/hosts/:host`       | What one host did in the whole run: `steps`, each with its `node`, its title (`step`) and its task results (`entries`)     | signed in  |
| `POST /runs/:id/relaunch`         | The same run again (same commit, inputs and credentials), as a new run                                                     | `operator` |

**A run's page** says what ran: the flow and commit, the run's number (counted over the
project's runs), check or real, the hosts and the limit, the inventory, the environment and its
image (marked "the server's default" when the run got the server's default image as it started),
the credentials by name, and the inputs (secret ones as `***`). `GET /runs/:id` gives the
same: `credentialNames`, `environment` (`id`, `name`), `skippedTargets`. **Run again** runs the
same commit, inputs and credentials as a new run; its title says which inputs it reuses, and on
a real run it asks first, as Launch does; so does a run that reached no host, which would likely
end the same way. **Hosts** lists the run's hosts and how each fared; a
host's row opens what it did, step by step: each task's result, with Ansible's message and
output.

**The value each host had:** a run records the values each step's inputs had for each host. In
the run's flow, a step's **Details › Data** shows **In this run** under each input (the values
with their hosts, or one host's after **For host**, which lists the run's hosts), and says when it
differs from the value the flow states; a variable's tooltip adds the values too (every host's, or
the host picked; for a flow input a step reads directly, the value the run was given), and the
step's **Run** tab lists a host's input values from its row. Secrets are never recorded (`no_log` steps, vaulted
values, secret-looking names and keys, the run's secret inputs): they read "secret: not recorded".
A value is cut past 2000 characters and a run keeps 256 KB of values at most. An administrator
turns recording off with `AFS_RUN_RECORD_INPUTS=false`: runs then record no input values at all.

**Watching a run:** the run page follows it live; a script reads the same with
`curl -N -H "Authorization: Bearer $AFS_TOKEN" https://flows.example.net:8443/api/v1/runs/<id>/events`.
Ended runs are removed after `AFS_RUNS_KEEP_DAYS` (90), and beyond `AFS_RUNS_KEEP_PER_FLOW`
(200) of one flow, with their output.

**The server in a container** runs flows in sibling containers through the engine's socket; see
[Run with docker compose](install.md#run-with-docker-compose). The data folder may be any volume: at start
the server asks the engine about its own container and gives run containers the volume's paths
as the engine knows them (`AFS_ENGINE_DATA_DIR` names them when it cannot find out).

## Step by step

A run can pause before each step until someone says how to go on: tick **Step by step** on a
launch configuration's **Launch** tab, or in the canvas's Run dialog (**Run Step by Step** in the
Run menu opens it ticked). It is one Ansible run that waits; nothing is split or started again,
so facts and registered values carry on from step to step.

- **Where it waits:** before a step that has hosts, all its hosts together. The run's page says
  so above the canvas: "Paused before Read the minimal facts · 2 hosts · stops by itself in
  59 min", with the hosts that wait there, how many pause points the run has, and, when it waits
  at a pause point, whose ("Dana Whitfield's pause point"). A step inside a subflow is named by
  its path: "Paused before Pre-checks › Read device status". The canvas rings the step with the
  number of hosts waiting, and its Run tab lists them "waiting for Step or Continue". On a phone
  the line and its buttons are above the canvas too.
- **Paused, not running:** a paused run reads **paused** on its page, in the lists, on the
  flow's page and on Home ("Your run #12 of Hello is paused before Say hello"). The Runs page has
  a **Paused** filter, and **Waiting** lists paused runs too; **Going** lists the runs queued or
  running and not paused (Home's "still go").
- **Step** runs that step and pauses before the next one. **Continue** runs on and pauses only at
  a pause point. While a step runs the bar says "Running Say hello…" and offers **Pause**, which
  pauses before the next step. **Stop** ends the run before its next step; what ran is kept, and
  the run reads "Stopped by Dana Whitfield before Say hello". A step-by-step run has one Stop,
  in its bar; stopping someone else's run asks first, naming whose it is.
- **The same controls on the canvas:** on the flow's page, Step, Continue and Stop in the
  canvas's toolbar and side panel drive the run shown, as the run's page does.
- **Keys**, while the bar shows: **F10** Step, **F8** Continue (or Pause while a step runs), on
  the run's page and on the canvas (when it has the focus). F5 is the browser's reload, so it is
  not one of them; VS Code keeps its own (F10, F5, F6, Shift+F5). The focus stays on the button
  pressed.
- **Who went on** is in the run's output, under the pause line: "Continue by Omar Haddad". The
  pause itself is said there once: "Paused before Say hello: 2 hosts wait for Step, Continue or
  Stop".
- **Step times** leave the pauses out: a step reads "ran 1 s, waited 31 s".
- **Pause points:** a step's menu on the canvas (also on a read-only canvas) sets or takes away a
  pause point, and so does the dot at a step's top left corner (it shows when the pointer is on
  the step). On the flow's page they are yours, per flow, kept by the server (not in the flow
  file), and a step-by-step run you launched gets the new ones at its next step. On a run's page
  they are that run's: changed there, they go to the run, and the run says who set them.
- **Launch tab:** with **Step by step** ticked, choose **Before each step** or **Only at your
  pause points**, and how long a pause waits (at most the server's
  `AFS_RUN_STEP_TIMEOUT_MINUTES`). A real run's question says that it pauses.
- **Readers** (`ro`) see where the run waits and who may go on: "Waiting for Dana Whitfield or
  an operator of this flow to go on".
- **Who:** whoever may launch the flow may launch it step by step (`operator` on the flow).
  Step, Continue, Pause and Stop are for whoever may stop the run: `operator` on its flow (the
  person who launched it is one) and administrators. Each is in the audit log as `run.step`
  with the command.
- **While it waits** the run keeps its container, its place among the runs at once
  (`AFS_MAX_RUNS`) and its lease, and counts toward `AFS_RUN_TIMEOUT_MINUTES`. A pause nobody
  answers stops the run by itself after `AFS_RUN_STEP_TIMEOUT_MINUTES` (60): "Stopped before
  Say hello: nobody answered for 60 minutes". A launch may ask for less (`timeoutMinutes`),
  never more.
- **A server that stops or restarts** while a run is paused ends it as stopped: "Stopped: the
  server restarted while the run was paused before Say hello; a paused run cannot go on after a
  restart". The process that waited is gone; launch it again.
- **Approvals** inside a step-by-step run work as in any run; after the decision the run goes on
  step by step from where it was.
- A schedule never runs step by step, and neither does an action. A run's end notifications are
  the same as for any run; a pause tells nobody.
- With several servers on one database, Step and Continue reach the run on the server that
  runs it: open its page there.

| Address (under `/api/v1`)                    | Does                                                                                                     | Who        |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------- |
| `POST /launch-configs/:id/launch`            | With `"step": {"every": true}` (or `"points": [<node ids>]`, `"timeoutMinutes"`): a step-by-step run     | `operator` |
| `POST /runs/:id/step`                        | `{"command": "step"\|"continue"\|"pause"\|"stop"}`, and/or `"points"`; 409 with why when it does not fit | `operator` |
| `GET /projects/:id/pause-points?path=<flow>` | Your pause points on a flow                                                                              | `ro`       |
| `PUT /projects/:id/pause-points?path=<flow>` | Keep them (`{"points": [...]}`); your step-by-step runs of the flow going now get them                   | `operator` |

`GET /runs/:id` says `step` (what it was asked for, with the pause points it has now and, when
someone changed them while it went, `pointsBy`) and `pausedBefore` (the step it waits at now, by
its path); the run's view has the designer's `step` (the pause, its hosts, when it stops by
itself, and the step running after Step or Continue). The answer to Step, Continue or Stop does
not carry `pausedBefore`: the run goes on.

## Dev runs

Someone with `rw` on a workspace can check work they have not pushed yet: VS Code's **Check My
Work on Server** (Ansible Flow Designer) sends it, committed or not, and the server runs it in
**check mode** with the flow's launch configuration. A real run still takes a commit of the
project's branch.

- The work comes as a git bundle (`POST /api/v1/projects/<id>/dev-bundles`,
  `content-type: application/x-git-bundle`, one ref), at most `AFS_DEV_BUNDLE_MAX_MB` (50). It
  starts from a commit the server has, or carries its whole history.
- The server keeps its commit under a ref of its own (`refs/afs/dev/<id>`) for
  `AFS_DEV_KEEP_HOURS` (24): never on a branch, never passed on to an external project's source,
  never shown to anyone who clones, fetches or pushes.
- A launch that names it (`{"dev": "<id>"}`) runs it in check mode; `rw` on the flow. `"mode":
  "real"` is refused. An expired bundle says to send the work again.
- The run is a **dev run** in the run list, on its page and in the API (`"dev": true`); the upload
  is in the audit log (`dev-bundle.upload`).

```sh
git update-ref refs/afd-dev/run HEAD
git bundle create work.bundle refs/afd-dev/run ^<the server's commit>
curl -H "Authorization: Bearer $AFS_TOKEN" -H 'content-type: application/x-git-bundle' \
  --data-binary @work.bundle https://flows.example.net:8443/api/v1/projects/<id>/dev-bundles
```
