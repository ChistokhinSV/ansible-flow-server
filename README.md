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

**Early development: not released yet.** The server keeps a database (SQLite or PostgreSQL),
speaks HTTPS with a certificate you can request and replace, signs in people (password) and
programs (access tokens, service accounts), keeps workspaces and projects in step with their git
repositories and is the git address of every project, keeps credentials encrypted, and runs flows
in execution environment containers from launch configurations, live on the designer's canvas.
Access levels say who sees, runs and changes what; approvals stop a run until someone allowed
decides; people are told by email and webhook; every change is in an audit log; the REST API is described as OpenAPI, and agents use the
server over MCP. The plan and its
tickets are in YouTrack project AFS; the decisions are in [docs/adr](docs/adr).

| Planned for 1.0                                                            | State            |
| -------------------------------------------------------------------------- | ---------------- |
| Projects from a git repository, or hosted by the server                    | done             |
| Flows shown on the designer's canvas, read-only, with live run status      | done             |
| Runs in execution environment containers, with credentials kept encrypted  | done             |
| Access levels: read, operate, edit, approve, per workspace or per flow     | done             |
| Approval steps: a run waits until a listed approver decides                | done             |
| Notifications by email and webhook                                         | done             |
| Execution environments built from a list of collections                    | planned          |
| Schedules, REST API with tokens, MCP endpoint                              | API and MCP done |
| Sign-in with local users, OIDC and LDAP; HTTPS with certificate management | done             |
| Install with docker compose or as a Linux service                          | done             |

## Requirements

