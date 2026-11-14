# Changelog

All notable changes to Ansible Flow Server.

## Unreleased — first version

Nothing is released yet.

### Added

- The server speaks HTTPS itself. At first start it makes a self-signed certificate; the `cert` commands request a certificate from your authority, install one, roll back, or make a new self-signed one, and the server uses a new certificate without a restart. Behind a proxy that does HTTPS, set `AFS_TLS=off`. See [HTTPS and the certificate](README.md#https-and-the-certificate).
- A Server certificate page for administrators, and the same actions over the API: the certificate in use with its days left, a request made and downloaded for your certificate authority, the signed certificate installed (or replaced with a certificate and key), a new self-signed one, a rollback, the history. A refused certificate is shown with every reason. Administrators see a banner on every page while the certificate has 30 days or fewer left.
- Settings from the environment or a `.env` file; SQLite by default, or PostgreSQL with `AFS_DATABASE_URL`. See [Configuration](README.md#configuration).
- People and groups, with sign-in by password. The first administrator is made with a setup code from the server's log, or with `user add --admin` on the server's machine. See [People, groups and sign-in](README.md#people-groups-and-sign-in).
  - After five wrong passwords for a login in fifteen minutes, sign-in for it waits.
  - The `user` commands set a password, enable, disable and make administrators when nobody can sign in.
- Personal access tokens for programs (git, scripts, the VS Code extension): sent as a bearer token or as the password of a git sign-in. A token can be read-only, expires (90 days unless set), and cannot make tokens or set passwords. See [Access tokens](README.md#access-tokens).
- Workspaces and projects. A project is a git repository: one the server keeps, or an existing one the server mirrors and looks at on a timer, on request, or when the git host calls the project's push hook. See [Workspaces and projects](README.md#workspaces-and-projects).
- Every project can be cloned, fetched and pushed through the server, signed in with an access token. A push to a project with an external repository is passed on to it and accepted only if that repository accepts it. The project's branch cannot be deleted or rewritten through the server. Who pushed what is listed per project.
- Web pages at the server's address: first-run setup, sign-in, workspaces, projects with their state, branches, flows and pushes, and your access tokens. Light and dark, at phone width too. See [The web pages](README.md#the-web-pages).
- Pages for people and groups, for administrators: add people, administrators and service accounts; change their profile, make or unmake administrators, disable, set a password, see and revoke tokens (and make them for a service account), delete; add, rename and delete groups, set their email address, webhook and members. See [The web pages](README.md#the-web-pages).
- A project's flows are listed with their errors and warnings, and a flow opens on the designer's canvas, read-only.
- Run on a flow's canvas opens the designer's launch dialog over one of the flow's launch configurations: its start values, the inventory's groups, and the hosts the targets match, counted again as you type; Run launches it and shows the run on the canvas.
- A launch configuration's page shows the hosts a launch would touch, read from the inventory in the launch's image: how many, which names the inventory does not have, and what looks like production. Also over the API: `POST /api/v1/launch-configs/:id/facts`. See [Launch configurations](README.md#launch-configurations).
- Credentials kept encrypted with a master key outside the database: SSH keys, logins, become passwords, vault passwords, git tokens, registry sign-ins and environment variables. A secret goes in and is never shown again. `secrets status` and `secrets rotate` manage the key; rotating seals again every secret the server keeps, runs' inputs included. See [Credentials and the master key](README.md#credentials-and-the-master-key).
- Runs use SSH keys with a passphrase: the key is unlocked into an ssh-agent inside the run, and a wrong passphrase fails the run with a clear reason. A registry credential signs in to the image's registry and pulls a private image before the run, without touching the engine's own sign-ins.
- A workspace's page lists its credentials, what each holds and how much uses it; administrators add one with a form for its kind, change it, replace its secret (never shown, not filled in by the browser; a private key from a file) and delete one nothing uses. An external project chooses its git sign-in when added and on its page, and says when its source asks for one.
- A project with a private repository over HTTPS signs in to it with a git token or login credential, also when passing pushes on.
- Launch configurations: a flow with its inventory, execution environment, check or real mode, limit, start values and credentials, saved only if it could run. Ask what a launch would run (commit, inputs, hosts) before running it. By default the newest commit of the project's branch runs; a launch can name another branch or a commit. See [Launch configurations](README.md#launch-configurations).
- Launching puts a numbered run in a queue kept in the database; runs can be listed and cancelled. At most `AFS_MAX_RUNS` runs at once (4), and `AFS_MAX_RUNS_PER_PROJECT` of one project (1). See [Runs](README.md#runs).
- The server runs flows: Ansible in an execution environment container (docker or podman), the same way VS Code runs them. See [How a run is run](README.md#runs).
  - The repository at the run's commit, with the flow's code generated fresh from the flow.
  - The image from the launch configuration, else `AFS_EE_IMAGE`. With no container engine, runs wait in the queue.
  - SSH keys, login and become passwords, vault passwords and environment variables from the credentials store; secret values are hidden in the output.
  - A run's output and how it went, step by step, are kept; a run longer than `AFS_RUN_TIMEOUT_MINUTES` (240) is stopped.
  - The server can itself run in a container, with the engine's socket.
- Runs can be watched as they go. See [Runs](README.md#runs).
  - **Runs** page: every run, filtered by state. A project's page lists its recent runs.
  - A run's page: what ran, the run on the flow's canvas live (hosts through each step), and Ansible's output as it comes. Administrators can **Stop** a run and **Run again** an ended one with the same commit, inputs and credentials.
  - On the canvas, a step's host output, the flow's earlier runs and Stop work as in VS Code.
  - Scripts can follow a run with `GET /api/v1/runs/<id>/events` (server-sent events).
  - Ended runs are removed after `AFS_RUNS_KEEP_DAYS` (90), and beyond `AFS_RUNS_KEEP_PER_FLOW` (200) of one flow.
- `/api/v1/meta` says which flow formats the server reads, what a client may rely on (`features`) and which designer canvas the pages carry. See [Compatibility with the designer](README.md#compatibility-with-the-designer).
- Search in the top bar of every page (`/` or Ctrl+K): workspaces, projects, flows, launch configurations, runs (by number too), environments and settings pages as you type, only what you may see; people and groups for administrators. See [The web pages](README.md#the-web-pages).
- A launch configuration's page shows what its flow needs (the collections its steps run, and the project's `collections/requirements.yml`) against what its environment's image holds, and makes an environment for the flow in one step. Collections can be searched on Galaxy, or the configured hub, when writing a spec. See [Execution environments](README.md#execution-environments).
- Execution environments: a workspace keeps the images its runs happen in, built by the server from a spec (ansible-core, collections with a version, a range or latest, Python and Debian packages, certificate authorities) or an image that exists already. A build settles versions into a lock, reads what the image really holds, keeps a log, and old images are removed. A launch configuration chooses an environment and gets its newest good build. The same environment can be taken to AWX or AAP as an ansible-builder file. See [Execution environments](README.md#execution-environments).
- Schedules: a launch configuration runs by itself on a cron in a time zone, or once at a set time, as the schedule's owner, whose access is checked each time. A schedule has its own mode, input values and optionally a pinned commit; after downtime it runs once or skips; while its last run goes it skips or queues. Its page shows the next times and how the last fire went; administrators can hand a schedule to a service account. See [Schedules](README.md#schedules).
- Dev runs: someone who may push sends work they have not pushed yet, committed or not, and the server checks it with the flow's launch configuration, in check mode only. The work is kept a day under a ref nobody else sees and never reaches a branch or an external source; the run is marked a dev run. See [Dev runs](README.md#dev-runs).
- Agents (Claude Code, Codex, Cursor) use the server over MCP at `/mcp`, signed in with an access token. See [Agents (MCP)](README.md#agents-mcp).
  - They read the projects' flows with the designer's flow tools, and list, check, launch, follow and stop runs, seeing and doing only what the token's owner may.
  - Approvals stay with people: an agent decides one only with a token made to allow it.
  - What an agent changes is in the audit log as coming from an agent.
- Notifications by email and webhook. See [Notifications](README.md#notifications).
  - Approvers are asked when a run waits for them; who launched a run is told when its approval is approved, rejected or times out; the approval's `notify` list is told of both.
  - A launch configuration can tell people and groups when its runs fail, or whenever they end.
  - Everyone sets their own email address on My account; webhooks are set by administrators.
  - Administrators are told as the server certificate nears its end (30, 14, 7, 3 and 1 days before, and once it has ended).
  - Email through a mail server set on the new Notifications page; its password is kept encrypted. Webhooks get the event as JSON with a `text` line for chat tools, signed with a key administrators make.
  - Messages are tried again when the mail server or receiver is busy or unreachable, survive a restart, and are listed in a delivery log with Try again. A message never holds a run's inputs or a secret.
- Approvals: a flow with approval steps stops at each one until someone allowed decides, then goes on with the hosts that waited. See [Approvals](README.md#approvals).
  - Whoever has the `approve` grant decides; when the approval names its approvers in the flow, only they. Who launched the run does not, unless the workspace allows it.
  - Decide with a comment on the **Approvals** page, on the run's page, on the canvas, or over the API. Who decided, when and why is shown with the run and kept in the audit log.
  - An approval with a timeout that nobody decides in time sends its hosts through its timeout port.
  - A waiting run holds no container, and still waits after the server restarts.
  - The `approve` grant lets its holder see the flows and runs they decide.
- Access levels: administrators give a user or a group `ro`, `operator`, `rw` or `approve` on a whole workspace or on one flow, on the workspace's page or over the API. See [Access levels](README.md#access-levels).
  - `ro` sees the workspace's projects, flows, launch configurations and runs, and clones; `operator` also launches as a configuration says and stops runs; `rw` also launches another branch or commit, manages launch configurations and pushes through the server.
  - A grant on one flow replaces the workspace's for that flow; the highest of a person's own and their groups' grants counts.
  - **Who can do what** on the workspace's page lists every person with access as their grants come out.
  - People who are not administrators now see only what they were given: give grants after upgrading.
- The API is described as an OpenAPI 3.1 document at `/api/v1/openapi.json`, and the **API reference** page shows it by subject: what each address does, who may call it, what it takes. See [The API](README.md#the-api).
- Service accounts: an identity for a pipeline or program, with no password, signed in only with tokens an administrator makes for it (`"service": true`, or `user add --service`). See [Service accounts](README.md#service-accounts).
- An access token can be limited to one workspace: it reaches that workspace's projects, credentials, launch configurations, runs and repositories, and nothing that spans workspaces. Choose it when making the token, or `user token --workspace`.
- Launching from the pages. See [Launch configurations](README.md#launch-configurations).
  - A project's page lists its launch configurations; administrators add, change and delete them, choosing the flow, branch or pinned commit, inventory, image, mode, limit and credentials.
  - A configuration's page has the launch form: the flow's inputs (secret ones typed hidden and never kept), check or real, another branch or a commit, and the limit.
  - **What would run** shows the commit, inputs and hosts before anything runs, with any problem shown at its field. **Launch** starts the run and opens its page. **Keep as start values** saves the typed values as the configuration's.
- An audit log of who did what and when: sign-ins (refused ones too), tokens, people and groups, workspaces, projects, credentials, launch configurations, runs launched, stopped and run again, pushes (refused ones too), and the server's `user`, `cert` and `secrets` commands. See [The audit log](README.md#the-audit-log).
  - Each entry names who, from where (pages, API, git, server command), what, to what, and how it ended. No secret values are kept.
  - Administrators read it on the **Audit log** page, filtered by person, subject, result, source and dates, and export it as CSV or JSON; `GET /api/v1/audit` for scripts.
  - Entries are kept for `AFS_AUDIT_KEEP_DAYS` (365); `0` keeps them all.
