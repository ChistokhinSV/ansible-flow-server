# Your first flow

[The guide](README.md)

A flow made in the web pages, from an empty project to a run on the canvas, in about 10 minutes.
It is a "NTP baseline" for switches with two steps; its steps print what they would do, so nothing
outside the server is touched. Get Started on an empty canvas opens this page.

You need `rw` on the project's flows (administrators have it; see
[Access levels](people-and-sign-in.md#access-levels)). No project yet? In a workspace,
**Add project** with **Start with** **Nothing**, or follow [Your first project](first-project.md),
which starts from a sample.

## 1. Make the flow

On the project's **Overview**, under Flows, press **New flow**. Name it `NTP baseline`: the file is
`flows/ntp-baseline/ntp-baseline.flow.yaml`. **Make the flow** makes it in one commit and opens it
for editing.

A new flow has a **Start** and a **Done** step, wired to each other, and one input, `devices`: the
hosts it runs on. Under them a card offers how to begin.

## 2. Add two steps

1. On the card, press **Add a Step**, type `Check NTP` and press Enter. The step goes between
   Start and Done.
2. With **Check NTP** still selected, press **N**, type `Push NTP servers` and press Enter. It goes
   after Check NTP, before Done.

Hosts travel along the wires: the hosts **Check NTP** goes well on leave by its `ok_hosts` port
and go on to the next step. A step's **Details** (the side panel) take one sentence on what it
does; a run prints it.

Everyone else editing this flow sees each change at once, and Ctrl+Z takes back your own last
one (see [Editing flows in the pages](web-pages.md#editing-flows-in-the-pages)).

## 3. Say what happens when a step fails

Each step also has a `failed_hosts` port, for the hosts it failed on. An amber port is a failure
nothing handles yet, and a bar over the canvas asks about it:

| Step             | Choose                      | Why                                         |
| ---------------- | --------------------------- | ------------------------------------------- |
| Check NTP        | **Exclude and Report**      | a check: take those hosts out and list them |
| Push NTP servers | **Notify On-Call and Stop** | the change failed: someone must look        |

Each choice adds the steps that handle it in one edit (Ctrl+Z takes it back). To leave a port open
on purpose, choose **Accept with Reason…**: the flow keeps your reason.

## 4. Save

Write what changed in **Commit message** (`First NTP baseline`) and press **Save**: one commit on
the project's branch, by you. **Stop editing** leaves the flow as saved. Runs take the flow from
the branch, so a flow runs only once it is saved.

## 5. Launch it

What **Launch** runs is a launch configuration: the flow with its inputs, inventory, credentials
and image (see [Launch configurations](launch-configurations.md)).

1. On the project's **Overview**, **Add a launch configuration**: name `NTP baseline on localhost`
   and the flow `flows/ntp-baseline/ntp-baseline.flow.yaml`.
2. On its **Launch** tab, set the input `devices` to `localhost` and keep the mode **Check**
   (nothing is changed).
3. Press **Launch**. The run's page shows the run on the flow's canvas as it goes: how many hosts
   took each wire, and each host's output.

## Next

- Give the steps real work: bind each one to a module of the flow's image (its **Details**), see
  [Editing flows in the pages](web-pages.md#editing-flows-in-the-pages).
- An approval before the change, and who decides: [Approvals](approvals.md).
- The flow in VS Code: the project's **Settings** show the address to clone (see
  [Workspaces and projects](workspaces-and-projects.md)).
