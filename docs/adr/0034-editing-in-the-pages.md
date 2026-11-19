# ADR-0034: Editing flows in the pages, together

- Status: accepted (2026-11-15, AFS-76)
- Builds on: ADR-0012 (the flow viewer), ADR-0033 (the flow-changed notice), the designer's flow
  merge (AFD-283, ADR-0037 there) and its command engine
- Decisions of the product owner: web editing and the live session in one ticket; undo of one's
  own last edit; the module catalog from the environment's image; drafts kept until saved or
  discarded.

## Decision

- **One draft per project and flow, in the database** (`flow_draft`): the flow's text at a commit
  of the branch, and a revision. Everyone with `rw` on the flow edits the same draft; nothing is
  per person but who made each edit.
- **Edits are the designer's own commands** (`planCommand` of `@ansible-flow/core`), applied by the
  server in the order it gets them, one at a time per draft, with the revision as an optimistic
  guard across servers. Commands name steps by their IDs, so edits of different steps all apply;
  the same field twice: the later wins. No operational transform: there is one authority.
- **Each edit is kept** (`flow_draft_edit`: who, kind, the text before and after). The others'
  pages are told who changed which steps (the designer's semantic diff of before and after).
- **Undo is the flow merge run backwards:** a person's last edit not yet undone is taken back by
  merging the version before it into the draft as it is now (base: the version after it). What
  others changed elsewhere stays; when they changed the same place, the merge has a conflict and
  the undo is refused with it. Redo (AFS-172) is the same merge the other way: a person's last
  undo is reapplied while they made no new edit since.
- **Live** is server-sent events per draft (`draft`, `edit` with the flow after, `people`, `saved`,
  `discarded`); the page posts its edits. A stream reads the draft's revision every 1.5 seconds,
  so an edit made through another server is seen too. Presence ("I am here", every 20 seconds,
  gone after 45) is kept in the server's memory.
- **Save** is one commit made with git's plumbing in the project's mirror (no working folder): the
  saver as author, everyone else who edited as `Co-authored-by`, the server as committer. The
  branch moves only from the commit it was at: in the external source first
  (`--force-with-lease`), then in the mirror. A branch that moved since the draft began is merged
  with the flow merge first; conflicts are answered with 409 and their labels, and `force` takes
  the draft's side of each.
- **The page is the designer's host:** the viewer page in edit mode answers the designer's
  messages as VS Code does (commands, tidy, catalog), takes the flow to show from the stream, and
  catches Ctrl+Z for undo, Ctrl+Y and Ctrl+Shift+Z for redo.
- **The module catalog** is the designer's own index, built per image: the designer's probe reads
  the plugin docs in the image, the index is built in a worker thread and kept in the data folder.
  The flow's image is its launch configuration's (environment, else image), else the server's
  default.

## Consequences

- A draft does not run: runs take the branch's commit.
- Presence is per server (several servers behind one address see only their own pages' people).
- The first catalog of an image takes minutes; it is kept afterwards, one per image name.
- A repository's own roles and playbooks are not in the browser's catalog yet.

## Alternatives considered

- **A CRDT or text OT on the YAML:** merges anything, including flows that break their rules; the
  commands already keep a flow valid.
- **A branch per person:** no live sharing; the merge happens later and to everyone's surprise.
- **Undo of the draft's last edit, whoever made it:** takes back someone else's work; a person
  expects Ctrl+Z to undo what they did.
- **WebSocket:** two-way is not needed; the page posts edits and follows events, as for runs.
