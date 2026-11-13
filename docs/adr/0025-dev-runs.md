# ADR-0025: Dev runs of unpushed work

- Status: accepted (2026-11-13, AFS-26; the extension's side is designer AFD-282). Builds on
  ADR-0010 (the server as git address), ADR-0014 (launch configurations), ADR-0020 (access levels)
- Context: a person editing a flow in VS Code wants to check it on the server, with the server's
  inventory, credentials and image, before pushing. Pushing a scratch branch through the server
  would not do: a push to an external project is passed on to its source (ADR-0010)

## Decision

**A git bundle, not a push.** The extension makes a bundle of the work (HEAD, or a commit of the
working tree made with a temporary index) from the server's commit when it has it, else with its
whole history, and sends it to `POST /api/v1/projects/:id/dev-bundles`
(`application/x-git-bundle`, at most `AFS_DEV_BUNDLE_MAX_MB`, default 50). `rw` on the workspace:
who may push may send work.

**Taken in without a transport:** `git bundle verify` (its starting commits must be in the
repository), `list-heads` (exactly one), `unbundle`, then `update-ref refs/afs/dev/<id>`. No
fetch: the server's git allows no `file` transport. No branch moves; nothing is passed on.

**Hidden:** `transfer.hideRefs=refs/afs` on every git call, so the dev refs are neither advertised
to a clone, fetch or `ls-remote` nor accepted from a push.

**Check runs only:** a launch naming the bundle (`dev`) runs its commit with the launch
configuration's inventory, image and credentials, in check mode; `mode: real` is refused, and a
branch or commit beside it too. `rw` on the flow, as for another commit. The run carries
`dev_bundle` (`"dev": true` in the API, a badge on the pages), and a relaunch keeps it.

**Short-lived:** the bundle's row and ref go after `AFS_DEV_KEEP_HOURS` (24, the hourly
retention sweep); a launch of an expired one says to send the work again. The commit's objects stay
in the repository until it is cleaned, so a dev run's page keeps reading its flow.

## Consequences

- A person checks work with the team's real settings without publishing it; real changes still go
  through a pushed, reviewable commit.
- Objects of dev runs accumulate in a repository until it is cleaned (the server runs no `gc`).
- Someone with `rw` on only one flow cannot send work (sending is per workspace); they push instead.
