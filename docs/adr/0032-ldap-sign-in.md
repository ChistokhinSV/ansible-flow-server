# ADR-0032: Sign-in with LDAP and Active Directory

- Status: accepted (2026-11-14, AFS-31)
- Builds on: ADR-0007 (people, groups, sessions), ADR-0013 (the master key), ADR-0031 (OIDC
  sign-in: sources of groups and rights)

## Decision

- **Directories live in the database,** like OIDC providers: added on the Sign-in page and over the
  API from an Active Directory or OpenLDAP preset, the service account's password sealed with the
  master key (re-sealed by `secrets rotate`). Changes need an administrator's session and are
  audited. The client is `ldapts`.
- **One sign-in form, local first.** A login whose account here has a password signs in here and
  never asks a directory. Any other login is tried with the enabled directories in order: the
  service account searches for the person (two entries refuse), and the person's own password is
  bound on a connection of its own. A wrong password is final; a directory that does not answer is
  skipped. Every refusal is the same 401. An empty password is refused before any bind (an
  anonymous bind would succeed).
- **Passwords never in clear:** `ldaps://`, or `ldap://` with StartTLS; plain `ldap://` only on this
  machine. Certificates are checked against the system's authorities and `AFS_CA_FILE`.
- **A person is their id in a directory** (`objectGUID`, `entryUUID`: it survives a rename), not
  their DN or login. As with OIDC, an existing local account is never taken over by a matching
  login: a new account gets a suffix. Groups come from a group search (`{dn}` in the filter; the AD
  in-chain rule gives nested groups) or `memberOf`; a mapping value matches a group's DN or its
  name. Memberships, the administrator right and a disabling carry their source, so a directory
  takes back only what it gave.
- **A sync disables who left:** each directory is looked up again every `syncMinutes` (60 by
  default) and on Sync now. A person not found, or disabled in AD (`userAccountControl` bit 2), is
  disabled here with the directory as the source; sessions and tokens of disabled accounts are
  refused on their next request, so a signed-in person is out within the sync interval. A person
  found again is enabled, unless they were disabled by hand. If the service account cannot connect
  or bind, nobody is disabled; a single failed lookup skips that person.
- **Binary ids are sent as bytes:** `ldapts` turns escaped bytes above 0x7f in a string filter into
  UTF-8 text, so an `objectGUID` lookup by string filter never matches. An id filter on a binary
  attribute goes as an `EqualityFilter` with a Buffer (found in the lab against Samba AD).

## Consequences

- People removed from the directory lose access within one sync interval even if they never sign
  in again; a directory outage locks nobody out of a session they already have.
- A directory account has no password here; an administrator may give it one, and it then signs in
  locally.
- Directory sign-ins work when passwords are for administrators only: that setting is about
  passwords kept here.

## Alternatives considered

- **Disable at next sign-in only:** simpler, but a person who left keeps working with an open
  session or a token.
- **Delete accounts that left:** their runs, approvals and audit entries name them; disabling keeps
  the history and is undone when they come back.
- **A separate directory sign-in form or a domain selector:** one more thing for people to choose;
  local-first with directories in order covers it.
- **Kerberos / SPNEGO:** sign-in without typing a password, but needs a keytab and browser setup;
  later if asked.
