# Configuration

[The guide](README.md)

Settings are read from environment variables and `.env` (environment variables win). Copy
[.env.example](../../.env.example) to `.env`. Invalid settings halt startup with every problem
named.

| Setting                        | Default                                              | Meaning                                                                                           |
| ------------------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `AFS_HOST`                     | `127.0.0.1`                                          | Listen address (`0.0.0.0` for all interfaces)                                                     |
| `AFS_PORT`                     | `8443`                                               | Listen port (`8080` when `AFS_TLS=off` unless `AFS_PORT` is set explicitly, as in `compose.yaml`) |
| `AFS_PUBLIC_URL`               | none                                                 | External URL users open, e.g. `https://flows.example.com:8443`                                    |
| `AFS_RUN_URL`                  | `AFS_PUBLIC_URL`                                     | Server URL passed to runs for the built-in [Ansible collection](collection.md)                    |
| `AFS_RUN_VERIFY_TLS`           | unless self-signed                                   | `true` or `false`: whether runs verify the server's TLS certificate                               |
| `AFS_HTTP_PORT`                | none                                                 | Optional plain-HTTP port that redirects to HTTPS                                                  |
| `AFS_TLS`                      | `on`                                                 | `off` when TLS is terminated by a trusted reverse proxy                                           |
| `AFS_TRUSTED_PROXIES`          | none                                                 | Trusted proxy IPs/CIDRs when `AFS_TLS=off`                                                        |
| `AFS_CA_FILE`                  | none                                                 | Custom CA bundle (PEM) for outgoing Git, OIDC, LDAP and webhook connections                       |
| `AFS_MASTER_KEY_FILE`          | `<data>/master.key`                                  | Path to the 32-byte master key file (created on first startup if unset)                           |
| `AFS_MASTER_KEY`               | none                                                 | Base64-encoded 32-byte master key (`openssl rand -base64 32`) instead of a file                   |
| `AFS_DATA_DIR`                 | `data`                                               | Directory holding SQLite, repositories, run outputs, TLS and environments                         |
| `AFS_DATABASE_URL`             | `sqlite:afs.db`                                      | `sqlite:<file>` or `postgres://user:pass@host:5432/db`                                            |
| `AFS_CONTAINER_ENGINE`         | `auto`                                               | Container engine for runs: `auto`, `docker`, `podman`, or `off`                                   |
| `AFS_ENGINE_DATA_DIR`          | auto-detected                                        | Host path of `AFS_DATA_DIR` when running the server inside a container                            |
| `AFS_EE_IMAGE`                 | `ghcr.io/ansible/community-ansible-dev-tools:latest` | Fallback execution environment image until an admin sets a default environment                    |
| `AFS_GALAXY_URL`               | `https://galaxy.ansible.com`                         | Galaxy / Automation Hub URL used when building environments                                       |
| `AFS_BUILD_TIMEOUT_MINUTES`    | `60`                                                 | Maximum duration of an execution environment build                                                |
| `AFS_MAX_RUNS`                 | `4`                                                  | Maximum concurrent runs across the server                                                         |
| `AFS_MAX_RUNS_PER_PROJECT`     | `1`                                                  | Maximum concurrent runs per project                                                               |
| `AFS_RUN_TIMEOUT_MINUTES`      | `240`                                                | Maximum duration of a run before automatic cancellation                                           |
| `AFS_RUN_STEP_TIMEOUT_MINUTES` | `60`                                                 | Maximum idle time at a step-by-step or debug pause (`1`–`1440`)                                   |
| `AFS_RUN_RECORD_INPUTS`        | `true`                                               | Record non-secret per-host step input values (`256` KB max per run; `false` disables recording)   |
| `AFS_RUNS_KEEP_DAYS`           | `90`                                                 | Retention period in days for ended runs and outputs                                               |
| `AFS_RUNS_KEEP_PER_FLOW`       | `200`                                                | Maximum ended runs kept per flow                                                                  |
| `AFS_AUDIT_KEEP_DAYS`          | `365`                                                | Audit log retention in days (`0` keeps forever)                                                   |
| `AFS_NOTIFICATIONS_KEEP_DAYS`  | `30`                                                 | Notification delivery log retention in days                                                       |
| `AFS_DEV_BUNDLE_MAX_MB`        | `50`                                                 | Maximum size of a VS Code [dev run](runs.md#dev-runs) Git bundle                                  |
| `AFS_DEV_KEEP_HOURS`           | `24`                                                 | Retention hours for uploaded dev run bundles                                                      |
| `AFS_ARCHIVE_MAX_MB`           | `50`                                                 | Maximum unpacked size of a project archive upload                                                 |
| `AFS_GIT_LOCAL`                | `off`                                                | `on` allows local filesystem paths as external Git sources                                        |
| `AFS_METRICS_TOKEN`            | unset (disabled)                                     | Bearer token (`16+` chars) enabling Prometheus `/metrics`                                         |
| `AFS_MIN_FREE_MB`              | `1024`                                               | Free disk threshold in `AFS_DATA_DIR` below which `/readyz` reports `degraded`                    |
| `AFS_LOG_LEVEL`                | `info`                                               | `trace`, `debug`, `info`, `warn`, `error`, `fatal` or `silent`                                    |
| `AFS_LOG_FORMAT`               | `text`                                               | `text` or `json`                                                                                  |
| `AFS_ENV_FILE`                 | `.env`                                               | Alternate env file path                                                                           |

Settings changed at runtime through the web UI or REST API are documented in the
[API reference](/docs/api), which lists every call and who may make it.
