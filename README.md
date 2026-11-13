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

**Early development: there is nothing to deploy yet.** The repository has its toolchain, the
designer's packages wired in, and the first code that reads and checks flow files. The plan and
its tickets are in YouTrack project AFS; the decisions are in [docs/adr](docs/adr).

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

```sh
just start test/fixtures/hello.flow.yaml test/fixtures/firewall-upgrade.flow.yaml
```

```text
Ansible Flow Server 0.1.0
Built on Ansible Flow Designer 0.85.0; reads flows up to format 2
Ansible probe: /srv/flow-server/node_modules/@ansible-flow/assets/probe
test/fixtures/hello.flow.yaml: Hello, Ansible (hello v1, format 2), 3 steps, 0 errors, 0 warnings
test/fixtures/firewall-upgrade.flow.yaml: Firewall firmware upgrade (firewall-upgrade v1, format 2), 18 steps, 0 errors, 0 warnings
```

The command reads each flow file with the designer's parser and validator and says what it found.
It exits with 1 when a file is not a flow this server can read. That is all the server does today.

## Configuration

None yet. Settings (the listening address, the data folder, the database, the secrets key) arrive
with the HTTP server and will be read from the environment or a `.env` file, never from the
repository.

## Development

| Command              | Does                                                         |
| -------------------- | ------------------------------------------------------------ |
| `just afd-packages`  | Pack the designer's packages and install them from `vendor/` |
| `just install`       | Install exact dependencies from `package-lock.json`          |
| `just check`         | Type-check (TypeScript) and lint and format check (Biome)    |
| `just fmt`           | Apply formatting and safe lint fixes                         |
| `just test [args]`   | Unit tests (Vitest)                                          |
| `just build`         | Build the server into `dist/`                                |
| `just start [flows]` | Build, then read the given flow files                        |

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
