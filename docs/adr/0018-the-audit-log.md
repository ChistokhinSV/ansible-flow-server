# ADR-0018: The audit log

- Status: accepted (2026-11-13, AFS-22). Builds on ADR-0007 (people and sessions), ADR-0009
  (tokens), ADR-0010 (the server as git address)
- Context: an administrator must be able to say who did what and when (who launched or stopped
  a run, who changed a credential, who tried to sign in, who pushed) and take that away for
  review

## Decision

**One table, rows only added** (`audit_entry`): when, who (user id and login, and the token when
one was used), source (`ui`, `api`, `git`, `cli`, `server`), action (`<object>.<verb>`), object
(type, id, name), result (`ok`, `refused`, `failed`), HTTP status, client address, request id
(the same as on the server's log lines), and a small detail. Nothing updates or deletes entries
but the keeping period, `AFS_AUDIT_KEEP_DAYS` (365; `0` keeps all), every hour.

**Recorded in one place, for every route:** a hook (`audit/routes.ts`) writes the entry for any
POST, PUT, PATCH or DELETE under `/api/` or `/git/`, from one list that names each route's
action. A changing route missing from the list stops the server from being built, so a new
endpoint cannot go unrecorded; a test checks that each listed route exists.

- The object's name is read before the change, so a deleted thing is still named.
- The entry is written before the answer goes out: when a client has its answer, the entry is
  there. A failed write is logged as an error; the change it records is not undone.
- Refusals are recorded (401, 403, 429 as `refused`; other 4xx and 5xx as `failed`), except a
  request with no credentials at all that is told to sign in: git asks that before every push.
- A refused sign-in is recorded with the login tried, lowercased; never the password.
- A push is recorded by the git route itself, after git, with the branches it moved; a refused
  push at git's first request (`info/refs?service=git-receive-pack`).
- The server's commands that change something (`user`, `cert`, `secrets rotate`) record
  themselves with source `cli`, the command line and the machine's user.
- Source: a token is `api`, a session is `ui`; with nobody signed in (a sign-in), `ui` when the
  browser says where the request comes from (`Sec-Fetch-Site`), else `api`.

**No secret values:** of a request's body an entry keeps the names of the fields a PATCH or PUT
changed and the boolean and number values; never text, which may be a password, a key or a
token. Error replies keep their code, not their message.

**Read by administrators:** `GET /api/v1/audit` (filters, newest first, a cursor for older
pages), `GET /api/v1/audit/export` (CSV or JSON, at most 50000 entries; the export is itself
recorded), and the page `/admin/audit`. CSV cells that a spreadsheet would read as a formula get
a leading quote mark.

## Not in this decision

- Approvals, schedules, the MCP endpoint and the VS Code extension: they are recorded through
  the same hook when they come, with their own sources.
- Certificate changes through the API: the certificate page is not built. The `cert` commands
  are recorded, and the certificate store keeps its own history.
- Sending entries elsewhere (syslog, a SIEM, a webhook): a later ticket.
- What the server does by itself (a run ending, removing old runs): that is in the runs.

## Alternatives considered

- **A call in each route.** Each records exactly what it knows. But one forgotten call is a
  hole nobody sees; a list checked at start is not forgotten.
- **Writing after the answer** (`onResponse`). Faster answers. But a client could read the log
  before its own action is in it, and tests could not rely on it.
- **Keeping request bodies with secrets masked by field name.** More detail. But masking by
  name misses a secret in a field named otherwise; not keeping text at all cannot leak.
- **An append-only file.** Simple. But it cannot be filtered or paged, and servers sharing one
  database would each have part of it.

## Consequences

- Every changing request does one more write, and one read for the object's name.
- The log grows with use; a year of a busy server is many rows in SQLite.
- A new route under `/api/` that changes something must be named in the list, or the server
  does not start.
