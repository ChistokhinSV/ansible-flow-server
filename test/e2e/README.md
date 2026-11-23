# End-to-end suites

Two suites run the server as a user would: built into its image, started with docker compose,
running flows against real hosts.

- **Lab suite** (`lab.test.ts`, Vitest). Each run starts the stack fresh, then sets up people, a
  workspace, a project and launch configurations, and checks:
  - **Routing:** each host goes its own way through a flow. Web hosts take one path, the others
    another, and a host that does not answer takes a third.
  - **Approvals:** a run waits for a group. Its webhook is called, and only its members may
    decide (not the launcher, not a reader). The decision and the refused attempts are in the
    audit log.
  - **Rejection:** a rejected approval sends the hosts to the rejected end.
  - **Email:** a run-ended email is caught by Mailpit.
  - **Schedules:** a schedule launches a run by itself.
  - **MCP:** an agent launches and follows a run over MCP with a token.
  - **Execution environments:** one is built from a collection list, and a flow runs in it.
- **Browser smoke test** (`browser/smoke.spec.ts`, Playwright). One person signs in, opens a flow
  on the canvas and launches it. Another approves it from their approvals. The run goes well and
  shows in the run history.

Neither suite runs in CI or with `just test`: they need Docker and the lab.

## What they need

- Docker with Compose v2. The server reaches the engine through its socket and starts runs as
  sibling containers.
- The GNS3 project `afs-e2e`, reachable from Docker containers:

  | Host     | Address         | Notes                                       |
  | -------- | --------------- | ------------------------------------------- |
  | web-01   | 192.168.200.231 |                                             |
  | web-02   | 192.168.200.232 |                                             |
  | db-01    | 192.168.200.233 |                                             |
  | db-02    | 192.168.200.234 |                                             |
  | ghost-01 | 192.168.200.239 | Must not answer: it is the unreachable host |

  The hosts run Alpine Linux with Python 3. Root signs in over SSH with a test key. In the lab
  the hosts sit on the GNS3 VM's host-only network (VMnet1), which Docker Desktop reaches
  through Windows. The addresses are in `repo/inventory.ini`; change them there for another lab.
- `AFS_E2E_LAB_KEY`: the path of the private key the hosts accept for root.
- The run image: `afd-ee:2.19` by default, or set `AFS_E2E_EE_IMAGE`. It must have
  ansible-core and openssh-client.

## Run them

```bash
just e2e image                 # build the server's image from this checkout
AFS_E2E_LAB_KEY=~/.ssh/afs-e2e just e2e lab
AFS_E2E_LAB_KEY=~/.ssh/afs-e2e just e2e browser
just e2e down                  # stop the stack and remove its data
```

- `AFS_E2E_EE=0` skips building the execution environment, which takes several minutes and
  downloads packages.
- The browser suite uses the stack the lab suite left, or makes a fresh one.
- The setup the suites made is kept in `afs-e2e-world.json` in the temporary folder. It holds
  generated test passwords and ids.

### Ports

| Variable               | Default | What                |
| ---------------------- | ------- | ------------------- |
| `AFS_E2E_PORT`         | 18443   | The server          |
| `AFS_E2E_MAIL_PORT`    | 18025   | Mailpit             |
| `AFS_E2E_CATCHER_PORT` | 18090   | The webhook catcher |

## Secret providers (AFS-242)

`secretProviders.test.ts` reads from real secret providers with the server's own clients:
HashiCorp Vault 2.2.2 (TLS, AppRole and a token), CyberArk Conjur OSS 1.27.0, LocalStack 4.14.0
(AWS Secrets Manager) and a CyberArk CCP mock with client certificates. The containers run on the
GNS3 VM (`~/spike-s9`, started with its `start.sh`; ports 18200, 18080, 14566 and 18443 on
192.168.200.128). Fictional secrets only. Skipped unless `AFS_SECRETS_LAB` names a folder with
the lab's values: `vault-ca.pem`, `vault-role-id`, `vault-secret-id`, `vault-token`,
`conjur-host-key` (from `~/spike-s9/out`), and `ccp-ca.pem`, `ccp-client.pem`, `ccp-client.key`
(the CCP mock's CA and a client certificate it trusts). `AFS_SECRETS_LAB_HOST` changes the
address.

```bash
AFS_SECRETS_LAB=/path/to/lab-values npx vitest run test/e2e/secretProviders.test.ts
```

A machine whose HTTPS is intercepted (an antivirus that re-signs every connection) cannot reach
Vault and CCP. Run it from a container on the VM instead, which bundles the test with esbuild
(node:test in place of Vitest) and takes the lab's values from `~/spike-s9/out`:

```bash
AFS_SECRETS_LAB_CERTS=/path/to/ccp-certs node test/e2e/secrets/on-vm.mjs
```

## What is where

- `stack/`: the compose file and the webhook catcher.
- `repo/`: what the hosted project holds (two flows, the inventory, `ansible.cfg`).
- `lib/`: the API client and the setup the suites share.
