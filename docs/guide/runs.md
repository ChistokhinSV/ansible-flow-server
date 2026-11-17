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

| Address (under `/api/v1`)                                    | Does                                                          | Who          |
| ------------------------------------------------------------ | ------------------------------------------------------------- | ------------ |
| `GET /runs?project=&flow=&state=&config=&by=&limit=&before=` | Runs, the newest first, narrowed and a page at a time (below) | what you see |
| `GET /runs/:id`                                              | One run                                                       | `ro`         |
| `POST /runs/:id/cancel`                                      | Stop it: at once when queued, else at the worker's next word  | `operator`   |

- **Filters:** `project` (its id), `flow` (the flow's file), `state`, `config` (a launch
  configuration's id) and `by` (the login of who asked for the run; your own for your runs).
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
- In the launch's image, else `AFS_EE_IMAGE`. Without a container engine (or with
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
  the reason; `cancelled` when stopped on request. A run longer than
  `AFS_RUN_TIMEOUT_MINUTES` (240) is stopped.

| Address (under `/api/v1`)         | Answers                                                                                                                    | Who        |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `GET /runs/:id/output`            | What Ansible wrote, secrets hidden (text)                                                                                  | signed in  |
| `GET /runs/:id/view`              | How the run went, step by step, as the designer shows it                                                                   | signed in  |
| `GET /runs/:id/events`            | The run as it goes, as server-sent events: `run`, `view`, `output` (with `next`), `end`; `?from=<next>` resumes the output | signed in  |
| `GET /runs/:id/hosts/:node/:host` | What one host did in one step, from the run's events                                                                       | signed in  |
| `POST /runs/:id/relaunch`         | The same run again (same commit, inputs and credentials), as a new run                                                     | `operator` |

**Watching a run:** the run page follows it live; a script reads the same with
`curl -N -H "Authorization: Bearer $AFS_TOKEN" https://flows.example.net:8443/api/v1/runs/<id>/events`.
Ended runs are removed after `AFS_RUNS_KEEP_DAYS` (90), and beyond `AFS_RUNS_KEEP_PER_FLOW`
(200) of one flow, with their output.

**The server in a container** runs flows in sibling containers through the engine's socket; see
[Run with docker compose](install.md#run-with-docker-compose). The data folder may be any volume: at start
the server asks the engine about its own container and gives run containers the volume's paths
as the engine knows them (`AFS_ENGINE_DATA_DIR` names them when it cannot find out).

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
