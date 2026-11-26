# ADR-0039: Control Room 3: the pages' structure and look

- Status: proposed (2026-11-26, epic AFS-267, this record AFS-268). The product owner chose
  Control Room 3 from five directions on 2026-11-26. The mock-ups are in
  `docs/design/1.2/control-room-3/`.
- Builds on: ADR-0011 (the web application), ADR-0012 (flows and the viewer), ADR-0038 (the web
  debugger). Replaces the look of AFS-64 ("Control Room") and keeps its rules: dark by default,
  flat, plain words.
- Context: the pages kept the AFS-64 look while 1.0 to 1.2 added approvals, actions, the debugger
  and more. A review of the guide's 1.2.0-rc.4 screenshots and of `src/web` found these problems:
  - **F1:** a run's state is told by the colour of its word alone ("went well" green, "failed"
    red). Without colour vision, or on a projector, a list of runs reads as one grey block.
  - **F2:** a real run and a check run look the same; the only difference is the word "real" in a
    grey line.
  - **F3:** before the debug workbench, a run was spread over three panes, and its output started
    below the fold.
  - **F4:** the canvas keeps the designer's standalone colours (VS Code's `#1f1f1f` ground and
    `#0078d4` buttons) inside the navy and teal pages.
  - **F5:** Home says what happened, not what needs you: no failed run of yours, no draft you left,
    no certificate about to end.
  - **F6:** an approval asks for a decision without saying what it lets happen, what a check run
    showed, or when it times out.
  - **F7:** the side menu lists every workspace, the administration's pages, and your name, the
    theme and Sign out as items of their own.
  - **F8:** tables repeat their loudest button (Take back on every grant), and audit rows wrap
    to two lines.
  - **F9:** one page head can hold a filled button, a plain link and an underlined link side by
    side.

## Decision

### 1. The look: Control Room 3

- **Kept:** the navy and teal, IBM Plex Sans and Plex Mono, the plain words, dark by default with
  light and "as the device".
- **The debug workbench** keeps VS Code's density (13px text, rows about 22px), as it has since
  AFS-266.
- **Audit log, People and Access** take the table system described in §7.
- **One component set** (§2 to §5) replaces what each page drew for itself.

### 2. Tokens in three layers

1. **Raw colours:** the variables `styles.css` has now (`--bg`, `--panel`, `--accent`, `--ok`,
   `--warn`, `--bad` and the rest), one set per theme. A theme changes only these.
2. **Roles:** new names that say what a colour is for, each pointing at a raw colour. For example
   `--state-ok`, `--state-failed`, `--state-waiting`, `--mode-real`, `--mode-check`, and the
   `--canvas-*` colours the viewer passes to the designer (§6).
3. **Components** use roles, never raw colours.

Each ticket adds its rules as one block at the end of `styles.css`. Why: the debugger work
changes the file daily, and an appended block merges without conflicts. The blocks are folded into
their places once 1.2 is out.

### 3. A state is a shape, a colour and a word (S4, AFS-269)

Every run state has its own glyph, as well as its colour and its word. The words do not change.
The glyph is decoration: the word stays the accessible text.

| State                     | Word                           | Glyph                                          |
| ------------------------- | ------------------------------ | ---------------------------------------------- |
| `queued`                  | queued                         | a dashed circle                                |
| `running`                 | running                        | an arc that turns (still under reduced motion) |
| `paused` (step by step)   | paused                         | a circle with two bars                         |
| `waiting`                 | waiting for a decision         | a diamond, the approval's shape on the canvas  |
| `succeeded`               | went well                      | a circle with a tick                           |
| `failed`                  | failed                         | a circle with a cross                          |
| `failed`, decided against | rejected / not decided in time | a diamond with a cross                         |
| `cancelled`               | stopped                        | a circle with a square                         |
| `lost`                    | lost                           | a broken circle                                |

`RunWords` and `StateBadge` (`runs.tsx`) draw them, so every list and badge gets them at once.

### 4. Real and Check (S4, AFS-269)

- **A real run** carries a solid "Real" badge with a bolt. **A check run** carries a dashed
  "Check" badge. Both appear in every run list's Mode column and on the run's header.
- **A real run's header** has a hatched stripe along its top.
- **Launch** names the run it starts (§8).

### 5. One set of buttons (S9, AFS-269)

- **Primary:** one per view (`button.primary`).
- **Secondary:** the default button.
- **Quiet:** for the lesser actions of a row or a toolbar.
- **Danger:** only for what deletes or stops.
- In a page head and in a toolbar everything is a button; a place to go there is `a.button`. Plain
  links stay in sentences and lists.
- A button with a shortcut names it in its `title` and in `aria-keyshortcuts`.

### 6. One palette for page and canvas (S8, AFD-383 then AFS-270)

