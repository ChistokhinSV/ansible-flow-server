# ADR-0024: Compatibility with the designer

- Status: accepted (2026-11-13, AFS-25). Builds on ADR-0002 (the designer's packages), ADR-0019
  (the API). The contract's other side is designer AFD-280 (fixtures) and AFD-277 (the
  extension's replay)
- Context: the server and the VS Code extension are released apart but share the flow format and
  the API. A client must know what it talks to, and a change on either side that breaks the other
  must show before it reaches anyone

## Decision

**`/api/v1/meta` says what a client may rely on:** `api` (`v1`); `designer.version` (the core the
server reads and runs flows with), `designer.formats` (every flow format it reads),
`designer.bundle` (the canvas the pages carry: a build-time dependency, so its version is stamped
by the build, not read at run time); `features`, names only ever added. A flow in a newer format
is listed with "Upgrade the server" and not run (since AFS-9).

**A contract as data, owned by the designer, replayed by both:** `@ansible-flow/assets` ships
`contract/server-api.json`: a world (people, tokens, a workspace, a project's files, a launch
configuration) and the exchanges the extension relies on, in order, with type placeholders and
captured values. The server's test sets up the world and replays each exchange against its real
routes on both databases; the extension's test serves the same exchanges from a mock. The
designer writes what its client needs; the server proves it keeps it.

**A new designer is taken by a workflow** (`afd-bump.yml`: daily, by hand, or on the designer's
`afd-release` event): install the new version of all four packages, run the type check, Biome,
the tests with the contract and the build, and open a pull request only when all pass. The checks
run in that workflow because a pull request opened with `GITHUB_TOKEN` starts no other workflow.
Like CI, it waits for the packages to be on npm (`AFD_PACKAGES_ON_NPM`).

## Consequences

- The extension can refuse a server it does not fit (`api`, `formats`) with a clear message, and
  offer only what `features` lists.
- An API change that breaks the extension fails the server's tests; a designer release whose
  contract the server does not keep is never proposed.
- The contract covers what the extension needs, not the whole API (OpenAPI describes that): it
  grows with AFD-276.
- Live run events (SSE) are not in the contract yet: an exchange there is a request and one
  answer.
