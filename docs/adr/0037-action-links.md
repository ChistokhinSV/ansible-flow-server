# ADR-0037: Links to actions from NetBox and Zabbix

- Status: accepted (2026-11-22, AFS-176)
- Builds on: ADR-0036 (actions), ADR-0009 (personal access tokens), ADR-0022 (notifications)

## Context

People who look at a device in NetBox or a problem in Zabbix should start an approved action on it
without retyping what those systems already know: the device's name and address, the problem's id.
Some systems start things with no person at all (a Zabbix action on a trigger, a NetBox webhook).
When a run started that way ends, the system it came from should say so where people look: the
device's journal, the problem's history.

## Decision

- **An action link** is `/a/<action>?<input>=<value>…` (the action's id is its configuration's id,
  ADR-0036). It is a page of the server: opening it (a GET) never runs anything. The page reads
  `GET /api/v1/actions/:id/link` with the link's query, which answers with the action's form and:
  - **ready**: every asked input has a value, each checked as the form checks it (the choices, the
    input's type, the host group): a **confirm page** lists the values by label, says what will
    happen, and **Run**;
  - else a **short form** with the link's values in: what the link gave right is listed, only what
    is missing or not right is asked;
  - **refused**: a name the action does not ask, or a name given twice, is said in plain words with
    nothing to fill or run (the link is wrong, not the person).
    Run is the page's `POST /api/v1/actions/:id/run` (the same route as the form, CSRF-safe as every
    change: the Origin check and the session cookie's SameSite=Lax). The person's own access
    decides: an action grant, operator or more on the flow, or an administrator.
- **Sign-in first:** a signed-out person gets the sign-in page at the link's own address, and
  stays on it after a password or directory sign-in; an OIDC sign-in now returns to the path
  **with its query** (it returned to the path only).
- **Run on open** (`runOnOpen`, an option of the action, off by default): when a link gives every
  value, the page makes the POST itself as it opens, once, and the progress page says the link
  started it. The GET still runs nothing: a crawler or a link preview that fetches the address does
  not start a run.
- **`_reply`** is the one query name that is not an input: where the result goes back, a NetBox
  object (`dcim.device:1`) or a Zabbix event (`event:2048`). The run notes it (`action_reply`) when
  the action is set to tell that system. A `_reply` that is not one (an unresolved macro) is said
  on the page and ignored, not refused: the run can still go.
- **Signed links**, for systems with no person: a token per action (`afsl_…`, 32 random bytes,
  kept as a SHA-256 hash, shown once), made and revoked on the action's Settings by who sets up
  the action, **in a session only** (a leaked token must not make more). It is accepted only as
  `Authorization: Bearer` on `POST /api/v1/actions/:id/run` of its own action: never from a URL or
  a body, and every other route answers 401 to it (the server's token hook does not take it for a
  person's token, so no other route sees a signed-in user). The run is requested by the token's
  maker, who must still be able to sign in and run the action; the audit entry is the maker's,
  source `api`, with `via: signed link` and the token's name. Wrong tokens count as wrong attempts
  (20 per address in 15 minutes). Revoking, removing the action, deleting the configuration or the
  maker ends the token. Audited: `action.link-create`, `action.link-revoke`.
- **Result back** is a setting of the action (`reply`: system, credential, when: every end or only
  when it did not go well), sent through the notification outbox (retries, the delivery log) by
  two new channels:
  - `netbox`: `POST /api/extras/journal-entries/` on the object, kind success, danger or warning,
    with a v2 token as `Bearer nbt_…` (an older token as `Token …`);
  - `zabbix`: JSON-RPC `event.acknowledge` (action 4: add a message) with the API token as a bearer
    (Zabbix 7.2 and later; no `auth` in the body).
    The address and token are a **credential** of the workspace, of the new kinds `netbox` and
    `zabbix` (an address and a secret token). The outbox keeps only `<credential id>|<object>`; the
    token is read when a message is sent. The message is plain words: the action's title, how it
    ended, who started it from which system, why it failed, and the progress page's link
    (`AFS_PUBLIC_URL/actions/runs/<run>`). One message per run (deduplicated).
- **Copy link for NetBox / Zabbix** on the action's Settings builds the link with a placeholder per
  asked input, picked from a list: NetBox Jinja on the custom link's `object`
  (`{{ object.name|string|urlencode }}`, a deeper attribute guarded by its first part so a device
  without an address gives an empty value and the form asks for it), Zabbix macros (`{HOST.HOST}`,
  `{HOST.IP}`, `{EVENT.ID}`, `{MANUALINPUT}`); and the ready-to-paste JSON for NetBox's
  `POST /api/extras/custom-links/` and Zabbix's `script.create` (type 6, URL; scope 2 host or 4
  problem). The page's own address is the server's address in them.
- **AFS-175's notes:**
  - a host list without choices can be **narrowed to one inventory group** (`group` on the asked
    input): the picker offers that group's hosts (with its child groups'), and the server refuses
    a name outside it (the group's own name is allowed);
  - "What will happen" no longer lists the values the action keeps fixed by their variable names:
    runners do not read those, whoever set up the action answers for them;
  - the progress view of a run is for **who may see the flow's runs** (ro or more) and for **who
    started it**: an action-only person no longer follows runs others started (their inputs are
    theirs).

## Where this differs from the brief

- `_reply` rides in the link (and in a signed link's body as `reply`) rather than a second
  setting: a NetBox link knows its object, a Zabbix problem's link its event; a host menu's link
  has no event, so it tells nothing back.
- The signed link's run is the maker's run (their access, their name in the run list), not a
  service account's: the token is the maker's delegation of one action, and ends with them.
- A `_reply` that does not read as the system's object does not block the run: an unresolved macro
  should not stop a person from running the action, only from writing back.

## Consequences

- Nothing runs from a GET, so links are safe to preview, prefetch and paste in tickets.
- A signed link can run its action and nothing else, and every run with it is in the audit log.
- NetBox and Zabbix see how a run went where their people look, with a link to the plain progress.
