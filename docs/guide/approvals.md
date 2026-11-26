# Approvals

[The guide](README.md)

![A run waiting at an approval: the approver decides beside the canvas](images/run-waiting.png)

![The Approvals page](images/approvals.png)

A **real** run of a flow with **approval** steps on its top level runs in segments: the server
runs it until hosts wait at an approval, records what waits and lets the run go (it takes no
place among the runs going and holds no container). Someone allowed decides; the run then goes back to the queue and
continues with the hosts that waited, through the approval's `approved` or `rejected` port. A
server that stops and starts again keeps the run waiting.

- **Who decides:** whoever has the `approve` grant on the flow or its workspace (see
  [Access levels](people-and-sign-in.md#access-levels)); when the approval names `approvers` (users or groups, in the
  flow), only they. Administrators may always decide. When editing a flow in the pages, an empty
  **Approvers** field names who will be asked (the people and groups holding approve), and so
  does an action's **What will happen**.
- **Not who launched the run**, unless an administrator lets the workspace allow it (Access, on
  the workspace's page, or `PATCH /api/v1/workspaces/<id>` with `{"selfApprove": true}`). Who
  launched it reads "You launched this run, so others decide its approvals" and who does, from
  the pages and the API alike. A deciding group they are in is named by its other members
  ("Sam Reyes (change-board) decides it"). The request email says the launcher does not decide
  it only when they would otherwise be asked (one of the approvers, or holding approve).
- **A comment** goes with every decision; the run, its page, its canvas and the audit log keep
  who decided, when and why. Rejecting needs one: the server refuses a rejection without a
  comment, from the pages, the canvas, the API or an agent. On the pages and the canvas,
  **Approve…** and **Reject…** ask once more, keep your comment in sight and name the step the
  hosts go to; each approval names who may decide it (people by name, groups by name).
- **A run that fails after a rejection** reads as **rejected** (or **not decided in time**), not
  failed, in the lists, on its page, on the flow page's Run panel and in its output, and says
  why (`Rejected at <approval> by <name>: <comment>`). The Runs page filters it under
  **Rejected** (`state=rejected`; `state=failed` leaves it out), and Home counts it as rejected.
  A host's own output ends with the approval it waited at, how it was decided, and where it
  ended. The decision email names the step the hosts go to.
- **The request email** carries the approval's message (or, without one, its step's intent),
  the hosts waiting, the run's inputs (secret-looking values as `***`), whether it is a real run,
  and when it times out. The Approvals page and the run's page show the same, how long it has
  waited, and **Who decides**.
- **What a decision lets happen** is said on the approval before anyone decides, on the
  Approvals page and on the run's page (the side bar's Details view):
  - **If approved:** the steps the hosts go through, in order, to an end or to a step where the
    way branches ("The hosts go on: Upgrade › Post-checks › Done");
  - **If rejected:** the step the hosts go to;
  - **If nobody decides:** when it times out, and where the hosts go then;
  - **Evidence:** the last check run of the same launch configuration that had ended when this
    run was launched (what was known then), how it went, when, and whether it ran at the same
    commit, with a link to it ("No check run of this launch configuration before this run" when
    there is none).

  On a phone, **Approve…** and **Reject…** stay at the bottom of the screen while you read the
  approval.
- **Timeout:** an approval with `settings.timeout` that nobody decides in time times out: its
  hosts take the approval's `timeout` port (or `rejected` when it has none).
- **A stopped run** asks nobody any more.
- **A check run** (skeleton) asks nobody: its approvals pass by themselves, as a skeleton run in
  VS Code does, and nobody is notified. Launch a real run to have approvers decide.
- The approval's `message` (else the step's `intent`) is shown to whoever decides and sent with
  the request to decide;
  `notify` names others who are told (see [Notifications](notifications.md)).
- Approvals inside subflows, or two that can wait at once, cannot be split: such a flow does not
  launch (the designer says why, `awx-segments`).

Decide on the **Approvals** page (what waits for you, and for others), on the run's page, or on
the canvas (the approval's Run tab), or:

```sh
curl -H "Authorization: Bearer $AFS_TOKEN" -H 'content-type: application/json' \
  https://flows.example.net:8443/api/v1/runs/<id>/approvals/approve \
  -d '{"decision":"approved","comment":"Window confirmed with the NOC"}'
```

| Address (under `/api/v1`)           | Does                                                                                                                                                                                                             | Who                          |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `GET /approvals`                    | What waits for a decision that you may see, each with whether you may decide and the hosts waiting; `?decided=1`: the newest 50 decided                                                                          | signed in                    |
| `GET /runs/:id/approvals`           | A run's approvals: waiting or decided, by whom (`decidedByName`), when, why; `mayDecide`, `why`; `deciders` (who may decide); `next`, `after` (the steps once approved) and, while it waits, `evidence.checkRun` | `ro`                         |
| `POST /runs/:id/approvals/:node`    | Decide one (`approved` or `rejected`, `comment`); the node by id or key                                                                                                                                          | `approve`, and the approvers |
| `GET /projects/:id/approvers?path=` | Who an approval of the flow asks when its approvers are empty (`approvers`, by name), and `selfApprove`                                                                                                          | `ro` on the flow             |
