# Configuration

[The guide](README.md)

Settings are read from the environment, and from a `.env` file beside the server (the environment
wins). Copy [.env.example](../../.env.example) to `.env`. A wrong setting stops the start and every
problem is named.

| Setting                       | Default                                              | Meaning                                                                                                              |
| ----------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `AFS_HOST`                    | `127.0.0.1`                                          | The address to listen on; `0.0.0.0` for every interface                                                              |
| `AFS_PORT`                    | `8443`                                               | The port (`8080` with `AFS_TLS=off`)                                                                                 |
| `AFS_PUBLIC_URL`              | none                                                 | The address people open, like `https://flows.example.net`                                                            |
| `AFS_RUN_URL`                 | `AFS_PUBLIC_URL`                                     | The address runs reach the server at, for the Ansible collection in them (see [Ansible collection](collection.md))   |
| `AFS_RUN_VERIFY_TLS`          | unless self-signed                                   | `true` or `false`: runs check the server's certificate                                                               |
| `AFS_HTTP_PORT`               | none                                                 | A port that redirects plain HTTP to HTTPS                                                                            |
| `AFS_TLS`                     | `on`                                                 | `off` behind a proxy that does HTTPS                                                                                 |
| `AFS_TRUSTED_PROXIES`         | none                                                 | With `AFS_TLS=off`: proxies whose word is taken for who asked                                                        |
| `AFS_CA_FILE`                 | none                                                 | Certificate authorities of your network, for outgoing connections                                                    |
| `AFS_MASTER_KEY_FILE`         | `<data>/master.key`, made at first start             | The file with the master key that stored credentials are encrypted with                                              |
| `AFS_MASTER_KEY`              | none                                                 | The master key itself (base64 of 32 bytes), instead of a file                                                        |
| `AFS_MAX_RUNS`                | `4`                                                  | Runs at once on this server                                                                                          |
| `AFS_MAX_RUNS_PER_PROJECT`    | `1`                                                  | Runs at once of one project                                                                                          |
| `AFS_CONTAINER_ENGINE`        | `auto`                                               | The container engine runs use: `auto`, `docker`, `podman`, or `off`                                                  |
| `AFS_METRICS_TOKEN`           | unset: no metrics                                    | The bearer token `/metrics` asks for, 16 characters or more                                                          |
| `AFS_MIN_FREE_MB`             | `1024`                                               | Below this much free space in the data folder, `/readyz` says degraded                                               |
| `AFS_ENGINE_DATA_DIR`         | found from the server's own container                | The server in a container: its data folder as the engine's machine has it                                            |
| `AFS_EE_IMAGE`                | `ghcr.io/ansible/community-ansible-dev-tools:latest` | The server's default image: what a run uses unless its launch names one, until an administrator picks an environment |
| `AFS_RUN_TIMEOUT_MINUTES`     | `240`                                                | A run that takes longer is stopped                                                                                   |
| `AFS_RUNS_KEEP_DAYS`          | `90`                                                 | Ended runs older than this are removed, with their output                                                            |
| `AFS_RUNS_KEEP_PER_FLOW`      | `200`                                                | Of one flow in one project, at most this many ended runs are kept                                                    |
| `AFS_AUDIT_KEEP_DAYS`         | `365`                                                | Audit entries older than this are removed; `0` keeps them all                                                        |
| `AFS_NOTIFICATIONS_KEEP_DAYS` | `30`                                                 | Notifications sent or given up on are kept this many days                                                            |
| `AFS_DEV_BUNDLE_MAX_MB`       | `50`                                                 | The largest bundle of unpushed work a dev run takes                                                                  |
| `AFS_DEV_KEEP_HOURS`          | `24`                                                 | How long the server keeps a dev run's work                                                                           |
| `AFS_ARCHIVE_MAX_MB`          | `50`                                                 | The most an archive a hosted project starts from may unpack to                                                       |
| `AFS_GALAXY_URL`              | `https://galaxy.ansible.com`                         | Where environment builds look up collection versions (Galaxy, an Automation Hub, a private Galaxy)                   |
| `AFS_BUILD_TIMEOUT_MINUTES`   | `60`                                                 | How long an environment build may take                                                                               |
| `AFS_GIT_LOCAL`               | `off`                                                | `on`: a project's repository may be a folder of this machine                                                         |
| `AFS_DATA_DIR`                | `data`                                               | Where the server keeps what it owns                                                                                  |
| `AFS_DATABASE_URL`            | `sqlite:afs.db`                                      | `sqlite:<file>` (in the data folder unless absolute) or `postgres://…`                                               |
| `AFS_LOG_LEVEL`               | `info`                                               | `trace`, `debug`, `info`, `warn`, `error`, `fatal` or `silent`                                                       |
| `AFS_LOG_FORMAT`              | `text`                                               | `text`, or `json` for one object a line                                                                              |
| `AFS_ENV_FILE`                | `.env`                                               | Another file to read the settings from                                                                               |

With PostgreSQL:

```sh
AFS_DATABASE_URL=postgres://flows:CHANGE_ME@db.example.net:5432/flows just start
```
