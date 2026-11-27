# The audit log

[The guide](README.md)

![The audit log grouped by day](images/audit.png)

Every action that changes server state — or tries and is refused — writes an immutable entry to the
audit log:

- **What is recorded**: timestamp, actor (and token name if used), source (`ui`, `api`, `git`,
  `mcp`, `cli`), action (`run.launch`, `grant.change`, `session.sign-in`, `secret-provider.read`,
  …), target object ID and display name (preserved even after deletion), outcome (`ok`, `refused`,
  `failed`), HTTP status, client IP and request ID.
- **No secrets**: request text and secret values are never logged — only changed field names,
  booleans, numbers, refusal reasons and approval decision comments.
- **Viewing and exporting**: administrators browse entries grouped by day under **Govern › Audit
  log** (`/admin/audit`), filter by actor, category, outcome, source or date range, and export up to
  50,000 matching entries as **CSV** or **JSON** (`/api/v1/audit/export`).
- **Retention**: entries older than `AFS_AUDIT_KEEP_DAYS` (`365` by default; `0` keeps forever) are
  pruned hourly. For continuous forwarding to a SIEM, see [Event streaming](event-streaming.md).
