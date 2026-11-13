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
(SQLite or PostgreSQL), speaks HTTPS with a certificate you can request and replace, answers
health checks and says what it is; it can read and check flow files. It does not run flows yet. The plan and its tickets are in YouTrack project AFS; the
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

| Setting               | Default         | Meaning                                                                |
| --------------------- | --------------- | ---------------------------------------------------------------------- |
| `AFS_HOST`            | `127.0.0.1`     | The address to listen on; `0.0.0.0` for every interface                |
| `AFS_PORT`            | `8443`          | The port (`8080` with `AFS_TLS=off`)                                   |
| `AFS_PUBLIC_URL`      | none            | The address people open, like `https://flows.example.net`              |
| `AFS_HTTP_PORT`       | none            | A port that redirects plain HTTP to HTTPS                              |
| `AFS_TLS`             | `on`            | `off` behind a proxy that does HTTPS                                   |
| `AFS_TRUSTED_PROXIES` | none            | With `AFS_TLS=off`: proxies whose word is taken for who asked          |
| `AFS_CA_FILE`         | none            | Certificate authorities of your network, for outgoing connections      |
| `AFS_DATA_DIR`        | `data`          | Where the server keeps what it owns                                    |
| `AFS_DATABASE_URL`    | `sqlite:afs.db` | `sqlite:<file>` (in the data folder unless absolute) or `postgres://…` |
| `AFS_LOG_LEVEL`       | `info`          | `trace`, `debug`, `info`, `warn`, `error`, `fatal` or `silent`         |
| `AFS_LOG_FORMAT`      | `text`          | `text`, or `json` for one object a line                                |
| `AFS_ENV_FILE`        | `.env`          | Another file to read the settings from                                 |

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

## Development

| Command                    | Does                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------ |
| `just afd-packages`        | Pack the designer's packages and install them from `vendor/`                                     |
| `just install`             | Install exact dependencies from `package-lock.json`                                              |
| `just check`               | Type-check (TypeScript) and lint and format check (Biome)                                        |
| `just fmt`                 | Apply formatting and safe lint fixes                                                             |
| `just test [args]`         | Unit tests (Vitest); with `AFS_TEST_POSTGRES_URL` set, the database tests also run on PostgreSQL |
| `just build`               | Build the server into `dist/`                                                                    |
| `just start`               | Build, then start the server                                                                     |
| `just check-flows <files>` | Build, then read the given flow files                                                            |
| `just cert <command>`      | Build, then run a certificate command                                                            |

Layout:

| Path           | Holds                                                           |
| -------------- | --------------------------------------------------------------- |
| `src/server/`  | The server (Node.js)                                            |
| `test/unit/`   | Unit tests; `test/fixtures/` has sample flows from the designer |
| `scripts/`     | Build and package scripts                                       |
| `docs/adr/`    | Architecture decisions, one file each                           |
| `media/icons/` | The icon set                                                    |
| `vendor/`      | The designer's packages as tarballs (not in git)                |

## License

MIT, see [LICENSE](LICENSE).
