# Schedules

[The guide](README.md)

A launch configuration also runs by itself: on a cron in a time zone, or once at a set time. Its
page lists its **Schedules** with their next times and how the last fire went; `rw` on the flow
adds, changes, pauses and deletes them, `ro` reads them.

- A run is launched as the schedule's owner (whoever made it; an administrator may hand it to a
  service account). The owner's access is checked every time: gone, disabled, or without
  `operator` on the flow, and the fire is refused and recorded instead.
- It runs the configuration with its own mode and input values if it has them (never a secret:
  those come from credentials), on the newest commit of the configuration's branch, or a pinned
  commit.
- Cron: five fields (`minute hour day month weekday`) or a nickname like `@daily`, at most once a
  minute; the time zone follows summer time. The page shows the next times as you type.
- The schedule's **Time zone** is the zone its rule is read in: the cron, and the **At** of a
  one-time schedule (the date and time on that zone's clocks). The page shows every time (next
  times, the last fire) in your browser's time zone, named. A schedule fires at its time.
- The list follows fires while the page is open: **Next** moves on, and **Last** shows the run a
  fire launched as it stands now (`last.runNumber`, `last.runState` in the API).
- After downtime: one catch-up run (default), or none. While its last run has not ended: skip
  this fire (default), or queue another.
- Every fire is kept on the schedule (launched, skipped, refused, failed, with why) and in the
  audit log (`schedule.fire`). Runs it launched are marked **scheduled**.

| Address (under `/api/v1`)                        | Does                                                        | Who       |
| ------------------------------------------------ | ----------------------------------------------------------- | --------- |
| `GET /launch-configs/:id/schedules`              | Its schedules, with `upcoming` times and `last` fire        | `ro`      |
| `POST /launch-configs/:id/schedules`             | Add one; the caller owns it                                 | `rw`      |
| `PATCH /launch-configs/:id/schedules/:schedule`  | Change, pause (`enabled: false`); `owner` by administrators | `rw`      |
| `DELETE /launch-configs/:id/schedules/:schedule` | Delete one                                                  | `rw`      |
| `GET /schedule-times?cron=&timezone=`            | The next times a cron fires                                 | signed in |

```json
{
  "name": "Weekdays at three",
  "kind": "cron",
  "cron": "0 3 * * 1-5",
  "timezone": "Europe/Berlin",
  "mode": "check",
  "inputs": { "retries": "5" },
  "missed": "once",
  "overlap": "skip"
}
```
