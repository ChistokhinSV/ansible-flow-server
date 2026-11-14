# ADR-0030: Operations: metrics, readiness, backup and restore

- Status: accepted (2026-11-14, AFS-37)
- Builds on: ADR-0005 (databases), ADR-0013 (the master key), ADR-0028, ADR-0029 (installs)

## Decision

- **`/metrics` for Prometheus**, with `@prometheus-io/client` (prom-client's successor), behind
  one setting, `AFS_METRICS_TOKEN`, sent as a bearer token (Prometheus's own `authorization`
  config); unset, it answers 404. No second port, no person's token (a scrape is not a person).
  What is in the database (runs by state, queue depth, approvals waiting, deliveries by status,
  builds going) is counted at each scrape, so several servers on one database say the same; how
  long runs and builds took is observed when each ends; requests by route pattern and status class.
  No label carries what someone typed.
- **`/readyz` check by check:** unavailable (503) when nothing can be kept (database, data folder
  not writable); degraded (200) when the server serves but something waits (no engine, little disk
  space, `AFS_MIN_FREE_MB`). A balancer keeps sending pages and the API to a degraded server.
- **Backup is the server's own export:** one `.tar.gz` with every table as JSON lines, read in one
  transaction (PostgreSQL: repeatable read), a manifest (server version, database kind, the
  database changes the rows are of, rows per table, the master key's fingerprint), and the data
  folders that cannot be made again (repositories, certificate, run output and folders, build
  logs). It is taken while the server runs: rows first, then files, which only grow.
- **The master key is not in a backup** unless `--with-key`: an archive that holds both the
  sealed secrets and their key is every credential at once. A restore checks the key in place
  against the backup's fingerprint and names the one it needs.
- **Restore** into an empty database (a database with only a fresh server's settings counts as
  empty) and a data folder without the backup's folders; `--force` drops the tables and replaces
  the folders. The database is made at the backup's schema (Kysely `migrateTo`), the rows are
  loaded in reference order in one transaction, then this server's changes are made. A backup
  with a change this server does not know is refused.

## Consequences

- SQLite to PostgreSQL (and back) is a backup and a restore.
- Only text and integer columns are used, with text ids and no sequences (and that stays so):
  rows move between databases as they are.
- A very large audit log makes the export slower (pages of 1,000 rows); it stays one transaction.

## Alternatives considered

- **Native dumps** (`VACUUM INTO`, `pg_dump`): faster, but `pg_dump` must be installed and match
  the server's version, and a restore only goes back into the same kind.
- **Metrics on a separate unauthenticated port:** simple for a sidecar, but one more port to
  open and keep local.