- **Designer:** an embedding host may pass a palette (the `--vscode-*` colours the canvas reads)
  with the mount configuration, and a new one when its theme changes. The canvas takes only names
  it reads and values that are colours. Inside VS Code the palette is ignored. This is an
  optional field and a new message, so older hosts and the protocol are unchanged.
- **Server:** `viewer.ts` passes the page's `--canvas-*` roles. With the pinned designer
  (1.2.0-rc.5) nothing changes, and the `viewer.css` fallbacks stay.

### 7. Quiet tables (S7, AFS-273)

- **Access** is a matrix: people and groups down; Read, Operate, Edit and Approve across. Each
  cell says whether the level is given here, comes through a group, or comes with a higher level.
  Grants on single flows have their own table.
- **Row actions** (Take back, Change) move into each row's ⋯ menu; a removal is confirmed in
  place.
- **Audit log** rows fit one line and are grouped by day.
- **Table system** for Audit log, People and Access: a panel with a title bar, zebra rows, one
  main button above the table.

### 8. Pages that say what will happen

- **Approvals (S5, AFS-271):**
  - If you approve: the steps that follow the approval, and the hosts waiting at it.
  - If you reject: where the hosts go.
  - Evidence: the last check run of the same launch configuration, and whether it was at the same
    commit.
  - The timeout, and what happens then.
  - This is shown wherever an approval is decided today: the Approvals page and the run page
    (`RunApprovals`). The approval's API answer gains optional fields for it.
- **Launch (S6, AFS-272):**
  - Beside the form, "What will run", kept current: the flow, the commit, the steps, the hosts the
    targets match, the image, the credentials, the approvals ahead, the last run.
  - Check or Real is a choice of two, each saying what it does.
  - The button says "Launch check run" or "Launch real run". Ctrl+Enter launches.

### 9. Home is an inbox (S2, AFS-212)

- **What needs you,** each item with its verb: approvals you may decide; your paused runs (with
  Step and Continue); your failed runs (Run again); drafts you left; flows changed under you; for
  administrators, a certificate that ends soon.
- **Above it:** the day in one sentence and four numbers. **Beside it:** running now and launch
  again.
- **API:** one call, `GET /api/v1/inbox`. It is easier to keep fast than five calls, and it can be
  offered over MCP too.

### 10. The menu (S1, AFS-274)

- **A workspace switcher** at the top of the side menu.
- **Three groups:**
  - Work: Home, Runs, Approvals, Actions. Across all workspaces.
  - Build: Projects, Library, Environments, Credentials. In the chosen workspace.
  - Govern: Access, Audit log, People, Server. For administrators.
- **Your name** opens one account menu: profile, access tokens, theme, help, sign out.
- **The folded menu** keeps the same groups.
- This restructures `app.tsx`, which the debugger work changes often, so it comes last and its
  plan is agreed first.

### 11. A run is one workbench (S3)

The debug workbench (ADR-0038, AFS-265, AFS-266) already gives a run one place: the side bar, the
toolbar over the canvas, the panel and the status line. Control Room 3 adds to it only the state
glyph, the Real or Check badge, the real run's stripe and the canvas colours. It does not change
`workbench.tsx` or `debugger.tsx`.

## Order of work

One branch and one pull request per ticket, each passing the gates and updating the guide and the
CHANGELOG where people see a change:

1. AFS-268: this record and the mock-ups.
2. AFS-269: states, badges and buttons.
3. AFD-383 (designer), then a designer release, then AFS-270 (server).
4. AFS-271: approvals.
5. AFS-272: launch.
6. AFS-212: inbox.
7. AFS-273: tables.
8. AFS-274: the menu.

## Alternatives considered

- **Studio:** light first, a white sheet on grey, black primary buttons. A friendly first
  impression, but fewer rows per screen, and the canvas would need a light-first palette.
- **Console:** an IDE everywhere (activity bar, status bar, monospace labels). The workbench
  already has its density; everywhere else it is hard going for approvers and people who run
  actions.
- **Ledger:** a dark global header, bordered panels, zebra tables. It reads as governed, but is
  heavy for a small team; only its tables are taken.
- **Blueprint:** a technical drawing (grid, condensed capitals, a title block). Too tiring for a
  working day. It may suit the sign-in picture, a wall display and the website later.
- **A choice of looks for each person:** the three token layers make a second look possible, but
  every look doubles the screenshots and the layout checks. Not now.
- **A component library:** ADR-0011 keeps dependencies few, and the pages need a handful of
  components.

## Consequences

- `styles.css` grows by appended blocks until they are folded in after 1.2.
- Each ticket retakes the guide's screenshots it changes, and the layout check (`test/layout`)
  covers the pages it adds or changes.
- The designer gets an optional palette; servers that do not send one see no change.
- The guide's description of the look (`web-pages.md`) is rewritten with AFS-269 and AFS-274.
