# ADR-0038: 1.2: web debugger, Run again, external secrets, event streaming

- Status: proposed (2026-11-23, 1.2 design, epic AFS-219). The engine side is in the designer's
  ADR-0040 ("Flow debugger"). The spikes behind each section are AFS-234 to AFS-237 and AFD-362 to
  AFD-368; the prototypes are in `C:\DOWNLOADS_TEMP\afs-1.2-spikes`.
- Context: product owner decisions on 2026-11-23:
  - every pause holds all hosts;
  - a failure pause offers Retry, Continue and Stop;
  - Debug this failure runs in check mode by default, and real if asked;
  - CyberArk is tested on Conjur OSS, and CCP is coded too and tested against a mock.

  The acceptance scenarios are in the KB under the roadmap ("1.2 Debugger: user scenarios").

## Decision

### 1. Web debugger (AFS-179)

- **Starting one:** **Debug** beside Launch, and Run again ▾ › Debug this failure, start a step run
  with `debug: true`. The executor then sets `AFD_DEBUG=1`. The pause points' conditions, hit counts
  and log messages travel in `step.points` (ADR-0040 §6). Pause on failure is a launch option, on by
  default for debug runs.
- **Asking the paused run:** `POST /api/v1/runs/:id/inspect` with `{op, host?, path?, expr?, start?,
  count?}` writes the request file and **waits for the answer**, which comes back as the response
  body. The spike (AFS/AFD-367) estimates 100–150 ms at the median, against 0.5–0.9 s if answers
  went through `events.jsonl`, the ticker and SSE.
  - Only the server that holds the run's driver answers. Others answer 409, "goes on another
    server", as `/step` does today.
  - An answer from a pause that has ended is 410.
- **Commands:** `retry`, beside Step, Continue, Pause and Stop on `POST /runs/:id/step`.
- **Who may use it:**
  - The person who started the run drives it and inspects it.
  - Administrators may also.
  - Starting a debug run needs read and write (rw) on the flow, or operator where a new workspace
    setting **Operators may debug** is on (off by default).
  - Others watching see the pause and the reason, but no variables, Evaluate or buttons.
- **MCP:** a new `run_inspect` tool, listed only on tokens with `mcpRunControl`, as `run_step` is.
- **Audit:**
  - `run.debug.inspect` with the op, and with the expression for `eval`/`watch`, never the result;
  - `run.step` with `retry`.
- **Kept after the run:** the answers to `scopes` and `watch` at each pause (already masked) stay
  in a `run_debug` table, limited to 1 MB per run and deleted with the run by retention. A finished
  run's pauses can then be read later.
- **The page:** a Debugger panel beside the Run panel on the run page and on the canvas:
  - a host picker that starts at the first failed or matching host;
  - scopes as a tree that opens lazily;
  - Watch, with "compare across hosts" grouping the hosts by value;
  - an Evaluate box;
  - the pause reason line;
  - Retry on a failure pause, with the warning that the step runs again.
  - Keys as in 1.1: F10 Step and F8 Continue/Pause. Ctrl+Enter evaluates.

### 2. Run again, Only the hosts that did not go well, Debug this failure (AFS-214, AFS-44, AFS-213; spike AFS-234)

- **Host sets from a run's summary:**
  - **failed**;
  - **unreachable**;
  - **stopped**: hosts in a stopped run that neither failed nor reached an end;
  - **handled**: a wired fail port took the host to an end that did not fail. This counts as going
    well.
  - **not-ok** = failed + unreachable + stopped.
  - Hosts that were never reached cannot be listed, and the page says so.
- **Where a host failed:** the earliest failing node, which is the inner step inside a subflow. A
  rolling subflow is one play, so its point is the subflow itself.
- **Relaunch body:** `POST /runs/:id/relaunch` with
  `{hosts: "all"|"not-ok"|"failed"|"unreachable"|"stopped"|[names], includeHandled?, mode?,
  step?: {every, points, timeoutMinutes, debug, pauseOnFailure} | null, commit?: "same"|"newest"}`.
  - `{}` keeps 1.1's behaviour.
  - 409 while the old run is going.
  - 422 for an empty set, a run that never ran, an unknown host, a pause point missing from the
    flow at `newest`, or `newest` on a dev run.
