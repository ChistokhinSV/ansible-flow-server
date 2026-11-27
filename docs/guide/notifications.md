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

## Email, webhooks and signing

- **Email (SMTP)**: administrators configure SMTP (`STARTTLS` on `587`, `TLS` on `465`, or local
  relay) under **Govern › Server › Notifications** (`/admin/notifications/settings`,requires an
  administrator password session). Set `AFS_PUBLIC_URL` so links in messages resolve.
- **Webhooks and headers**: payloads are JSON with a Slack / Mattermost / Rocket.Chat compatible
  `text` line plus `event`, `at`, `server`, `run` and `approval`. Every delivery sends:
  - `X-AFS-Event` (event type, e.g. `approval.waiting`),
  - `X-AFS-Delivery` (unique delivery ID),
  - `X-AFS-Timestamp` (timestamp needed to verify the signature), and
  - `X-AFS-Signature: sha256=<hex>` — HMAC-SHA256 of `<timestamp>.<body>` using the webhook signing
    key (once generated on the settings page).
    Generating a new signing key **immediately invalidates the previous key**, and HTTP **redirects
  are never followed**.
- **Recipients and access**: anyone sets their own email on **Account › Profile**; administrators
  set user/group webhook URLs and group emails under **Govern › People**. Run notifications are sent
  only to people who currently have permission to view that flow's runs.
- **Secrets and retries**: credentials and secrets never appear in notifications (webhook payloads
  omit run inputs entirely; approval emails mask secret-like inputs as `***`). Transient network,
  `408`/`429`/`5xx` or SMTP `4xx` errors retry from the database outbox after 1, 5 and 15 minutes,
  then 1 and 3 hours; permanent `4xx` / SMTP `5xx` refusals do not retry.

The [API reference](/docs/api) lists every `/api/v1/notifications` endpoint and who may call it.
