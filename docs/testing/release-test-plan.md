# Release test plan: Ansible Flow Server

Every release candidate is tested by hand on staging before it is released
([RELEASING.md](../../RELEASING.md)). This plan has two parts:

- **Core**: every check below, for every candidate. They cover what people rely on; a check that
  cannot be done (a lab device is down) is written down as not done, with why, and does not pass.
- **What changed**: for each line under `## Unreleased` in the CHANGELOGs of the server, the
  collection and the designer, at least one check that does what the line says, written into the
  release ticket before testing starts.

The designer's own plan (the VS Code extension alone) is in the designer repository,
`docs/testing/release-test-plan.md`; a candidate that changes the designer goes through both.

Staging: `https://192.168.200.128:9443`. People: `dana` (administrator), `olga` (operator on
`network`), `andre` (approve, through the group `change-board`), `nina` (ro). Use a private
browser window per person. Fictional names only in anything kept (screenshots in tickets).

Labs beside staging, started before testing (`test/e2e/labs/README.md`): `secrets` (Vault,
Conjur, AWS, CCP) for checks of secret providers, `streaming` (syslog, OpenTelemetry) for event
streams, `identity` (Keycloak, OpenLDAP) for 2.6. A check whose lab is not running is `not done`.

## Results

Copy into the release ticket and fill in: `pass`, `fail` (with a ticket), or `not done` (with why).

| #   | Area                            | Result | Notes |
| --- | ------------------------------- | ------ | ----- |
| 1   | Deploy and upgrade              |        |       |
| 2   | Sign-in and access              |        |       |
| 3   | Projects and git                |        |       |
| 4   | Flows in the pages              |        |       |
| 5   | Launch configurations and runs  |        |       |
| 6   | Approvals                       |        |       |
| 7   | Schedules                       |        |       |
| 8   | Execution environments          |        |       |
| 9   | Credentials and lab hosts       |        |       |
| 10  | Notifications                   |        |       |
| 11  | API, MCP and the collection     |        |       |
| 12  | The designer with the server    |        |       |
| 13  | Audit log                       |        |       |
| 14  | Operations                      |        |       |
| 15  | Pages: themes, widths, errors   |        |       |
| 16+ | What changed (one row per line) |        |       |

## 1. Deploy and upgrade

1. Deploy the candidate on staging (RELEASING.md, with the backup first). The log has no `ERROR`;
   it names the database changes it made, if any.
2. `curl -k https://192.168.200.128:9443/api/v1/meta`: `version` is the candidate's,
   `designer.version` the designer's it carries, `features` lists at least what the last release
   listed.
3. `curl -k https://192.168.200.128:9443/readyz`: ready (every check ok).
4. What the last release left is still there: workspaces, projects, launch configurations, the
   runs list with its last runs, their pages (canvas, output), the audit log's older entries.
5. A browser that had the pages open before the upgrade reloads into the new version (no blank
   page, no error about missing files).

## 2. Sign-in and access

1. Each of the four signs in with a password. A wrong password is refused with a message; the
   sixth wrong one in a row is refused for a while.
2. `nina` (ro) sees the `network` projects and runs; has no Launch, Stop, Run again, Edit or
   Settings; the canvas offers no Run.
3. `olga` (operator) launches a configuration and stops her run; cannot edit a flow, add a
   configuration or change access.
4. `andre` decides approvals (section 6); `dana` changes access: **Access** → **Give access**,
   then **Take back**; the change shows at once for the person (reload).
5. **My account**: make an access token, use it with `curl -H "Authorization: Bearer …"
   …/api/v1/session`, revoke it; the next call is refused (401).
6. **OIDC and LDAP**, with the identity lab (`test/e2e/labs/identity`, running beside staging and
   trusted through `AFS_CA_FILE`): run `test/e2e/identity/on-vm.mjs` (see
   `test/e2e/labs/README.md`). Then by hand: **Sign-in** → **Add a provider** for the lab's Keycloak
   with a mapping `net-ops` → a group with access to `network`; `sam.reyes` signs in from the
   sign-in page in a private window and sees `network`. Add him to another group by hand, take
   the mapping away, sign him in again: the group added by hand stays, the mapped one is gone. An
   **LDAP directory** (**Add a directory**) for the lab's OpenLDAP tests ok; `nora.lind` signs in with her password and
   gets the group her `change-board` mapping names. Remove what you added.

## 3. Projects and git

1. As `dana`: **Add project** from a sample (each sample in turn on a new key): the project
   starts with its files and flows; its Overview lists them.
2. A project with an external source (a repository of the lab's git server, or GitHub over
   HTTPS with a token credential): **Sync** brings a commit pushed there; the project's state
   says when it last read the source.
3. **Work on it with git**: clone the hosted project with an access token as the password, commit,
   push. The push is in the project's pushes and the audit log; a `ro` token's push is refused.
4. **Files**: open a file, change it, add one, move one, **Save** as one commit; the branch shows
   the commit by the person. A Save after someone else changed the same file lists the files
   and offers what to do.
5. **Branches**: make a branch, see it in the list, delete it.

## 4. Flows in the pages

1. A flow's page shows the flow on the canvas; levels (subflows) open; the run list shows
   earlier runs with their host counts.
