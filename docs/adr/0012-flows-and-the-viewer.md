# ADR-0012: A project's flows, and the designer as a viewer

- Status: accepted (2026-11-13, AFS-16). Builds on ADR-0002 (the designer's packages), ADR-0008
  (reading a repository at a commit) and ADR-0011 (the web application)
- Context: a project page must say which flows the project has and show one as its author
  sees it in VS Code, without being able to change it

## Decision

**A flow is a file named `*.flow.yaml`** (or `.yml`), anywhere in the repository, at the
project's commit (`src/server/projects/flows.ts`). Each is read with the designer's own code:
what it is called, its version, how many steps, how many errors and warnings, or why it cannot
be read. A flow in a newer format than the server's core says "Upgrade the server" and is not
shown. At most 500 are listed.

**What the designer shows is made on the server**: the flow, its findings, the open failure
ports, the places of nodes the file does not place, and the generated play of each step (only
for a flow without errors, as in the designer). That is the designer's `Snapshot`, as plain
data, from `GET /api/v1/projects/:id/flows/view?path=`.

**A commit never changes**, so lists and snapshots are kept in memory by project and commit
(the last hundred of each) and made once.

**The designer is a page of its own** (`/viewer.html`, `src/web/viewer.ts`). The designer's
package styles the whole page and listens to its keys, and brings its own copy of React; it is
not a part to put inside another page. The application shows that page in a frame under its
bar (`/w/<workspace>/<project>/flow/<file>`), and it can be opened alone.

- The viewer page asks for the snapshot once and answers the designer's messages itself, in
  viewer mode (`viewer: true`): the designer shows and does not offer to change.
- A new commit or another theme is a new address of the frame.
- Its content policy allows this server's own pages to frame it, and the designer's icon font;
  still nothing from elsewhere and no `unsafe-*`.

**No live channel yet.** The ticket planned a viewer session over a WebSocket. A flow that is
only shown does not change while it is looked at, so one request is the whole conversation, and
it is the same REST API a script uses. The live channel comes with what is live: run status
(AFS-21). Until then, asking the viewer to run says that runs are not built.

**Nothing on the server can change a flow**: there is no such request to refuse.

## Not in this decision

- Showing a flow at another branch or commit than the project's (comes with launch, AFS-18).
- Flows that use subflows kept in other files of the repository, beyond what the designer's
  code reads from one file.
- Inventories and other files of the project.

## Alternatives considered

- **The designer mounted inside the application's page.** One page, no frame. But its
  stylesheet styles `<body>` and its menus open on `<body>`: the application's bar and the
  designer would fight over the page, and the page would carry React twice.
- **Building the snapshot in the browser** from the file's text. No server code. But the
  layout and the generated plays need the designer's Node package, and the server needs the
  same answer for its own checks before a run.
- **A file-name setting per project.** Flexible. But `*.flow.yaml` is what the designer makes
  and opens; a second convention would only be a way to lose flows.

## Consequences

- The pages bundle is two pages; the viewer's is large (the designer and its canvas).
- The designer package joins the build-time dependencies, from `vendor/` until it is on npm.
- A project page reads every flow file of the commit once to list them; the second look is
  from memory.
