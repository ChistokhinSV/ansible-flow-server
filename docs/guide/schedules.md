# Schedules

[The guide](README.md)

A launch configuration can run automatically on a **cron** expression (`minute hour day month
weekday` or `@daily`, `@hourly`, …) or **once** at a scheduled date and time. Open a launch
configuration's **Schedules** tab to view upcoming fire times and last-run outcomes; editors (`rw`
on the flow) add, edit, pause and delete schedules.

- **Time zones**: cron and one-time rules evaluate in the schedule's configured IANA time zone
  (including daylight saving transitions), while the UI displays next and past fire times in your
  local browser time zone too.
- **Owner and permissions**: each fire runs as the schedule's owner (administrators can reassign
  ownership to a [service account](people-and-sign-in.md#service-accounts)). The owner's permissions
  are re-checked at fire time; if revoked or disabled, the fire is refused and logged.
- **Overrides**: a schedule can override the configuration's mode (`check` or `real`), non-secret
  inputs, and pinned commit.
- **Downtime and overlap**: choose whether to run **one catch-up run** (default) or skip missed
  fires after server downtime, and whether to **skip** (default) or queue when the previous
  scheduled run is still active.
- **Flow renames and deletions**: deleting a flow automatically disables its branch schedules and
  records why (`offWhy`). Moving a flow on the **Files** tab with **Point them at the new file in
  the same save** keeps its schedules active.

Every fire (launched, skipped, refused or failed) is recorded on the schedule and in the
[audit log](audit.md) (`schedule.fire`).
