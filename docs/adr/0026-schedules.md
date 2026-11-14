# ADR-0026: Schedules

- Status: accepted (2026-11-14, AFS-34). Builds on ADR-0014 (launch configurations), ADR-0015
  (the run queue), ADR-0020 (access levels)
- Context: a launch configuration should also run by itself: on a cron in a time zone, or once
  at a set time. Unattended runs need an identity, a rule for downtime and for overlap, and a
  commit to run

## Decision

**Under a launch configuration.** A schedule belongs to one launch configuration
(`/api/v1/launch-configs/:id/schedules`), so the catalog's existing access check on the
configuration's flow applies: `ro` reads schedules, `rw` makes, changes and deletes them
(product owner, 2026-11-14). A schedule goes with its configuration and project.

**Runs as its owner, checked at fire time.** The owner is whoever made it; an administrator may
hand it to a service account (or to themself), so it outlives a person. Each fire checks the
owner now: gone or disabled, or without `operator` on the flow (`rw` for a pinned commit other
than the configuration's), and the fire is refused and recorded, not run.

**What it carries.** Its rule (cron with time zone, or one time), mode (else the configuration's),
non-secret input values over the configuration's start values, and either the newest commit of
the configuration's branch at fire time or one pinned commit. Secret inputs are refused: nobody is
there to type one; they come from credentials. A schedule is checked when saved as a launch would
be (what is missing, a commit that is not there).

**Rules.** Cron of five fields or a nickname, read by croner 11.0.0 (time zones and summer time),
at most once a minute; an unknown time zone is refused, not taken as UTC. After downtime (a fire
found more than two minutes late): one catch-up run (default) or none. While the schedule's last
run is queued, running or waiting: skip this fire (default) or queue another.

**Firing from the database.** The schedule row keeps its next time. Every 30 seconds the server
takes the due ones by moving each one's next time on with a compare-and-set update, so a second
server would not fire it twice, then launches through the same prepare and queue as a person's
launch. A one-time schedule ends when it fires. Every fire's result (launched, skipped, refused,
failed, with why) is kept on the schedule and in the audit log (`schedule.fire`, source
`server`, the owner as actor). Runs carry their schedule (`run.schedule_id`).

## Consequences

- People see when a configuration runs next and how its last fire went, on its page.
- A schedule whose owner lost access stops launching but stays, visibly refused, until someone
  fixes the grant or hands it over.
- Fires are at most 30 seconds late; seconds-level timing is out of scope.
