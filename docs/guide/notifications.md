# Notifications

[The guide](README.md)

The server tells people what concerns them, by email and by webhook:

| When                                         | Who is told                                                                                                           |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| A run waits at an approval                   | Its approvers: those the approval names, else whoever holds `approve` on the flow or workspace; and its `notify` list |
| An approval is approved, rejected, timed out | Who launched the run, and the approval's `notify` list                                                                |
| A run ends                                   | As its launch configuration says: when a run fails (or is lost), or whenever one ends                                 |
| The server certificate nears its end         | The administrators, 30, 14, 7, 3 and 1 days before, and once it has ended; each step once                             |

- **Where:** a person at the email address and webhook their account has; a group at its own,
  or, when it has neither, through each of its members. Disabled accounts are told nothing; an
  address reached two ways is told once. Who launched a run is not asked to approve it unless
  the workspace allows self-approval.
- **Email** goes through the mail server an administrator sets on the **Notifications** page
  (`/admin/notifications`): STARTTLS (587, required), TLS (465), or a relay on the network as it
  allows. Its password is kept encrypted with the master key and never shown.
- **A webhook** gets the event as JSON, with a `text` line that Slack, Mattermost and
  Rocket.Chat incoming webhooks show:

  ```json
  {
    "text": "Firewall upgrade, run 7 (net / edge) waits for a decision at \"Approve the change\". ...",
    "event": "approval.waiting",
    "at": "2026-11-13T10:00:00.000Z",
    "server": "https://flows.example.net",
    "run": {
      "id": "7c1e2a90-...",
      "number": 7,
      "state": "waiting",
      "flow": { "file": "flows/upgrade.flow.yaml", "name": "Firewall upgrade" },
      "project": { "key": "edge" },
      "workspace": { "key": "net" },
      "requestedBy": "dana",
      "link": "https://flows.example.net/runs/7c1e2a90-..."
    },
    "approval": { "node": { "key": "change-approval", "title": "Approve the change" }, "status": "waiting" }
  }
  ```

  Headers: `X-AFS-Event`, `X-AFS-Delivery` (the message's id), `X-AFS-Timestamp`, and, once an
  administrator has made a key (shown once), `X-AFS-Signature: sha256=<hex>`: HMAC-SHA256 of
  `<timestamp>.<body>` with the key. Redirects are not followed.
- **Never in a message:** a run's inputs, a credential, a secret. Links need `AFS_PUBLIC_URL`.
- **Tries again** on a network error, a busy relay or receiver (408, 429, 5xx, SMTP 4xx): after 1,
  5 and 15 minutes, 1 and 3 hours, then it is given up on. A refusal (other 4xx, SMTP 5xx) is
  not tried again. Messages wait in the database: a restart loses none.
- **The delivery log** on the Notifications page lists each message, where it went (a webhook by
  its host only: its path can be its secret), how many tries and why one failed, with **Try
  again**. Messages sent or given up on are kept `AFS_NOTIFICATIONS_KEEP_DAYS` (30).

A launch configuration says whom its runs tell (`notify`, see
[Launch configurations](launch-configurations.md)):

```json
{ "notify": { "when": "failed", "to": ["network-oncall", "dana"] } }
```

| Address (under `/api/v1`)         | Does                                                                        | Who                   |
| --------------------------------- | --------------------------------------------------------------------------- | --------------------- |
| `GET /notifications`              | The delivery log (`status`, `event`, `run`, `before`, `limit`)              | administrators        |
| `POST /notifications/:id/retry`   | Try a message given up on again                                             | administrators        |
| `GET /notifications/settings`     | The mail server (never its password), whether webhooks are signed           | administrators        |
| `PUT /notifications/smtp`         | Set the mail server: `host`, `port`, `security`, `user`, `password`, `from` | administrator session |
| `DELETE /notifications/smtp`      | Send no email                                                               | administrator session |
| `POST /notifications/webhook-key` | A new signing key, in this answer only; the old one stops working           | administrator session |
| `POST /notifications/test`        | Send a test now (`channel`, `to`; no `to`: your own address); tried once    | administrators        |

Everyone sets their own email address on **My account** (`/account`, or `PATCH /api/v1/session`
with a session). A webhook is set only by an administrator (the server calls the address it is
given): their own on **My account**, anyone's with `PATCH /api/v1/users/<id>`, a group's with
`PATCH /api/v1/groups/<id>` (`email`, `webhookUrl`).