- **Limit:** the hosts go to a **limit file**, `--limit @<run dir>/limit.txt`, written by the
  server.
  - On the command line, a host named `!x` or `&x` makes **every** inventory host run, and commas
    split names.
  - Names with `[ ] * ?`, or a leading `! & ~ @`, are written as anchored regexes (`~^…$`).
  - Up to 5,000 hosts, each one a host of the old run.
  - `@file` replaces the old run's limit; it cannot be combined with it.
- **Same checks as a launch.** A relaunch goes through the launch's checks of who may run what with
  which credentials. Today it copies the credentials unchecked; that is fixed as AFS-238.
- **Approvals:** a relaunch asks every approval again.
- **The page:**
  - "3 of 40 hosts did not go well: 2 failed at Apply config, 1 unreachable"; unreachable hosts
    are counted too (AFS-239).
  - Run again ▾: **Run again** · **Change and run** (the launch form prefilled, with a line naming
    what differs) · **Only the N hosts that did not go well** · **Debug this failure**.
  - Debug this failure: check mode, step by step, the not-ok hosts, the same commit, a pause before
    the failing step, and pause on failure on. A **Real** tick asks for confirmation, names the
    hosts, and says that a failure after an approval means passing that approval again.
- **Risks to show in the form:**
  - steps that run on localhost or a controller host are skipped by a host limit;
  - failure percentages, rolling batches and `run_once` work on the smaller set.

### 3. External secrets (AFS-47; spike AFS-235)

- **Secret providers:** an administrator's list (Administration › Secret providers), a
  `secret_provider` table built like the OIDC providers.
  - Kinds: `vault` (HashiCorp Vault, AppRole or token), `conjur` (CyberArk Conjur, host API key),
    `ccp` (CyberArk Central Credential Provider, AppID and client certificate), `aws` (Secrets
    Manager, access key; assuming a role comes later).
  - Open settings: address, CA, timeout, and the kind's own fields. The secret part is sealed
    under `secret-provider:<id>`.
  - Each provider lists the workspaces allowed to use it.
  - Key rotation reseals provider secrets too.
- **References:** any secret field of any credential kind is either stored, as today, or **taken
  from a provider**. The reference is kept in `credential.refs`: `{provider, mount, path, field}`
  for Vault, `{provider, safe, folder, object}` for CCP, and the like.
  - Workspace administrators see the reference path, because they need it to fix a broken
    credential. Others see only "from <provider name>".
