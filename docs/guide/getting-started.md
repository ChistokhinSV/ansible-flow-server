# Start the server

[The guide](README.md)

## Use

Start the server:

```sh
just start
```

```text
[09:44:37 13.11.2026] INFO  Ansible Flow Server starts version=1.0.0 designer=1.0.0
[09:44:37 13.11.2026] INFO  Database ready kind=sqlite where=/srv/flow-server/data/afs.db changes=1
[09:44:37 13.11.2026] INFO  Server certificate subject="CN=127.0.0.1" names=127.0.0.1,localhost expires=2027-11-13T08:44:37.000Z source=self-signed
[09:44:37 13.11.2026] INFO  Server listening at https://127.0.0.1:8443
```

Open the address in a browser for the pages (see [The web pages](web-pages.md)).

| Address        | Answers                                                                                                                    |
| -------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `/healthz`     | `{"status":"ok"}` while the process is up                                                                                  |
| `/readyz`      | Ready, degraded or unavailable (503), check by check (see [Operations](operations.md))                                     |
| `/metrics`     | Prometheus metrics, with `AFS_METRICS_TOKEN` as a bearer token (see [Operations](operations.md))                           |
| `/api/v1/meta` | What the server is and what a client may rely on (see [Compatibility with the designer](#compatibility-with-the-designer)) |

```sh
curl --insecure https://127.0.0.1:8443/api/v1/meta
```

```json
{
  "name": "Ansible Flow Server",
  "version": "1.0.0",
  "designer": { "version": "1.0.0", "format": 2, "formats": [1, 2], "bundle": "1.0.0" },
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

### Compatibility with the designer

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
Ansible Flow Server 1.0.0, built on Ansible Flow Designer 1.0.0; reads flows up to format 2
test/fixtures/hello.flow.yaml: Hello, Ansible (hello v1, format 2), 3 steps, 0 errors, 0 warnings
test/fixtures/firewall-upgrade.flow.yaml: Firewall firmware upgrade (firewall-upgrade v1, format 2), 18 steps, 0 errors, 0 warnings
```

It exits with 1 when a file is not a flow this server can read.
