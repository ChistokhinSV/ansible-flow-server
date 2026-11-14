# ADR-0031: Sign-in with OIDC providers

- Status: accepted (2026-11-14, AFS-30)
- Builds on: ADR-0007 (people, groups, sessions), ADR-0013 (the master key), ADR-0020 (access levels)

## Decision

- **Providers live in the database**, set up by administrators on a page and over the API, the
  client secret sealed with the master key (re-sealed by `secrets rotate`). Adding, changing or
  removing one needs an administrator's session, not a token: it decides who may become an
  administrator. Every change is audited.
- **The flow:** authorization code with PKCE (S256), state and nonce, with `openid-client` 6. A
  sign-in under way is a row (state, verifier, nonce, page to return to), used once and gone after
  ten minutes, so it works with several servers on one database. The redirect address is the
  public URL's (`AFS_PUBLIC_URL`), else the request's. An issuer must be https; http only on this
  machine (a provider being tried).
- **A person is their identity at a provider** (provider, subject). The first sign-in makes an
  account without a password, with a login from a claim (`preferred_username` by default, made
  unique with `-2`...). An existing local account is never taken over by an email or a login that
  matches: that would let a provider's user become anyone here.
- **Groups and the administrator right follow a mapping table per provider:** a claim value is a
  server group or administrator; values not mapped mean nothing. At each sign-in what the claim
  no longer says is taken back, and only that: memberships and rights carry their source (`null`:
  given here by hand), so what an administrator set is never removed by a provider.
- **Passwords for administrators only** is a server setting: everyone else then signs in with a
  provider, and administrators keep a way in when the provider is down.
- **GitHub is not here:** it signs people in with OAuth 2 without an ID token; it would need its
  own account and team lookup (a later ticket).

## Consequences

- An account made by a provider has no password and cannot sign in with one; an administrator may
  give it one.
- Removing a provider keeps its people (their runs, approvals and audit entries name them) and
  takes back what it gave.
- Single logout at the provider is not followed: signing out ends this server's session only.

## Alternatives considered

- **Settings file for providers:** simpler, but a restart per change, the secret in a file, and no
  test button.
- **Groups made from claim values automatically:** fewer steps, but any group a provider lists
  would appear here, and a renamed group there would leave stale groups here.
- **Matching existing accounts by email:** convenient, but an email at a provider is not proof of
  being the person who has that account here.
