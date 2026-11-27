# Event streaming

[The guide](README.md)

The server sends its audit entries and its runs, as they happen, to systems of yours: a SIEM or a
log server over **syslog**, or a tracing and logging backend through an **OpenTelemetry
collector**. Administrators add the destinations on **Administration › Event streaming**
(`/admin/streams`).

| Destination   | Audit entries              | Runs                                         |
| ------------- | -------------------------- | -------------------------------------------- |
| Syslog        | One RFC 5424 message each  | One line when a run starts, one when it ends |
| OpenTelemetry | One log record each (OTLP) | One trace when a run ends                    |

Each destination has **On**, **Audit entries** and **Runs**, and a **Test** button that sends one
message now and says how it went, under the buttons. A change takes effect at once: what the
destination was doing stops (a connection to an address that does not answer is given up), what
waits for it is sent on the new settings, and the last error of the old settings is cleared.

When sending fails, the page says why in words, with the code in brackets for a search:

| Last error                                                    | What to do                           |
| ------------------------------------------------------------- | ------------------------------------ |
| Its certificate is not trusted: add the authority (CA) ...    | Paste the receiver's CA in Authority |
| Its certificate is for another name ...                       | Use the name in the certificate      |
| Nothing listens on host:port ...                              | Check the port and that it is up     |
| Not reachable: no answer from host:port                       | Check the address and the firewall   |
| The answer is not HTTP: OTLP/HTTP is usually on port 4318 ... | Use the OTLP/HTTP port, not gRPC     |

An error from before the destination sent again (a receiver that was restarting) stays, marked
"Before it sent again", with its time.

## Syslog

- **Receiver** and **Transport**: TLS (RFC 5425, port 6514, the default), plain TCP, or UDP
  (RFC 5426: messages can be lost and nobody knows; for labs).
- **Certificate authority**: the PEM of the authority that signed the receiver's certificate, when
  the server does not already trust it (`AFS_CA_FILE` adds authorities for everything). The
  receiver's name is checked against its certificate.
- **More options** (folded unless changed or refused):
  - **Facility**: 13 (log audit) by default. **Enterprise number**: the number in the structured
    data names (`audit@32473`); 32473 is the number reserved for documentation.
  - **Host name in messages**: the server's host name when left empty.
  - **Framing**: octet counting (RFC 5425), or one message per line for older TCP receivers.
  - **Byte order mark**: RFC 5424 puts one before the message text; some viewers show it as
    three odd characters. On by default.
  - **Most rows waiting** and **Most days waiting**: queue limits while the destination is down.

An audit entry, wrapped here (one line on the wire):

```text
<110>1 2026-11-23T18:04:00.500Z flows-01 ansible-flow-server 4123 run.launch
 [origin software="ansible-flow-server" swversion="1.2.0"]
 [audit@32473 id="0b6f6a8e-41d2-4c3e-9a51-6c0e2f1d7b03" source="ui" result="ok" status="201" ip="2001:db8::17"]
 [actor@32473 id="u-91aa" login="olga"]
 [object@32473 type="run" id="7c1e2a90-5d3b-4f61-8c2e-0a9b7f3e1d42" name="Firewall upgrade #7"]
 [detail@32473 json="{\"mode\":\"real\",\"number\":7}"]
 olga run.launch run 7c1e2a90-5d3b-4f61-8c2e-0a9b7f3e1d42 "Firewall upgrade #7": ok (201)
```

- The severity follows the result: informational (ok), warning (refused), error (failed).
- MSGID is the action (`run.launch`, `session.sign-in`); the structured data names are lowercase.
- A run's lines have MSGID `run.started` and `run.ended` and an element
  `run@32473` with its number, project, flow, mode, state, who launched it, its hosts and those
  that failed, and how long it took. Flow inputs are never sent.
- A line's time is when it happened, not when it was sent: a destination that was down gets the
  same `run.started` time as the others when what waited is sent. `run.started` is the moment the
  run left the queue; the run page's **Started** is when its worker began, a moment later.

Syslog has no acknowledgement. Messages written on a connection count as sent once it has stayed
up for 3 seconds with nothing left in its buffer; when it drops before that, they are written
again on the next connection. A receiver can see a message twice: it removes the repeats by the
audit entry's id (`audit@32473 id`).

## OpenTelemetry

