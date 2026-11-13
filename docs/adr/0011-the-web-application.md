# ADR-0011: The web application

- Status: accepted (2026-11-13, AFS-15)
- Context: people need pages: to sign in, find a project, see what it is at, and later watch
  runs and approve. The designer's canvas will be shown inside these pages (AFS-16)

## Decision

**One page application, built with the designer's tools** (`src/web`): React 19 and Vite, the
same versions the designer's canvas is built with, so the canvas drops in without a second
copy of React. It talks to the server's REST API and nothing else; whatever a page can do, a
script can do.

**Served by the server itself** (`src/server/web.ts`) from `dist/web`, built beside
`dist/server.js`. No second process, no separate origin, so the session cookie and the API need
no cross-origin rules.

- The files are read once at start and served from memory by exact path: an address cannot
  name anything else on the machine.
- Files Vite names by their content (`/assets/…`) are kept by browsers for good; everything
  else is checked each time.
- Any other `GET` that is not the server's own (`/api`, `/git`, `/healthz`, `/readyz`) answers
  with the application's page, so a link to a project opens the project.
- The page may load and run only its own files and talk only to its own server
  (Content-Security-Policy with no `unsafe-*`), and is in nobody's frame.
- A server started without the built application says so once and has no pages; its API works.

**Few dependencies.** Addresses are matched by twenty lines of code (`router.tsx`), not a
router library; state is React's own; styles are one stylesheet. The API's types are the
server's own types, imported as types.

**Addresses are plain paths**: `/` (workspaces), `/w/<workspace>`, `/w/<workspace>/<project>`,
`/runs`, `/account`, `/admin`. Sign-in and first-run setup are not addresses: they are what any
address shows until someone is signed in, and then the address asked for is shown.

**The look is the designer's standalone theme**: the same colours for background, text, panels,
borders, inputs and the accent, in light and dark. The page follows the device unless the
person chose; the choice is kept in that browser.

**For everyone:** semantic elements, a label on every field, visible focus, a skip link,
refusals announced (`role="alert"`), no horizontal scrolling at phone width.

**What only some may do is shown only to them**, read from who is signed in. That is for
clarity: the server decides, whatever a page shows.

## In this ticket, and not

- In: sign-in, first-run setup, workspaces, a workspace's projects (add hosted or external), a
  project's state, git address and pushes, access tokens, theme, sign-out.
- Runs and Administration are in the navigation and say that they are not built yet.
- Not: the flow viewer (AFS-16), people and groups pages (AFS-56), the certificate page
  (AFS-54), branch management (AFS-59), a test in a real browser (AFS-38).

## Alternatives considered

- **Pages rendered by the server.** No build step. But the designer's canvas is a React
  application; two ways of making pages would meet in the middle of the project page.
- **A router and a data-fetching library.** Familiar. But six addresses and a dozen requests do
  not need them, and each is a dependency to keep current and audited.
- **A separate static host for the pages.** Common. But it adds an origin, cookie and CORS
  rules, and a second thing to deploy.

## Consequences

- `just build` builds the server and the pages; `just web-dev` serves the pages with live
  reload against a running server.
- React and Vite are build-time dependencies: the server at run time needs neither.
- The sign-in check of a page that is not signed in shows as one 401 in the browser's console.
