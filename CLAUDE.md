# Working on Ansible Flow Designer (AFD) and Ansible Flow Server (AFS)

The same file sits at the root of both repositories. Read it before changing anything: it holds rules that the code and docs do not show.

|                    | Designer (AFD)                                                                                                    | Server (AFS)                                                                     |
| ------------------ | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Repository         | github.com/ChistokhinSV/ansible-flow-designer                                                                     | github.com/ChistokhinSV/ansible-flow-server                                      |
| What it is         | a VS Code extension, plus npm packages `@ansible-flow/core`, `node`, `assets` and `designer` (the canvas webview) | a web server that runs flows. Its pages embed the designer's canvas in an iframe |
| Tickets (YouTrack) | AFD                                                                                                               | AFS                                                                              |

Both are TypeScript on Node 24, linted with Biome, tested with Vitest, and use `just`.

## Where things are

**Designer:**

- `src/core/` holds pure logic: the flow model, the host ↔ canvas protocol (`protocol.ts`), run views and the debugger's words.
- `src/node/` holds the runner and the debug adapter.
- `src/extension/` holds the VS Code glue.
- `src/webview/` holds the canvas: React, a Zustand store (`store.ts`), `panels/` and CSS in `styles/`.
- `probe/` holds the Python side that runs inside Ansible.
- `docs/packages.md` documents the messages for embedding hosts.

**Server:**

- `src/server/` holds the API, runner and database (SQLite or Postgres; migrations are numbered and never edited once released).
- `src/web/` holds the web app: React built by Vite, one `styles.css`.
- `src/web/viewer.html` and `viewer.ts` are the iframe that loads the designer's canvas.

**Both:** the user guide is in `docs/guide/` and the design records in `docs/adr/`.

## How the two fit

- **The server pins an exact published version** of the designer packages (`package.json`). A designer change reaches the server only after a designer release.
  - To try an unreleased designer in the server, run `just afd-packages` with the designer checkout in `AFD_REPO` (default: a sibling folder).
  - Never commit the `package.json` change this makes.
- **Order cross-repo work:** designer first, then a release, then the server moves its pin. Until the pin moves, the server must work with the pinned designer. Older designers ignore messages they do not know; keep `viewer.css` fallbacks for the pinned one.
- **Keep the protocol backward compatible:** add messages and optional fields, and never rename or remove one.

### The debug workbench

The server's debug UI is like VS Code:

- a left side bar (Variables, Watch, Hosts, Pause points; Details on the run page);
- one floating icon-only toolbar over the canvas (Continue/Pause F5, Step F10, Retry at failure pauses, Stop Shift+F5, Restart);
- a bottom panel (Debug Console, Terminal, Problems);
- a status line, the only place the pause reason is said.

It opens in place on the flow page and on the run page.

- **Density** is VS Code's: 13px text, rows about 22px, no text buttons where Enter submits.
- **Folds:** the side bar (Ctrl+B), the panel (Ctrl+J) and the app menu (to an icon rail) fold. Each fold is kept in `localStorage`, inside try/catch.

The page and the canvas talk over `postMessage`.

- **Page → viewer:** `afs-host-toolbar`, `afs-host`, `afs-reveal`, `afs-set-points`, `afs-watch-run`, `afs-run-event`.
- **Viewer → page:** `afs-run-started`, `afs-node-selected`, `afs-points`, `afs-canvas-ready`, F5 and Shift+F5 forwarded.
- **The page holds the run's only EventSource** and feeds the canvas.

On the designer side:

- **`config.hostToolbar: true`:** the canvas shows no run controls and no run text (no failure bar, no paused pill, no step section, no waiting-hosts table). It does not open panels or switch modes at a pause by itself. Node badges stay.
- **VS Code (flag off) must not change:** test both.
- **Hooks:** `nodeSelected` (canvas → page); `revealNode` (selects and opens the side panel, so do not send it unasked) and `highlightHost` (page → canvas).
- **In a web page narrower than 1000 px,** a run's side panel folds until a step is selected, also when the page narrows the frame later. The canvas keeps most of the room.

## Gates

Every change must pass these before it is committed. Read the exit codes, not the tail of the output.

**Designer:**

```
just check                            # tsc (extension, webview, tests) and biome check
npx biome ci .
just test                             # vitest
node scripts/build.mjs --production   # dist/extension.js must stay under 1,344 KB: say the size
node scripts/packages.mjs --check     # the npm packages build, pack and load on their own (CI "Packages")
```

The packages check fails when a published package's types import a file that is not published, for example a type re-exported from `src/webview/theme/`. Put such a type in a file that ships.

**Server:**

```
just check
npx biome ci .
npx vitest run
# after any change to src/web layout or CSS (no Docker needed):
node scripts/build.mjs && npx playwright test -c test/layout/playwright.config.ts
```

The layout check loads every page at 390, 1024, 1280×720 and 1440 px in both themes. It fails on horizontal scroll, covered controls and a squeezed canvas. Change its expectations only when the layout was meant to change, and say why in the commit.

Timing tests flake under load: re-run a failed one alone before calling it a failure. Integration tests inside VS Code and tests against a real engine (`*Docker.test.ts`) need a desktop or Docker. Say which you could not run.

## Rules

- **Commits:**
  - short, plain words, ending with the ticket id in brackets, e.g. `(AFS-266)` or `(AFD-382)`;
  - no `Co-Authored-By` or other attribution lines;
  - stage only the files you changed, never `git add .`.
- **Branches:**
  - work on a branch and open a pull request;
  - never push to `main`, change versions, tag or publish. Releases are cut elsewhere, as a release candidate tested on a staging server;
  - avoid two branches editing the same big files at once (`src/web/styles.css`, `workbench.tsx`, `debugger.tsx`, `app.tsx`).
- **CHANGELOG.md:**
  - write under `## Unreleased`, in `### Added`, `### Changed` or `### Fixed` (the server's first `### Fixed` list);
  - user-facing facts only, in plain words;
  - no ticket ids, no file or function names, no internals.
- **Docs:** a change people see updates `docs/guide/` (and the designer's `docs/packages.md` for host messages) in the same pull request.
- **Fictional data** in examples, samples, tests, screenshots and docs:
  - hosts `fw-01`, `sw-edge-01`;
  - people such as Dana Whitfield;
  - documentation addresses 192.0.2.0/24 and example.com.
- **Both repositories are public.** Never commit:
  - real addresses, hostnames or lab details;
  - credentials or tokens, not even in tests;
  - local machine paths.
- **Secrets:** never log or print one. Runs mask them before anything leaves.
- **No emoji** in log output.
- **UI:**
  - it works at 390 px (no horizontal scroll), 1024 px and 1440 px, in light and dark themes, and from the keyboard;
  - every icon-only button has an `aria-label` and a `title`.
- **Line endings:** files use LF. Biome fails CRLF files, YAML included.
- **Tests:** they catch real breakage, not boilerplate. A bug fix gets a test that fails without the fix.
- **Comments:** explain why, not what.
- **Tickets and knowledge base:**
  - every change has a YouTrack ticket (AFD or AFS);
  - the project's knowledge base article is updated in the same change.
  - If you cannot reach YouTrack, end your pull request description with:
    - the ticket summary;
    - what changed;
    - what the knowledge base article should say,

    so it can be filed.
