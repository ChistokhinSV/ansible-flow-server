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
  flow), only they. Administrators may always decide.
- **Not who launched the run**, unless the workspace allows it (Access, on the workspace's page,
  or `PATCH /api/v1/workspaces/<id>` with `{"selfApprove": true}`).
- **A comment** goes with every decision; the run, its page, its canvas and the audit log keep
  who decided, when and why. Rejecting needs one. On the pages, **Approve…** and **Reject…** ask
  once more and say where the hosts go; each approval says who may decide it.
- **A run that fails after a rejection** says so (`Rejected at <approval> by <login>: <comment>`),
  and the decision email says where the hosts go.
- **Timeout:** an approval with `settings.timeout` that nobody decides in time times out: its
  hosts take the approval's `timeout` port (or `rejected` when it has none).
- **A stopped run** asks nobody any more.
- **A check run** (skeleton) asks nobody: its approvals pass by themselves, as a skeleton run in
  VS Code does, and nobody is notified. Launch a real run to have approvers decide.
- The approval's `message` is shown to whoever decides and sent with the request to decide;
  `notify` names others who are told (see [Notifications](notifications.md)).
- Approvals inside subflows, or two that can wait at once, cannot be split: such a flow does not
  launch (the designer says why, `awx-segments`).

Decide on the **Approvals** page (what waits for you, and for others), on the run's page, or on
the canvas (the approval's Run tab), or:

```sh
curl -H "Authorization: Bearer $AFS_TOKEN" -H 'content-type: application/json' \
  https://flows.example.net:8443/api/v1/runs/<id>/approvals/change-approval \
  -d '{"decision":"approved","comment":"Window confirmed with the NOC"}'
```

| Address (under `/api/v1`)        | Does                                                                                                                                    | Who                          |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `GET /approvals`                 | What waits for a decision that you may see, each with whether you may decide and the hosts waiting; `?decided=1`: the newest 50 decided | signed in                    |
| `GET /runs/:id/approvals`        | A run's approvals: waiting or decided, by whom, when, why; `mayDecide`, `why`                                                           | `ro`                         |
| `POST /runs/:id/approvals/:node` | Decide one (`approved` or `rejected`, `comment`); the node by id or key                                                                 | `approve`, and the approvers |