2. Select a step: its Details show; **Binding** shows the module's docs (not "Reading the docs…"
   for long); **Full Docs** opens a new tab (docs.ansible.com for ansible.builtin, Galaxy for
   others). Fields cannot be typed into.
3. **Edit** (as `dana`): add a step, bind it to `ansible.builtin.ping` found by search, wire it,
   set a parameter; **Save** makes one commit. A second person in the same draft sees the edit
   live and who is there.
4. Step search finds `chistokhinsv.ansible_flow.run` with its docs (the collection every run has).
5. **Insert Shared Subflow…** from the library project (a project made a library in its Settings):
   the copy is pinned and listed on the flow's page.
6. A link in a note on the canvas opens in a new tab.

## 5. Launch configurations and runs

1. **Add a launch configuration** for the edge baseline sample (inputs `site`, `devices`); the
   Launch tab's **What would run** lists the hosts the inventory gives.
2. **Launch** in Check mode: the run's page shows the run live on the canvas (hosts per wire,
   steps going green), then its hosts, what ran, and **To the output**. The canvas shows no run
   buttons or run summary of its own; a selected step shows each host's output.
3. A Real run: the same, and the run is "real run".
4. **Stop** a long run (a flow with a pause): it ends as stopped, by whom; the canvas says so.
5. **Run again** on an ended run: a new run with the same inputs and commit.
6. A run that fails on one host: the run page lists that host first with why ("Why … failed").
7. A flow with **Run outputs** (designer 0.97+): the run page's **Outputs** shows each host's
   values.
8. The **Runs** list: filters (state, Mine, project and configuration) and older runs.

## 6. Approvals

1. As `olga`, launch a Real run of the firewall upgrade sample: it stops at **Change approval**,
   waiting for a decision.
2. `andre` sees it on **Home** (Waiting for you), on **Approvals** (the count in the menu), and is
   told (section 10). `olga` and `nina` cannot decide (no buttons; the API answers 403).
3. `andre` **Approve**s with a comment: the hosts go on; the decision and comment are on the run
   page and in the audit log. Another run: **Reject** sends the hosts to Not approved.
4. A Check run of the same flow passes the approval by itself.
5. **Stop** a run that waits: the approval says it was cancelled, by whom.

## 7. Schedules

1. On a configuration's **Schedules**, **Add schedule** to run once a few minutes from now: the
   run starts on time, as the configuration's owner, marked scheduled.
2. A repeating schedule (cron): the next time shown is right in the server's time zone; disable
   it, and no run starts at that time.

## 8. Execution environments

1. In the workspace's **Execution environments**, make one from a spec with a collection
   (`ansible.utils latest`) and build it: the build log ends well, the lock lists the versions.
2. A configuration using it runs; the run log names the image.
3. **What the flow needs** on the configuration lists the flow's collections against the image.

## 9. Credentials and lab hosts

1. **Add credential**: an SSH key for the lab's devices; it is never shown back (only that it is
   set).
2. A Real run against lab devices (an inventory of GNS3 lab hosts, e.g. a router's `show version`
   with `ansible.netcommon`) succeeds and its output shows the devices' answers.
3. The run's output and the audit log show no secret (key, password, token).

## 10. Notifications

1. **Notifications**: send a test email (staging's mail server) and a test webhook; both arrive;
   the delivery log says sent.
2. The approval of section 6 told `andre` by email (with a link to the run) and the group's
   webhook.
3. A configuration set to tell when a run fails: a failing run tells the person.

## 11. API, MCP and the collection

1. The API reference page opens; `GET /api/v1/runs?limit=1` with a token answers the newest run.
2. An MCP client (Claude Code with an access token) lists the tools, launches a configuration
   (`run_launch`) and follows it (`run_status`) to its end; `run_status` has the run's outputs.
3. A flow that launches another with `chistokhinsv.ansible_flow.run` (`wait: true`) and uses its
   `outputs` succeeds, with no url or token set in the flow.

## 12. The designer with the server

In VS Code with the designer candidate's VSIX:

1. Set `afd.runner.url` to staging and sign in with a token; **Run on Server** launches the flow's
   configuration and follows the run on the canvas.
2. A **dev run** of an unpushed change runs in check mode and shows on the server marked dev run.
3. **Set Up Git for the Server** (self-signed certificate): pulling and **Show changes** work.

## 13. Audit log

1. Every change made above is in the log: who, from where (pages, API, git, agent), what, result.
2. Names are shown and linked while the thing exists; a push lists its branches; **All of it**
   shows the whole detail.
3. **Export CSV** with a filter downloads the filtered entries; the export is itself logged.

## 14. Operations

1. `/metrics` with the metrics token answers Prometheus text; without it, 401.
2. `backup` (as in RELEASING.md) writes a file; its summary names the database and folders.
3. Restarting the server container: runs that were queued start after; a run that was going is
   marked lost or goes on, as the run page says.

## 15. Pages: themes, widths, errors

1. Dark and light themes on Home, a run page, a flow page and the audit log: readable, nothing
   overlapping.
2. At phone width (375 px) Home and a run page have no sideways scroll; the menu folds.
3. The browser console shows no errors on the pages visited (warnings about the self-signed
   certificate aside).