- **When values are read:** in `runCredentials()`, still the only place values are resolved, with
  one resolver per run.
  - Read once, when the run really starts (after an approval, or at a schedule's time).
  - Cached for that run only and never stored. Vault tokens the run signed in with are revoked at
    its end.
  - A failed read fails the run before any container starts.
- **Masking:** resolved values join the run's hidden list and `AFD_SECRETS_FILE`. The engine then
  masks them as `external` (ADR-0040 §4). A JSON secret is hidden whole and value by value.
- **Errors:**
  - The run's output says provider, connection, status and the kind of error, never the path:
    "Vault refused the read (403): connection "corp-vault" may not read this secret".
  - Conjur answers 404 both when a variable is missing and when it may not be read, so the words
    say "no such variable, or it may not be read".
  - The provider's raw text, which names the path, goes only to the server log.
- **Code:** no new packages. Requests go through `node:https`, which allows a CA and a client
  certificate per connection, and AWS requests are signed with our own SigV4 (checked against the
  AWS SDK's signer). The lab runs on the GNS3 VM: Vault 2.2.2, Conjur OSS 1.27.0, LocalStack
  4.14.0 and a CCP mock.

### 4. Event streaming (AFS-53; spike AFS-236)

- **Destinations** (Administration › Event streaming):
  - **Syslog:** RFC 5424 over TLS (RFC 5425 octet framing), or over TCP or UDP.
    - Facility 13 (log audit) by default.
    - MSGID is the action.
    - SD elements `audit`, `actor`, `object` and `detail` with lowercase names.
    - The BOM is a setting.
    - An enterprise number setting (default: the documentation number 32473, until we register
      our own).
  - **OpenTelemetry:** OTLP/HTTP JSON.
    - Audit entries become log records.
    - Each run becomes a trace: a root span `RUN <flow>`, a `queue` span, and one `STEP <key>`
      span per step. Host counts per port and the time spent waiting are attributes, and the
      events per host are capped. Flow inputs are never included.
    - Trace and span ids are derived from the run id, so sending a run twice shows it once.
- **What is sent:** audit entries, and the start and end of each run. Run events go to syslog only
  as lines at the start and end of a run.
- **Delivery:** a `stream_delivery` outbox per destination, unique on (sink, kind, ref).
  - It is copied from the notification outbox (`takeDue` works across servers), not a "last id"
    cursor: audit ids are random, so a row that commits late would be skipped.
  - Syslog has no acknowledgement. Rows are `inflight` until the connection has stayed up for a
    3 s window, then they are sent. Receivers remove repeats by audit id; the spike lost nothing,
    with about 210 repeats per restart at 100 messages/s.
  - The backlog keeps at most 100,000 rows or 7 days. Past that the oldest are dropped and
    counted.
  - Metrics: the backlog, its age, the drops and the last success. A notification event
    `stream.failing`.
  - Replaying a time range from the audit table comes later.
- **Code:** our own senders, about 470 lines, with no new packages. `@opentelemetry/sdk-node` is
  68 packages, 37 MB and takes 1.4–2.3 s to import, and it would duplicate our outbox. A contract
  test posts to a real collector in Docker.

### 5. API documentation (AFS-199; spike AFS-237)

- **Page:** Scalar (`@scalar/api-reference`, MIT, about 1.3 MB gz). It is loaded lazily on that one
  page only.
  - Its own Vite entry, `apidocs.html`, is framed in `/docs/api` within the app shell, as
    `viewer.html` is. The theme is passed by query and by `postMessage`.
  - Its own CSP adds only `style-src 'unsafe-inline'` and `frame-ancestors 'self'`. Scripts stay
    `'self'`, and every other page keeps the strict policy.
  - Settings: `agent`/`mcp` off, `telemetry:false`, `withDefaultFonts:false`. With these it makes
    no requests outside the server.
  - Fallbacks: RapiDoc (181 KB) if size matters; Swagger UI if the CSP must not change.
- **Try it:**
  - It uses the session.
  - A pasted token is kept in memory only.
  - When a token is set, requests omit cookies, because the server reads the session before the
    bearer header.
  - Requests other than GET ask before sending.
  - `servers[0].url` is relative (`/`), so it works behind a TLS proxy.
- **Response schemas:**
  - Hand-written JSON Schema for about 15 main resources, set in a new `RouteDoc.returns` used by
    `openApi()`.
  - A test-only ajv check of every 2xx answer in the route tests, to catch drift.
  - Not Fastify `response` schemas, because those drop unknown fields without a word.
  - First the run, flow, launch, approval and token routes (about 60), then the rest.
- The current renderer goes away: Scalar shows the same groups.

### 6. Actions on their own page (AFS-201), implied approvers (AFS-224)

- An action's settings (title, sentence, inputs, links, grants) are edited on `/actions/:id/edit`,
  for rw on its configuration. The launch configuration's Settings keep one line linking there.
  `ConfigActionSection` moves as a whole.
- An empty Approvers field shows who will be asked, as a tooltip and a line under the field (the
  workspace's default approvers).

## Consequences

- New tables:
  - `run_debug`;
  - `secret_provider`;
  - `stream_sink`, `stream_delivery`;
  - `credential.refs`.
- New routes:
  - `/runs/:id/inspect`;
  - the relaunch body;
  - `/admin/secret-providers`;
  - `/admin/streams`.
- New MCP tool: `run_inspect`.
- Lab containers next to staging (AFS-233): Vault, Conjur, LocalStack, a CCP mock, rsyslog with
  TLS, an otel collector and Jaeger. Start scripts are in the spike folders.
- Every new route is listed in `api/catalog.ts` with its access level, its audit action and its
  response schema.
