# ADR-0009: Personal access tokens

- Status: accepted (2026-11-13, AFS-57; pulled forward from the REST API ticket by the product
  owner, as its own ticket). Builds on ADR-0007 (people and sessions)
- Context: a session is for a person at a browser. Git, the VS Code extension, a pipeline and an
  MCP client are programs: they cannot type a password, and must not be given one

## Decision

**A token is a person's, and acts as that person** (`src/server/auth/tokens.ts`). It has no rights
of its own: what its owner may do, it may do, with the limits below. There are no tokens without
an owner; a pipeline gets a person made for it.

- **Shape:** `afs_` and 32 random bytes in base64url. The prefix makes a token recognisable in a
  header, in a log and to a leak scanner.
- **Kept as a SHA-256 hash**, with its last four characters to tell one from another. The token
  is in the answer that makes it and nowhere else, ever. A fast hash is right here: the token is
  256 random bits, not something a person chose.
- **It ends.** 90 days unless its maker says otherwise, 365 at most, no token without an end.
  Ended tokens are removed with ended sessions.
- **It stops working** when it is revoked, at its end, and while its owner is disabled; it is
  deleted with its owner. Changing a password does not revoke tokens: they are revoked by name.
- **It can be read-only:** then it is good for `GET` and `HEAD` and nothing else.
- **At most 50 per person.**

**How a request carries it:** `Authorization: Bearer <token>`, or HTTP Basic with the token as the
password and any user name: that is what git sends, and what the server's own git address will
ask for (AFS-14). A cookie session, when there is one, wins. A token sign-in starts no session and
sets no cookie.

**What a token cannot do, whoever owns it:** make a token, revoke a token, change its owner's
password, set anyone's password. Each of those is a way for a token that leaked to outlive its
revocation; they take a session, so a password. An administrator sees and revokes other people's
tokens and cannot make one for them over HTTP.

**A token that is not one is refused everywhere**, also where no sign-in is needed, and counts as
a wrong attempt for its address (30 in fifteen minutes, as for passwords). Text that does not
have a token's shape is not looked at.

**On the server's machine,** `user token <login> [--name] [--days] [--read-only]` prints a token
and nothing else, for the first token of a pipeline's account.

**The log never has a token.** Authorization headers were already hidden by name; a value with a
token's shape is now hidden in any field.

## Not in this decision

- **Tokens narrowed to a workspace or to named actions.** They come with access levels (AFS-27).
- **Approving with a token.** Off by default, decided with approvals (AFS-29).
- **The page for tokens** (AFS-56).

## Alternatives considered

- **The password as the Basic password.** Nothing to build. But the password would sit in git's
  credential store and in pipeline settings, and could not be revoked one program at a time.
- **Signed tokens (JWT) with no row in the database.** No lookup per request. But revoking one
  needs a list anyway, and the lookup is one indexed read.
- **Tokens that never end.** Convenient. But a forgotten token is the usual way in; a year is the
  longest a pipeline should go without anyone looking at it.

## Consequences

- Every route that asks "who is this?" accepts a token with no change (`auth/guards.ts`).
  A route that must not accept one asks for a session (`inSession`).
- "Last used" is written at most once a minute per token, so a busy client costs one write a
  minute, not one per request.
