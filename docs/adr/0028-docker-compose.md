# ADR-0028: The server as a container, with docker compose

- Status: accepted (2026-11-14, AFS-35)
- Builds on: ADR-0016 (the executor), ADR-0005 (databases)

## Context

The first install is a container: one compose file, SQLite by default, PostgreSQL when wanted.
The server starts runs, inventory probes and environment builds in containers through the
engine's socket, so those containers are siblings of the server's, and the engine mounts paths
of its own machine. ADR-0016 asked for the data folder at the same path inside and outside: a
named volume could not be used, and a wrong path silently gave runs empty folders.

## Decision

- **One image, published for each release** (tags `v1.2.3`): `ghcr.io/chistokhinsv/ansible-flow-server`
  and Docker Hub's `chistokhinsv/ansible-flow-server`, amd64 and arm64, tagged `1.2.3`, `1.2`,
  `1` and `latest`, with provenance and an SBOM. Built by `.github/workflows/image.yml`, which
  waits, like CI, until the designer's packages are on npm (vendor/ is not in git).
- **The image:** Node 24 on Debian 13 (slim), git, openssh-client, the docker CLI and buildx from
  Docker's own repository. The server listens on all interfaces at 8443, keeps its data in the
  volume `/var/lib/afs`, runs as root (the engine's socket is root's; run folders are given to
  each image's user, ADR-0016), and checks itself with `/healthz`.
- **Paths as the engine has them:** at start the server finds its own container (its id from
  `/proc/self/mountinfo`), asks the engine for its mounts, and rewrites the source of every `-v`
  and `--mount` it hands to run and probe containers from its path to the engine's. A named
  volume works, and so does a bind mount at another path. `AFS_ENGINE_DATA_DIR` says it when the
  server cannot find out (another engine, a socket proxy that hides `inspect`). Not in a
  container, nothing changes.
- **Compose:** `deploy/compose/compose.yaml` with the server, the `afs-data` volume and the
  socket (`AFS_ENGINE_SOCKET`), and PostgreSQL 18 under the `postgres` profile with its own
  volume and health check; the server waits for it when it is there. `.env` beside it holds the
  compose values and any `AFS_*` setting (an example with made-up values is in the repository).
- **The first administrator** comes from the setup code in the log, or `user add --admin` run in
  the container; the master key is made in the volume at first start unless `AFS_MASTER_KEY`
  gives it, and the README says to keep a copy outside the volume.

## Consequences

- Upgrading is pulling a newer tag; the database changes at start, as everywhere.
- Whoever controls the socket controls the machine: that is said in the README, and a socket
  proxy can sit between them (then `AFS_ENGINE_DATA_DIR`).
- podman: its docker-compatible socket works with the same image and paths; a native podman
  install is AFS-36.

## Alternatives considered

- **Same path inside and outside** (ADR-0016 as it was): no code, but no named volume, and an
  easy mistake to make.
- **A data volume container shared with `--volumes-from`:** the designer's run command mounts
  paths, not volumes; it would need changing there.
