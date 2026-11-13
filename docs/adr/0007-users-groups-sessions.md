# ADR-0007: Local users, groups and sessions

- Status: accepted (2026-11-13, AFS-12)
- Context: everything after this ticket asks "who is this, and may they?". This decides how a
  person is known to the server, how they prove it, and how the first one comes to exist

## Decision

**People and groups** (`src/server/auth/users.ts`).

- A user has a login (lower case, unique), a name, an email address and a webhook address (where
  a notification for them goes), whether they are an administrator, and whether they are
  disabled. A group has a name, an email and a webhook address, and members.
- For now there are two levels: an administrator, and everyone else who can sign in. The levels
  on workspaces and flows (read, operate, edit, approve) are AFS-27.
- **The last administrator who can sign in stays one.** They cannot be demoted, disabled or
  deleted, by others or by themself, and nobody deletes their own account.
- Disabling a person, or deleting them, ends their sessions at once.

**Passwords** (`auth/passwords.ts`).

- Kept only as an argon2id hash with its own salt, in the usual `$argon2id$v=19$m=…,t=…,p=…$`
  form (19 MiB, 2 passes, 1 lane: OWASP's first choice). The cost is in the hash, so it can be
  raised later and old hashes still check. Node's own `crypto.argon2` does it: no dependency.
- At least 12 characters, at most 256, not containing the login, not a few characters repeated.
  No rule about digits or symbols: length is what makes a password hard to guess.
- A password is never logged, never an argument of a command, and never in an answer.

**Sign-in.**

- A wrong login, a wrong password and a disabled account get the same answer and take the same
  time (a hash is checked even when the login does not exist).
- Five wrong passwords for a login, or thirty from one address, in fifteen minutes: sign-in is
  refused with 429 and how long to wait, also for the right password. Kept in memory.
- **A session** is a random 256-bit token in a cookie; the database keeps only its SHA-256, so
  reading the table gives nobody a session. It ends after 8 hours without use, or 7 days after
  sign-in whichever comes first, on sign-out, and when the password is set (except the session
  that changed it).
- **The cookie** is `HttpOnly` (no script reads it), `SameSite=Lax` (other sites' requests do not
  carry it), `Secure` (HTTPS only; always, unless the settings say people reach the server over
  plain HTTP), for the whole site.
- **Requests that change something** must come from the server's own pages: when a browser names
  the page's origin, it has to be the address that was asked, else 403.
- A request body is checked against a schema; a field it has no business sending is refused, not
  dropped.

**The first administrator.** A new server has no user. At each start without one, the server
writes a setup code to its log; the first administrator is made with that code (`POST
/api/v1/setup`), so by someone who can read the server's log, not by whoever reaches the port
first. Guessing the code is rate-limited like a password. Once a user exists, setup is closed.

**The way back in** is the machine: `user add --admin`, `user password`, `user enable` and the
rest work on the database directly and need no sign-in. Whoever can run them can already read the
database.

**API** (all under `/api/v1`, JSON):

| Address                     | Does                                                    | Who            |
| --------------------------- | ------------------------------------------------------- | -------------- |
| `GET /setup`, `POST /setup` | Is a first administrator needed; make one with the code | anyone, once   |
| `POST /session`             | Sign in                                                 | anyone         |
| `GET /session`              | Who am I, with my groups                                | signed in      |
| `DELETE /session`           | Sign out                                                | anyone         |
| `PUT /session/password`     | Change my password (needs the current one)              | signed in      |
| `/users`, `/users/:id`      | List, add, change, disable, delete people               | administrators |
| `PUT /users/:id/password`   | Set someone's password                                  | administrators |
| `/groups`, `/groups/:id`    | List, add, change, delete groups                        | administrators |
| `PUT /groups/:id/members`   | Set a group's members                                   | administrators |

## Alternatives considered

- **Tokens in the page's storage instead of a cookie.** A script on the page could read them; an
  `HttpOnly` cookie cannot be read by any script.
- **Signed, stateless sessions (JWT).** No table. But a session could not be ended before its
  time: disabling a person, or changing a password, must end it now.
- **The first visitor becomes the administrator.** Simplest. A server that is reachable before
  its owner opens it would belong to someone else.
- **A password policy of character classes.** People answer it with `Password1!`. Length and the
  rate limit do more.

## Consequences

- The rate limit is per server process and forgotten at a restart. With more than one server
  (after 1.0) it moves to the database.
- OIDC and LDAP (AFS-30, AFS-31) add other ways to prove who one is; a user from them has no
  password hash, which the schema allows.
- API tokens for scripts and MCP (AFS-23) are not sessions: they come with their own table.
- The pages (sign-in, first administrator, users, groups) come with the web application
  (AFS-15, AFS-56); until then this is an API and commands.
