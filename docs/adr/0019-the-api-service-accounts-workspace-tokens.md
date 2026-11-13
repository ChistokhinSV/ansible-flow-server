# ADR-0019: The API described, service accounts, tokens for one workspace

- Status: accepted (2026-11-13, AFS-23). Builds on ADR-0009 (tokens), ADR-0017 (the run
  stream), ADR-0018 (the audit log's list of routes)
- Context: programs use the server (pipelines, the VS Code extension, scripts); they need to know
  the API, an identity that is not a person, and tokens that reach no more than they need

## Decision

**One list describes every route** (`src/server/api/catalog.ts`): what it does, its subject,
who may call it, and which workspace it reaches (named by a parameter directly or through a
project, launch configuration, run or credential; by the project in the query; or none). A
route under `/api/` or `/git/` that is not in the list stops the server from being built.

**The OpenAPI 3.1 document is made from it** (`GET /api/v1/openapi.json`, no sign-in): the list
gives summary, tag and who; the routes' own JSON schemas give parameters and bodies. Answers are
described in words, not schemas: the route types are TypeScript, not JSON schemas. The page
`/docs/api` shows the document by subject.

**Service accounts:** a user flagged `service`: no password ever (setting one is refused), so it
cannot sign in to the pages; administrators, signed in with a password, make its tokens
(`POST /api/v1/users/:id/tokens`, refused for a person, who makes their own). Otherwise it is a
user: what it may do follows its account (an administrator, until access levels, AFS-27).

**Tokens for one workspace:** a token may name one workspace. A check before every handler
resolves the workspace the route reaches and refuses (`403 out_of_scope`) a route of another
workspace, and every route that spans workspaces or none (all workspaces, all runs, people,
groups, the audit log). Its own session and tokens (`self`) and what needs no sign-in stay
open. A token whose workspace is deleted reaches nothing.

**The run stream stays server-sent events** (ADR-0017); no WebSocket: a watcher only listens.

## Alternatives considered

- **@fastify/swagger.** Generates the document from the same schemas. But summaries, tags and
  who would still be written per route, the document would be one more dependency's view of the
  routes, and the list is needed anyway for the workspace check.
- **Narrowing in each route.** Each knows its object. But one forgotten check opens another
  workspace; a list checked at start, and one check for all, is not forgotten.
- **Service accounts as a kind of token without a user.** Fewer tables. But audit entries,
  run requesters and later access levels all name a user; a service account is one.

## Consequences

- A new route needs its line in two lists: the catalog (what and where) and, when it changes
  something, the audit log's (what it records).
- A token for one workspace cannot list runs without naming a project, nor see workspaces it
  is not for.
- The document says what each address takes, not the shape of each answer.
