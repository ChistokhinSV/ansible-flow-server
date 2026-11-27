# Event streaming

[The guide](README.md)

Administrators can forward [audit entries](audit.md) and run summaries in real time to a SIEM or
observability backend under **Govern › Server › Event streaming** (`/admin/streams`):

| Destination       | Audit entries                              | Runs                                                                             |
| ----------------- | ------------------------------------------ | -------------------------------------------------------------------------------- |
| **Syslog**        | One RFC 5424 message per entry             | `run.started` and `run.ended` structured messages (`run@32473`)                  |
| **OpenTelemetry** | One OTLP log record (`afs.audit.<action>`) | One OTLP trace on completion (queue span + per-step spans with port host counts) |

Flow input values and secrets are never exported to either destination.

## Syslog and OpenTelemetry settings

- **Syslog**: supports **TLS** (RFC 5425, port `6514` default, optional custom CA), **TCP** (octet
  counting or newline framing) and **UDP** (labs only). Facility (`13` default), enterprise number
  (`32473`), hostname and BOM are configurable under **More options**. Deduplicate replayed messages
  on reconnect using `audit@32473 id`.
- **OpenTelemetry**: sends gzipped OTLP/HTTP JSON to `<endpoint>/v1/logs` and `<endpoint>/v1/traces`
  (for example `https://collector.example.com:4318`), with encrypted custom headers (`Authorization`,
  `api-key`), `deployment.environment.name`, and optional host names on spans. Audit entries for a
  run share its `traceId`.

Click **Test** on any destination to send a probe immediately and see plain-language diagnostics
(untrusted CA, hostname mismatch, gRPC port used instead of HTTP `4318`, or unreachable host).

## Outbox and backpressure

While a destination is unreachable, events queue in the database (up to `100,000` rows or `7` days
by default) and drain in order in batches of `500` with exponential retry (5 s up to 1 min).
Administrators are [notified](notifications.md) after 15 minutes of continuous failure, and backlog
metrics are exposed on `/metrics` (see [Operations](operations.md)).