- Node.js 24 or later
- git
- [just](https://github.com/casey/just) for the development commands

## Run with docker compose

The server image (`ghcr.io/chistokhinsv/ansible-flow-server`, also on Docker Hub as
`chistokhinsv/ansible-flow-server`; amd64 and arm64) is published for each release. It runs flows
in sibling containers through the engine's socket. The files are in
[deploy/compose](deploy/compose).

```sh
mkdir flow-server && cd flow-server
curl -fsSLO https://raw.githubusercontent.com/ChistokhinSV/ansible-flow-server/main/deploy/compose/compose.yaml
curl -fsSL -o .env https://raw.githubusercontent.com/ChistokhinSV/ansible-flow-server/main/deploy/compose/.env.example
# change .env: AFS_PUBLIC_URL at least
docker compose up -d
docker compose logs server | grep -i "setup code"
```

```text
server-1  | [09:44:37 13.11.2026] WARN  Made a master key. Keep a copy somewhere safe: stored credentials cannot be read without it file=/var/lib/afs/master.key key=3fa1c2d4
server-1  | [09:44:37 13.11.2026] WARN  No user yet. Make the first administrator with this setup code (POST /api/v1/setup, or: user add --admin) setup=Jq3vN0c4TzWk
```

- **The first administrator:** open the address and enter the setup code from the log, or
  `docker compose exec server node dist/server.js user add dana --name "Dana Whitfield" --admin`
  (the password is asked).
- **Data:** the `afs-data` volume holds the database (SQLite), repositories, runs, the
  certificate and the master key. Back it up whole; keep a copy of `master.key` (or set
  `AFS_MASTER_KEY`) outside it: without the key, stored credentials cannot be read.
- **PostgreSQL:** set `AFS_DB_PASSWORD` and
  `AFS_DATABASE_URL=postgres://afs:${AFS_DB_PASSWORD}@postgres:5432/afs` in `.env`, then
  `docker compose --profile postgres up -d`. Its data is the `afs-db` volume.
- **HTTPS:** the server makes a self-signed certificate at first start; request or install yours
  on the Server certificate page (see [HTTPS and the certificate](#https-and-the-certificate)).
  Behind a proxy that does HTTPS: `AFS_TLS=off` (the server then answers plain HTTP on 8080:
  publish that port instead).
- **Runs:** the server starts them with the docker command in its image, through
  `AFS_ENGINE_SOCKET` (default `/var/run/docker.sock`; rootless docker:
  `/run/user/<uid>/docker.sock`). Whoever can use that socket controls the machine: the server
  runs as root in its container for it. It finds where its data volume is on the engine's machine
  by itself; when it cannot (it logs nothing about "The data folder as the engine's machine has
  it"), set `AFS_ENGINE_DATA_DIR`.
- **Upgrade:** set `AFS_VERSION` to the new release, then `docker compose pull && docker compose
  up -d`. The database is changed at start.
- **Build the image yourself:** `docker compose build` from `deploy/compose` in a checkout.

Every `AFS_*` setting ([Configuration](#configuration)) can go in `.env`.

## Install as a Linux service

Each release has a bundle per architecture (`linux-x64`, `linux-arm64`) on its
[GitHub release](https://github.com/ChistokhinSV/ansible-flow-server/releases): the server, its
dependencies and Node.js 24, with a SHA-256 beside it. It needs systemd, git, and for runs rootless
podman (or docker). Checked on Ubuntu 24.04 and Rocky Linux 10 (SELinux enforcing).

```sh
# Debian, Ubuntu
sudo apt install podman uidmap git
# RHEL, Rocky, Alma
sudo dnf install podman git policycoreutils-python-utils

V=1.0.0; A=x64
curl -fsSLO https://github.com/ChistokhinSV/ansible-flow-server/releases/download/v$V/ansible-flow-server-$V-linux-$A.tar.gz
curl -fsSLO https://github.com/ChistokhinSV/ansible-flow-server/releases/download/v$V/ansible-flow-server-$V-linux-$A.tar.gz.sha256
sha256sum -c ansible-flow-server-$V-linux-$A.tar.gz.sha256
tar xzf ansible-flow-server-$V-linux-$A.tar.gz && cd ansible-flow-server-$V-linux-$A
sudo ./install.sh
sudo /usr/local/bin/ansible-flow-server user add dana --name "Dana Whitfield" --admin
```

```text
Made the service user afs.
SELinux: /var/lib/ansible-flow-server labelled for containers.
Wrote /etc/ansible-flow-server/afs.env.
Installed 1.0.0; the server answers on port 8443.
Make the first administrator: sudo /usr/local/bin/ansible-flow-server user add <login> --admin
```

| Where                                             | What                                                                    |
| ------------------------------------------------- | ----------------------------------------------------------------------- |
| `/opt/ansible-flow-server/releases/<v>`           | The release; `current` points to the one in use (3 are kept)            |
| `/etc/ansible-flow-server/afs.env`                | The settings (any `AFS_*`); kept by upgrades                            |
| `/var/lib/ansible-flow-server`                    | The data: database, repositories, runs, certificate, `master.key`       |
| `/etc/systemd/system/ansible-flow-server.service` | The service: `systemctl status`, `journalctl -u ansible-flow-server`    |
| `/usr/local/bin/ansible-flow-server`              | The command line (`user`, `cert`, `secrets`), run as the service's user |

- **Runs:** with rootless podman (the default) the service runs as the user `afs`, who gets a
  range of subordinate ids and stays logged in (lingering) for its podman. Each run's image user
  is mapped to `afs`, so what a run writes stays the server's. With `--engine docker` the service
  runs as root: the docker socket is root's anyway, and an unprivileged user in the docker group
  would be root in all but name.
- **SELinux** (RHEL family): the installer labels the data folder as container content, and the
  user's image storage as `/var/lib/containers` is labelled; it needs `semanage`.
- **The command line** needs its full path with `sudo` on RHEL-family systems (sudo's
  `secure_path` leaves `/usr/local/bin` out).
- **Upgrade:** unpack the new bundle and run `sudo ./install.sh` again. Settings and data are kept;
  the database is changed at start, forward only. To go back, point `current` to the previous
  release and restart, with a backup of the data taken before the upgrade. `--engine` on an
  upgrade switches the engine runs use.
- **Remove:** `sudo ./install.sh --uninstall` removes the service and the program and keeps the
  data, the settings and the user; `--uninstall --purge` removes them too (and the SELinux
  labels).
- Other options: `--prefix`, `--data`, `--user`, `--keep N`, `--no-start` (`./install.sh --help`).

## Install for development

The server is built on the designer's npm packages (`@ansible-flow/core`, `@ansible-flow/node`,
`@ansible-flow/assets`, and `@ansible-flow/designer` for the pages), pinned to one version:

```sh
git clone https://github.com/ChistokhinSV/ansible-flow-server.git
cd ansible-flow-server
just install
```

A new designer release is taken by the "Designer packages" workflow, which opens a pull request
when the server passes its checks with it.

**An unreleased designer:** `AFD_REPO=../ansible-flow-designer just afd-packages` packs the
packages in a checkout of the designer, copies the tarballs to `vendor/` (not in git) and installs
them; `package.json` then names those tarballs. Do not commit that change: put the npm version
back (`git checkout package.json package-lock.json && just install`).

## Use

Start the server:

```sh
just start
```

```text
[09:44:37 13.11.2026] INFO  Ansible Flow Server starts version=0.1.0 designer=0.86.0
[09:44:37 13.11.2026] INFO  Database ready kind=sqlite where=/srv/flow-server/data/afs.db changes=1
[09:44:37 13.11.2026] INFO  Server certificate subject="CN=127.0.0.1" names=127.0.0.1,localhost expires=2027-11-13T08:44:37.000Z source=self-signed
[09:44:37 13.11.2026] INFO  Server listening at https://127.0.0.1:8443
```

Open the address in a browser for the pages (see [The web pages](#the-web-pages)).

| Address        | Answers                                                                                                                    |
| -------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `/healthz`     | `{"status":"ok"}` while the process is up                                                                                  |
| `/readyz`      | Ready, degraded or unavailable (503), check by check (see [Operations](#operations))                                       |
| `/metrics`     | Prometheus metrics, with `AFS_METRICS_TOKEN` as a bearer token (see [Operations](#operations))                             |
| `/api/v1/meta` | What the server is and what a client may rely on (see [Compatibility with the designer](#compatibility-with-the-designer)) |

```sh
curl --insecure https://127.0.0.1:8443/api/v1/meta
```

```json
{
  "name": "Ansible Flow Server",
  "version": "0.1.0",
  "designer": { "version": "0.86.0", "format": 2, "formats": [1, 2], "bundle": "0.86.0" },
  "features": [
    "git",
    "launch-configs",
    "runs",
    "run-events",
    "approvals",
    "notifications",
    "workspace-tokens",
    "mcp"
  ],
  "api": "v1",
  "instance": "7c9e6679-7425-40de-944b-e07fc1f90ae7"
}
```

#### Compatibility with the designer

The server is built on the designer's packages (`@ansible-flow/*`) of one version, and a client
(the VS Code extension, an agent) reads `/api/v1/meta` before it talks to the server:

- `api`: the REST API's version (`v1`). A client made for another does not go on.
- `designer.version`: the designer the server reads, checks and runs flows with;
  `designer.bundle`: the designer canvas the pages carry, stamped at build (the same version).
- `designer.formats`: the flow formats the server reads. A flow in a newer format (written by a
  newer designer) is listed with "Upgrade the server" and is not run.
- `features`: what a client may rely on; a name is only ever added.

The designer ships its **contract** with this server in `@ansible-flow/assets` (`contract/`): the
exchanges the extension relies on (sign-in, projects, flows, launch configurations, check, launch,
a run, stop, and the refusals). The server's tests replay them against its real routes on both
databases (`test/unit/contract.test.ts`); the extension's replay them against a mock. A new
designer release is taken by the **Designer packages** workflow (`.github/workflows/afd-bump.yml`,
daily, by hand, or on the designer's `afd-release` event): it installs the new version, runs every
check with the contract, and opens a pull request only when they pass.

Stop it with Ctrl+C: requests in flight are answered first.

Read flow files without starting the server:

```sh
just check-flows test/fixtures/hello.flow.yaml test/fixtures/firewall-upgrade.flow.yaml
```

```text
Ansible Flow Server 0.1.0, built on Ansible Flow Designer 0.86.0; reads flows up to format 2
test/fixtures/hello.flow.yaml: Hello, Ansible (hello v1, format 2), 3 steps, 0 errors, 0 warnings
test/fixtures/firewall-upgrade.flow.yaml: Firewall firmware upgrade (firewall-upgrade v1, format 2), 18 steps, 0 errors, 0 warnings
```

It exits with 1 when a file is not a flow this server can read.

## Configuration

Settings are read from the environment, and from a `.env` file beside the server (the environment
wins). Copy [.env.example](.env.example) to `.env`. A wrong setting stops the start and every
problem is named.

| Setting                       | Default                                              | Meaning                                                                                            |
| ----------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `AFS_HOST`                    | `127.0.0.1`                                          | The address to listen on; `0.0.0.0` for every interface                                            |
| `AFS_PORT`                    | `8443`                                               | The port (`8080` with `AFS_TLS=off`)                                                               |
| `AFS_PUBLIC_URL`              | none                                                 | The address people open, like `https://flows.example.net`                                          |
| `AFS_HTTP_PORT`               | none                                                 | A port that redirects plain HTTP to HTTPS                                                          |
| `AFS_TLS`                     | `on`                                                 | `off` behind a proxy that does HTTPS                                                               |
| `AFS_TRUSTED_PROXIES`         | none                                                 | With `AFS_TLS=off`: proxies whose word is taken for who asked                                      |
| `AFS_CA_FILE`                 | none                                                 | Certificate authorities of your network, for outgoing connections                                  |
| `AFS_MASTER_KEY_FILE`         | `<data>/master.key`, made at first start             | The file with the master key that stored credentials are encrypted with                            |
| `AFS_MASTER_KEY`              | none                                                 | The master key itself (base64 of 32 bytes), instead of a file                                      |
| `AFS_MAX_RUNS`                | `4`                                                  | Runs at once on this server                                                                        |
| `AFS_MAX_RUNS_PER_PROJECT`    | `1`                                                  | Runs at once of one project                                                                        |
| `AFS_CONTAINER_ENGINE`        | `auto`                                               | The container engine runs use: `auto`, `docker`, `podman`, or `off`                                |
| `AFS_METRICS_TOKEN`           | unset: no metrics                                    | The bearer token `/metrics` asks for, 16 characters or more                                        |
| `AFS_MIN_FREE_MB`             | `1024`                                               | Below this much free space in the data folder, `/readyz` says degraded                             |
| `AFS_ENGINE_DATA_DIR`         | found from the server's own container                | The server in a container: its data folder as the engine's machine has it                          |
| `AFS_EE_IMAGE`                | `ghcr.io/ansible/community-ansible-dev-tools:latest` | The image a run uses unless its launch names one                                                   |
| `AFS_RUN_TIMEOUT_MINUTES`     | `240`                                                | A run that takes longer is stopped                                                                 |
| `AFS_RUNS_KEEP_DAYS`          | `90`                                                 | Ended runs older than this are removed, with their output                                          |
| `AFS_RUNS_KEEP_PER_FLOW`      | `200`                                                | Of one flow in one project, at most this many ended runs are kept                                  |
| `AFS_AUDIT_KEEP_DAYS`         | `365`                                                | Audit entries older than this are removed; `0` keeps them all                                      |
| `AFS_NOTIFICATIONS_KEEP_DAYS` | `30`                                                 | Notifications sent or given up on are kept this many days                                          |
| `AFS_DEV_BUNDLE_MAX_MB`       | `50`                                                 | The largest bundle of unpushed work a dev run takes                                                |
| `AFS_DEV_KEEP_HOURS`          | `24`                                                 | How long the server keeps a dev run's work                                                         |
| `AFS_ARCHIVE_MAX_MB`          | `50`                                                 | The most an archive a hosted project starts from may unpack to                                     |
| `AFS_GALAXY_URL`              | `https://galaxy.ansible.com`                         | Where environment builds look up collection versions (Galaxy, an Automation Hub, a private Galaxy) |
| `AFS_BUILD_TIMEOUT_MINUTES`   | `60`                                                 | How long an environment build may take                                                             |
| `AFS_GIT_LOCAL`               | `off`                                                | `on`: a project's repository may be a folder of this machine                                       |
| `AFS_DATA_DIR`                | `data`                                               | Where the server keeps what it owns                                                                |
| `AFS_DATABASE_URL`            | `sqlite:afs.db`                                      | `sqlite:<file>` (in the data folder unless absolute) or `postgres://…`                             |
| `AFS_LOG_LEVEL`               | `info`                                               | `trace`, `debug`, `info`, `warn`, `error`, `fatal` or `silent`                                     |
| `AFS_LOG_FORMAT`              | `text`                                               | `text`, or `json` for one object a line                                                            |
| `AFS_ENV_FILE`                | `.env`                                               | Another file to read the settings from                                                             |

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

| Command                                            | Does                                                                                         |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `cert show`                                        | The certificate in use, the one before it, a waiting request                                 |
| `cert request <names> [--org] [--out]`             | A new key and a request to sign; the key stays with the server                               |
| `cert install <file> [--key <file>]`               | Installs a certificate; without `--key` it answers the request, or renews for the key in use |
| `cert install <file.pfx> --passphrase-file <file>` | Installs the certificate, chain and key of a PFX (PKCS#12) file                              |
| `cert self-signed [names]`                         | A new self-signed certificate                                                                |
| `cert rollback`                                    | Back to the certificate that was in use before                                               |
| `cert history`                                     | Every change: when, what, by whom, which certificate                                         |

- A certificate is checked before anything changes: its key belongs to it, it is valid now, its
  chain is in order, and it is good for the host of `AFS_PUBLIC_URL`. Every problem is named.
- A running server needs no restart: new connections get the new certificate within a moment.
- The server warns in its log when the certificate has 30 days or fewer left.
- Keys and certificates are in `<data folder>/tls`. Back that folder up with the rest. The
  private keys (in use, the one before it, a waiting request's) are sealed with the master key
  (`*.sealed`): a copy of the folder gives them away only with the master key. A plain `key.pem`
  from an older server is sealed at its next start; `secrets rotate` seals them again with the
  new key. This protects them only when the master key is kept elsewhere: give it as
  `AFS_MASTER_KEY`, or point `AFS_MASTER_KEY_FILE` outside the data folder (another disk, a
  secret mount). With `master.key` in the data folder, a copy of the folder has both.
- Behind a proxy that does HTTPS: `AFS_TLS=off` and `AFS_TRUSTED_PROXIES`.

A PFX file (`.pfx`, `.p12`), as Windows certificate authorities and many appliances export one,
holds the certificate, its chain and its key. Its passphrase is read from a file, never given as an
argument, where the process list and the shell's history would show it:

```sh
just cert install flows.pfx --passphrase-file pfx-pass.txt   # an empty file: no passphrase
```

The file is taken apart and goes through the same checks. Modern (AES-256) and older (3DES, RC2)
files are read, with RSA or EC keys; a file with more than one key is refused (export one
certificate). The passphrase is used once and kept nowhere.

The same actions are on the **Server certificate** page (Administration) and over the API, for
administrators. A change needs a sign-in with a password, not a token: a leaked token must not be
able to put its own certificate in front of everyone. The history names the administrator, and the
audit log has every change (`certificate.*`). While the certificate has 30 days or fewer left,
every page shows administrators a banner.

| Address (under `/api/v1/admin/certificate`) | Does                                                                                |
| ------------------------------------------- | ----------------------------------------------------------------------------------- |
| `GET` (the address itself)                  | In use, the one before it, a waiting request, whether TLS is on                     |
| `POST /request`                             | `{"names":[…],"organization"}`: a new key and a request; the key stays here         |
| `GET /request.pem`                          | The waiting request, as a file for the certificate authority                        |
| `POST /install`                             | `{"certificate","key"?}`: install; refused with `422` and every reason (`problems`) |
| `POST /install` (a PFX)                     | `{"pfx","passphrase"}`: the file as base64; the same checks and refusals            |
| `POST /self-signed`                         | `{"names"?}`: a new self-signed certificate                                         |
| `POST /rollback`                            | Back to the certificate before                                                      |
| `GET /history`                              | Every change, newest first                                                          |

Not there yet: automatic certificates (ACME).

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

| Address (under `/api/v1`)                                  | Does                                                                | Who                               |
| ---------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------- |
| `POST /session`                                            | Sign in with `{"login","password"}`                                 | anyone                            |
| `GET /session`                                             | Who am I, with my groups                                            | signed in                         |
| `DELETE /session`                                          | Sign out                                                            | anyone                            |
| `PUT /session/password`                                    | Change my password: `{"current","password"}`                        | signed in                         |
| `PATCH /session`                                           | Change my `name` and `email`; `webhookUrl` only as an administrator | session (not a token)             |
| `GET /tokens`, `POST /tokens`                              | My access tokens; make one (shown once)                             | signed in; making needs a session |
| `DELETE /tokens/:id`                                       | Revoke one of my tokens                                             | signed in, with a session         |
| `/users`, `/users/:id`                                     | List, add, change, disable, delete people                           | administrators                    |
| `PUT /users/:id/password`                                  | Set someone's password                                              | administrators                    |
| `GET /users/:id/tokens`, `DELETE /users/:id/tokens/:token` | See and revoke someone's tokens                                     | administrators                    |
| `/groups`, `/groups/:id`                                   | List, add, change, delete groups                                    | administrators                    |
| `PUT /groups/:id/members`                                  | Set a group's members: `{"users":[ids]}`                            | administrators                    |
| `GET /users/:id/access`                                    | What one person reaches, workspace by workspace (below)             | administrators                    |
| `GET /groups/:id/grants`                                   | The grants that name a group, in every workspace (below)            | administrators                    |

- A password has at least 12 characters and is kept only as an argon2id hash.
- A session lasts 8 hours without use and 7 days at most. Its cookie is not readable by scripts
  and is sent over HTTPS only.
- After five wrong passwords for a login in fifteen minutes, sign-in for it waits.
- The last administrator cannot be demoted, disabled or deleted.
- `GET /users/:id/access` answers `{"admin", "workspaces"}`: a row for each workspace where a
  grant names the person or one of their groups, with the `workspace` (`id`, `key`, `name`),
  their `level` there, `approve`, the `flows` with a grant of their own, and `through` (whose
  grants gave it: `user:omar`, `group:netops`). For an administrator it is `"admin": true` and
  no rows. `GET /groups/:id/grants` lists the grants that name the group: each with the
  `workspace` (`id`, `key`, `name`), the `level`, and the `flow` when it is on one flow.
- A person and a group each have an email address and a webhook address: where a notification
  for them goes (see [Notifications](#notifications)).

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
- An agent with a token made with `"mcpApprovals": true` may decide approvals over MCP (see
  [Agents (MCP)](#agents-mcp)); without it approvals stay with people. Not for a read-only token.
- A token for one workspace (`"workspace": "net"`, its key or id) reaches that workspace only:
  its projects, flows, credentials, launch configurations, runs and git repositories. What spans
  workspaces (the list of workspaces, all runs, people, the audit log) is refused with
  `403 out_of_scope`; list runs with `?project=<id>`.
- A token cannot make or revoke tokens, or set a password: those take a signed-in session.
- Keep it in an environment variable or a credential store, never in a repository or an address.

**Sign in with your organisation (OIDC):** Keycloak, Microsoft Entra ID, Google, Okta, Authentik
and any other OpenID Connect provider. On the Sign-in page (Administration, `/admin/sign-in`) an
administrator adds a provider:

| Setting       | What                                                                                      |
| ------------- | ----------------------------------------------------------------------------------------- |
| Name, key     | The button's words; the key is in the sign-in address (`keycloak`)                        |
| Issuer        | `https://login.example.net/realms/net`; `https://login.microsoftonline.com/<tenant>/v2.0` |
| Client id     | The client registered at the provider for this server                                     |
| Client secret | Kept sealed with the master key, never shown again; empty for a public client             |
| Scopes        | `openid profile email` by default; add what the groups claim needs                        |
| Groups claim  | The claim with the person's groups (`groups`)                                             |
| Login claim   | A new person's login (`preferred_username`; else the email, else the subject)             |
| Mappings      | A value of the groups claim and what it is here: a server group, or administrator         |

Register the address the page shows (`https://flows.example.net/api/v1/auth/oidc/<key>/callback`)
as the client's redirect URI at the provider, and Test the provider. Then:

- The sign-in page has a button per provider. The sign-in is the authorization code flow with
  PKCE, state and nonce; the ID token's signature, issuer and audience are checked.
- A person is made at their first sign-in (no password: they sign in at the provider) and found
  again by their subject there. Their name and email follow the provider.
- At each sign-in their groups and the administrator right follow the mapped claim values: what the
  provider no longer says is taken back. Groups and rights given here by hand are kept.
- **Passwords for administrators only:** the page's Passwords setting lets everyone else sign in
  only with a provider (a way in stays if the provider is down).
- Removing a provider keeps its people; the groups and administrator rights it gave go.
- A provider's certificate authority: `AFS_CA_FILE`. Every change is in the audit log.

**Sign in with a directory (LDAP, Active Directory):** people type their directory login and
password in the usual sign-in form. On the same Sign-in page an administrator adds a directory,
starting from the Active Directory or the OpenLDAP preset:

| Setting                | What                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Address                | `ldaps://dc1.corp.example.net:636`; `ldap://` only with StartTLS (or on this machine)                                    |
| Service account        | The DN that searches (`CN=svc-flows,OU=Services,DC=corp,DC=example,DC=net`) and its password, sealed with the master key |
| Where people are       | The search base (`OU=Staff,DC=corp,DC=example,DC=net`)                                                                   |
| Person filter          | `(&(objectCategory=person)(objectClass=user)(sAMAccountName={login}))`                                                   |
| Id, login, name, email | Attributes; the id stays the same when a person is renamed (`objectGUID`, `entryUUID`)                                   |
| Groups from            | A search (`(&(objectClass=group)(member:1.2.840.113556.1.4.1941:={dn}))`: nested AD groups too) or `memberOf`            |
| Disabled in AD         | People disabled in Active Directory cannot sign in                                                                       |
| Sync every             | Minutes (60 by default; 0: only at sign-in)                                                                              |
| Mappings               | A group's name (`netops`) or DN and what it is here: a server group, or administrator                                    |

Test it, with a login if you like: the page shows the entry found, its groups and what they are
here. Then:

- A login with a password here signs in here; any other login is tried with the directories, in
  order. A wrong password is refused there and then; a directory that does not answer is skipped.
  Every refusal says the same thing.
- A person is made at their first sign-in and found again by their id in the directory. Their
  name, email, groups and administrator right follow the directory, as with a provider: what was
  given here by hand stays.
- **The sync** looks everyone up again on the timer (and with Sync now): who left the directory, or
  was disabled in Active Directory, is disabled here, and their open sessions and tokens stop at
  once. Who comes back is enabled again. A directory that does not answer disables nobody; an
  account disabled here by hand stays disabled.
- Directory sign-ins also work when passwords are for administrators only.
- Removing a directory keeps its people; the groups, rights and disabling it gave go.
- The directory's certificate authority: `AFS_CA_FILE`. Every change and sync is in the audit log.

Not there yet: GitHub sign-in (OAuth 2, not OIDC); Kerberos (sign-in without typing a password).

#### Access levels

Administrators may do everything. Everyone else sees and does only what they are given: a
**grant** gives a user or a group a level on a whole workspace, or on one flow of it.

| Level      | May                                                                                                                                       |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `ro`       | See the workspace, its projects, flows, launch configurations, credentials (names) and runs; clone and fetch; ask what a launch would run |
| `operator` | And launch a flow as its launch configuration says; stop a run, run it again                                                              |
| `rw`       | And launch another branch or commit; add, change and delete launch configurations; push through the server; look at the source now        |
| `approve`  | Decide approval gates, and see what they decide (as `ro`); a grant of its own, which never lowers another                                 |

- **A grant on one flow replaces the workspace's for that flow:** it may give more (operator on
  one flow of a workspace that is ro) or less (ro on one flow of a workspace that is rw).
- **Of a person's own and their groups' grants, the highest counts.**
- **Git is the workspace's:** clone needs `ro` on the workspace and push `rw` on it; a grant on
  one flow does not open the repository, which holds every flow.
- **What a person may not see is not there for them:** lists leave it out, and asking for it
  answers 404. What they may see but not do answers 403.
- **Tokens act as their owner,** narrowed further when read-only or made for one workspace.
- Workspaces, projects, credentials and grants are changed by administrators.

Give and take grants on the workspace's page (Access), or:

```sh
curl --cookie cookies.txt -H 'content-type: application/json' \
  https://flows.example.net:8443/api/v1/workspaces/net/grants -d '{"group":"net-ops","level":"operator"}'
curl --cookie cookies.txt -H 'content-type: application/json' \
  https://flows.example.net:8443/api/v1/workspaces/net/grants \
  -d '{"user":"omar","level":"rw","project":"<project id>","flow":"flows/firewall-upgrade.flow.yaml"}'
```

| Address (under `/api/v1`)            | Does                                                                                         | Who            |
| ------------------------------------ | -------------------------------------------------------------------------------------------- | -------------- |
| `GET`, `POST /workspaces/:id/grants` | A workspace's grants; give one (`user` or `group`, `level`, optionally `project` and `flow`) | administrators |
| `DELETE /grants/:id`                 | Take a grant back                                                                            | administrators |
| `GET /workspaces/:id/access`         | Who can do what: every person with access, as their grants come out                          | administrators |
| `GET /projects/:id/access`           | What you may do in a project: your level on it and on each flow                              | can see it     |

#### Service accounts

A pipeline or another program gets an identity of its own: a service account. It has no
password and cannot sign in to the pages; it signs in only with tokens, which an administrator
makes for it (signed in with a password). What it may do is what its account may do:

```sh
# as an administrator, signed in to the pages (cookie) or on the server's machine
curl --cookie cookies.txt -H 'content-type: application/json' \
  https://flows.example.net:8443/api/v1/users -d '{"login":"ci-pipeline","name":"CI pipeline","service":true}'
curl --cookie cookies.txt -H 'content-type: application/json' \
  https://flows.example.net:8443/api/v1/users/<id>/tokens -d '{"name":"nightly","workspace":"net"}'

just user add ci-pipeline --service
just user token ci-pipeline --name nightly --workspace net --days 30
```

Its tokens are listed and revoked like anyone's (`GET`/`DELETE /api/v1/users/<id>/tokens`). On
the pages, an administrator adds a service account at Administration > People and groups and makes
its tokens on its page.
A service account is given levels like a person (see [Access levels](#access-levels)).

### The API

Everything the pages do goes through the REST API under `/api/v1`, and every address is in the
server's OpenAPI 3.1 document, `GET /api/v1/openapi.json` (no sign-in needed). The page
`/docs/api` shows it by subject: what each address does, who may call it, and what it takes.

```sh
curl -s https://flows.example.net:8443/api/v1/openapi.json | jq '.paths | keys | length'
curl -H "Authorization: Bearer $AFS_TOKEN" \
  "https://flows.example.net:8443/api/v1/runs?project=<id>&state=failed&limit=20"
```

- Errors are JSON: `{"error": "<code>", "message": "<words fit to show>"}`, with the HTTP status.
- A run is followed as server-sent events (`GET /api/v1/runs/<id>/events`), see [Runs](#runs).
- The list of runs is narrowed with `project`, `flow`, `state`, `config` (a launch
  configuration's id) and `by` (the login of who asked for the run), and read a page at a time
  with `limit` and `before`, see [Runs](#runs). A list never shows more than you may see,
  whatever it is asked for.
- Each route is described in one list on the server (what it does, who may call it, which
  workspace it reaches); a route that is not in it stops the server from starting.

### The web pages

The server serves its own pages at its address. A new server shows the first-run setup (the
setup code from its log); after that, sign-in: a card over a quiet picture of a flow, which says
nothing about the server (the page is public). Signed in, a side menu leads to Home, Runs,
Approvals (with how many wait for you), Library, each workspace and, for administrators, the
administration's pages; your name, the theme and Sign out are at its end. Long pages are split
into tabs; each tab has its own address. At phone width it folds into **Menu**.

| Page                                              | Shows                                                                                                                                                                                                                                                              |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/`                                               | Home: the day in a sentence, the approvals waiting for you, the launch configurations you used lately (Launch again), the latest runs, the workspaces                                                                                                              |
| `/workspaces`                                     | The workspaces; administrators add one                                                                                                                                                                                                                             |
| `/w/<workspace>`                                  | A workspace in tabs. **Projects**: its projects; administrators add one, kept by the server or external (with what it signs in with)                                                                                                                               |
| `/w/<workspace>/-/environments`                   | **Execution environments** of the workspace                                                                                                                                                                                                                        |
| `/w/<workspace>/-/credentials`                    | **Credentials** of the workspace (administrators add, change, delete)                                                                                                                                                                                              |
| `/w/<workspace>/-/access`                         | **Access** (administrators): who can do what, the grants, giving access, who decides a launcher's own approvals                                                                                                                                                    |
| `/w/<workspace>/<project>`                        | A project in tabs, with its state in one line under the title (source, branch, commit). **Overview**: launch configurations with their last run and Launch, flows with their findings and how their last run went, the newest runs                                 |
| `/w/<workspace>/<project>/runs`                   | **Runs** of the project                                                                                                                                                                                                                                            |
| `/w/<workspace>/<project>/files`                  | **Files** of the project                                                                                                                                                                                                                                           |
| `/w/<workspace>/<project>/branches`               | **Branches** and who pushed through the server                                                                                                                                                                                                                     |
| `/w/<workspace>/<project>/settings`               | **Settings**: the `git clone` command, what an external source signs in with, its SSH host key, the push hook, library                                                                                                                                             |
| `/w/<workspace>/<project>/flow/<file>`            | One flow on the designer's canvas; its launch configurations (Launch) and newest runs above it; "Open on its own page"                                                                                                                                             |
| `/w/<workspace>/<project>/launch/<id>`            | A launch configuration in tabs. **Launch**: the form with Launch on top, what would run, keep start values                                                                                                                                                         |
| `.../launch/<id>/runs`, `/schedules`, `/settings` | Its **Runs** (older ones a page at a time), its **Schedules**, and its **Settings** (change, delete; `rw` on its flow)                                                                                                                                             |
| `/w/<workspace>/<project>/launch/new`             | Add a launch configuration (`rw` on its flow)                                                                                                                                                                                                                      |
| `/runs`                                           | Every run you may see, the newest first, filtered by state, by project and one of its launch configurations, and to your own (Mine); the choices are in the address; older runs a page at a time                                                                   |
| `/runs/<id>`                                      | One run: where it belongs (workspace, project, launch configuration), where it stands in a sentence, the run on the canvas, beside it the approval that waits, its hosts (those with a problem first), why one failed and what ran; its output; Stop and Run again |
| `/approvals`                                      | What waits for a decision: yours each in a tinted box with the decision (and a comment), others' as rows with why not                                                                                                                                              |
| `/docs/api`                                       | The API reference, from the server's OpenAPI document                                                                                                                                                                                                              |
| `/account`, `/account/tokens`                     | Your **Profile** (name, email address; webhook for administrators) and your **Access tokens**                                                                                                                                                                      |
| `/admin/people`, `/admin/groups`                  | **People** (filtered by name and kind) and **Groups**, each a tab; add a person, service account or group                                                                                                                                                          |
| `/admin/people/<id>`                              | One account: groups, what they reach in each workspace, profile, password, tokens (made here for a service account); disable and delete last                                                                                                                       |
| `/admin/groups/<id>`                              | One group: members, the workspaces that name it, name, email address and webhook, delete                                                                                                                                                                           |
| `/admin/sign-in`                                  | Sign-in providers, directories, who may use a password                                                                                                                                                                                                             |
| `/admin/certificate`                              | The server certificate: in use and its days left, the one before (roll back), history; replace it by a request, a certificate or a PFX file; new self-signed                                                                                                       |
| `/admin/notifications`                            | The delivery log; `/admin/notifications/settings`: the mail server, the webhook signing key, a test message                                                                                                                                                        |
| `/admin/audit`                                    | The audit log, filtered, older entries a page at a time; export as CSV or JSON                                                                                                                                                                                     |

- **Search** at the top of every page (`/` or Ctrl+K): as you type, the workspaces, projects, flows (by name,
  key or file), launch configurations, runs (by number, flow or configuration), environments and
  pages the person may see; people and groups for administrators. Arrows and Enter open one, Esc
  closes. The same over the API: `GET /api/v1/search?q=` (a token made for one workspace searches
  there only).
- Dark by default; the theme button in the side menu goes to light, then to following the device.
  The flow canvas keeps the designer's own look in the same theme.
- Works at phone width and with a keyboard and a screen reader.
- A flow is shown as in VS Code (levels, details, generated code) and cannot be changed here.
- **When someone changes a flow you have open** (a push, through the server or to the source the
  server looks at), a bar on the canvas says who and how much ("Mia Ortega changed this flow: 3
  steps"). **Show changes** opens the new version in the Changes lens, compared with the one you
  had; **Update** just shows the new version. A flow removed from the branch is said so and stays
  as it was. The Changes lens also compares with any earlier commit that changed the flow. A
  project's page lists the flows changed while it is open, and by whom. Over the API:
  `GET /api/v1/projects/<id>/events` (server-sent events: `commit`, then `moved` with from and to),
  `GET /api/v1/projects/<id>/changes?from=<commit>` (the flows added, changed or removed, and who
  changed them) and `GET /api/v1/projects/<id>/flows/history?path=` (the commits that changed a
  flow).
- A run is shown on the canvas as in VS Code, live while it goes; a step's host output, the flow's earlier runs and Stop work from the canvas, and an approval is decided in its Run tab.
- Run on the canvas opens the designer's launch dialog over a launch configuration of the flow (pick one when there are several): its start values, the inventory's groups, and the hosts the targets match, counted again as you type. Run launches it (`operator` on the flow) and the run shows on the canvas.
- Administrators read the audit log at `/admin/audit` and export it.
- A project's page lists its launch configurations; `rw` on a flow adds, changes and deletes
  them.
- A workspace's Access tab is for administrators: who can do what, and the grants.
- Each page shows only what the person's level lets them do; the server decides either way.
- Administrators manage people and groups at `/admin/people`. The server's rules stand there too
  (the last administrator stays one; nobody disables or deletes themself), and a refusal is shown
  as the server words it.

### Editing flows in the pages

Someone with `rw` on a flow edits it on its page: **Edit** opens the designer in full, as in VS
Code. Everyone who edits the same flow edits one shared draft:

- **Edits are shared at once.** Each change goes to the server, which applies it to the draft in
  the order it gets them, and everyone's canvas shows the result. Changes to different steps all
  apply; when two people change the same field, the later one wins. The draft bar says who is
  here and what the others changed last.
- **Ctrl+Z takes back your own last edit**, and leaves the others' alone. When someone changed the
  same place after you, it is refused with what they changed.
- **Save** makes one commit on the project's branch, with your message, by you, and
  `Co-authored-by` for everyone else who edited. For a project with an external repository the
  commit is pushed there first, only if the branch there has not moved. When the branch moved
  since the draft began, the draft is merged onto it step by step first; places both changed are
  listed, and **Save with the draft's side** takes the draft's version of those.
- A draft is kept until it is saved or discarded: the flow's page says there are unsaved edits and
  by whom; **Open the draft** goes on with it, and anyone with `rw` may **Discard** it. Runs take
  the flow from the branch, so a draft runs only once saved.
- **Binding steps** searches the module catalog of the flow's image (its launch configuration's
  environment or image, else the server's default `AFS_EE_IMAGE`). The first time an image is
  asked for, the server reads its plugin docs with the designer's probe (a few minutes; the
  catalog's state shows meanwhile) and keeps the index in the data folder. A repository's own
  roles and playbooks are not offered yet.
- Over the API: `POST /api/v1/projects/<id>/drafts?path=` opens a flow's draft;
  `GET /api/v1/drafts/<id>/events` follows it (server-sent events: `draft`, `edit`, `people`,
  `saved`, `discarded`); `POST /api/v1/drafts/<id>/commands` (the designer's commands), `/undo`,
  `/tidy`, `/here`, `/catalog`, `/save`; `DELETE /api/v1/drafts/<id>` discards.

Not there yet: colours per person and selections on the canvas, Follow, and VS Code joining a
draft (designer AFD-285).

### Files of a project

The **Files** tab of a project shows everything else in the repository: templates, files,
`group_vars`, roles, `ansible.cfg`. The page uses the width of the screen: the tree on the left,
the file beside it; the README (or the first file) is open when you come. Pick a branch, read any
file, and download it. Text files (YAML, Jinja2, ini and cfg, Python, Markdown, JSON, shell) open in an
editor with highlighting; flows are read here and edited in the flow editor.

With `rw` on the workspace you change files: edit text, **New file**, **Upload files** and
**Upload a folder (zip)** (a zip or tar.gz unpacked into the folder you are in), **Rename or
move** and **Delete** (files and folders). The changes are listed until **Save**, which makes one
commit of them on the branch, with your message, by you; this browser keeps them meanwhile, and
**Take back** drops one. When the branch moved since your first change, Save goes on top of it,
unless the branch changed one of the same files: then nothing is saved and those files are
listed. For a project with an external repository the commit is pushed there first. A Save is
listed with the pushes and in the audit log (`project.files-save`).

Limits: an edited file up to 1 MB, an uploaded one up to 5 MB, archives as for a start
(`AFS_ARCHIVE_MAX_MB`); paths stay inside the project and never in `.git`. Larger files go by
`git push`.

Over the API: `GET /api/v1/projects/<id>/files?branch=` lists the files;
`GET /api/v1/projects/<id>/files/content?commit=&path=` gives one (`&download=true` as a
download); `GET /api/v1/projects/<id>/files/history?commit=&path=` the commits that changed it;
`POST /api/v1/projects/<id>/files` saves a change set:

```json
{
  "branch": "main",
  "base": "9f2c1e7ab3d45c60e8a1f2b3c4d5e6f708192a3b",
  "message": "Add the web template",
  "changes": [
    { "op": "write", "path": "templates/web.conf.j2", "text": "listen {{ web_port }};
" },
    { "op": "move", "from": "files/old.cfg", "to": "files/web.cfg" },
    { "op": "delete", "path": "files/unused" },
    { "op": "unpack", "path": "roles", "base64": "<a zip or tar.gz>" }
  ]
}
```

A write takes `text` or `base64`, and `executable: true` for a program. A refusal because the branch
changed the same files is `409` with `files`.

Not there yet: a diff before Save, and a link from a step's template in the designer to its file.

### Flow library

An administrator makes a project a **library** on its page (**Make it a library**). Its flows'
subflows (a backup with its check, a maintenance window, an approval chain) are then offered to
every project on the server, to people who may read the library's workspace (`ro` or more).

- **Library** (the side menu) lists what the libraries offer: each subflow, its flow, version and
  commit.
- While a flow is edited in the pages, **Insert Shared Subflow…** on the canvas opens the library:
  the subflow picked is copied into the draft, pinned to the library flow's version and commit
  (`ref.from: afs://<workspace>/<project>/<file>#<subflow>`). In VS Code, with this server set
  (`afd.runner.url`), the designer lists the library too.
- The copy lives in the flow: runs read nothing from the library. A flow's page lists its library
  copies under **From the library**: up to date, behind (the library has a newer version; **Update**
  while the draft is edited copies it again), or no longer offered. The flow's problems on the canvas say the
  same.
- A library flow's version is its `flow.version`: raise it when its subflows change, so the flows
  that copy them see an update.

Over the API: `GET /api/v1/library/subflows` lists what you may read;
`GET /api/v1/library/subflow?from=afs://…` gives one as it is now, with its steps; an
administrator sets `PATCH /api/v1/projects/<id>` `{"library": true}`.

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

| Address (under `/api/v1`)             | Does                                                                                                                                        | Who                                        |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `/workspaces`, `/workspaces/:id`      | List, add, change, delete (by id or key)                                                                                                    | read: what you see; change: administrators |
| `/workspaces/:id/projects`            | A workspace's projects; add one (its source is looked at at once)                                                                           | as above                                   |
| `/projects/:id`                       | A project; change its name, source, branch, timer; delete                                                                                   | as above                                   |
| `POST /projects/:id/sync`             | Look at the source now                                                                                                                      | `rw` on the workspace                      |
| `GET /samples`                        | The sample projects a hosted project can start from                                                                                         | signed in                                  |
| `POST /projects/:id/start`            | A hosted project's first commit: `{"sample":"hello"}`, or a zip or tar.gz as the body                                                       | `rw` on the workspace                      |
| `GET /projects/:id/branches`          | The branches: names, and each with its newest commit, commits not on the project's branch and the launch configurations that run it         | signed in                                  |
| `POST /projects/:id/branches`         | `{"name","from"}`: a branch from a branch or a commit                                                                                       | `rw` on the workspace                      |
| `DELETE /projects/:id/branches?name=` | Delete a branch; `&force=true` for one with commits not on the project's branch                                                             | `rw` on the workspace                      |
| `GET /projects/:id/pushes`            | Who pushed what through the server, newest first                                                                                            | signed in                                  |
| `GET /projects/:id/flows`             | The flows (`*.flow.yaml`) at the project's commit, each with name, version, steps, errors, warnings and `lastRun`, or why it cannot be read | signed in                                  |
| `GET /projects/:id/flows/view?path=`  | One flow as the designer shows it (the flow, findings, positions, generated plays)                                                          | signed in                                  |
| `POST /projects/:id/hook`, `DELETE`   | Make a push hook (its token is shown once); remove it                                                                                       | administrators                             |
| `POST /hooks/projects/:id/push`       | Called by the git host with the hook's token                                                                                                | the token                                  |

- **The source** is `https://…`, `ssh://…` or `git@host:path`. An address with a password in it
  is refused. A folder of this machine is allowed only with `AFS_GIT_LOCAL=on`.
- **The branch** (`gitRef`, `main` unless set) is the one whose commits may run.
- **Kept up to date** when added, on request, by the push hook, and every `pollSeconds` (300
  unless set; 0 for never). A source that cannot be reached shows as the project's `sync` state
  with the reason; the commit it had stays.
- **The push hook:** set it up on the project's page (**Push hook**, administrators) or with
  `POST /projects/:id/hook`; its address and token are shown once. GitLab, Gitea and anything that
  can send a header send the token in `X-Gitlab-Token`, `X-AFS-Token` or `Authorization: Bearer`.
  **GitHub** signs each call instead: in the repository's Settings, Webhooks, add one with the
  address as Payload URL, content type `application/json`, the token as Secret, and the push
  event. The server keeps the token sealed with the master key and checks `X-Hub-Signature-256`
  over the call's bytes; GitHub's first call (`ping`) is answered `pong`. A wrong token or
  signature, a project without a hook and no project get the same `401`, and too many from one
  address wait. A hook made before signed hooks has only the token's hash: make a new token for
  GitHub.

  ```text
  Payload URL   https://flows.example.net:8443/api/v1/hooks/projects/2a968c91-1ac7-4654-94c8-2eb24a28b10b/push
  Content type  application/json
  Secret        <the hook's token>
  Events        Just the push event
  ```
- The server needs the `git` program.

#### Starting a hosted project from a sample or an archive

A hosted project can get its first commit from the server instead of a first push: one of the
designer's sample projects, or an archive of your own files. Choose it under **Start with** when
adding the project, or on the project's page while it has no commit (**Start this project**).

```sh
curl ... -X POST https://flows.example.net:8443/api/v1/workspaces/network/projects \
  -d '{"key":"try","name":"Try it","sample":"hello"}'
curl ... -X POST https://flows.example.net:8443/api/v1/projects/<id>/start \
  -H 'content-type: application/gzip' --data-binary @edge-flows.tar.gz
```

- **Samples:** Hello, Ansible (runs on localhost), Edge baseline (with the playbooks and roles it
  binds) and Firewall firmware upgrade (with an approval). Each flow is at
  `flows/<key>/<key>.flow.yaml`, with an `inventory.ini`.
- **Archives:** zip (`application/zip`) or tar.gz (`application/gzip`). One folder that holds
  everything is taken off. The files are committed as they are, `.gitignore` or not; programs in
  a tar.gz stay programs.
- **Refused, with the reason:** a path that leaves the project (`..`, absolute, a drive), links
  and other special entries, a `.git` folder, more than 5,000 files, more than
  `AFS_ARCHIVE_MAX_MB` (50) unpacked, counted while unpacking.
- **Only while empty:** a project with commits (409) is pushed to instead; a project with a
  source starts from its source.
- The commit is by the person who started the project, and shows in the record of pushes; the
  audit log has `project.start`.

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

- **Who:** `ro` on the workspace clones and fetches, `rw` on it pushes (see
  [Access levels](#access-levels)). A read-only token never pushes.
- **A hosted project** starts empty, or from a sample or an archive (see above); otherwise the
  first push makes its branch.
- **A project with a source:** a clone or fetch gets what the source has now. A push is passed
  on to the source and is accepted only if the source accepts it. Until credentials exist, that
  works only where the server's own account may push to the source.
- **The project's branch** (`gitRef`) cannot be deleted and its history cannot be rewritten
  through the server. Other branches are free. Only branches are pushed, not tags.
- **Who pushed** is kept (`GET /projects/:id/pushes`); commits keep their own authors.

#### Branches

The project's page lists its branches with their newest commit and how many of its commits are
not on the project's branch. Who may push makes a branch from a branch or a commit and deletes
one; administrators make another branch the project's branch (the one that runs), which is
`PATCH /projects/:id {"gitRef"}`.

- **For a project with a source** the branch is made or deleted at the source first, with the
  project's credential, as a push through the server is; the mirror follows only what the source
  took.
- **Never deleted:** the project's branch, and a branch a launch configuration runs (the answer
  names them; change those first).
- **Asked again:** a branch with commits that are not on the project's branch (`409 unmerged`
  with the count; `force=true` deletes it). For a hosted project those commits are then gone.
- Each change is in the record of pushes and the audit log (`project.branch-create`,
  `project.branch-delete`, with the branch's name).
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

For a private repository see [Credentials](#credentials-and-the-master-key).

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

| Address (under `/api/v1`)     | Does                                                     | Who                                                 |
| ----------------------------- | -------------------------------------------------------- | --------------------------------------------------- |
| `/workspaces/:id/credentials` | List; add                                                | read: `ro` on the workspace; change: administrators |
| `/credentials/:id`            | One; change name, open part, or the whole secret; delete | as above                                            |

- **A secret goes in and never comes out.** Answers name what a credential holds (`has`), not
  the values. To change a secret, send it again whole.
- **A private repository:** give the project a credential of its workspace:
  `"gitCredential": "<credential id>"` when adding it, or `PATCH /projects/:id` (`null` takes it
  away). A `git_token` or `login` for an `https://` source, an `ssh_key` for an `ssh://` or
  `git@host:path` one. The server signs in with it to read the source and to pass pushes on.
- **An SSH key** is written to a private folder for one git call only and removed after it; a key
  with a passphrase is unlocked by a helper that reads it from a private file (never an argument or
  a variable of the call). The user is the one in the address, else the credential's `username`.
  Without a credential, an ssh source uses the server account's own key, as before.
- **SSH host keys** are trusted on first use: the first look at an ssh source keeps its host key
  in `<data folder>/repos/known_hosts` (the account's `~/.ssh/known_hosts` is read too), says so
  in the log and the audit log (`git.host-key-trusted`), and the project's page shows the
  fingerprint. A host that later shows another key stops the project with a reason; an
  administrator who knows why it changed presses **Accept the new host key**
  (`POST /projects/:id/host-key/forget`), and the next look trusts the key it finds.
  `GET /projects/:id/host-key` gives the fingerprints.
- A credential a project uses is not deleted until the project has another.
- With authorities of your own (`AFS_CA_FILE`), the server's git trusts them too.

| Command          | Does                                                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `secrets status` | Which master key the server has, and whether the stored credentials open with it                                                                  |
| `secrets rotate` | Makes a new master key and seals everything again: credentials, runs' inputs, the mail server's password, the webhook key (stop the server first) |

On the pages, a workspace's **Credentials** list what each holds (never a secret) and how many
projects and launch configurations use it; administrators add one with a form for its kind, change
its name, description and visible fields, replace its secret (the fields start empty and the
browser does not fill them; a private key can come from a file), and delete one nothing uses. An
external project chooses what it signs in with on its page (and when it is added): a git token or
a login for an `https://` address, an SSH key for an ssh one; a source that asks for a sign-in
says so there.

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

| Setting       | Means                                                                       |
| ------------- | --------------------------------------------------------------------------- |
| `flowFile`    | The flow's file in the repository                                           |
| `gitRef`      | Another branch than the project's to take the newest commit of              |
| `commit`      | One commit, always (a pin). Not together with `gitRef`                      |
| `inventory`   | The inventory's path in the repository; left out: what `ansible.cfg` names  |
| `eeImage`     | The execution environment's image; left out: the server's default           |
| `mode`        | `check` (a skeleton run, the default) or `real`                             |
| `limit`       | Ansible's limit, for fewer hosts than the flow targets                      |
| `inputs`      | Start values of the flow's inputs. Never one that looks like a secret       |
| `credentials` | Credentials of the workspace a run gets (not a git token)                   |
| `notify`      | Whom its runs tell: `{"when": "failed" or "ended", "to": [logins, groups]}` |

| Address (under `/api/v1`)         | Does                                                       | Who                                  |
| --------------------------------- | ---------------------------------------------------------- | ------------------------------------ |
| `/projects/:id/launch-configs`    | List, each with its `lastRun`; add                         | read: `ro`; change: `rw` on the flow |
| `/launch-configs/:id`             | One, with its `lastRun`; change; delete                    | as above                             |
| `GET /launch-configs/:id/form`    | The flow's inputs as a form, with the start values         | `ro`                                 |
| `POST /launch-configs/:id/check`  | What a launch would run, or 422 with everything in its way | `ro`                                 |
| `POST /launch-configs/:id/facts`  | The hosts it would touch, as the inventory has them        | `operator`                           |
| `POST /launch-configs/:id/launch` | The same, and the run goes in the queue (201 with the run) | `operator`                           |

`lastRun` is the configuration's newest run among the runs you may see: `id`, `number`, `state`,
`createdAt`, and `endedAt` once it has ended. A configuration that has not run has none. A
project's list of flows says the same of each flow.

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
- **Launch** (`operator` on the flow) queues the run and opens its page; another branch or
  commit than the configuration's needs `rw`.
- **Keep as start values** (`rw` on the flow) saves the typed values that are not secret as the
  configuration's.
- **Hosts in the inventory** (`operator`): under What would run, the hosts the targets match,
  the names the inventory does not have, and production-looking groups and hosts.

**The hosts, as the inventory has them** (`facts`): the server reads the inventory in the
launch's image, at the launch's commit, with the configuration's environment-variable
credentials (a dynamic source may need a token), the way the run will. It takes the same body as
`check`, and `"groups": true` adds the inventory's groups. Inputs that do not read yet are left
out; only a host list that does not read holds the hosts back.

```json
{
  "facts": {
    "sources": ["inventory/hosts.yaml"],
    "count": 2,
    "hosts": ["fw-edge-01", "fw-edge-02"],
    "unknown": ["fw-lab-09"],
    "uses": [],
    "prod": ["prod"],
    "vault": false,
    "environment": "registry.example.net/ee/network:2 (docker)"
  },
  "groups": ["edge", "lab", "prod"],
  "groupHosts": { "edge": { "count": 2, "hosts": ["fw-edge-01", "fw-edge-02"] } },
  "environment": "registry.example.net/ee/network:2 (docker)",
  "inventory": "inventory/hosts.yaml",
  "commit": "59b2575163b54f0c8a1e7d9b3f2a6c8e1d0b5741"
}
```

Without facts, `factsError` says why (no host typed, nothing matches, the image did not answer).
The image's container stays up two minutes after its last answer, so the next question is
quick; at most four are kept, and a stopping server removes them.

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
[Run with docker compose](#run-with-docker-compose). The data folder may be any volume: at start
the server asks the engine about its own container and gives run containers the volume's paths
as the engine knows them (`AFS_ENGINE_DATA_DIR` names them when it cannot find out).

### Execution environments

The image a run happens in. A workspace keeps its own **execution environments**: built by the
server from a spec, or an image that exists already. A launch configuration chooses one, and each
launch gets that environment's newest good build (the run records the exact image). Without one, a
launch configuration's own image, else `AFS_EE_IMAGE`, is used as before.

- **A spec**: ansible-core (`2.19` is the newest 2.19.x), collections each with a version, a range
  as `requirements.yml` writes it (`>=8.0.0,<9`) or `latest`, Python packages (pip requirements),
  Debian packages and extra certificate authorities. The base is a Python image, by default the
  one the designer's `afd-ee` image uses, and the image is made the same way: collections in
  `/usr/share/ansible/collections`, user `ansible` (uid 1000), SSH host keys checked.
- **A build**: `latest` and ranges are settled against `AFS_GALAXY_URL` into a lock (exact
  versions, kept with the build); the image is built on the server's container engine, tagged
  `afs-ee/<workspace>-<environment>:<hash of what went in>`, then asked what it holds (ansible-core
  and its collections). Builds go one at a time; each has a log. Collection server out of reach:
  pin exact versions, or point `AFS_GALAXY_URL` at one that can be reached.
- **An existing image** is pulled (or, when it has no registry, the engine's copy is used) and
  read the same way.
- Images of builds beyond an environment's newest few (`keep`, 3) are removed from the engine.
- The **ansible-builder file** (`execution-environment.yml`, version 3) describes the same
  environment for AWX or AAP: ansible-core, ansible-runner, the collections at the versions the
  newest build settled, Python packages, certificates. It builds on `quay.io/centos/centos:stream9`
  (ansible-builder installs with dnf); Debian package names are listed for a person to translate.
- `ro` on the workspace reads environments, builds and logs; `rw` adds, changes, builds and deletes
  them. An environment a launch configuration uses cannot be deleted.

| Address (under `/api/v1`)                         | Does                                                                      | Who                         |
| ------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------- |
| `GET`, `POST /workspaces/:id/environments`        | A workspace's environments; add one (`kind`: `spec` or `image`)           | `ro`, `rw` on the workspace |
| `GET`, `PATCH`, `DELETE /environments/:id`        | One environment: what runs get now (`current`), what it holds (`catalog`) | `ro`, `rw`                  |
| `GET`, `POST /environments/:id/builds`            | Its builds (state, image, lock, catalog); build now                       | `ro`, `rw`                  |
| `GET /environments/:id/builds/:build/log`         | A build's log                                                             | `ro`                        |
| `GET /environments/:id/execution-environment.yml` | The ansible-builder file                                                  | `ro`                        |

```json
{
  "name": "net-tools",
  "kind": "spec",
  "spec": {
    "ansibleCore": "2.19",
    "collections": [
      { "name": "cisco.ios", "version": "latest" },
      { "name": "ansible.netcommon", "version": ">=8.0.0,<9" }
    ],
    "python": ["netaddr>=1.3"],
    "system": ["iputils-ping"]
  }
}
```

**What a flow needs.** A launch configuration's page compares what its flow needs with what its
environment's image holds: the collections its steps run (a module or role named by its full name;
a step chosen from the designer's module catalog asks for at least the version it was made against)
and the project's `collections/requirements.yml`, which wins. Each collection is in the image at a
fitting version, at another, or missing. **Make an environment for this flow** adds one whose spec
is exactly those needs and builds it. In a spec, the collections are a table of names and versions; **Add a collection** searches
`AFS_GALAXY_URL`, and **Add an empty row** is for typing a name and version (also when the
collection server cannot be reached). The base image and extra certificate authorities are folded
under the packages. **Delete the environment** is the last section of the page.

| Address (under `/api/v1`)                   | Does                                                                   | Who                                |
| ------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------- |
| `GET /launch-configs/:id/environment-check` | The flow's needs against its environment, or another (`?environment=`) | `ro` on the flow                   |
| `POST /launch-configs/:id/environment`      | `{"name"}`: an environment from the flow's needs, built                | `rw` on the flow and the workspace |
| `GET /galaxy/search?q=`                     | Collections on the collection server: newest version, description      | signed in                          |

Not there yet: pushing images to a registry, and rebuilding on a schedule.

### Schedules

A launch configuration also runs by itself: on a cron in a time zone, or once at a set time. Its
page lists its **Schedules** with their next times and how the last fire went; `rw` on the flow
adds, changes, pauses and deletes them, `ro` reads them.

- A run is launched as the schedule's owner (whoever made it; an administrator may hand it to a
  service account). The owner's access is checked every time: gone, disabled, or without
  `operator` on the flow, and the fire is refused and recorded instead.
- It runs the configuration with its own mode and input values if it has them (never a secret:
  those come from credentials), on the newest commit of the configuration's branch, or a pinned
  commit.
- Cron: five fields (`minute hour day month weekday`) or a nickname like `@daily`, at most once a
  minute; the time zone follows summer time. The page shows the next times as you type.
- After downtime: one catch-up run (default), or none. While its last run has not ended: skip
  this fire (default), or queue another.
- Every fire is kept on the schedule (launched, skipped, refused, failed, with why) and in the
  audit log (`schedule.fire`). Runs it launched are marked **scheduled**.

| Address (under `/api/v1`)                        | Does                                                        | Who       |
| ------------------------------------------------ | ----------------------------------------------------------- | --------- |
| `GET /launch-configs/:id/schedules`              | Its schedules, with `upcoming` times and `last` fire        | `ro`      |
| `POST /launch-configs/:id/schedules`             | Add one; the caller owns it                                 | `rw`      |
| `PATCH /launch-configs/:id/schedules/:schedule`  | Change, pause (`enabled: false`); `owner` by administrators | `rw`      |
| `DELETE /launch-configs/:id/schedules/:schedule` | Delete one                                                  | `rw`      |
| `GET /schedule-times?cron=&timezone=`            | The next times a cron fires                                 | signed in |

```json
{
  "name": "Weekdays at three",
  "kind": "cron",
  "cron": "0 3 * * 1-5",
  "timezone": "Europe/Berlin",
  "mode": "check",
  "inputs": { "retries": "5" },
  "missed": "once",
  "overlap": "skip"
}
```

### Dev runs

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

### Approvals

A flow with **approval** steps on its top level runs in segments: the server runs it until hosts
wait at an approval, records what waits and lets the run go (it takes no place among the runs
going and holds no container). Someone allowed decides; the run then goes back to the queue and
continues with the hosts that waited, through the approval's `approved` or `rejected` port. A
server that stops and starts again keeps the run waiting.

- **Who decides:** whoever has the `approve` grant on the flow or its workspace (see
  [Access levels](#access-levels)); when the approval names `approvers` (users or groups, in the
  flow), only they. Administrators may always decide.
- **Not who launched the run**, unless the workspace allows it (Access, on the workspace's page,
  or `PATCH /api/v1/workspaces/<id>` with `{"selfApprove": true}`).
- **A comment** goes with every decision; the run, its page, its canvas and the audit log keep
  who decided, when and why.
- **Timeout:** an approval with `settings.timeout` that nobody decides in time times out: its
  hosts take the approval's `timeout` port (or `rejected` when it has none).
- **A stopped run** asks nobody any more.
- The approval's `message` is shown to whoever decides and sent with the request to decide;
  `notify` names others who are told (see [Notifications](#notifications)).
- Approvals inside subflows, or two that can wait at once, cannot be split: such a flow does not
  launch (the designer says why, `awx-segments`).

Decide on the **Approvals** page (what waits for you, and for others), on the run's page, or on
the canvas (the approval's Run tab), or:

```sh
curl -H "Authorization: Bearer $AFS_TOKEN" -H 'content-type: application/json' \
  https://flows.example.net:8443/api/v1/runs/<id>/approvals/change-approval \
  -d '{"decision":"approved","comment":"Window confirmed with the NOC"}'
```

| Address (under `/api/v1`)        | Does                                                                          | Who                          |
| -------------------------------- | ----------------------------------------------------------------------------- | ---------------------------- |
| `GET /approvals`                 | What waits for a decision that you may see, each with whether you may decide  | signed in                    |
| `GET /runs/:id/approvals`        | A run's approvals: waiting or decided, by whom, when, why; `mayDecide`, `why` | `ro`                         |
| `POST /runs/:id/approvals/:node` | Decide one (`approved` or `rejected`, `comment`); the node by id or key       | `approve`, and the approvers |

### Notifications

The server tells people what concerns them, by email and by webhook:

| When                                         | Who is told                                                                                                           |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| A run waits at an approval                   | Its approvers: those the approval names, else whoever holds `approve` on the flow or workspace; and its `notify` list |
| An approval is approved, rejected, timed out | Who launched the run, and the approval's `notify` list                                                                |
| A run ends                                   | As its launch configuration says: when a run fails (or is lost), or whenever one ends                                 |
| The server certificate nears its end         | The administrators, 30, 14, 7, 3 and 1 days before, and once it has ended; each step once                             |

- **Where:** a person at the email address and webhook their account has; a group at its own,
  or, when it has neither, through each of its members. Disabled accounts are told nothing; an
  address reached two ways is told once. Who launched a run is not asked to approve it unless
  the workspace allows self-approval.
- **Email** goes through the mail server an administrator sets on the **Notifications** page
  (`/admin/notifications`): STARTTLS (587, required), TLS (465), or a relay on the network as it
  allows. Its password is kept encrypted with the master key and never shown.
- **A webhook** gets the event as JSON, with a `text` line that Slack, Mattermost and
  Rocket.Chat incoming webhooks show:

  ```json
  {
    "text": "Firewall upgrade, run 7 (net / edge) waits for a decision at \"Approve the change\". ...",
    "event": "approval.waiting",
    "at": "2026-11-13T10:00:00.000Z",
    "server": "https://flows.example.net",
    "run": {
      "id": "7c1e2a90-...",
      "number": 7,
      "state": "waiting",
      "flow": { "file": "flows/upgrade.flow.yaml", "name": "Firewall upgrade" },
      "project": { "key": "edge" },
      "workspace": { "key": "net" },
      "requestedBy": "dana",
      "link": "https://flows.example.net/runs/7c1e2a90-..."
    },
    "approval": { "node": { "key": "change-approval", "title": "Approve the change" }, "status": "waiting" }
  }
  ```

  Headers: `X-AFS-Event`, `X-AFS-Delivery` (the message's id), `X-AFS-Timestamp`, and, once an
  administrator has made a key (shown once), `X-AFS-Signature: sha256=<hex>`: HMAC-SHA256 of
  `<timestamp>.<body>` with the key. Redirects are not followed.
- **Never in a message:** a run's inputs, a credential, a secret. Links need `AFS_PUBLIC_URL`.
- **Tries again** on a network error, a busy relay or receiver (408, 429, 5xx, SMTP 4xx): after 1,
  5 and 15 minutes, 1 and 3 hours, then it is given up on. A refusal (other 4xx, SMTP 5xx) is
  not tried again. Messages wait in the database: a restart loses none.
- **The delivery log** on the Notifications page lists each message, where it went (a webhook by
  its host only: its path can be its secret), how many tries and why one failed, with **Try
  again**. Messages sent or given up on are kept `AFS_NOTIFICATIONS_KEEP_DAYS` (30).

A launch configuration says whom its runs tell (`notify`, see
[Launch configurations](#launch-configurations)):

```json
{ "notify": { "when": "failed", "to": ["network-oncall", "dana"] } }
```

| Address (under `/api/v1`)         | Does                                                                        | Who                   |
| --------------------------------- | --------------------------------------------------------------------------- | --------------------- |
| `GET /notifications`              | The delivery log (`status`, `event`, `run`, `before`, `limit`)              | administrators        |
| `POST /notifications/:id/retry`   | Try a message given up on again                                             | administrators        |
| `GET /notifications/settings`     | The mail server (never its password), whether webhooks are signed           | administrators        |
| `PUT /notifications/smtp`         | Set the mail server: `host`, `port`, `security`, `user`, `password`, `from` | administrator session |
| `DELETE /notifications/smtp`      | Send no email                                                               | administrator session |
| `POST /notifications/webhook-key` | A new signing key, in this answer only; the old one stops working           | administrator session |
| `POST /notifications/test`        | Send a test now (`channel`, `to`; no `to`: your own address); tried once    | administrators        |

Everyone sets their own email address on **My account** (`/account`, or `PATCH /api/v1/session`
with a session). A webhook is set only by an administrator (the server calls the address it is
given): their own on **My account**, anyone's with `PATCH /api/v1/users/<id>`, a group's with
`PATCH /api/v1/groups/<id>` (`email`, `webhookUrl`).

### Agents (MCP)

Agents such as Claude Code, Codex and Cursor reach the server over MCP (Streamable HTTP) at
`/mcp`, signed in with an [access token](#access-tokens). The agent acts as the token's owner:
it sees and does only what they may, within the token's workspace, and what it changes is in
the audit log with the source `mcp`.

| Tool                                                            | Does                                                                                              |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `flow_list`, `flow_describe`, `flow_validate`, `flow_reference` | The designer's flow tools, read-only, on the projects' flows (`net/edge/flows/upgrade.flow.yaml`) |
| `project_list`                                                  | Workspaces and projects you may see: branch, commit, sync state                                   |
| `launch_config_list`                                            | A project's launch configurations, each with how its last run went (`lastRun`)                    |
| `run_check`                                                     | What a launch would run (commit, inputs, hosts) or what is in its way                             |
| `run_launch`                                                    | Queue a run of a launch configuration (`operator`)                                                |
| `run_status`, `run_output`, `run_list`                          | How a run stands (state, approvals, hosts per step), its output, the runs                         |
| `run_stop`                                                      | Stop a run                                                                                        |
| `approval_list`                                                 | Approvals that wait, and whether you may decide each                                              |
| `approval_decide`                                               | Only with a token made to allow it (below)                                                        |

- **Flows are read-only here:** they change in git (clone the project from the server, edit it
  in VS Code, push). Edit tools come with editing on the server.
- **Approvals stay with people:** `approval_decide` is offered only to a token made with
  "An agent with this token may decide approvals over MCP" (on My account, or
  `"mcpApprovals": true` when making a token), and then only where its owner may decide.
- A launch configuration is named by its id or as `<workspace>/<project>/<name>`.
- `run_list` takes a `project`, a `config` (a launch configuration), `by` (a login) or `mine`
  (the runs the token's owner asked for), and a `state`. When there are more runs, its answer
  has `next`: pass it as `before` for the next page.

Make a token on **My account** (for one workspace, if the agent needs no more), keep it in an
environment variable (`AFS_TOKEN` below), and add the server to the agent:

Claude Code:

```sh
claude mcp add --transport http ansible-flow-server https://flows.example.net:8443/mcp \
  --header "Authorization: Bearer $AFS_TOKEN"
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.ansible-flow-server]
url = "https://flows.example.net:8443/mcp"
bearer_token_env_var = "AFS_TOKEN"
```

Cursor (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "ansible-flow-server": {
      "url": "https://flows.example.net:8443/mcp",
      "headers": { "Authorization": "Bearer ${env:AFS_TOKEN}" }
    }
  }
}
```

With the server's self-signed certificate, the agent's machine must trust it (or use a
certificate from your authority, see [HTTPS and the certificate](#https-and-the-certificate)).
The endpoint is stateless and answers with JSON: any server behind a load balancer answers any
request.

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

## Operations

### Metrics

Set `AFS_METRICS_TOKEN` (`openssl rand -hex 24`), and Prometheus reads `/metrics` with it:

```yaml
scrape_configs:
  - job_name: ansible-flow-server
    scheme: https
    tls_config: { ca_file: /etc/prometheus/flows-ca.pem }
    authorization: { credentials_file: /etc/prometheus/afs-metrics-token }
    static_configs: [{ targets: ["flows.example.net:8443"] }]
```

| Metric                                                   | What                                                                   |
| -------------------------------------------------------- | ---------------------------------------------------------------------- |
| `afs_runs{state}`                                        | Runs kept, by state (`queued`, `running`, `waiting` are going)         |
| `afs_queue_depth`                                        | Runs waiting for a worker                                              |
| `afs_run_duration_seconds{mode,outcome}`                 | How long runs took, start to end (histogram)                           |
| `afs_approvals_waiting`                                  | Approval gates waiting for a decision                                  |
| `afs_notifications{status}`                              | The delivery log: `pending`, `sent`, `failed` (given up after retries) |
| `afs_environment_builds_going`                           | Execution environment builds queued or building                        |
| `afs_environment_build_duration_seconds{outcome}`        | How long builds took (histogram)                                       |
| `afs_certificate_expiry_seconds`                         | Until the server's certificate ends                                    |
| `afs_http_request_duration_seconds{method,route,status}` | Requests answered, by route pattern and status class                   |
| `afs_info{version,designer}`                             | The server's and the designer's versions                               |
| `afs_process_*`, `afs_nodejs_*`                          | The process: memory, CPU, event loop, garbage collection               |

Without the token set, `/metrics` answers 404; with a wrong one, 401. No label holds a name someone
typed (a flow, a host): only states, outcomes and route patterns.

### Health checks

`/healthz` answers while the process is up (liveness). `/readyz` says whether the server can do its
work (readiness), check by check; why a check failed is in the log, not in the answer:

```json
{
  "status": "degraded",
  "database": "postgres",
  "checks": {
    "database": { "state": "ok" },
    "data": { "state": "ok", "freeBytes": 52613349376 },
    "engine": { "state": "warn", "engine": "none" }
  }
}
```

| `status`      | When                                                                        | HTTP |
| ------------- | --------------------------------------------------------------------------- | ---- |
| `ready`       | Everything answers                                                          | 200  |
| `degraded`    | It serves, but no container engine answers (runs wait) or disk space is low | 200  |
| `unavailable` | The database does not answer, or the data folder cannot be written          | 503  |

### Backup and restore

```sh
# while the server runs
node dist/server.js backup /srv/backups/flows-2026-11-14.tar.gz
docker compose exec server node dist/server.js backup /var/lib/afs/backup.tar.gz   # then docker compose cp
sudo -u afs /usr/local/bin/ansible-flow-server backup /var/lib/ansible-flow-server/backup.tar.gz
```

```text
Backup written: /srv/backups/flows-2026-11-14.tar.gz
  postgres database, 18342 rows in 21 tables; folders: repos, tls, output, runs, environments
  The master key (3fa1c2d4) is not in it: keep a copy of the key apart; without it the credentials cannot be read after a restore.
```

- **What is in it:** every table of the database, read in one transaction; the repositories
  (hosted and mirrors), the certificate and its history, runs' output and their designer folders,
  execution environment build logs. Not in it: checkouts, the probe and temporary secrets (made
  again), and the master key unless `--with-key` (then the file is as secret as every credential
  it opens).
- **Any database to any database:** the rows are the server's own export, so a SQLite backup
  restores into PostgreSQL and back. A backup of an older server restores into a newer one (its
  database changes are made after the rows are in); a newer one is refused.
- **Restore** with the server stopped, into a new data folder, with the same master key in place
  (`master.key`, `AFS_MASTER_KEY` or `AFS_MASTER_KEY_FILE`); the restore refuses a different one and
  names the key it needs:

  ```sh
  node dist/server.js restore /srv/backups/flows-2026-11-14.tar.gz
  docker compose run --rm -v ./flows.tar.gz:/b.tar.gz server restore /b.tar.gz
  ```

  A database or data folder that has data is refused; `--force` drops the database's tables and
  replaces the folders. Both commands are in the audit log.

### Upgrade

1. Take a backup (above), and keep the master key apart.
2. Install the new version: `AFS_VERSION=<new>` then `docker compose pull && docker compose up -d`;
   or the new bundle's `sudo ./install.sh` (it keeps the settings, the data and three releases).
3. The server changes its database at start, forward only; `changes=` in its first log line says
   how many. `/readyz` says when it is ready.
4. Going back: the previous version cannot read a changed database. Stop the server, restore the
   backup into a new data folder (and database) with the previous version, start that version.

## Development

| Command                    | Does                                                                                                                             |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `just install`             | Install exact dependencies from `package-lock.json`                                                                              |
| `just afd-packages`        | Try an unreleased designer: pack its packages and install them from `vendor/`                                                    |
| `just check`               | Type-check (TypeScript) and lint and format check (Biome)                                                                        |
| `just fmt`                 | Apply formatting and safe lint fixes                                                                                             |
| `just test [args]`         | Unit tests (Vitest; the pages in jsdom); with `AFS_TEST_POSTGRES_URL` set, the database tests also run on PostgreSQL             |
| `just build`               | Build the server and the web pages into `dist/`                                                                                  |
| `just web-dev`             | The pages with live reload (port 5180), against a server on port 8080 (`AFS_DEV_SERVER` to change)                               |
| `just start`               | Build, then start the server                                                                                                     |
| `just check-flows <files>` | Build, then read the given flow files                                                                                            |
| `just cert <command>`      | Build, then run a certificate command                                                                                            |
| `just user <command>`      | Build, then run a user command                                                                                                   |
| `just secrets <command>`   | Build, then run a secrets command                                                                                                |
| `just e2e <suite>`         | End-to-end suites (`image`, `lab`, `browser`, `down`): the image in docker compose, flows on lab hosts; see `test/e2e/README.md` |

Layout:

| Path           | Holds                                                           |
| -------------- | --------------------------------------------------------------- |
| `src/server/`  | The server (Node.js)                                            |
| `src/web/`     | The web pages (React, built by Vite into `dist/web`)            |
| `test/web/`    | Tests of the web pages                                          |
| `test/unit/`   | Unit tests; `test/fixtures/` has sample flows from the designer |
| `test/e2e/`    | End-to-end suites: docker compose, a GNS3 lab, a browser        |
| `scripts/`     | Build and package scripts                                       |
| `CHANGELOG.md` | What changed, for people who use the server                     |
| `docs/adr/`    | Architecture decisions, one file each                           |
| `media/icons/` | The icon set                                                    |
| `vendor/`      | An unreleased designer's packages as tarballs (not in git)      |

## License

MIT, see [LICENSE](LICENSE).
