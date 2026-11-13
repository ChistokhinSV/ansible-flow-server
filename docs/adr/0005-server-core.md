# ADR-0005: The server's core: settings, log, HTTP, and one schema for two databases

- Status: accepted (2026-11-13, AFS-10)
- Context: every feature after this one reads settings, writes log lines, answers over HTTP and
  keeps rows. How those are done is decided once, here

## Decision

**Settings** come from the environment, and from a `.env` file beside the server when there is
one (the environment wins). `src/server/config.ts` reads them all at start and names every problem
at once; a server with a wrong setting does not start. Names begin with `AFS_`. A database
address is never printed with its password.

**The log** is one line per event on the standard output, through one logger
(`src/server/log.ts`) that the HTTP server uses too.

- As text (the default): `[HH:MM:SS dd.mm.yyyy] LEVEL message name=value …`, in local time.
- As JSON (`AFS_LOG_FORMAT=json`): one object a line, with an ISO time, for a log collector.
- A value whose name looks secret (`password`, `token`, `secret`, `authorization`, `cookie`, a
  key) is written as `***`, at any depth. A request is logged as its method, its path without the
  query, and where it came from; a reply as its status; an error as its message. Headers and
  bodies are never logged.

**HTTP** is Fastify 5.

- `/healthz`: the process is up. `/readyz`: it can work (the database answers), else 503.
  `/api/v1/meta`: the server's name and version, the designer version it is built on, the newest
  flow format it reads, the API version and the installation's id. Clients read it before they
  talk to the server.
- Everything is JSON, errors too: `{ error, message }`. A failure inside the server is a 500 that
  says nothing of what failed and names the request; the reason is in the log under that request.
- **Stopping:** on SIGINT or SIGTERM the server takes no new requests, answers the ones in flight,
  closes the database and ends. Once closing, each answer ends its connection: a connection kept
  alive after its last answer made the close wait until it timed out. If stopping takes longer
  than 15 seconds the process ends anyway.

**Database.** Kysely is the query layer; SQLite through Node's own `node:sqlite` (no native
module to build), PostgreSQL through `pg`. One schema for both (`src/server/db/schema.ts`):

| Kind of value | Stored as                                  | Why                                              |
| ------------- | ------------------------------------------ | ------------------------------------------------ |
| A time        | text, ISO 8601 in UTC, to the millisecond  | The same in both; sorts as it reads              |
| True or false | integer 0 or 1                             | SQLite has no boolean                            |
| A structure   | text holding JSON                          | No JSON type of one database is relied on        |
| An id         | text                                       | Ids are made by the server, not by the database  |

- No feature of one database is used that the other lacks: no arrays, no `jsonb` operators, no
  sequences, no `LISTEN`. A write that must replace a row uses `ON CONFLICT`, which both have.
- **Changes to the schema** are in code (`src/server/db/migrations.ts`), run at every start and
  only go forward. One that was released is never edited. A database that has a change this
  server does not know was last used by a newer server: the start fails.
- **Tests** of the database layer run on both. SQLite always; PostgreSQL when
  `AFS_TEST_POSTGRES_URL` names a database the tests may empty. CI gives them one.
- SQLite is opened in WAL mode with foreign keys on and a 5 second wait for a lock.

## Alternatives considered

- **Pino for the log.** It is Fastify's default and fast. The text format asked for here, and the
  rule that a secret-looking name is never written, would both be configuration on top of it; the
  logger is 100 lines and has no dependency.
- **better-sqlite3.** The usual SQLite driver for Kysely. It is a native module: a compiler or a
  prebuilt binary for every platform the server is installed on. Node's own SQLite needs neither,
  and the designer's packages already require it.
- **An ORM.** More than a server of this size needs, and its migrations would be the ORM's, not
  plain changes both databases read the same way.

## Consequences

- A query that would be simpler with a PostgreSQL feature is written the plain way, or not at all.
- Times are compared as text. That is correct only because every time is written by one function
  in one format; a time is never written by the database (`now()`).
- The server listens with plain HTTP until AFS-11 gives it certificates. Until then it listens on
  this machine only unless `AFS_HOST` says otherwise.
