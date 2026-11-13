# Ansible Flow Server

<img src="media/icons/png/afs-icon-128.png" alt="" width="96" align="right" />

Runs the flows you design in [Ansible Flow Designer](https://github.com/ChistokhinSV/ansible-flow-designer)
for a team: shared projects, access levels, approvals, schedules, execution environments, a REST
API and an MCP endpoint.

Ansible Flow Designer is a VS Code extension: you draw an automation as a diagram of steps, say
what happens when a step fails, and it generates plain Ansible playbooks. It runs a flow from your
own machine. This server is where a team runs them: the same flows, read and run by the designer's
own code, with who may run what, who must approve, and a record of every run.

## Status

**Early development: there is nothing to deploy yet.** The server starts, keeps a database
(SQLite or PostgreSQL), speaks HTTPS with a certificate you can request and replace, knows its
users and groups and signs them in (with a password, or a program with an access token), keeps workspaces and projects in step with their git
repositories and is itself the git address of every project (clone, fetch, push), keeps credentials encrypted and signs in to private repositories with them, keeps launch
configurations, and runs flows in execution environment containers, has web pages to sign
in and look at workspaces, projects and their flows on the designer's canvas (read-only), answers health checks and says what it is; it can read and
check flow files. It does not run flows yet. The plan and its tickets are in YouTrack project AFS; the
decisions are in [docs/adr](docs/adr).

| Planned for 1.0                                                            | State   |
| -------------------------------------------------------------------------- | ------- |
| Projects from a git repository, or hosted by the server                    | planned |
| Flows shown on the designer's canvas, read-only, with live run status      | planned |
| Runs in execution environment containers, with credentials kept encrypted  | planned |
| Access levels: read, operate, edit, approve, per workspace or per flow     | planned |
| Approval steps: a run waits until a listed approver decides                | planned |
| Notifications by email and webhook                                         | planned |
| Execution environments built from a list of collections                    | planned |
| Schedules, REST API with tokens, MCP endpoint                              | planned |
| Sign-in with local users, OIDC and LDAP; HTTPS with certificate management | planned |
| Install with docker compose or as a Linux service                          | planned |

## Requirements

- Node.js 24 or later
- git
- [just](https://github.com/casey/just) for the development commands
- For now, a checkout of Ansible Flow Designer beside this one (see below)

## Install for development

The server is built on the designer's npm packages (`@ansible-flow/core`, `@ansible-flow/node`,
`@ansible-flow/assets`). They are not on npm yet, so they are packed from a checkout of the
designer and installed from `vendor/`:

```sh
git clone https://github.com/ChistokhinSV/ansible-flow-designer.git
git clone https://github.com/ChistokhinSV/ansible-flow-server.git
cd ansible-flow-designer && npm ci && cd ../ansible-flow-server
AFD_REPO=../ansible-flow-designer just afd-packages
```

`just afd-packages` builds and checks the packages in the designer's checkout, copies the tarballs
to `vendor/` and installs everything. Run it again after pulling the designer. Once the packages
are on npm, this step goes away and `just install` is enough.

## Use

Start the server:

```sh
just start
```

```text
[09:44:37 13.11.2026] INFO  Ansible Flow Server starts version=0.1.0 designer=0.85.0
[09:44:37 13.11.2026] INFO  Database ready kind=sqlite where=/srv/flow-server/data/afs.db changes=1
[09:44:37 13.11.2026] INFO  Server certificate subject="CN=127.0.0.1" names=127.0.0.1,localhost expires=2027-11-13T08:44:37.000Z source=self-signed
[09:44:37 13.11.2026] INFO  Server listening at https://127.0.0.1:8443
```

Open the address in a browser for the pages (see [The web pages](#the-web-pages)).

| Address        | Answers                                                                         |
| -------------- | ------------------------------------------------------------------------------- |
| `/healthz`     | `{"status":"ok"}` while the process is up                                       |
| `/readyz`      | `{"status":"ready","database":"sqlite"}`, or 503 when the database is not there |
| `/api/v1/meta` | The server's version, the designer version it is built on, the installation id  |

```sh
curl --insecure https://127.0.0.1:8443/api/v1/meta
```

```json
{
  "name": "Ansible Flow Server",
  "version": "0.1.0",
  "designer": { "version": "0.85.0", "format": 2 },
  "api": "v1",
  "instance": "7c9e6679-7425-40de-944b-e07fc1f90ae7"
}
```

Stop it with Ctrl+C: requests in flight are answered first.

Read flow files without starting the server:

```sh
just check-flows test/fixtures/hello.flow.yaml test/fixtures/firewall-upgrade.flow.yaml
```

```text
Ansible Flow Server 0.1.0, built on Ansible Flow Designer 0.85.0; reads flows up to format 2
test/fixtures/hello.flow.yaml: Hello, Ansible (hello v1, format 2), 3 steps, 0 errors, 0 warnings
test/fixtures/firewall-upgrade.flow.yaml: Firewall firmware upgrade (firewall-upgrade v1, format 2), 18 steps, 0 errors, 0 warnings
```

It exits with 1 when a file is not a flow this server can read.

## Configuration

Settings are read from the environment, and from a `.env` file beside the server (the environment
wins). Copy [.env.example](.env.example) to `.env`. A wrong setting stops the start and every
problem is named.

| Setting                    | Default                                              | Meaning                                                                 |
| -------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------- |
| `AFS_HOST`                 | `127.0.0.1`                                          | The address to listen on; `0.0.0.0` for every interface                 |
| `AFS_PORT`                 | `8443`                                               | The port (`8080` with `AFS_TLS=off`)                                    |
| `AFS_PUBLIC_URL`           | none                                                 | The address people open, like `https://flows.example.net`               |
| `AFS_HTTP_PORT`            | none                                                 | A port that redirects plain HTTP to HTTPS                               |
| `AFS_TLS`                  | `on`                                                 | `off` behind a proxy that does HTTPS                                    |
| `AFS_TRUSTED_PROXIES`      | none                                                 | With `AFS_TLS=off`: proxies whose word is taken for who asked           |
| `AFS_CA_FILE`              | none                                                 | Certificate authorities of your network, for outgoing connections       |
| `AFS_MASTER_KEY_FILE`      | `<data>/master.key`, made at first start             | The file with the master key that stored credentials are encrypted with |
| `AFS_MASTER_KEY`           | none                                                 | The master key itself (base64 of 32 bytes), instead of a file           |
| `AFS_MAX_RUNS`             | `4`                                                  | Runs at once on this server                                             |
| `AFS_MAX_RUNS_PER_PROJECT` | `1`                                                  | Runs at once of one project                                             |
| `AFS_CONTAINER_ENGINE`     | `auto`                                               | The container engine runs use: `auto`, `docker`, `podman`, or `off`     |
| `AFS_EE_IMAGE`             | `ghcr.io/ansible/community-ansible-dev-tools:latest` | The image a run uses unless its launch names one                        |
| `AFS_RUN_TIMEOUT_MINUTES`  | `240`                                                | A run that takes longer is stopped                                      |
| `AFS_RUNS_KEEP_DAYS`       | `90`                                                 | Ended runs older than this are removed, with their output               |
| `AFS_RUNS_KEEP_PER_FLOW`   | `200`                                                | Of one flow in one project, at most this many ended runs are kept       |
| `AFS_AUDIT_KEEP_DAYS`      | `365`                                                | Audit entries older than this are removed; `0` keeps them all           |
| `AFS_GIT_LOCAL`            | `off`                                                | `on`: a project's repository may be a folder of this machine            |
| `AFS_DATA_DIR`             | `data`                                               | Where the server keeps what it owns                                     |
| `AFS_DATABASE_URL`         | `sqlite:afs.db`                                      | `sqlite:<file>` (in the data folder unless absolute) or `postgres://…`  |
| `AFS_LOG_LEVEL`            | `info`                                               | `trace`, `debug`, `info`, `warn`, `error`, `fatal` or `silent`          |
| `AFS_LOG_FORMAT`           | `text`                                               | `text`, or `json` for one object a line                                 |
| `AFS_ENV_FILE`             | `.env`                                               | Another file to read the settings from                                  |

With PostgreSQL:

```sh
AFS_DATABASE_URL=postgres://flows:CHANGE_ME@db.example.net:5432/flows just start
```

### HTTPS and the certificate

The server speaks HTTPS itself. At its first start it makes a self-signed certificate, so nothing
is ever sent in the clear; browsers warn about it until you install one from a certificate
authority. The `--insecure` above is for that first certificate only.

```sh
just cert show
just cert request flows.example.net --org "Example Ltd" --out flows.csr
# have your certificate authority sign flows.csr, then (the chain may follow in the same file):
just cert install flows.pem
```

```text
Installed
  Subject      CN=flows.example.net, O=Example Ltd
  Names        flows.example.net
  Issuer       CN=Example Issuing CA
  Valid        2026-11-13T08:40:00.000Z to 2027-02-11T08:40:00.000Z (89 days left)
  Fingerprint  4E:1B:…
  Chain        1 more certificate
A running server serves it to new connections from now on.
```

| Command                                | Does                                                                                         |
| -------------------------------------- | -------------------------------------------------------------------------------------------- |
| `cert show`                            | The certificate in use, the one before it, a waiting request                                 |
| `cert request <names> [--org] [--out]` | A new key and a request to sign; the key stays with the server                               |
| `cert install <file> [--key <file>]`   | Installs a certificate; without `--key` it answers the request, or renews for the key in use |
| `cert self-signed [names]`             | A new self-signed certificate                                                                |
| `cert rollback`                        | Back to the certificate that was in use before                                               |
| `cert history`                         | Every change: when, what, by whom, which certificate                                         |

- A certificate is checked before anything changes: its key belongs to it, it is valid now, its
  chain is in order, and it is good for the host of `AFS_PUBLIC_URL`. Every problem is named.
- A running server needs no restart: new connections get the new certificate within a moment.
- The server warns in its log when the certificate has 30 days or fewer left.
- Keys and certificates are in `<data folder>/tls`. Back that folder up with the rest.
- Behind a proxy that does HTTPS: `AFS_TLS=off` and `AFS_TRUSTED_PROXIES`.

Not there yet: the same actions in the web page and over the REST API (they need sign-in first),
PFX files, and automatic certificates (ACME).

### People, groups and sign-in

A new server has no user. At start it writes a setup code to its log; the first administrator is
made with it, so by someone who can read the server's log:

```text
[09:44:38 13.11.2026] WARN  No user yet. Make the first administrator with this setup code (POST /api/v1/setup, or: user add --admin) setup=Jq3vN0c4TzWk
```

```sh
curl --cacert data/tls/certificate.pem --cookie-jar cookies.txt \
  -H 'content-type: application/json' https://flows.example.net:8443/api/v1/setup \
  -d '{"code":"Jq3vN0c4TzWk","login":"dana","name":"Dana Whitfield","password":"<a long passphrase>"}'
```

or, on the server's machine, with no code and the password typed unseen:

```sh
just user add dana --name "Dana Whitfield" --admin
```

| Address (under `/api/v1`)                                  | Does                                         | Who                               |
| ---------------------------------------------------------- | -------------------------------------------- | --------------------------------- |
| `POST /session`                                            | Sign in with `{"login","password"}`          | anyone                            |
| `GET /session`                                             | Who am I, with my groups                     | signed in                         |
| `DELETE /session`                                          | Sign out                                     | anyone                            |
| `PUT /session/password`                                    | Change my password: `{"current","password"}` | signed in                         |
| `GET /tokens`, `POST /tokens`                              | My access tokens; make one (shown once)      | signed in; making needs a session |
| `DELETE /tokens/:id`                                       | Revoke one of my tokens                      | signed in, with a session         |
| `/users`, `/users/:id`                                     | List, add, change, disable, delete people    | administrators                    |
| `PUT /users/:id/password`                                  | Set someone's password                       | administrators                    |
| `GET /users/:id/tokens`, `DELETE /users/:id/tokens/:token` | See and revoke someone's tokens              | administrators                    |
| `/groups`, `/groups/:id`                                   | List, add, change, delete groups             | administrators                    |
| `PUT /groups/:id/members`                                  | Set a group's members: `{"users":[ids]}`     | administrators                    |

- A password has at least 12 characters and is kept only as an argon2id hash.
- A session lasts 8 hours without use and 7 days at most. Its cookie is not readable by scripts
  and is sent over HTTPS only.
- After five wrong passwords for a login in fifteen minutes, sign-in for it waits.
- The last administrator cannot be demoted, disabled or deleted.
- A person and a group each have an email address and a webhook address: where a notification
  for them will go.

When nobody can sign in, the way back is the machine the server runs on:

| Command                                              | Does                                                        |
| ---------------------------------------------------- | ----------------------------------------------------------- |
| `user list`                                          | Everyone, with level, state and groups                      |
| `user add <login> [--name] [--email] [--admin]`      | Adds a person; the password is typed unseen, or piped       |
| `user password <login>`                              | Sets a password and ends that person's sessions             |
| `user disable <login>`, `user enable <login>`        | Disabling signs the person out                              |
| `user admin <login> on\|off`                         | Makes, or unmakes, an administrator                         |
| `user token <login> [--name] [--days] [--read-only]` | Prints a new access token for that person, and nothing else |

#### Access tokens

A program (git, the VS Code extension, a pipeline) signs in with an access token, not a
password. A token is a person's and acts as that person. Make one while signed in:

```sh
curl --cacert data/tls/certificate.pem --cookie cookies.txt \
  -H 'content-type: application/json' https://flows.example.net:8443/api/v1/tokens \
  -d '{"name":"laptop git","expiresInDays":90,"readOnly":false}'
```

```json
{
  "id": "0b6f5c1e-8f0e-4d0a-9a53-6d0f8f1f2c77",
  "name": "laptop git",
  "hint": "Xk3Q",
  "readOnly": false,
  "createdAt": "2026-11-13T09:44:37.512Z",
  "expiresAt": "2027-02-11T09:44:37.512Z",
  "token": "afs_<43 characters, shown this once>"
}
```

and use it as a bearer, or as the password of HTTP Basic with any user name (what git sends):

```sh
curl --cacert data/tls/certificate.pem -H "Authorization: Bearer $AFS_TOKEN" \
  https://flows.example.net:8443/api/v1/workspaces
```

- The server keeps a hash of the token: it cannot show it again. Lost means revoke and make anew.
- A token lasts 90 days unless you say otherwise, a year at most. It stops when it is revoked,
  at its end, and while its owner is disabled. A person has at most 50.
- A read-only token (`"readOnly": true`) reads and changes nothing.
- A token cannot make or revoke tokens, or set a password: those take a password sign-in.
- Keep it in an environment variable or a credential store, never in a repository or an address.

Not there yet: the pages for all this, levels on workspaces and flows, sign-in with OIDC or LDAP.

### The web pages

The server serves its own pages at its address. A new server shows the first-run setup (the
setup code from its log); after that, sign-in.

| Page                                   | Shows                                                                                       |
| -------------------------------------- | ------------------------------------------------------------------------------------------- |
| `/`                                    | The workspaces; administrators add one                                                      |
| `/w/<workspace>`                       | Its projects; administrators add one, kept by the server or external                        |
| `/w/<workspace>/<project>`             | State, commit, branches, its flows with their findings, the `git clone` command, who pushed |
| `/w/<workspace>/<project>/flow/<file>` | One flow on the designer's canvas, read-only; "Open on its own page"                        |
| `/w/<workspace>/<project>/launch/<id>` | A launch configuration and its launch form: what would run, Launch, keep start values       |
| `/w/<workspace>/<project>/launch/new`  | Add a launch configuration (administrators); `.../launch/<id>/edit` changes one             |
| `/runs`                                | Every run, the newest first, filtered by state                                              |
| `/runs/<id>`                           | One run: what ran, the run on the canvas, its output as it comes; Stop and Run again        |
| `/account`                             | Your access tokens: make (shown once), list, revoke                                         |
| `/admin`                               | Administration: the audit log; people, groups and the certificate are not built yet         |
| `/admin/audit`                         | The audit log, filtered, older entries a page at a time; export as CSV or JSON              |

- Light and dark: follows the device, or the choice made with the theme button.
- Works at phone width and with a keyboard and a screen reader.
- A flow is shown as in VS Code (levels, details, generated code) and cannot be changed here.
- A run is shown on the canvas as in VS Code, live while it goes; a step's host output, the flow's earlier runs and Stop work from the canvas.
- Administrators read the audit log at `/admin/audit` and export it.
- A project's page lists its launch configurations; administrators add, change and delete them.
- Not there yet: the pages for people, groups, credentials and the certificate.

### Workspaces and projects

A workspace is a team's space. A project in it is a git repository whose flows the server will
run. It has a source somewhere else (the server keeps a mirror of it), or, made without
`gitUrl`, the server hosts it itself. Either way the server knows the commit its branch is at,
and is the address git clients use.

```sh
curl ... -X POST https://flows.example.net:8443/api/v1/workspaces \
  -d '{"key":"network","name":"Network team"}'
curl ... -X POST https://flows.example.net:8443/api/v1/workspaces/network/projects \
  -d '{"key":"edge","name":"Edge switches","gitUrl":"https://git.example.net/network/edge-flows.git"}'
```

```json
{
  "id": "2a968c91-1ac7-4654-94c8-2eb24a28b10b",
  "key": "edge",
  "name": "Edge switches",
  "hosted": false,
  "gitUrl": "https://git.example.net/network/edge-flows.git",
  "gitPath": "/git/network/edge.git",
  "gitRef": "main",
  "commit": "9f2c1e7ab3d45c60e8a1f2b3c4d5e6f708192a3b",
  "sync": { "state": "ok", "at": "2026-11-13T10:15:33.364Z" },
  "pollSeconds": 300,
  "hook": false
}
```

| Address (under `/api/v1`)            | Does                                                                                                                             | Who                                     |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `/workspaces`, `/workspaces/:id`     | List, add, change, delete (by id or key)                                                                                         | read: signed in; change: administrators |
| `/workspaces/:id/projects`           | A workspace's projects; add one (its source is looked at at once)                                                                | as above                                |
| `/projects/:id`                      | A project; change its name, source, branch, timer; delete                                                                        | as above                                |
| `POST /projects/:id/sync`            | Look at the source now                                                                                                           | administrators                          |
| `GET /projects/:id/branches`         | The branches the source has                                                                                                      | signed in                               |
| `GET /projects/:id/pushes`           | Who pushed what through the server, newest first                                                                                 | signed in                               |
| `GET /projects/:id/flows`            | The flows (`*.flow.yaml`) at the project's commit, each with name, version, steps, errors and warnings, or why it cannot be read | signed in                               |
| `GET /projects/:id/flows/view?path=` | One flow as the designer shows it (the flow, findings, positions, generated plays)                                               | signed in                               |
| `POST /projects/:id/hook`, `DELETE`  | Make a push hook (its token is shown once); remove it                                                                            | administrators                          |
| `POST /hooks/projects/:id/push`      | Called by the git host with the hook's token                                                                                     | the token                               |

- **The source** is `https://…`, `ssh://…` or `git@host:path`. An address with a password in it
  is refused. A folder of this machine is allowed only with `AFS_GIT_LOCAL=on`.
- **The branch** (`gitRef`, `main` unless set) is the one whose commits may run.
- **Kept up to date** when added, on request, by the push hook, and every `pollSeconds` (300
  unless set; 0 for never). A source that cannot be reached shows as the project's `sync` state
  with the reason; the commit it had stays.
- **The push hook:** the git host sends the token in `X-Gitlab-Token`, `X-AFS-Token` or
  `Authorization: Bearer` (GitLab, Gitea, anything that can send a header).
- The server needs the `git` program.

#### Git: clone, fetch and push through the server

Every project, hosted or with a source, is at `<server><gitPath>`. Sign in with a
[personal access token](#access-tokens) as the password; the user name is not looked at.

```sh
git clone https://flows.example.net:8443/git/network/edge.git
# Username: dana        Password: <your access token>
git push origin main
```

While the server uses its own first certificate, tell git to trust it:
`git -c http.sslCAInfo=data/tls/certificate.pem clone …`.

- **Who:** everyone signed in clones and fetches. Until access levels exist, administrators
  push. A read-only token never pushes.
- **A hosted project** starts empty; the first push makes its branch.
- **A project with a source:** a clone or fetch gets what the source has now. A push is passed
  on to the source and is accepted only if the source accepts it. Until credentials exist, that
  works only where the server's own account may push to the source.
- **The project's branch** (`gitRef`) cannot be deleted and its history cannot be rewritten
  through the server. Other branches are free. Only branches are pushed, not tags.
- **Who pushed** is kept (`GET /projects/:id/pushes`); commits keep their own authors.
- Deleting a hosted project puts its repository aside in `data/repos/deleted`: it was the
  only copy.

```json
[
  {
    "id": "5d0c2f0e-0f52-4a55-a2f4-0d2f5c0e7a11",
    "login": "dana",
    "ref": "main",
    "from": "9f2c1e7ab3d45c60e8a1f2b3c4d5e6f708192a3b",
    "to": "41d7a0c93be2f5681a0c4e7d9b3f2a6c8e1d0b57",
    "at": "2026-11-13T12:09:23.386Z"
  }
]
```

Not there yet: GitHub's signed hooks, an ssh source with a stored key, and starting a hosted
project from a sample. For a private repository over https see
[Credentials](#credentials-and-the-master-key).

### Credentials and the master key

What a run or a mirror signs in with is kept by the server, encrypted with a **master key**
that is not in the database.

- With no setting, the server makes `data/master.key` at its first start and says so in the
  log. **Keep a copy somewhere safe:** without it the stored credentials cannot be read.
- Stronger: keep the key outside the data folder with `AFS_MASTER_KEY_FILE`, or give it as
  `AFS_MASTER_KEY` (32 random bytes in base64: `openssl rand -base64 32`).
- A server started with another key than its database's refuses to start.

```sh
curl ... -X POST https://flows.example.net:8443/api/v1/workspaces/network/credentials \
  -d '{"name":"Git host","kind":"git_token","fields":{"username":"deploy"},"secret":{"token":"<the token>"}}'
```

```json
{
  "id": "7b1f6c0a-3c1e-4c58-9f0e-2f6a1d4b8e90",
  "workspace": "5d0c2f0e-0f52-4a55-a2f4-0d2f5c0e7a11",
  "name": "Git host",
  "kind": "git_token",
  "fields": { "username": "deploy" },
  "has": ["token"],
  "usedBy": 0,
  "createdAt": "2026-11-13T13:55:06.120Z",
  "updatedAt": "2026-11-13T13:55:06.120Z"
}
```

| Kind        | Open part            | Secret part                | For                              |
| ----------- | -------------------- | -------------------------- | -------------------------------- |
| `ssh_key`   | `username`           | `privateKey`, `passphrase` | Machines over SSH                |
| `login`     | `username`           | `password`                 | Machines; a git host over HTTPS  |
| `become`    | `method`, `username` | `password`                 | Becoming another user (sudo)     |
| `vault`     | `vaultId`            | `password`                 | An Ansible vault                 |
| `git_token` | `username`           | `token`                    | A git host over HTTPS            |
| `registry`  | `host`, `username`   | `password`                 | A container registry             |
| `env`       | the variables' names | the variables' values      | Variables of a run's environment |

| Address (under `/api/v1`)     | Does                                                     | Who                                     |
| ----------------------------- | -------------------------------------------------------- | --------------------------------------- |
| `/workspaces/:id/credentials` | List; add                                                | read: signed in; change: administrators |
| `/credentials/:id`            | One; change name, open part, or the whole secret; delete | as above                                |

- **A secret goes in and never comes out.** Answers name what a credential holds (`has`), not
  the values. To change a secret, send it again whole.
- **A private repository:** give the project a `git_token` or `login` credential of its
  workspace: `"gitCredential": "<credential id>"` when adding it, or
  `PATCH /projects/:id` (`null` takes it away). For a source over https. The server signs in
  with it to read the source and to pass pushes on.
- A credential a project uses is not deleted until the project has another.
- With authorities of your own (`AFS_CA_FILE`), the server's git trusts them too.

| Command          | Does                                                                             |
| ---------------- | -------------------------------------------------------------------------------- |
| `secrets status` | Which master key the server has, and whether the stored credentials open with it |
| `secrets rotate` | Makes a new master key and seals everything again (stop the server first)        |

Not there yet: handing credentials to runs, an ssh source with a stored key, the pages.

### Launch configurations

A launch configuration is a flow of a project with what a run of it needs, saved under a name.
A launch settles it into a run and puts the run in the queue ([Runs](#runs)).

```sh
curl ... -X POST https://flows.example.net:8443/api/v1/projects/<project id>/launch-configs \
  -d '{"name":"Upgrade edge firewalls","flowFile":"flows/firewall-upgrade.flow.yaml",
       "inventory":"inventory/hosts.yaml","mode":"check",
       "inputs":{"devices":["fw-edge-01","fw-edge-02"]},"credentials":["<credential id>"]}'
curl ... -X POST https://flows.example.net:8443/api/v1/launch-configs/<id>/check \
  -d '{"mode":"real","inputs":{"target_version":"7.4.1"}}'
```

```json
{
  "launch": {
    "config": "0f3d6f0e-6a53-4d4e-8a55-9d2f0c1b7e21",
    "project": "2a968c91-1ac7-4654-94c8-2eb24a28b10b",
    "commit": "59b2575163b54f0c8a1e7d9b3f2a6c8e1d0b5741",
    "ref": "main",
    "flow": {
      "file": "flows/firewall-upgrade.flow.yaml",
      "key": "firewall-upgrade",
      "name": "Firewall firmware upgrade",
      "version": 1
    },
    "mode": "real",
    "inventory": "inventory/hosts.yaml",
    "inputs": {
      "devices": ["fw-edge-01", "fw-edge-02"],
      "target_version": "7.4.1",
      "backup_dir": "/srv/backups"
    },
    "targets": ["fw-edge-01", "fw-edge-02"],
    "credentials": ["7b1f6c0a-3c1e-4c58-9f0e-2f6a1d4b8e90"]
  }
}
```

| Setting       | Means                                                                      |
| ------------- | -------------------------------------------------------------------------- |
| `flowFile`    | The flow's file in the repository                                          |
| `gitRef`      | Another branch than the project's to take the newest commit of             |
| `commit`      | One commit, always (a pin). Not together with `gitRef`                     |
| `inventory`   | The inventory's path in the repository; left out: what `ansible.cfg` names |
| `eeImage`     | The execution environment's image; left out: the server's default          |
| `mode`        | `check` (a skeleton run, the default) or `real`                            |
| `limit`       | Ansible's limit, for fewer hosts than the flow targets                     |
| `inputs`      | Start values of the flow's inputs. Never one that looks like a secret      |
| `credentials` | Credentials of the workspace a run gets (not a git token)                  |

| Address (under `/api/v1`)         | Does                                                       | Who                                     |
| --------------------------------- | ---------------------------------------------------------- | --------------------------------------- |
| `/projects/:id/launch-configs`    | List; add                                                  | read: signed in; change: administrators |
| `/launch-configs/:id`             | One; change; delete                                        | as above                                |
| `GET /launch-configs/:id/form`    | The flow's inputs as a form, with the start values         | signed in                               |
| `POST /launch-configs/:id/check`  | What a launch would run, or 422 with everything in its way | signed in                               |
| `POST /launch-configs/:id/launch` | The same, and the run goes in the queue (201 with the run) | administrators                          |

- **Saved only if it could run now:** the flow, the inventory, the branch or commit, each start
  value and each credential are checked; a refusal names the setting (`field`).
- **Which commit runs:** what the launch names (`ref` or `commit`), else what the configuration
  names, else the newest commit of the project's branch, after a look at the source.
- **At launch** a person may give `mode`, `ref` or `commit`, `limit`, and `inputs` as typed
  text (`"fw-edge-01, fw-edge-02"` is a host list). A secret-looking input is given here and is
  not repeated in the answer.

**On the pages:** a project's page lists its launch configurations. A configuration's page
shows its settings and the launch form:

- Check or real, and another branch or a commit; the form shows the flow's inputs at that
  commit, starting with the configuration's values.
- Secret-looking inputs are typed hidden and never kept.
- **What would run** shows the commit, the inputs as the flow gets them (secrets as `***`), the
  hosts it starts on, the inventory, image and credentials; what stands in the way is shown at
  its field.
- **Launch** (administrators) queues the run and opens its page.
- **Keep as start values** (administrators) saves the typed values that are not secret as the
  configuration's.

### Runs

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

| Address (under `/api/v1`)                  | Does                                                         | Who            |
| ------------------------------------------ | ------------------------------------------------------------ | -------------- |
| `GET /runs?project=&state=&limit=&before=` | Runs, the newest first (`before`: the last `createdAt` seen) | signed in      |
| `GET /runs/:id`                            | One run                                                      | signed in      |
| `POST /runs/:id/cancel`                    | Stop it: at once when queued, else at the worker's next word | administrators |

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
- Credentials: SSH key (mounted read-only for the run, a key without a passphrase), login and
  become passwords, the vault password, and environment variables. Secret values are hidden in
  the output.
- Ended: `succeeded` when Ansible ended well and wrote its events; `failed` otherwise, with
  the reason; `cancelled` when stopped on request. A run longer than
  `AFS_RUN_TIMEOUT_MINUTES` (240) is stopped.

| Address (under `/api/v1`)         | Answers                                                                                                                    | Who            |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `GET /runs/:id/output`            | What Ansible wrote, secrets hidden (text)                                                                                  | signed in      |
| `GET /runs/:id/view`              | How the run went, step by step, as the designer shows it                                                                   | signed in      |
| `GET /runs/:id/events`            | The run as it goes, as server-sent events: `run`, `view`, `output` (with `next`), `end`; `?from=<next>` resumes the output | signed in      |
| `GET /runs/:id/hosts/:node/:host` | What one host did in one step, from the run's events                                                                       | signed in      |
| `POST /runs/:id/relaunch`         | The same run again (same commit, inputs and credentials), as a new run                                                     | administrators |

**Watching a run:** the run page follows it live; a script reads the same with
`curl -N -H "Authorization: Bearer $AFS_TOKEN" https://flows.example.net:8443/api/v1/runs/<id>/events`.
Ended runs are removed after `AFS_RUNS_KEEP_DAYS` (90), and beyond `AFS_RUNS_KEEP_PER_FLOW`
(200) of one flow, with their output.

**The server in a container** runs flows in sibling containers: give it the engine's socket and
mount the data folder at the same path as on the host.

```sh
docker run -d --name flow-server \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /srv/flow-server:/srv/flow-server -e AFS_DATA_DIR=/srv/flow-server/data \
  -e AFS_TLS=off -e AFS_HOST=0.0.0.0 -p 8080:8080 \
  <an image with Node.js 24, git and the docker command> node dist/server.js
```

### The audit log

Everything that changes something, or tries to, leaves an entry: who (the user, and the token
when one was used), from where (`ui`: the pages, `api`: a token, `git`, `cli`: the server's
commands), what (`run.launch`, `user.change`, `session.sign-in`, ...), to what (by id and by
name, so a deleted thing is still named), how it ended (`ok`, `refused`, `failed`, with the
HTTP status), the client's address and the request id of the server's log.

- Sign-ins, refused ones too (by the login tried); sign-outs; passwords set or changed.
- Tokens made and revoked; people and groups made, changed, deleted.
- Workspaces, projects, credentials and launch configurations made, changed, deleted; syncs and
  push hooks.
- Runs launched, stopped, run again. Pushes through the server with the branches they moved;
  refused pushes.
- The `user`, `cert` and `secrets` commands that change something, with the machine's user.
- Exports of the log itself.

An entry never holds a secret: of what a request sent it keeps the names of the changed fields
and the yes/no and number values, never text. Entries are only added; those older than
`AFS_AUDIT_KEEP_DAYS` (365, `0` keeps all) are removed every hour. Administrators read it on the
page `/admin/audit`, or:

| Address (under `/api/v1`) | Answers                                                                                                                                                                                               | Who            |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `GET /audit`              | `{entries, next}`, newest first. Filters: `actor`, `action` (`run` or `run.launch`), `objectType`, `objectId`, `result`, `source`, `from`, `to`. Paging: `before=<next>`, `limit` (100, at most 1000) | administrators |
| `GET /audit/export`       | The same filters, as a file: `format=csv` (default) or `json`; at most 50000 entries                                                                                                                  | administrators |

```sh
curl -H "Authorization: Bearer $AFS_TOKEN" -o audit.csv \
  "https://flows.example.net:8443/api/v1/audit/export?format=csv&action=run&from=2026-11-01"
```

```text
at,actor,token,source,action,object_type,object_id,object_name,result,status,ip,request,detail
2026-11-13T09:12:04.118Z,dana,,ui,run.stop,run,6f1c…,#12,ok,202,192.0.2.10,req-2k,
2026-11-13T09:11:40.502Z,dana,8a0e…,api,run.launch,run,6f1c…,#12,ok,201,192.0.2.10,req-2h,"{""launch-config"":""c41d…""}"
2026-11-13T08:59:13.077Z,omar,,git,git.push,project,,net/firewalls,refused,403,192.0.2.25,req-1x,
```

## Development

| Command                    | Does                                                                                                                 |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `just afd-packages`        | Pack the designer's packages and install them from `vendor/`                                                         |
| `just install`             | Install exact dependencies from `package-lock.json`                                                                  |
| `just check`               | Type-check (TypeScript) and lint and format check (Biome)                                                            |
| `just fmt`                 | Apply formatting and safe lint fixes                                                                                 |
| `just test [args]`         | Unit tests (Vitest; the pages in jsdom); with `AFS_TEST_POSTGRES_URL` set, the database tests also run on PostgreSQL |
| `just build`               | Build the server and the web pages into `dist/`                                                                      |
| `just web-dev`             | The pages with live reload (port 5180), against a server on port 8080 (`AFS_DEV_SERVER` to change)                   |
| `just start`               | Build, then start the server                                                                                         |
| `just check-flows <files>` | Build, then read the given flow files                                                                                |
| `just cert <command>`      | Build, then run a certificate command                                                                                |
| `just user <command>`      | Build, then run a user command                                                                                       |
| `just secrets <command>`   | Build, then run a secrets command                                                                                    |

Layout:

| Path           | Holds                                                           |
| -------------- | --------------------------------------------------------------- |
| `src/server/`  | The server (Node.js)                                            |
| `src/web/`     | The web pages (React, built by Vite into `dist/web`)            |
| `test/web/`    | Tests of the web pages                                          |
| `test/unit/`   | Unit tests; `test/fixtures/` has sample flows from the designer |
| `scripts/`     | Build and package scripts                                       |
| `CHANGELOG.md` | What changed, for people who use the server                     |
| `docs/adr/`    | Architecture decisions, one file each                           |
| `media/icons/` | The icon set                                                    |
| `vendor/`      | The designer's packages as tarballs (not in git)                |

## License

MIT, see [LICENSE](LICENSE).
