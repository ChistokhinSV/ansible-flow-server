# ADR-0016: The executor: runs in execution environment containers

- Status: accepted (2026-11-13, AFS-20). Builds on ADR-0015 (the queue), ADR-0013
  (credentials), ADR-0002 (the designer's packages)
- Context: a queued run must be run with Ansible, the way the same run from VS Code would be,
  without the server's machine needing Ansible, and without one run seeing another's secrets

## Decision

**The server is its own first worker** (`src/server/runs/executor.ts`): it takes runs from the
queue (ADR-0015) up to `AFS_MAX_RUNS` at once, keeps each lease alive every 15 seconds, and
says how each run ended.

**Ansible runs in a container** of the run's execution environment image (the launch's, else
`AFS_EE_IMAGE`), started with docker or podman (`AFS_CONTAINER_ENGINE`: `auto` finds one; `off`
runs nothing and runs wait in the queue). The run itself is the designer's own pipeline
(`runFlow`): the same command, event callback, secret handling and summary as in VS Code.

**The commit's files.** The project's branch has one lasting folder (`data/work/<project>/branch`),
put exactly at the run's commit (reset and cleaned). A run of another branch or commit, or a
second run of the branch while the first goes on, gets a folder of its own, removed when it
ends (product owner, 2026-11-13). Folders are git worktrees of the project's mirror: the objects
are not copied.

**The flow's code is generated fresh** from the flow at the run's commit, into `generated/`
beside it, replacing what the commit has there. A run does what the flow says, never a
hand-edited or older copy of its code. The folder is made new; a link in its place is removed,
never followed. A flow with errors at the run's commit fails the run with the first error.

**Credentials reach the run** as:

- Ansible's own variables (`ansible_user`, `ansible_password`, `ansible_become_password`,
  `_method`, `_user`); those with secret-looking names travel the way the designer passes secret
  inputs: in the engine's environment, then a file only the run can read, never `vars.json`;
- the vault password, the designer's way;
- an SSH key in a folder of its own, mounted read-only at `/afd-cred`, named by
  `ANSIBLE_PRIVATE_KEY_FILE`, removed when the run ends. A key with a passphrase (AFS-66): the
  container's entrypoint becomes a script in that folder that starts an ssh-agent, adds the key
  (ssh-add asks an askpass script, which answers once from `AFS_SSH_PASSPHRASE` in the engine's
  environment), drops the variable and runs the run's command; Ansible's ssh finds the key
  through `SSH_AUTH_SOCK`. The passphrase is never in a file or an argument. A wrong passphrase
  or an image without ssh-agent ends the run at once with the script's reason as its error;
- environment variables as `-e NAME`, the value in the engine command's own environment: never
  in an argument list;
- a registry credential (AFS-66), when its host is the image's registry: the server signs in
  with the password on the engine's input (`--password-stdin`) into a configuration folder of
  the run's own (docker `--config`, podman `--authfile`), pulls the image, and removes the
  folder. The engine's own stored sign-ins are not touched; a failed sign-in or pull fails the
  run with the reason, the password scrubbed.

Every secret value is replaced by `********` in the run's output.

**When the server runs as root** (a container with the engine's socket), the image's own user
(found once per image with `id`) is given the run's folder and its key file: Ansible in the
image writes events there, and ssh reads only a key its user owns. Found on the lab VM: without
it, runs "produced no events".

**How a run ends:**

| What happened                                       | The run                                           |
| --------------------------------------------------- | ------------------------------------------------- |
| Ansible ended with 0 and wrote events               | `succeeded`                                       |
| Ansible ended with another code                     | `failed`, with the code and how many hosts failed |
| Ansible wrote no events                             | `failed`: nothing says what the flow did          |
| Someone cancelled it                                | `cancelled`: the container is stopped             |
| It took longer than `AFS_RUN_TIMEOUT_MINUTES` (240) | `failed`                                          |
| The server stopped                                  | `failed`: it is never started again on its own    |
| Its lease was lost                                  | not recorded by this worker (ADR-0015)            |

**What is kept:** the run's output (`data/output/<run>.log`, up to 20 MB, secrets hidden), the
designer's view of how it went in the run's record, and the designer's run folder with the
events (`data/runs/<project>/`).

**When the server runs in a container**, run containers are its siblings: the data folder must
be mounted at the same path as on the host, since the engine mounts paths of the host. Every
run container has the labels `afs.worker` and `afs.run`; at start the server removes the
containers and run folders a stopped server of its own left.

## Not in this decision

- Live status and output while a run goes, pages for runs, retention (AFS-21).
- Hosts a launch would touch as the inventory has them (needs the probe; AFS-21 or AFS-65).
- Which images may be used (AFS-32). Keys with a passphrase and registry sign-in came with
  AFS-66.
- Remote workers (AFS-50).

## Alternatives considered

- **Running the committed `generated/` code**, refusing hand edits as the extension does. The
  same check as VS Code. But a server has nobody to ask, and a commit made with an older designer
  would run older code than the flow says; generating fresh has one answer.
- **Ansible installed beside the server.** No container engine needed. But every project's
  collections and Python packages would share one installation, and a run could read the
  server's files.
- **A key file readable by everyone** in a folder nobody can list. Works with any image user.
  But it is readable by anyone on the machine who learns the name.

## Consequences

- A server that runs flows needs docker or podman, and the image locally or reachable.
- A run of the project's branch reuses its folder: the first run of a large repository takes
  longest.
- A hand-edited `generated/` file in a repository has no effect on server runs.
