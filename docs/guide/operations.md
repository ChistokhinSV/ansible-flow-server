# Operations

[The guide](README.md)

## Health checks and metrics

- **`GET /healthz`**: returns `200 {"status":"ok"}` while the process is alive.
- **`GET /readyz`**: checks database connectivity, writable `AFS_DATA_DIR`, free disk space
  (`AFS_MIN_FREE_MB`) and container engine availability — returning `200` (`ready`, or `degraded`
  when no container engine answers or disk space is low) or `503` (`unavailable` when the database
  or data directory fails).
- **`GET /metrics`**: set `AFS_METRICS_TOKEN` (`openssl rand -hex 24`) to expose Prometheus metrics
  with `Authorization: Bearer <token>` (`404` when unset, `401` on wrong token) — covering runs by
  state (`afs_runs`), queue depth, run and EE build duration histograms, waiting approvals,
  notification deliveries, event stream backlogs, certificate expiry
  (`afs_certificate_expiry_seconds`), HTTP latency and Node.js process stats. Metric labels never
  include user-typed flow or host names.

## Backup and restore

Create a consistent online backup while the server is running:

```sh
# Docker Compose (then copy out with docker compose cp)
docker compose exec server node dist/server.js backup /var/lib/afs/backup.tar.gz
# Linux systemd service
sudo -u afs /usr/local/bin/ansible-flow-server backup /var/lib/ansible-flow-server/backup.tar.gz
```

- **Included**: a single-transaction export of all database tables (portable between SQLite and
  PostgreSQL), Git repositories, TLS certificates and history, run outputs/views and EE build logs.
- **Master key**: omitted by default so backups do not carry your encryption key — store
  `master.key` (or `AFS_MASTER_KEY`) separately, or pass `--with-key` and protect the archive like a
  secret.
- **Restore**: stop the server and restore into an empty data directory and database (`--force`
  overwrites existing data) with the matching master key in place (mismatched keys or backups from a
  newer server version are refused):

```sh
docker compose run --rm -v ./backup.tar.gz:/b.tar.gz server restore /b.tar.gz
```

## Upgrades and rollback

1. Take a backup and verify your master key copy is stored safely outside the container/folder.
2. Upgrade the server:
   - **Docker Compose**: set `AFS_VERSION=<version>` **in `.env`**, then run
     `docker compose pull && docker compose up -d` (do not pass `AFS_VERSION=…` only on the first
     command: `up -d` reads `.env` and would keep the previous version).
   - **Linux service**: unpack the new release bundle and run `sudo ./install.sh`.
3. Forward-only database migrations run automatically on startup (`changes=` in the startup log);
   check `/readyz`.
4. **Rollback**: because database migrations are forward-only, stop the server, restore your
   pre-upgrade backup into a clean data folder/database, and start the previous version.

The [API reference](/docs/api) lists every operational and administrative endpoint and who may call
it.
