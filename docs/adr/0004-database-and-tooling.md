# ADR-0004: Database choice, repository layout and tooling

- Status: accepted (2026-11-13, AFS-9). The database part is not implemented yet (AFS-10)

## Decision

**Database.** SQLite by default, PostgreSQL supported, through one query layer tested on both.

- SQLite needs no setup: one file in the data folder. It is right for a single server and a small
  team, which is who the first version is for.
- PostgreSQL is for larger installs and, later, for more than one server instance.
- The job queue is rows with leases (claim, heartbeat, expiry), which both databases can do. No
  feature of one database is used that the other lacks.
- Migrations only go forward and run at start.

**Repository.** One npm package, sources in `src/`:

| Path          | Holds                                     | May use                               |
| ------------- | ----------------------------------------- | ------------------------------------- |
| `src/server/` | The server                                | Node.js, the designer's packages      |
| `src/web/`    | The web page (from AFS-15)                | The browser, `@ansible-flow/designer` |
| `src/shared/` | Types both sides use (when there are any) | Neither Node.js nor the browser       |

**Tooling**, the designer's choices, so one person moves between the two repositories without
relearning anything:

- TypeScript 7 for type-checking, esbuild to build the server, Biome for lint and format, Vitest
  for tests, `just` as the one entry point for every command.
- Exact versions in `package.json`; the latest stable release of each was checked on the day it
  was added (2026-11-13: TypeScript 7.0.2, Biome 2.6.7, Vitest 5.1.0, esbuild 0.28.2).
- Node.js 24 or later.
- CI runs the type check, `biome ci .` and the unit tests on every push and pull request.

**Secrets and settings** come from the environment or a `.env` file that is not in git. Examples
in the documentation use made-up names and addresses.

## Consequences

- Every query is written for two databases and tested on both; anything clever that only one of
  them can do is left out.
- A web page in the same package as the server means one version and one release for both.
