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

## Where a value comes from (AFS-183, 2026-11-21)

The designer explains where a step's value comes from (its ADR-0038); its phase 2 reads the
repository's variables, which in VS Code the extension does. On the pages the server does it, so
the canvas (a flow, a run, a flow at a commit, a draft) says the same.

- **On the server, from git.** `POST /api/v1/projects/:id/vars` (`{commit, inventory?, roles?,
  files?}` → `{commit, index}`) builds the designer's index (`buildVarIndex`) over the commit's tree
  (`git ls-tree`, then `git cat-file` per file it reads). No checkout, nothing written. The page
  sends what the flow runs (`indexInputs` of its steps), so a draft that binds another role gets
  that role's variables without a save.
- **The inventory the runs use.** A run's page: the run's inventory. Elsewhere: the one the flow's
  launch configurations name when they all name the same one; otherwise (none, or several) what
  ansible.cfg names, as a run without one gets. The launch form uses its configuration's.
- **Kept per commit.** A commit never changes, so an index is kept per (project, commit,
  inventory, roles, files), 64 at most, the least recently asked for going first; a failure is not
  kept. Limits: the designer's 400 files and 2 s, and no file over 256 KB or that is a link; a cut
  index says so, and the designer then names no winner.
- **Access as the Files tab.** It reads the project's files, so it asks ro on the project (the
  route catalog), not on one flow. Someone with a grant on one flow gets no index and the canvas
  answers from the flow alone. Nothing secret: the designer keeps no value of a vaulted or
  secret-looking variable, and the route returns only the index.
- **The page posts it.** viewer.ts and viewerDraft.ts (`viewerVars.ts`) post `{type:'varIndex',
  index, openFiles: true}` and add the repository's findings to each snapshot they show
  (`withRepoFindings`: a name the repository sets is information, not an unknown read; an input
  default that hides the inventory). A followed flow reads it again when the branch moves. History
  (a past version in the Changes lens) gets none, as in VS Code.
- **A definition's file:line** (`openCode`) opens the Files tab at that line (`?path=…&line=…`) in a
  new tab, so the canvas stays; the Files page puts the cursor on that line and scrolls it into the
  middle. The Files tab shows the branch, so at an older commit (a run's) the line may have moved.
- **The launch form** shows, under each input's hint, one line from the designer's
  `flowInputUses`: the steps that read it, its default, and what it wins over (a same-name step
  input, and the repository's definitions when the person may read the files). Computed on the form
  route (`origins` in its answer); not on check or launch.
