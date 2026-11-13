# ADR-0022: Notifications

- Status: accepted (2026-11-13, AFS-29). Builds on ADR-0013 (the master key), ADR-0015 (the queue),
  ADR-0018 (the audit log), ADR-0020 (access levels), ADR-0021 (approval gates)
- Context: an approval is only useful when its approvers learn that it waits; a failed nightly
  run when someone hears of it; a certificate's end before it comes. People and groups already
  have an email address and a webhook (ADR-0007)

## Decision

**An outbox in the database.** An event is turned into one message per place (email address or
webhook) and written to `notification` first; a loop (every 10 s, and at once after an event)
sends what is due. So a restart loses nothing, two servers on one database do not both send
(a server takes a message by moving its next try two minutes ahead, conditionally on the value it
read), and the same table is the delivery log administrators read.

- **Tries again** on what can pass (network errors, 408, 429, 5xx, SMTP 4xx): after 1, 5, 15
  minutes, 1 and 3 hours, then given up on (`failed`, with the last error; **Try again** resets
  it). A refusal is not tried again. A test message is tried once: its sender reads the answer.
- **What happens never waits for a notification** and never fails because of one: the events
  are told after the change is in the database (`RunQueue.onEnded` after the transaction), the
  work runs in the background, errors are logged.

**Events and who is told:**

- `approval.waiting`: the approvers the approval names (users or groups), else whoever holds
  `approve` on the flow or its workspace (not administrators as such: they could decide
  anything, and would be told of everything); never who launched the run unless the workspace
  allows self-approval; and the approval's `notify` list.
- `approval.decided` (approved, rejected, timed out): who launched the run, and `notify`.
- `run.ended`: as the launch configuration says (`notify: {when: failed | ended, to}`), checked
  when it is saved (names the server has). Every way a run ends counts: finished, stopped while
  queued or waiting, lost.
- `certificate.expiring`: administrators, at 30, 14, 7, 3 and 1 days and once ended; each step
  once per certificate (`dedupe` key: fingerprint and step), whatever restarts between.

**Where:** a person at their email and webhook; a group at its own, or through each member when
it has neither; disabled accounts never; one address once per event.

**Channels** behind one interface (`send(target, message) → sent | retry? + error`), so Telegram
and a Slack app (AFS-41, AFS-42) are channels added later:

- **Email** with nodemailer through a relay set on the Notifications page (`tls`, `starttls`
  required, or `none` for a relay on the network). Its password is sealed with the master key
  (`setting:notify.smtp.password`); setting it needs a session, as a token that leaked must not
  redirect mail.
- **Webhook:** a POST of the event as JSON with `text` (what Slack, Mattermost and Rocket.Chat
  incoming webhooks show) instead of a separate "Slack format": one payload serves both.
  Signed when an administrator has made a key (shown once, sealed): `X-AFS-Signature: sha256=`
  HMAC of `<timestamp>.<body>`, with `X-AFS-Timestamp` against replays. Redirects are not
  followed.

**Nothing secret in a message:** the run as what it is (number, flow, project, state, who
launched, error, link), never its inputs; a webhook's address is shown as its host only
(`https://hooks.example.net/…`) in the log, the API, the server's log and errors, as its path
is often its secret. Links use `AFS_PUBLIC_URL`; without it messages carry none.

**`secrets rotate`** seals again every sealed value: credentials, runs' inputs (it missed those
before), the relay's password and the webhook key.

## Consequences

- Contacts are set by administrators (API, until the pages for people, AFS-56); a person cannot
  set their own webhook, which would let them make the server call any address.
- One payload shape for all receivers; a receiver that wants another shape (Teams cards, a
  Slack app with buttons) is a channel of its own.
- Messages go out from the server that wrote them or any other on the same database; a server
  that dies while sending leaves the message to be taken again after two minutes (a receiver
  may get it twice: `X-AFS-Delivery` is the same).
