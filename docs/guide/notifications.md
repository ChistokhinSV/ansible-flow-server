# Notifications

[The guide](README.md)

The server sends notifications by **email** and **webhook** whenever action or attention is needed:

| Event                                             | Recipients                                                                                                        |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Run waiting at an [approval](approvals.md)        | Named approvers (or `approve` holders on the flow/workspace) + `notify` list                                      |
| Approval decided or timed out                     | Run launcher + the approval's `notify` list                                                                       |
| Run ended                                         | Configured `notify` recipients on the [launch configuration](runs.md#launch-configurations) (`failed` or `ended`) |
| TLS certificate expiring (30/14/7/3/1 d)          | Administrators                                                                                                    |
| [Event stream](event-streaming.md) stalled 15 min | Administrators                                                                                                    |

## Configure channels and recipients

- **Email (SMTP)**: administrators configure SMTP (`STARTTLS` on `587`, `TLS` on `465`, or local
  relay) under **Govern › Server › Notifications** (`/admin/notifications/settings`). Set
  `AFS_PUBLIC_URL` so notification links point to your server.
- **Webhooks**: payloads include a Slack / Mattermost / Rocket.Chat compatible `text` summary plus
  structured `event`, `run` and `approval` fields. Generate a signing key on the settings page to
  sign deliveries with `X-AFS-Signature: sha256=<hex>` over `<timestamp>.<body>`.
- **Recipient addresses**: anyone sets their own email under **Account › Profile**; administrators
  set user and group webhook URLs and group email addresses under **Govern › People**. Only users
  who currently have permission to view a flow's runs receive run notifications.
- **Secrets and retries**: credentials and secrets are never included in notifications (webhook
  payloads omit run inputs entirely). Transient network or `429`/`5xx` failures retry automatically
  with backoff from a persistent database outbox and can be retried manually from the delivery log.
