# ADR-0002: The designer's code comes as its npm packages, at one exact version

- Status: accepted (2026-11-13, AFS-9). The designer's side is its ADR-0036
- Context: the server must read, check, generate and run a flow exactly as the extension does, in
  this version and in every later one

## Decision

- **Packages.** `@ansible-flow/core` (the flow model, validation, generation, run summaries, the
  designer's message protocol), `@ansible-flow/node` (layout, the run pipeline, the probe client),
  `@ansible-flow/assets` (the Python probe, the events callback, the schemas) and, from the first
  page that shows a flow, `@ansible-flow/designer` (the canvas).
- **One exact version, the same for all of them.** They are released together with the extension;
  the server names one version and moves to the next in a change of its own, which its tests gate.
  A range would let two installs of the server read a flow differently.
- **One copy of the core.** The core caches a model per flow and compares objects by identity. The
  server's bundle leaves its dependencies as imports (`packages: 'external'`), so the server's code
  and `@ansible-flow/node` load the same `@ansible-flow/core`. A test says so
  (`test/unit/packages.test.ts`).
- **No copies of the designer's rules here.** What a flow means is asked of the packages. When the
  server needs something they do not have, it is added to the designer and released.
- **Until the packages are on npm** they are tarballs: `just afd-packages` packs them in a checkout
  of the designer, copies them to `vendor/` (not in git) and installs them as `file:` dependencies.
  `package.json` names the tarballs; `package-lock.json` records them. When the packages are
  published, the dependencies become the exact version and `vendor/` goes.

## Consequences

- A fresh clone cannot install without a checkout of the designer, until the first npm release.
  CI is in the same position: its job is switched off (the repository variable `AFD_PACKAGES_ON_NPM`)
  until then.
- The server's minimum Node.js version is the packages' (22.13 for `node:sqlite` in the catalog);
  the server asks for 24, the current long-term-support line, and runs on nothing older.
- A mistake in how the server calls a package shows up as a wrong reading of a correct flow. The
  first one did (the schema validator given the parsed file instead of its data): the tests now
  check that the designer's own samples have no errors.
