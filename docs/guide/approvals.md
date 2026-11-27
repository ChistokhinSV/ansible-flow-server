# Approvals

[The guide](README.md)

![A real run waiting at an approval gate on the run page](images/run-waiting.png)

Top-level **approval** steps pause a **Real** run in segments: once hosts reach the gate, the server
records the waiting state and releases the worker container, so waiting runs consume zero runner
slots and survive server restarts. **Check** runs pass approval gates automatically without asking.

![The Approvals page showing a pending decision and consequences](images/approvals.png)

## Who may decide

- Users or groups with the `approve` grant on the flow or workspace (see
  [Access levels](people-and-sign-in.md#access-levels)) — narrowed to the step's named `approvers`
  when set in the flow. Administrators can always decide.
- **No self-approval by default**: whoever launched the run cannot approve it unless an
  administrator enables **A launcher decides their own approvals** under **Govern › Access**.

## Reviewing and deciding

Open **Work › Approvals** (`/approvals`), the run's **Details** side bar, or the step on the canvas.
Before you decide, each gate shows what happens next:

- **If approved**: the step sequence hosts will run next (`Upgrade › Post-checks › Done`).
- **If rejected**: where hosts route instead (`Not approved`).
- **If nobody decides**: the gate's timeout deadline and timeout path.
- **Evidence**: the latest completed **Check** run of the same launch configuration before this run
  started (whether it succeeded and whether it ran on the same commit).

Enter a **Comment** (optional when approving, **required** when rejecting) and confirm **Approve…**
or **Reject…**. Every decision is recorded on the run, in notifications and in the
[audit log](audit.md). Runs that end because an approval was rejected or timed out are badged and
filtered as **rejected** rather than failed.

> Approval steps must sit at the top level of a flow and cannot wait in parallel (`awx-segments`).
