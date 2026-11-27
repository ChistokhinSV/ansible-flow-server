# The flow editor

A flow's page shows the flow on the designer's canvas, as VS Code does. With `rw` on the flow you
edit it there. This page is the short version. The whole story of drafts and saving is in
[Editing flows in the pages](web-pages.md#editing-flows-in-the-pages). A first flow, step by step,
is in [Your first flow](first-flow.md).

## The page

- **The head:** the flow's name, then its buttons:
  - **Edit** (or **Open the draft** when someone left a draft);
  - **Full screen** (Esc comes back);
  - **Open on its own page**;
  - **Help** (this page);
  - **⋯**: **History**, and with `rw` **Copy the flow…** and **Delete the flow…**.
- **The line under the name:** the branch and commit shown, the flow's launch configurations
  (**Launch: …**), and its latest runs with how each went.
- **The breadcrumb** above names the workspace and the project. The canvas's own top bar shows the
  flow's key and version. On a page of its own the canvas shows the name too, since nothing else
  does there.

## Edit

1. **Edit** opens the designer in full:
   - the palette on the left (the node types, the failure patterns, annotations);
   - the canvas in the middle;
   - the side panel on the right (the flow, or the selected step's **Details**);
   - and on the top bar **Design**, **Code** and **Run**, **Lens**, **Generate Code** and **⋯**.

   The designer's guide explains each part:
   [Canvas basics](https://github.com/ChistokhinSV/ansible-flow-designer/blob/main/docs/guide/how-to/canvas-basics.md).
2. **Everyone who edits the flow edits one shared draft.** Each change shows on everyone's canvas
   at once. Who is in the draft shows as initials beside the buttons, with what happened last.
3. **Ctrl+Z** takes back your own last edit, never someone else's. **Ctrl+Y** (or Ctrl+Shift+Z)
   brings it back.
4. **Save** (or **Ctrl+S**) shows what the draft changes and the commit message made of it. It then
   makes one commit on the project's branch, by you, with everyone else who edited as co-authors.
5. **Stop editing** leaves the draft for later. **Discard** drops it after asking, and **Bring
   back** restores it for 15 minutes.

A draft stays until it is saved or discarded. Until then, the flow's page says who has unsaved
edits, and offers **Open the draft** and **Discard the draft**. Runs always run the branch, never
the draft: save first to run your edits.

## Run and debug

- **Run** on the canvas opens the launch dialog over one of the flow's launch configurations. With
  `operator` on the flow it launches, and the run shows on the canvas.
- **Run ▾ › Debug…** starts a debug run in place: the debug workbench opens around the canvas with
  its pause points, the hosts' variables and the debug console. See [Debug a run](debugging.md).

## Keys

| Keys                 | Does                                          |
| -------------------- | --------------------------------------------- |
| Ctrl+S (Cmd+S)       | Save the draft (on the page or in the canvas) |
| Ctrl+Z               | Take back your own last edit                  |
| Ctrl+Y, Ctrl+Shift+Z | Bring back what Ctrl+Z took                   |
| / or Ctrl+K          | Search the server                             |
| Esc                  | Leave full screen, close a menu               |
