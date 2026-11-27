# Schedules

[The guide](README.md)

A launch configuration can run automatically on a **cron** expression (`minute hour day month
weekday` or `@daily`, `@hourly`, …; at most once per minute) or **once** at a scheduled date and
time. Open a launch configuration's **Schedules** tab to view upcoming fire times and last-run
outcomes; editors (`rw` on the flow) add, edit, pause and delete schedules, and `ro` reads them.

## Rules and behaviour

- **Time zones**: cron and one-time rules evaluate in the schedule's configured IANA time zone
  (following daylight saving transitions), while the page displays next and past fire times in your
  local browser time zone too.
- **Owner and permissions**: each fire runs as the schedule's owner (administrators can reassign
  ownership to a [service account](people-and-sign-in.md#service-accounts)). The owner's permissions
  are checked at every fire; if the owner is gone, disabled or lacks `operator` on the flow, the
  fire is refused and recorded.
- **Overrides**: a schedule can override the configuration's mode (`check` or `real`), non-secret
  inputs, and pinned commit.
- **Downtime and overlap**: choose whether to run **one catch-up run** (default) or skip missed
  fires after server downtime, and whether to **skip** (default) or queue when the previous
  scheduled run is still active.
- **Flow errors, renames and removals**:
  - **Adding a new schedule or re-enabling a disabled one is refused while the flow has validation
    errors or is missing** (an existing schedule on a broken or missing flow can still be paused,
    edited or deleted).
  - Deleting a flow in the web UI or API immediately turns off its branch schedules and records why
    (`offWhy`); moving a flow on **Files** with **Point them at the new file in the same save**
    keeps its schedules active.
  - **If a flow is removed by a `git push`**, its schedule turns off automatically at its next fire
    time (`offWhy`) and **must be turned back on manually** once the flow is restored.

Every fire (launched, skipped, refused or failed) is recorded on the schedule and in the
[audit log](audit.md) (`schedule.fire`). The [API reference](/docs/api) lists every
`/api/v1/launch-configs/:id/schedules` and `/schedule-times` call and who may make it.
