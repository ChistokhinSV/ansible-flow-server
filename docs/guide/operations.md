# Operations

[The guide](README.md)

## Metrics

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
| `afs_stream_backlog{sink,type}`                          | Event streaming: rows waiting to go, per destination                   |
| `afs_stream_oldest_pending_seconds{sink,type}`           | Event streaming: age of the oldest row waiting                         |
| `afs_stream_dropped_total{sink,type}`                    | Event streaming: rows dropped over the backlog's bounds, or refused    |
| `afs_stream_last_success_timestamp_seconds{sink,type}`   | Event streaming: when the destination last took something (0: never)   |
| `afs_http_request_duration_seconds{method,route,status}` | Requests answered, by route pattern and status class                   |
| `afs_info{version,designer}`                             | The server's and the designer's versions                               |
| `afs_process_*`, `afs_nodejs_*`                          | The process: memory, CPU, event loop, garbage collection               |

Without the token set, `/metrics` answers 404; with a wrong one, 401. No label holds a name someone
typed (a flow, a host): only states, outcomes, route patterns and the ids of event streaming
destinations.

## Health checks

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

## Backup and restore

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

## Upgrade

1. Take a backup (above), and keep the master key apart.
2. Install the new version: `AFS_VERSION=<new>` then `docker compose pull && docker compose up -d`;
   or the new bundle's `sudo ./install.sh` (it keeps the settings, the data and three releases).
3. The server changes its database at start, forward only; `changes=` in its first log line says
   how many. `/readyz` says when it is ready.
4. Going back: the previous version cannot read a changed database. Stop the server, restore the
   backup into a new data folder (and database) with the previous version, start that version.
