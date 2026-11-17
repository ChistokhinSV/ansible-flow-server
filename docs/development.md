# Development

[README](../README.md) · [Releasing](../RELEASING.md)

## Requirements

- Node.js 24 or later
- git
- [just](https://github.com/casey/just) for the development commands
- docker (or podman) for runs and the end-to-end suites

## Install for development

The server is built on the designer's npm packages (`@ansible-flow/core`, `@ansible-flow/node`,
`@ansible-flow/assets`, and `@ansible-flow/designer` for the pages), pinned to one version:

```sh
git clone https://github.com/ChistokhinSV/ansible-flow-server.git
cd ansible-flow-server
just install
```

A new designer release is taken by the "Designer packages" workflow, which opens a pull request
when the server passes its checks with it. A designer release candidate (`1.1.0-rc.1`, on npm's
`next` tag) is taken the same way by hand: see [RELEASING.md](../RELEASING.md).

**An unreleased designer, on this machine only:** `AFD_REPO=../ansible-flow-designer just afd-packages`
packs the packages in a checkout of the designer, copies the tarballs to `vendor/` (not in git)
and installs them; `package.json` then names those tarballs. Do not commit that change: put the
npm version back (`git checkout package.json package-lock.json && just install`). CI and a clean
checkout cannot build from `vendor/`; for anything others test, publish a release candidate.

## Commands

| Command                    | Does                                                                                                                             |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `just install`             | Install exact dependencies from `package-lock.json`                                                                              |
| `just afd-packages`        | Try an unreleased designer: pack its packages and install them from `vendor/`                                                    |
| `just check`               | Type-check (TypeScript) and lint and format check (Biome)                                                                        |
| `just fmt`                 | Apply formatting and safe lint fixes                                                                                             |
| `just test [args]`         | Unit tests (Vitest; the pages in jsdom); with `AFS_TEST_POSTGRES_URL` set, the database tests also run on PostgreSQL             |
| `just build`               | Build the server and the web pages into `dist/`                                                                                  |
| `just web-dev`             | The pages with live reload (port 5180), against a server on port 8080 (`AFS_DEV_SERVER` to change)                               |
| `just start`               | Build, then start the server                                                                                                     |
| `just check-flows <files>` | Build, then read the given flow files                                                                                            |
| `just cert <command>`      | Build, then run a certificate command                                                                                            |
| `just user <command>`      | Build, then run a user command                                                                                                   |
| `just secrets <command>`   | Build, then run a secrets command                                                                                                |
| `just e2e <suite>`         | End-to-end suites (`image`, `lab`, `browser`, `down`): the image in docker compose, flows on lab hosts; see `test/e2e/README.md` |

## Layout

| Path           | Holds                                                           |
| -------------- | --------------------------------------------------------------- |
| `src/server/`  | The server (Node.js)                                            |
| `src/web/`     | The web pages (React, built by Vite into `dist/web`)            |
| `test/web/`    | Tests of the web pages                                          |
| `test/unit/`   | Unit tests; `test/fixtures/` has sample flows from the designer |
| `test/e2e/`    | End-to-end suites: docker compose, a GNS3 lab, a browser        |
| `scripts/`     | Build and package scripts                                       |
| `collection/`  | The Ansible collection `chistokhinsv.ansible_flow`              |
| `deploy/`      | docker compose and the Linux service install                    |
| `docs/guide/`  | The user guide                                                  |
| `docs/adr/`    | Architecture decisions, one file each                           |
| `CHANGELOG.md` | What changed, for people who use the server                     |
| `media/icons/` | The icon set                                                    |
| `vendor/`      | An unreleased designer's packages as tarballs (not in git)      |
