# ADR-0035: SSH sources with a stored key, and how host keys are trusted

- Status: accepted (2026-11-15, AFS-60)
- Builds on: ADR-0008 (projects from git), ADR-0010 (the server as every project's git address),
  ADR-0013 (credentials and the master key)
- Decisions of the product owner: trust on first use; one known_hosts for the server, in the data
  folder.

## Context

A project's source over https signs in with a token or a login (AFS-17). One over ssh used the
server account's own key and its `~/.ssh/known_hosts`: a key per source was not possible, and an
unknown host failed with git's words.

## Decision

- **The key:** an `ssh_key` credential is the sign-in of an `ssh://` or `git@host:path` source
  (a `git_token` or `login` only of an https one). For each git call the key is written to a new
  private folder (0700, key 0600), ssh is told to use only it (`-i … -o IdentitiesOnly=yes -o
  IdentityAgent=none`), and the folder is removed when the call ends; for a push passed on to the
  source, when the git process ends. The user is the address's, else the credential's
  `username`.
- **A passphrase** is never an argument or a variable of the call: it is written to a private file
  in that folder, and an askpass helper (`SSH_ASKPASS`, `SSH_ASKPASS_REQUIRE=force`) prints it.
  ssh is not in batch mode then, but asks no one else: no password or keyboard sign-in.
- **Host keys, trust on first use:** every ssh call uses
  `StrictHostKeyChecking=accept-new` with `UserKnownHostsFile="<data>/repos/known_hosts
  ~/.ssh/known_hosts"`. A host not seen before is added to the server's file (the account's is
  read, never written); the server logs it and writes `git.host-key-trusted` to the audit log
  with the fingerprints. A host that shows another key than a trusted one stops the call; the
  project's state says so, and an administrator who knows why it changed accepts it
  (`POST /projects/:id/host-key/forget`: the host's lines are removed with `ssh-keygen -R`, the
  next look trusts what it finds; audited with the keys forgotten).
- **Errors in the server's words:** a changed host key, a key the source refuses, a key that
  cannot be read (a wrong passphrase; on Linux ssh says that as a refused key, so the message
  names both).

## Consequences

- A first connection is as safe as the network it goes over; the fingerprint is on the project's
  page to compare with what the git host publishes.
- One file for the server: two projects on one host trust it once; accepting a new key for one
  accepts it for all.
- The server needs `ssh` and `ssh-keygen` (the image has them; the native installer says so when
  they are missing).
- Not covered: pinning a fingerprint given in advance, host certificates (`@cert-authority`),
  keys in an agent.