- **Endpoint**: the collector's OTLP/HTTP address, such as `https://collector.example.net:4318`;
  `/v1/logs` and `/v1/traces` are added. The server sends JSON, gzipped.
- **Headers**: **Add a header** gives a **Name** and a **Value**, sent with each request
  (`Authorization`, `api-key`). Their values are kept encrypted with the master key and never
  shown: leave a value empty to keep it.
- **Environment**: `deployment.environment.name` on everything sent.
- **Host names in traces**: off, a trace has host counts only.

Audit entries become log records named `afs.audit.<action>`, with severity INFO, WARN or ERROR. An
entry about a run (its launch, its stop) carries that run's trace id, so a backend links who
launched it to how it went.

Each run becomes a trace when it ends:

```text
RUN firewall-upgrade    148.7s  error  afs.hosts.total=4 ok=2 failed=2
  queue                   2.6s
  STEP precheck          12.4s         afs.step.port.ok_hosts=4
  STEP backup             7.5s  error  afs.step.port.ok_hosts=3 afs.step.port.failed_hosts=1
  STEP approve           74.7s         afs.step.port.approved=3 afs.step.waited_s=70.1
  STEP deploy            45.6s  error  afs.step.port.ok_hosts=2 afs.step.port.failed_hosts=1
```

The root span has the run's number, mode, state, project, flow, commit and image, and the CI/CD
attributes (`cicd.pipeline.*`); each step's span has its host counts per port, named by the port
(`afs.step.port.<port>`), and, for a step by step run, the time it waited. A step no host reached
(a rollback in a run that went well) has no span. Per-host events are capped at 100 per span; the rest are counted in
`afs.step.hosts_omitted`. The trace and span ids come from the run's id, so a run sent twice is
one trace. Flow inputs are never sent.

A collector that does not answer, or answers 408, 429, 502, 503 or 504, is tried again; any other
refusal drops the batch, says why on the page, and is in the server's log.

## When a destination is down

What a destination should get waits in the database, and is sent when it is back, oldest first,
in batches of 500. The destination is tried again after 5 seconds, then twice as long each time,
up to every minute, without giving up; the page shows the **next try**. Changing the destination,
or a **Test** that reaches it, sends what waits at once. Lines written to a syslog receiver just
before the server stops are sent again when it starts (a receiver removes repeats by the audit
id). The
waiting rows are bounded: at most **100,000 rows** and **7 days** by default (**Most rows waiting**
and **Most days waiting**, under **More options** on each destination). Past either, the oldest are dropped and counted; the audit log says so once an
hour (`stream.dropped`). The audit log itself keeps everything for its own keeping time.

The page shows, for each destination: whether it is sending or failing and since when, how many
rows wait and since when, how many were dropped, and the last error. After **15 minutes** without
sending, the administrators are told (`stream.failing` on the [notifications](notifications.md)
they get), once for each time it starts failing. The e-mail gives the time in UTC; the page gives
it in your time zone and in UTC.

Prometheus ([operations](operations.md)) has the same per destination, labelled by its id:
`afs_stream_backlog`, `afs_stream_oldest_pending_seconds`, `afs_stream_dropped_total` and
`afs_stream_last_success_timestamp_seconds`.

Adding, changing, testing and removing a destination are in the audit log (`stream.*`).

## The API

| Method and path                        | What                                |
| -------------------------------------- | ----------------------------------- |
| `GET /api/v1/admin/streams`            | The destinations, with their status |
| `POST /api/v1/admin/streams`           | Add one (a session, not a token)    |
| `GET /api/v1/admin/streams/<id>`       | One                                 |
| `PATCH /api/v1/admin/streams/<id>`     | Change one (a session)              |
| `DELETE /api/v1/admin/streams/<id>`    | Remove one and what waits for it    |
| `POST /api/v1/admin/streams/<id>/test` | Send a test message now             |

```json
{
  "name": "SIEM",
  "type": "syslog",
  "audit": true,
  "runs": true,
  "syslog": { "host": "siem.example.net", "transport": "tls", "port": 6514, "facility": 13 }
}
```

```json
{
  "name": "Traces",
  "type": "otlp",
  "audit": false,
  "runs": true,
  "otlp": {
    "endpoint": "https://collector.example.net:4318",
    "environment": "production",
    "headers": [{ "name": "Authorization", "value": "Bearer example-token" }]
  }
}
```
