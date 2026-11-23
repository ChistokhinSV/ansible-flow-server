# Changelog

All notable changes to Ansible Flow Server.

## Unreleased

### Added

- The API reference (**Help › API reference**) is interactive: every address with its parameters, body, answers and example requests, and **Test Request** to send one as you or as an access token you paste. A pasted token stays on that page only and is never stored; anything but a read asks before it is sent. The page is served by the server, with nothing loaded from the internet, and follows the pages' theme.
- The OpenAPI document says what the main resources look like in the answers: runs, flows, launch configurations, schedules, actions, approvals, tokens, people, workspaces and projects.

### Changed

- The OpenAPI document's server is `/`, the address it was read from: clients behind a TLS proxy send to the right address.

## 1.1.0 — Step by step runs, pause points, and who may run each action

Carries Ansible Flow Designer 1.1.0.

### Added

- **Step by step**: a run can pause before each step until someone says **Step** (run that step, pause again), **Continue** (run on to a pause point), **Pause** or **Stop** (end before the next step, keeping what ran). Tick **Step by step** on the **Launch** tab or in the canvas's Run dialog (**Run Step by Step**). The run's page says where it waits and how many hosts wait there, with the buttons above the canvas, also on a phone; the canvas rings the step.
- Pause points: set on a step's menu on the canvas, kept per person and flow by the server, and sent to your step-by-step run going now.
- Who may stop a run may drive it (operator on its flow, administrators); each command is in the audit log as `run.step`.
- A paused run stops by itself after `AFS_RUN_STEP_TIMEOUT_MINUTES` (default 60); a launch may ask for less. A run paused when the server stops or restarts ends as stopped, saying why.
- The API: `step` on `POST /api/v1/launch-configs/<id>/launch`, `POST /api/v1/runs/<id>/step`, and `/api/v1/projects/<id>/pause-points`. MCP: `step` on `run_launch`, and `run_step` for a token made to allow agents to drive step-by-step runs.
- The workspace's **Access** tab lists every action of the workspace and who may run it, also those nobody was given yet, and **Who can do what** has an Actions column. A person's **What they reach** and **Your access** on My account list the actions they may run. `GET /api/v1/workspaces/<id>/actions`.
- A paused run reads **paused** on its page, in the lists (with a **step by step** mark), on the flow's page and on Home, which says when your own run waits for you. The Runs page has a **Paused** filter; **Waiting** lists paused runs too (`state=paused` and `state=waiting` in the API, `paused` in MCP's `run_list`).
- Keys while a step-by-step run shows its bar: **F10** Step, **F8** Continue or Pause, on the run's page and on the canvas.
- Pause points on a read-only canvas: **Add Pause Point** on a step's menu, and a dot at a step's corner that shows on hover. On a run's page they are that run's, and the run says whose pause point it waits at.
- The run's output says who said Step, Continue or Pause.
- The **Launch** tab offers **Only at your pause points** and how long a pause waits; a real run's question says that it pauses.
- Readers of a paused run are told who may go on.
- An action's host input can take **one host** or **up to a number** of hosts; a group counts by its hosts, so a "one switch" action refuses a group of four. **Starts with** gives a host input a start value of its own.
- An action's form checks its values before the question: a host outside its group or the inventory, or more hosts than it takes, is said at the field. The host picker marks groups with their size, and the question says a group's number of hosts and whether it runs for real.
- Running an action with the same values as your run of a moment ago asks **Run again** or **Open that run**; the API answers 409 `duplicate` unless `again` is sent.
- **Search** finds the actions you may run. A group's page lists the actions its members may run (`GET /api/v1/groups/<id>/action-grants`).
- An action card marks an action that runs for real and opens your last run of it; **Run it again** starts with that run's values.
- Moving or renaming a flow in **Files** names, before Save, the launch configurations that run it and their schedules, and offers to point them at the new file in the same save. Deleting one there names them too.
- A schedule the server turned off because its flow was moved or deleted says why on its page (`offWhy` in the API).
- `repoint` on `POST /api/v1/projects/<id>/files`; the answer names the configurations it pointed at a moved flow (`repointed`) and the schedules it turned off (`turnedOff`).

### Changed

- Someone whose grants in a workspace are on some of its flows only sees those flows, their launch configurations and runs: a project's page shows them **Overview** and **Runs**, with "You see 1 flow of this project" under its title, and no Files, History, Branches or Settings tabs. Read only on one flow no longer says it clones.
- Someone with read and write on a workspace gives an action to people and groups who already have access to that workspace, offered as they type; an administrator gives it to anyone.
- Deleting a launch configuration asks with the action it is, who can no longer run it, and a run of it that still goes or is paused.
- The audit log says what was done in words ("gave access", "took back an action"), with the code on hover; an action set up for the first time is named by its title; an action grant's entry names the person, not the grant's id.
- A reader no longer sees the Check / Real choice and Step by step on a launch configuration's page; the token form offers deciding approvals and driving step-by-step runs only to people who can.
- The Actions page has one intro, whether it is your Home or a page of the menu.
- A host input of an action starts empty (the runner picks) instead of with the launch configuration's value, which could be a whole group.
- An action switched off, or one you may not run, says so with whom to ask and a way back to Actions, instead of a bare "No such action". Nobody is told to ask themselves.
- **Copy link for NetBox and Zabbix** puts the object's name into the host input and its site into a site input by default, and warns when the page is open at an address only your machine reaches.
- The Runs page points someone who may only run actions to Actions.
- **Only hosts of group** offers every group of the configuration's inventory with its number of hosts, also before the action is saved, and refuses one the inventory does not have.
- While a step runs, the bar says "Running Say hello…" and offers **Pause**; the focus stays on the button pressed.
- A step-by-step run has one **Stop**, in its bar; stopping someone else's run asks first, naming whose it is.
- A pause inside a subflow is named by its path ("Pre-checks › Read device status"), and a subflow stopped inside reads stopped.
- Step times leave the pauses out ("ran 1 s, waited 31 s"); a time near a whole minute no longer reads "7 min 60 s".
- A pause is said once in the run's output, in plain words, after the step before it.
- Your own run that still goes stays in the flow page's **Latest runs** and on its canvas after others launched newer ones.
- Home's counts of today's runs say they are everyone's, and each is a link to those runs on the Runs page ("still go" to the runs going: the Runs page's **Going**, `state=going` in the API and MCP's `run_list`).
- An upload over a file that is there says it replaces it ("Replace inventory.ini with an upload").
- A Files save left without a message lists every change in the commit's body when its subject sums them up, so History shows them all.
- History opens one commit at a time.
- `?line=` in **Files** scrolls only as far as it takes to show the line: a line near the top keeps the page where it is.

### Fixed

- **Bring back** after someone else discarded the draft and began a new one failed and the edits were lost: they are merged into the new draft (where both changed the same place, the new draft's value stays and the page names it). A second **Bring back**, in another tab or by someone else, opens the draft they went to; a brought-back draft keeps who made each edit (co-authors, Ctrl+Z).
- Who is here while editing shows as chips with names on hover instead of a line cut to a few letters; someone about to save or discard, errors and what an import or sample added are a bar across the page, read whole.
- The Save dialog stays current while it is open (others' edits and notes made meanwhile), lists the steps moved on the canvas and by whom (a draft of moves only is no longer empty) and the files a sample adds, and names fields as the forms do ("changed the description of Rollback", not "changed Rollback (intent)"); so do the activity line and the Undo note.
- The commit message made of the changes no longer ends with "…": it names whole changes, then "and N more".
- One Save asks once: who else is editing is said in the Save dialog, not in a second question.
- The "N earlier" list closes on Escape and on a click elsewhere.
- A tab closed while editing no longer counts as "your other tabs" for about a minute.
- Someone with a grant on one flow could read every commit message and author of the project's repository through its Branches tab and `GET /api/v1/projects/<id>/pushes` and `/branches`, and the names of its other flows and their drafts. Pushes now need read only on the workspace; branches answer such a person with their names only; the project's access, drafts and the project itself show only what their flows need.
- Workspaces and Home counted every project of a workspace for someone who sees only some of them.
- Someone with read and write on a workspace could learn whether any login or group existed on the server (and a person's full name) by giving an action to it. Anyone outside the workspace now gets the same answer as a name that does not exist.
- Deleting a launch configuration that is an action, or a person or group with action grants, ended the action and its grants without a word in the audit log: each is now recorded as ended, with why.
- `/w/<workspace>/access` (and `environments`, `credentials`) said Not found: it opens the workspace's tab.
- **Step** and **Continue** on the canvas of a flow's page (toolbar and side panel) did nothing.
- After **Step** or **Continue** the run's page kept saying "Paused before" until the run paused again, and a refusal stayed on the page after the run went on.
- A paused step's Run tab said "0 hosts" while hosts waited there.
- "Stops by itself in 61 s" with a 60 s timeout.
- The **Launch** tab's **Step by step** box was smaller than the radios beside it and grey in the dark theme; the host list's help said what it is twice.
- Browser **Back** after a link that runs its action as it opens started the action again.
- An action run's progress said **Done** for steps no host reached (a run where no host ran showed every step done and a full bar; a rollback not needed showed as done).
- Someone who started a run of an action could not open it any more after the action was taken back from them or its configuration was deleted.
- Saving an action that tells NetBox or Zabbix without a credential said "Reply is not the right kind of value"; it now asks to choose a token credential.
- A link with a value that is not among an action's choices said the link gives only some of what it needs.
- The audit log listed every field of an action as changed when one changed.
- A revoked signed link's token stayed on the page.
- `GET /api/v1/actions/<id>/hosts` gave the whole inventory for an action whose host inputs are narrowed to a group.
- On a phone, **Back to actions** and **Not now** now line up with the buttons; the NetBox and Zabbix choice sits on one line; an action's page is named in its settings instead of by its address.
- A run whose only host failed at a step (a role that cannot be found) said "went well" when Ansible ended with 0: it fails, "1 of 1 host failed at Apply motd role", and the host row says where it stopped.
- A run a rejection ended reads **rejected** in Search, and the flow page's Run panel lists its steps under "Not approved", not as failed steps.
- On the canvas of a run, a step no longer shows its authoring status as if it were a result (a green check on a step waiting for approval); a step without code says **TODO**.
- **What would run** of a check goes away when **Real** is ticked, and a real run's question says how many hosts it reaches.
- A host list that cannot be read is said once, at its field.
- A new launch configuration of a repository without `ansible.cfg` starts with its only inventory (such as `inventory.ini`), or names those it has.
- After the settings are saved (another inventory), the **Launch** tab reads the inventory again instead of keeping the old groups and target warning.
- The Run dialog on the canvas no longer says what the host list is twice.
- A playbook imported with its role in the project's top `roles/` folder failed with "the role was not found" unless an `ansible.cfg` named that folder: runs now search `roles/` at the top of the project, after the roles path the config gives.
- Moving a flow in **Files** broke its launch configurations and turned their schedules off without a word.
- A refusal on a schedule stayed on the page after a later change was saved.
- The History tab dropped `?commit=` unless it was the full 40-character hash: the 12 characters the pages show open the commit, also one older than the list shows, and a wrong one is said.
- The clone help broke `-c http.sslBackend=openssl` across lines.
- **Files**: after a save refused because the branch changed the same files, taking back those changes and making them again was refused the same way every time (only **Discard all** helped): once no change touches those files, the change set is made on the branch as it is now, and the file list shows it without a reload. The refusal names that commit (`head`).
- The audit log's "gave access" entries name the workspace so it links in Detail, as "took back access" entries do; a grant on a flow names the flow by its title, as the Access tab does.

## 1.0.3 — Steps move again after Undo

Carries Ansible Flow Designer 1.0.3.

### Fixed

- After Undo of a flow's first move or Tidy Up in the pages, steps can be moved again: every move was refused with "overlapping edits".

## 1.0.2 — Actions for everyone, links from NetBox and Zabbix, History, and where a value comes from

Carries Ansible Flow Designer 1.0.2.

### Added

- **Actions**: a launch configuration can be made an action (on its **Settings**, by an administrator or someone with read and write on the workspace): a plain title, a sentence on what it does, the inputs a runner chooses with their own labels, help lines and choices, check or real fixed by the action, and whether Run asks to confirm. Everything else runs with the configuration's values and cannot be changed by a runner.
- "May run this action", given to people or groups on the action: it lets them run that action and follow their runs, and nothing else of the workspace. Operators of the flow and administrators may run actions too; approvals in the flow still apply. The workspace's **Access** tab lists who may run each action, and the audit log records setting, granting and running actions.
- **Actions** in the side menu, for anyone with an action: cards with each action's last run of yours; an action opens a short form with only what it asks, what will happen in words, and **Run**. Someone whose only access is actions lands on Actions and sees only it in the menu.
- A run of an action has a plain progress view at its own address: steps done of how many, by title, who an approval waits for, done or failed with the reason in words and whom to ask, and the values it was asked for. It follows the run live; who may see the run also gets a link to its full page. The form and the progress view work on phones.
- The API: `GET /api/v1/actions`, `GET /api/v1/actions/<id>`, `POST /api/v1/actions/<id>/run`, `GET /api/v1/actions/runs/<run>` (and `/events`), and `/api/v1/launch-configs/<id>/action` with its `/grants`.
- Links to actions from NetBox and Zabbix: `/a/<action>?<input>=<value>` opens a confirm page when the link gives every value the action asks (checked as the form checks them), else the short form with the link's values in and only the rest to fill. A name the action does not ask is refused in plain words. Opening a link never runs anything; an action can be set to run as its link opens (the page starts it and says so). Signing in comes back to the link, with your own access deciding.
- **Copy link for NetBox / Zabbix** on an action's settings: the link with a value per input from the object (NetBox Jinja, Zabbix macros), and what to paste as a NetBox custom link or a Zabbix URL script.
- Signed links for systems with no person (a Zabbix action, a NetBox webhook): a token per action, shown once, that runs that action only, taken only in the `Authorization` header of its run; made and revoked on the action's settings and recorded in the audit log.
- An action can tell NetBox or Zabbix how a run started from their link ended: a journal entry on the NetBox object, or a message on the Zabbix problem, with the link to its progress. New credential kinds **NetBox token** and **Zabbix token** hold the address and token.
- An action's host list can be narrowed to one inventory group.

- Where a value comes from, from the repository: on a flow's page, a run's page, a flow at a commit and while editing a draft, a variable's tooltip and **Details › Data** list every place in the repository that sets the name (the inventory the flow's runs use, `group_vars/` and `host_vars/`, a role's defaults and vars, a playbook's vars files), with its precedence and the one that wins for the host picked in **For host**. A file and line opens the **Files** tab at that line in a new tab. It needs read access to the project's files; secret values are never shown (`POST /api/v1/projects/<id>/vars`).
- The launch form says under each input which steps read it, its default and what it wins over (a step input of the same name, and the repository's definitions of the name).
- The **Files** tab opens a file at a line with `?path=<file>&line=<n>`.
- A run records the value each step's inputs had for each host. On the run's page, a step's **Details › Data** shows **In this run** under each input, with the hosts that had each value or one host's value, and says when it differs from what the flow states; a variable's tooltip and the step's **Run** tab show them too. Secrets are never recorded, long values are cut, and a run keeps 256 KB of values at most. The new setting `AFS_RUN_RECORD_INPUTS` (default `true`) turns it off.
- A project's **History** tab: the commits of a branch, newest first, with author, time and short hash; a filter by words in the message, author, hash or changed files; more on request. A commit opens to the files it changed: flows by their title, to the flow at that commit; every other file to its text at that commit; a file moved is one line, **renamed**, with the path it had (`GET /api/v1/projects/<id>/commits`, `GET /api/v1/projects/<id>/commits/<hash>`).
- A flow's history, from **History** in its page's **More** menu: the commits that changed the flow or its scenarios.
- A flow at a commit (`?commit=<hash>` on its page): the flow as that commit left it, read only, in the Changes lens against the version before, with the commit's author, time and message said once above the canvas, a way back to the current flow (to the project when the flow is gone) and to the flow's history. The hash may be its start, as History shows it; one that names no commit, or a commit without the flow, is said with the same ways on, never the current flow to edit. A commit the project's branch does not have names the branches that do (`GET /api/v1/projects/<id>/flows/commit`).
- Redo while editing a flow in the pages: Ctrl+Y (or Ctrl+Shift+Z) brings back what Ctrl+Z took, one edit at a time, until you make a new edit; it says what came back, and is refused when someone changed the same place since (`POST /api/v1/drafts/<id>/redo`).
- Adding an existing repository as a project reads its address first. When it cannot be read (or has no branch `main`), the form says why at the address and offers **Add anyway** (`POST /api/v1/workspaces/:id/projects/check`).
- While someone has **Save** open on a flow's draft, everyone else in it sees that a save is coming and ends their editing, before it is made.
- On a run's page, a host's row in **Hosts** opens what that host did, step by step (`GET /api/v1/runs/:id/hosts/:host`).
- A schedule whose fire found errors in its flow lists them under **Last**, each a link to its step.
- While editing a flow in the pages, **Save** opens a dialog that lists what the draft changes, place by place, with who changed each, and fills the commit message from it.
- **Bring back** restores a discarded draft, with everyone's edits, for 15 minutes after it was discarded (for whoever discarded it and the others who were in it). While someone asks whether to discard a draft, the others in it see that a discard is coming, and what they are typing goes into the draft first.

### Changed

- The progress view of an action's run opens for whoever started it and whoever may see the flow's runs; someone who may only run the action no longer sees runs others started.
- An action's **What will happen** no longer lists the values the action keeps fixed by their variable names.
- Signing in with your organisation's sign-in comes back to the page asked for with its query.

- The questions the pages ask name their button by what it does (**Delete**, **Revoke**, **Take back**, **Discard**, **Disable**, **Turn email off**) instead of OK. A question whose answer loses something has Cancel focused and a solid red button; opening a question no longer scrolls the page.
- **Take back** on a workspace's Access says what the person keeps (their other grants and those of their groups), and afterwards a note says what was taken back, as **Give** does. **Revoke** on a token leaves a note too.
- A flow's page names the flow by its title in the breadcrumbs (its file in the tooltip), and a draft saved with no message is committed as "Edit <flow title>".
- An existing-image environment speaks of pulls: **Pulls**, "Pull 1 failed", "Not pulled yet". The launch configuration's environment picker says "(could not be pulled)" or "(its build failed)" after a failed try.
- What the flow needs: "any version" instead of `*`, where each need comes from in words, the steps that use a collection by their titles, and a suggested environment name made from the flow's file.
- A person's page names projects by their names in **What they reach**. An AWX credential reads "AWX address …" under **Holds**.
- Words: a webhook or email test that fails reads "Not sent to …. Not reachable: …"; **Turn email off** and **New self-signed** say beside them what they do; "No steps yet: Open the draft to add them" when a draft waits; a branch name with `..`, `//`, a trailing slash or `.lock` is refused with that reason; "Nothing to start from: the repository has no branch …"; the AWX import box with no AWX credential offers **Close**.
- A project's Settings tab tells someone without read and write that they may clone and pull but not push.
- Someone who reaches no project sees a line saying so on **Runs** instead of filters, and **Library** tells only administrators where to make a project a library.
- **Stop** on a real run asks first, naming the run and what stopping does (the step in progress is cut off; a run that waits for approval is not decided any more), as **Launch** and **Run again** do. A check run stops at once.
- A stopped run says when it was stopped, after who stopped it ("Stopped by Dana Whitfield at … during Push baseline"); its output names that person by name, not by login.
- When a run's approval waited and the run is stopped, those its approval asked are told that it no longer waits, and the approval reads "run stopped" (was "cancelled").
- A run whose steps had all ended when **Stop** reached it is recorded as it ended (went well, or failed), not as stopped; its output says the stop came after its steps had ended.
- Credential kinds have one name each on every page and in messages (SSH key, login and password, become password, vault password, git token, container registry, environment variables, AWX token).
- A new schedule's **Cron** starts empty, with an example in it, instead of a cron that looked chosen.
- A launch configuration's header names whom its runs tell, as its Settings tab does.
- On the **Files** tab, **Changes not saved** sits under the files and stays at the window's foot: the first change no longer pushes the editor down.
- **Open Sample Flow…** in an existing project brings the roles the sample's flow runs: **Save** adds them to the repository in the same commit as the flow, so it runs at once. A role the project has already is kept, and the note after the start says which.
- Questions such as "Delete …?" are asked on the page itself, in its own look, instead of the browser's dialog: Escape or **Cancel** says no, and a question that loses something has a red button with **Cancel** focused.
- Saving a flow's draft that changes the flow raises its version by one from the branch's, as a save in VS Code does.
- A project's state badge explains itself on hover, and **cannot be read** says beside git's reason what it means and what to do.
- A mirrored project with no commit says why it has no Files tab or **New flow**, and how to give it its first commit.
- An error the server answers without words (a bare 422, 404, 500…) says what it means and what to do.
- "N of M hosts failed at a step" also says Ansible's exit code and what it means.
- On the **Files** tab, an upload is the file shown next (so **Rename or move** is about it), with its text when it is a text file. An upload moved before **Save** is one change at its new path ("Upload group_vars/all.yml"); an upload deleted before Save is taken back. A file marked for deletion stays in the tree, struck through, with **Keep it**.
- A project started from a sample names the launch configurations it came with, and lists them at once.
- An external project whose repository cannot be read shows **Source** first on its Settings tab. While it has no commit, it offers no git clone and no **Add a launch configuration**.
- A workspace says that administrators add projects, to those who have no **Add project**.
- **Open Sample Flow…** names the roles the project keeps in one sentence.
- **New branch** says at the field when a name is not allowed or taken, without asking the server.
- The audit log says whether a launch or a run again was real or a check, and names the new run of a run again by its number.
- A launch configuration cannot be given an environment that has no image and no build going: the form says why at the field.
- While editing a flow in the pages, who is here and what happened last is one line beside **Save** in the flow's head: someone joining, saving or discarding no longer moves the canvas down, and notes no longer lie over the canvas's toolbar or side panel. The same change made again and again (a burst of typing) is one entry with a count. What a save's clashes, the branch's move and the commit message say is in **Save**'s dialog.
- **Save** is off while a draft changes nothing (no edit yet, or every edit taken back), and Ctrl+S says there is nothing to save. Discard of such a draft asks nothing, and **Stop editing** drops it when nobody else is in it.
- Ctrl+Z and Ctrl+Y say what they took back or brought back (a note's text, a step's fields), not "your last move on the canvas".
- A save with one co-author says "as co-author"; a commit's details on the **History** tab name co-authors without their e-mail addresses.
- The flow's page says "A draft of this flow has unsaved edits by …" for a draft waiting to be saved.
- A launch on which no host would run (no target in the inventory, or a limit that leaves none) asks first, on the launch page and in the canvas's Run dialog. **Run again** of a run that reached no host asks first too, and its question's button names the action (**Run for real**, **Run again anyway**).
- Enter in a field of the launch form launches (asking first where **Launch** asks), instead of **What would run**.
- The launch form says once that another branch or commit needs read and write access, and a host list with its own description is not described twice.
- The audit log names who by their name (the login on hover), says a grant in the pages' words ("read only for group netops on Network team", "operator for Nora Brandt on the flow hello in Hello"), and shows **refused** in the warning colour, not one close to **ok**.
- Taking back a grant records its workspace in the audit log, as giving one does. Deleting a group or a person records each grant it ended as **grant.delete** ("the group was deleted"), and the deletion lists them.
- An existing image's environment speaks of pulls, not builds: **Pulls**, "Pull 1 failed", **pulled**. The launch form's environment picker says "(its pull failed)" or "(its build failed)", and an environment with no image is not offered as the server's default.
- **Add a provider** puts the cursor in the provider's **Name**.
- The flow page's **More** menu works with the keyboard: the first item has the focus when it opens, the arrows, Home and End move, and Escape gives the focus back to **More**.
- Closing **Save**'s dialog with Escape or **Cancel** gives the focus back to where it was (Save, the canvas), not to the page.
- Approvers see what they decide: the Approvals page, the run's page and the request email show the approval's message (or, without one, its step's intent); the email lists the hosts waiting, and the pages say how long it has waited.
- Who launched a run and may not decide its approval reads "You launched this run, so others decide its approvals (only an administrator can change that)" and who decides it, on the pages and on the canvas; the request email to a group they belong to says they do not decide it.
- A run whose approval was rejected or not decided in time is no longer counted or filtered as failed: the Runs page has a **Rejected** filter (`state=rejected`; `state=failed` leaves such runs out), Home counts them as rejected, the flow page's Run panel and its list of runs say rejected, and the output says "(outcome: rejected)".
- A host's own output (its row in **Hosts**) ends with the approval it waited at, how it was decided, and where it ended.
- A task its `failed_when` condition failed says the condition ("Its failed_when condition was true: …") instead of Ansible's "Unknown error"; the step is named without its key.

### Fixed

- A step bound to one of the repository's own roles lists the role's options and required ones from its `meta/argument_specs.yml` in **Binding**, and **About** opens with them, on the flow's and run's pages and while editing. Before, every role read as having no argument_specs and **About** stayed on "Reading…".
- On a phone the folded side panel under the canvas is one row with its label written across, not a tall strip with the label on end.
- The Approvals count in the side menu drops as soon as a run stops waiting (decided, stopped or timed out elsewhere) and on every page opened, not only on reload.
- On a run's page the canvas fits the window under a notice of why the run ended: its zoom controls stay in sight.
- A time on an approval's Run tab names its time zone.
- The output of a run no longer shows generated playbook code under the error of a host stopped at a port with no next step.
- Deleting a flow turns off the schedules that fire it in the same save (the delete question already said so); before, they stayed on, fired once and failed. A move or delete through the **Files** tab or the API does the same.
- A schedule whose flow has errors, or is gone, can be paused, changed and deleted; before, only Delete worked and it kept firing. Turning it on again is refused while the flow cannot run, as adding one is.
- A launch configuration's settings (description, credentials, notifications and the rest) save while its flow has errors or is gone; only launching is refused. Changing it to another flow still needs one that can run.
- A refused change of a launch configuration or schedule lists in the audit log only the fields it asked to change, not every field the form sent.
- Home no longer offers **Launch again** for a configuration whose flow is gone.
- A configuration's **Launch** tab says once that its flow is gone or has errors; **What the flow needs** is not shown while the flow cannot be read.
- Opening a commit of a flow from its **History** no longer keeps the note of the last save or discard ("Saved as …", "The draft is discarded.") above it.
- A read-only token may read the repository's variables (`POST /api/v1/projects/<id>/vars`), as it reads the project's files; it was refused as a write.
- The repository's variables include those written on a host range line of the inventory (`sw-edge-0[1:4] ansible_connection=local`) for each host of the range.
- On a run's page, **For host** lists only the run's hosts, and a variable's tooltip shows **In this run** without a host picked; a flow input a step reads directly shows the value the run was given.
- The launch form names every step that reads an input, not three "and 1 more", and a required input that no step reads says that a run must give it.
- Typing "/" in a file's text on the **Files** tab typed it; it moved the cursor to **Search**, and the rest of the typing went there.
- A host list typed as a JSON list (`["sw-edge-01", "sw-edge-02"]`) runs on those hosts; one that is not valid JSON is refused at its field instead of being launched as a host name.
- Emptying the **Limit** at launch runs without a limit; it kept the configuration's limit.
- The notifications guide no longer says a run's inputs are never in a message: an approval's request email carries them (secrets as `***`).
- The **Find** boxes of **Runs** and **History** are wide enough to show their hint whole.
- A flow's page no longer keeps an old note ("Saved as …", "The draft is discarded.") when you open a commit of the flow or its **History**; the **History** list opens under the flow's line, not between it and the title.
- In a shared draft, a step's binding open on someone else's page no longer writes its old parameters back over a parameter you changed.
- A conflict choice in **Save** is for the values shown: when someone changes the draft while you choose, the save stops and shows the places again with their values now, instead of saving a value you did not see.
- A page no longer calls the draft's "I am here" after the draft was saved or discarded (a 404 and a console error each time).
- Asking a question on a phone no longer scrolls the page behind it.
- On a run's canvas, the last step inside a subflow (Check the upgrade path, Wait for the target version) read "not reached" though its hosts ran it.
- The flow page's Run panel and badge said "went well" for a run that failed without running anything (no host to run on); they say failed, with the reason.
- While a run waits for approval, the flow page's Run panel says "waiting for approval", not "running", and the steps after the approval read "not reached yet", not "waiting".
- A stopped run marks the step it was stopped in as stopped; it read "not reached".
- The flow page's Run panel calls its run list **Run shown** (it lists the newest run too, not only earlier ones) and names the run's hosts, not only how many.
- A run's **Terminal output** shows a host that a rejection, a timeout or any route sent to a failed end with its error alone, without the excerpt of generated code Ansible prints under it (the downloadable output keeps it).
- The delivery log says why a webhook was not reached: connection refused, timed out, the host name not found (DNS), or its certificate (expired, for another name, not trusted). A certificate problem, or a port web requests may not use, is not tried again.
- The **Take back** buttons on the **Access** tab no longer move sideways when a longer grant is added.
- **What ran** marks an image as the server's default by how the run started, not by how its launch configuration reads now; dev runs are marked too.
- The launch form offers the inventory's groups for a flow whose host list is not marked as its targets (the first host list is then the targets).
- Search no longer shows, or opens with Enter, the results of the question typed before while the new one is asked.
- The audit log's **Since** and **Until** stay whole words; they broke inside the word ("Sinc e").
- One long credential name no longer squeezes the credentials list: kinds stay on one line and **Change** and **Delete** side by side in every row.
- A read-only token that tries to open a draft is told it may only read, before any word about the request's form.
- The guide's project table says that branches, pushes and flows need access to the project, not only a sign-in.
- A flow's page with a long file path no longer leaves a lone "/" on a line of the breadcrumb, nor scrolls a little at tablet and laptop widths.
- A page of a project that is not shared with you asks for the workspace's projects once, not twice.

## 1.0.1 — Access you can see, guided first steps, plainer words

Carries Ansible Flow Designer 1.0.1.

### Added

- An administrator can make an execution environment the server's default image: runs whose launch configuration names no environment or image get its newest good image (`AFS_EE_IMAGE` until one is picked, and while the one picked has none). The environments pages say which image is the default, and a run's **What ran** names the image it got (`GET`, `PUT /api/v1/default-environment`).
- **My account** shows your access, workspace by workspace: the level, the flows a grant of your own gives another level on (by title), whether you approve, and whose grants gave it (`GET /api/v1/session/access`, which also names the administrators who give access).
- Giving access says what was given, and the form starts again empty.
- A project's name, description and branch can be changed on its **Settings** tab.
- A one-time schedule shows its **At** in your own time too.
- The credentials list names what uses each credential, with links (for administrators).
- Each approval names who may decide it: its approvers, or the people and groups with approve on the flow or its workspace (`deciders` in the API). The Approvals page shows the run's inputs (secret-looking values as `***`), its workspace and project, and whether it is a real run; the request email carries the inputs too.
- An empty flow edited in the pages starts from what its canvas offers: **Import Ansible Playbooks…** (a playbook of the project's repository), **Import AWX Workflow or Job Template…** (through a new credential kind, `awx`: an address and a token), **Open Sample Flow…** and **Get Started**. Before, only **Add a Step** did anything.
- A project started from a sample comes with a launch configuration of its flow, inputs filled in for the sample's hosts, so **Launch** runs it at once.
- The launch page says how many of the hosts a **Limit** leaves (and warns when it leaves none), and names targets that are not in the inventory.
- Workspace and project pages say what your own access there is.
- An approval shows the hosts waiting at it. The Approvals page lists the approvals decided lately, with who decided and why (`GET /api/v1/approvals?decided=1`).
- A flow's draft can be discarded from the flow page, without opening it. In full screen, **Exit full screen** stays in sight.
- **Help** in the side menu (also at `/help`) lists the user guide's pages and the API reference, and most pages link their part of the guide with **Help** beside the title.
- An empty project's Overview shows how to clone it. The clone help says what to do when git does not trust a self-signed certificate, and anyone can download the certificate in use at `/api/v1/certificate.pem`.
- A refused form says why at the field it is about, which is marked, scrolled to and focused; the words go once that field is changed. Messages use the fields' labels, not internal names or the server's schema wording.
- Forms opened by a button (Give access, Add credential, Change, Add schedule, New flow, Copy the flow, Add project, Add workspace) come into view with the cursor in their first field. **What would run** brings its answer into view.
- Leaving a page with typing not sent in a form (a link, a tab, Back, closing the tab) asks first.
- Credentials are checked before they are sent: the become method (with the usual ones offered), the registry host, the AWX address, the vault id, the private key, and two variables of one name.
- Password fields state the rules (12 characters, 5 different ones, not the login) and check them before sending.
- **Add a provider** shows the redirect address while the key is typed. LDAP filters are typed in a box of several lines.
- An external project whose source cannot be read when it is added opens on Settings, which says why; its repository address can be changed there. **Look at the source now** says what it found.
- Starting a project from a sample or an archive says what its first commit holds, and when it has playbooks, how to make a flow of one.
- Search says it needs at least two characters.
- A run's page lists what it ran with: its inputs (secret ones hidden), the limit, the inventory, the environment and its image, and the credentials by name.
- The launch page says, at the field and before **Launch**, which targets are not in the inventory, when the targets match no host, and how many hosts the limit leaves. A launch with targets the inventory does not have names them first.
- A run names the targets Ansible skipped because the inventory does not have them, also when it went well.
- The Runs page has a **Find** box: words in a flow's or configuration's name, a login, or a run's number (`q` in the API).
- A launch configuration's page names its environment (with its image, or why it has none), its limit and its credentials. The inventory's group buttons say how many hosts each holds.
- A save the branch's changes clash with lists each place with the draft's value and the branch's; you pick which to keep at each and **Save with these**.
- After a save, the page says the commit (a link to the flow at it) and the co-authors. The Branches tab's pushes name the person, say how each came (git push, draft saved, files changed, branch, project started) and show the new commit's message.
- Full screen has a **Save** while editing a draft.
- The draft bar's line of what the others did says what each edit was ("removed Ping", "changed Backup (timeout)", "changed the flow's goal"); **N earlier** lists the ones before.
- The server shows its own user guide, as it is for its version, at `/help/guide/`: it works without internet. **Help**, the **Help** links beside page titles, the not-found pages and the certificate hint open it; a link in it that leaves the server says it opens GitHub.
- **Get Started** on an empty canvas opens a new guide page, **Your first flow**: a flow made in the pages, step by step, from New flow to a launch.
- An empty project the server hosts has its **Files** tab from the start: upload your playbooks (or a zip of the folder) or write new files before the first flow, then make a **New flow** and start it from one. Its Overview says so.
- Ctrl+S (Cmd+S) saves a flow's draft while you edit it, on the page and inside the canvas. On other pages it submits the form you are typing in (not one that deletes); it no longer opens the browser's Save page dialog.

### Changed

- A run that ends with only Ansible's exit code says what the code means, with Ansible's last error line (which names the file or the host) when there is one, on the run page, in mails and in the API. A run whose failed hosts could only not be reached names them.
- Deleting a project, a workspace, a flow, an execution environment or a launch configuration sits in one red-bordered box, apart from the other settings, in both themes.
- The setup code line in the server's log names the address to open: the setup page under the public address (or the address the server listens on), with the code filled in.
- An execution environment's **Save the spec** and **Build** sit together at the bottom of its spec and stay in sight while the spec is long.
- Access levels are said in words everywhere in the pages (read only, operator, read and write, approver), not as ro or rw. Every tab of a project says your access, including a grant on one of its flows ("read only; operator on Hello, Ansible").
- The Access tab names flows by their titles and projects by their names, in the grants, in **Who can do what** and in the question before taking a grant back; groups are marked as groups in **Who**, and **Through** says "group ops, their own grant".
- A run, a flow, a launch configuration or a project that is not there, or not shared with you, shows one page: what was looked for, a way back to a page you can open (no links to pages you cannot), and the administrators who give access. A project missing from a workspace you have a level on is said not to exist.
- Who cannot launch is no longer told that runs start from a launch configuration. Who has no workspace yet is told which administrators to ask, and the side menu has no empty **Workspaces** heading.
- The disabled **Branch** and **Or a commit** fields of the launch page say why they cannot be changed.
- A token's **Reaches** column names the workspace, as the form does.
- **Upload a folder (zip)** no longer replaces files that are there without asking: Save lists them and **Replace them and save** saves. Over the API an `unpack` that would replace files is refused unless it says `replace: true`.
- **Discard all** on the Files tab asks first.
- Deleting a flow turns off the schedules that would fire it, and says so. A schedule whose flow is gone is turned off at its next fire instead of failing every time.
- A variable of a credential with no value is refused.
- A launch configuration tells of its runs only people and groups with access to the flow: saving one that names someone without access is refused and says who, and someone whose access was taken back later is no longer told. The same goes for the people an approval in a flow names to ask or to tell.
- The audit log names the token an action was done with, beside where it came from, and an entry of a token made says what it reaches.
- A read-only token is refused as such at once, before what it sent is checked.
- A run that failed because its approval was rejected (or nobody decided in time) reads as **rejected** (or **not decided in time**) in the run lists and on its page, and its hosts as ended at the rejection's step, not failed.
- Approvals, their emails and the run's notice name people by their names, not their logins. The run page's breadcrumb names the project by its name.
- **Approve…** and **Reject…** name the step the hosts go to, keep your comment in sight while they ask, and **Keep waiting** no longer looks like Reject. The decision email says who decided without a stray comma and names the step the hosts go to.
- Refusing someone who launched the run says the workspace can allow it on its Access page.
- The audit log names a run by its flow and number on every entry, and a refused decision names the approval by its title.
- Emails sent from a bare address carry the name Ansible Flow Server.
- A pinned commit (launch configurations, schedules, a launch) can be given as the pages show it (12 digits) or in full.
- Keys made from a name keep accented letters as their plain letter (Ünïcödé: unicode) and a long name is cut between words.
- A cron that cannot be read says which part is out of range and what it takes; a time-zone problem is said at the time zone.
- A file saved on the Files page without a message is committed with the words the Message field showed, and the note after it counts the changes.
- **Add a launch configuration** on a project without flows says so instead of offering an empty list.
- **Delete the environment** cannot be clicked while launch configurations use it, and says why beside it.
- **Add workspace** and **Add project** make the key from the name as you type it (lower case, other characters as dashes); a key you type yourself stays. The same for a new directory or sign-in provider.
- **Approve** and **Reject** ask once more and say where the hosts go; rejecting needs a comment. The Approvals page says what you just decided, the sidebar count goes down at once, and every approval says who may decide it. The audit log keeps the approval's name and the comment.
- A real launch, disabling a person and **Administrators only** for passwords ask first. Password sign-in cannot be limited to administrators while no sign-in provider or directory is enabled.
- A disabled person who types the right password is told the account is disabled, not that the password is wrong.
- **Save** and **Discard** of a flow's draft name who else is editing it before they go ahead. **Save** takes in what everyone in the draft is still typing: the others' pages send it first. The latest change by someone else shows on one line, so the canvas no longer moves down. A draft nobody changed is not shown as unsaved edits, and is dropped when you stop editing it.
- The notification recipients a launch configuration offers are the people and groups of its workspace (administrators still see everyone).
- Something you may not see gets the same "No such …" answer as something that does not exist.
- Ctrl+Z in a draft says which step it took back. While a draft is edited it has no Run buttons (runs use saved flows).
- **Save as Launch Configuration** in the canvas's launch dialog is offered only to those who may add one. Empty lists say who adds things, someone without access to any workspace is told to ask an administrator, and fields that cannot be used look it.
- The Access tab names people by their names and flows by theirs; taking access back names the flow.
- One set of words for runs: a run is "flow #number" on its page, in lists and in emails; its state reads "went well" and "stopped" everywhere, said once in its header; emails name the workspace and project by name. People who launched runs are shown by name. The mode choice says what **Check** and **Real** do, a flow shown and not edited is "read only", a decided approval no longer says "Waiting since", and why a host stopped names the step by its title, not its key.
- A page that is not there, or not shared with you, says what was looked for ("The project edge in network") with the way back, not the address's last part as its title. **Copy** says when it could not copy and selects the text instead.
- The audit log names environments, schedules, sign-in providers and directories, not their ids; access grants name the workspace or flow they are on. A group's entry says who was added and who left, a person not added is named by the login tried with the reason, and a change lists only the fields whose values changed. **About** filters by every kind, access grants and approvals among them, and the detail column wraps within the page.
- **New flow** puts the file in a folder of its own, `flows/<key>/<key>.flow.yaml`, as the samples do; a copy of such a flow gets a folder too.
- Breadcrumbs name the workspace ("Network team"), not its key.
- Home says when a run of yours waits for someone else's approval. A runs list emptied by its filters offers **Show all runs**.
- **Add a provider** sits at the head of the Providers section, as **Add a directory** does at its own.
- Notes about a draft (the branch moved, a save's clashes) lie over the top of the canvas, and the line of what the others did is there from the start: the canvas no longer moves down while you edit.
- Discarding a draft asks the same question on the flow's page and in the editor, naming whose unsaved edits go.
- The Run tab of a flow being edited says runs use the saved flow (save, then launch), not AWX or the local environment.
- "Reading the hosts from the inventory…" shows only when reading takes a while, and no longer stays over the launch dialog.
- **New configuration…** from the canvas's Run goes back to the flow once the configuration is saved.
- Every page has the same width and right edge as the top bar: the flow page, the Files tab, a run's page (its side panel too) and the not-found box no longer reach further. On a very wide screen every page widens alike.
- On a phone, tables show each row as a card, each value named by its column, with the row's buttons under it: Take back, Launch, Revoke, Change and Delete no longer cover other columns.
- Breadcrumbs name the project, not its key.
- A button that cannot be pressed looks it: faded, unfilled, with a dashed edge.
- A field cut at its length (a pasted name of more than 100 characters) says so under it.
- The canvas on the server's pages tells a run in the pages' words: **Run a Check** (not **Run as Skeleton**), "check run", "went well", "failed" and "stopped" (no exit code, no "Run interrupted"), "1 host", and the earlier runs with the time and its zone. A stopped run's status is "stopped", with who stopped it as its **Why**.
- Search names workspaces and projects by name, not by key, and says a run's state as the run pages do ("went well", "stopped").
- Breadcrumbs name the project, schedules name their owner, and launch configurations name their flow, by name (the key, login or file on hover).
- The audit log's **Who** finds part of a login or a name, in any case, and a refused sign-in by the login typed; the filters are kept in the address, so a reload or a shared link shows the same entries. A login stays on one line, and a refused sign-in says the login was typed, not signed in. A request the server turned down (a field that is not right, a login already taken) is **refused**, as a missing access is; **failed** is for what the server could not do.
- The audit log's entry for a changed credential lists only the fields whose values changed (and `secret` when a new secret was given).
- Deleting a person or a group says so on the list it leads back to. A person's groups link to their pages; a group's page calls its grants **Access this group gives**.
- **Send no email** is now **Turn email off**, says on hover that nobody gets email until a mail server is saved again, and asks first in those words.
- A new file made on the Files page is "Add <file>" in the change list and in the commit message, not "Edit".
- A flow with no steps is "no steps yet" in the project's list (not "no findings"), and its page says to Edit to add them.
- An image environment with no image yet says "pull it" (not "build it"), and the launch configuration form says "(not pulled yet)"; the environments list says "1 launch configuration" as the environment's page does.
- A registry host typed as an address (`https://registry.example.net:5000/`) is taken as its host and port. The AWX address error says http:// is accepted too. An email address that is not one is said plainly.
- A schedule's true-or-false input is picked from a list, as on the launch form.
- A flow with no steps yet offers **Edit** as the main button to who may edit it.
- "The flow has N errors" names them (the step and what is wrong, a few, then how many more), and the launch page lists each as a link that opens the flow with that step selected (for editing, when you may edit it).
- Editing a flow in the pages leaves the canvas right under its head: **Save**, **Stop editing** and **Discard** sit beside the title, **Save** asks for the commit message, the draft's commit is behind **i** beside Full screen, and the line about the others shows only when someone else (or another tab of yours) is in the draft.

### Fixed

- **Add a collection** on an execution environment no longer offers collections already in the spec; one removed is offered again.
- A flow that is not there no longer shows an empty white canvas in the dark theme nor offers to copy or delete it; it links back to its project.
- Pressing Delete on a flow's canvas when it is shown read only says so, instead of nothing happening.
- A page for something that is not there asks the server once: no repeated failing requests, and a run's page no longer asks for the events of a run that is not there.
- A flow started from a sample keeps its own version and owner; before, it took the sample's (version 3, owner netops).
- The note after starting a flow from a playbook or sample counts the steps as **Readiness** does, on every level.
- Ctrl+Z after starting a flow from a sample or a playbook says what it took back in one line ("Took back the import of site.yml (28 steps)"), and a change inside a subflow is named by its step, not "a step".
- A step bound to a role the project does not have is shown with a warning and as specified, not implemented, in the flow editor and the flow page.
- **Add a directory** on the sign-in settings puts the focus on the form's first field.
- On a laptop (1024 px wide, or 1280 x 720 with the side menu) a flow's canvas keeps the window's height: the designer's side panel stays beside it, folded to a strip until a step is selected, instead of going under the canvas. Only on a phone does it go under.
- The canvas opens with the whole flow in view, notes included, at every width and in the editor; a sample opened in the editor is fitted again, and a new note is brought into view. The open fail port question names its step in full and wraps on a narrow window.
- After a step is clicked on a run's page, the mouse wheel scrolls the page again; a click on the empty canvas still lets it zoom.
- On a run's canvas a step the run did not reach no longer shows a check beside "not reached", and wires no host took have no "0 hosts" label. Notes read clearly on a flow's page when no run is shown.
- The **Import…** and **Open Sample Flow…** pickers dim the canvas behind them (a click there closes them), and the AWX picker takes the focus.
- Leaving a launch configuration's Settings, the launch page or a new launch configuration with changes not saved asks first; switching between a configuration's own tabs keeps the launch form's typing and does not ask. Typing in **Send a test** of Notifications no longer asks.
- Pending uploads show each file's own size.
- The note of the last save on the Files tab goes once a new change starts.
- A field's problem no longer pushes the other fields of a credential's variable row or of a collection row out of line. The private key's problem marks the key box, not the file chooser.
- A credential name that is taken, an empty token or password, and a schedule's missing input are said at their field, not as a banner or the browser's tooltip. A schedule's input hint says when there is no start value.
- A schedule with no commit of its own says it runs the configuration's pinned commit when the configuration has one, not the newest commit.
- A wrong time zone and a wrong cron are both said at once, and checking them as they are typed no longer logs errors in the browser's console. The cron's hint no longer repeats a wrong zone.
- An operator who opens the address of a new launch configuration is told it needs rw, instead of a form refused at Add.
- On an external project's Settings, the reason its source cannot be read is said once, under Source.
- Deleting a project with a run going says to stop the run, as the pages do.
- A rejection without a comment is refused by the server, whatever asks for it (the canvas, the API, an agent), not only by the pages.
- The Approvals count in the side menu follows a decision made on the canvas, and what the Approvals page shows, at once.
- The hosts of a run waiting at an approval read as waiting for a decision, not in progress.
- The home page accounts for every run of the day (those going and stopped too), and says whose decision your waiting run needs.
- On a run's page the canvas fits the window beside a long side panel: the whole flow and its zoom controls are in sight.
- A comment is typed in the page's font, not in monospace.
- **Run again** on a real run asks first, as a real launch does, and says which inputs it reuses; the page no longer asks for the new run's view before it has started.
- A run stopped while it waited for approval no longer shows the approval waiting and the later steps waiting on the canvas: the step it stopped at reads stopped, the rest not reached. A stopped run says who stopped it and during which step, its output ends with that, and its header says how long it went.
- A failed run says how many hosts failed and at which step, not Ansible's exit code. A run that reached no host says which targets or limit left none, not Ansible's own error.
- Home counts stopped runs and runs still going in the day's total, and the runs that wait for a decision are a link to them.
- The flow page says that runs use the branch, not the unsaved edits of a draft. **Latest runs** follows a queued run sooner, so it does not say queued while the canvas shows it running. A run that was stopped, failed or lost says so in the canvas's run list instead of "did not finish" (with a designer after 1.0.1-rc.7).
- A launch configuration whose flow was deleted is marked on the project's page and offers no **Launch…**; its page says so. A deleted flow's page says it is gone and offers no launch. Deleting a flow names the schedules that would then fail.
- A step where hosts failed in the run shown no longer has a green check beside "1 failed" (with a designer after 1.0.1-rc.7).
- Disabled fields (Branch and Commit for an operator) look disabled.
- The page for adding or changing a launch configuration says what saving checks: an environment still building and the hosts are checked at launch.
- An empty flow's **Get Started** opens the guide's part on building a flow in the pages. The pickers of **Import …** and **Open Sample Flow…** take the focus when they open and close with Escape. A sample opened in a project that lacks its roles says which roles to copy.
- A flow's page shows its newest run on the canvas, as **Latest runs** above it lists it; before, the Run panel said there was no run. A run the canvas launches, or one that ends while shown, updates **Latest runs** and the canvas's run list, and a run that is still going is listed as running, not "did not finish". The Run panel names a run of the server as one, with its number, not as a local run (with designer 1.0.1-rc.7).
- Every time on the pages names its time zone (yours), in one format: search results showed runs in UTC, other pages in local time without saying so.
- Schedules: the **At** of a one-time schedule is in the schedule's **Time zone**, as its hint now says (before, it was in the browser's zone whatever the field said). The cron and **At** hints name the zone they are read in, and the next times are shown in your time zone, named.
- Schedules fire at their time; before, up to half a minute late. The Schedules tab follows fires while it is open: **Next** moves on, and **Last** shows the run it launched as it stands now (went well, failed), not "queued".
- The Branches tab counts and lists the branch a project's start made, with no reload.
- **Last used** of access tokens follows a token's use elsewhere when you come back to the page, and every half minute while it is open.
- A run is named the same everywhere: its flow and #number (the run page, its breadcrumb, search, the home page).
- **What the flow needs** says that a configuration without an environment runs on the server's default image, as **What would run** does.
- **Upload files** with several files picked at once keeps every file, not only the last.
- A new file or a rename onto a path outside the project (`../`) or onto a file that is there is refused when typed, not at **Save**, and no longer hides that file.
- **Copy the flow** says what is wrong with the file (outside the project, not `.flow.yaml`, already there) and offers a name that is free, instead of "Something went wrong".
- A file deleted but not saved yet is said to be marked for deletion, not missing. **New file** puts the cursor in the new file's editor, and the editor is a labelled text box for screen readers.
- A schedule's cron problem is said once, not three times.

- On a phone the breadcrumb is on a line of its own above the search box; it was squeezed to one letter per line. All of a project's tabs show, wrapped.
- In a narrow window (a phone, a tablet, a laptop with the menu) a flow's side panel goes under the canvas, so the canvas keeps the width; it was left a few pixels, and about 200 in edit mode at 1024 px.
- Tables fit the page: long names, user names, paths and audit details wrap instead of pushing **Launch**, **Change**, **Delete** and **Revoke** out of sight. On a phone a row's buttons stay at the right edge, and a table that still scrolls sideways shows a shade on the side that has more.
- The runs' project filter no longer grows to the longest project name and makes the page scroll sideways.
- Every page has one frame: the breadcrumb, the search box and the page's title start at the same edge on a run's page, a flow's page and the Files tab, and the search box no longer moves between them. On a phone the search box lines up with the page.
- Terminal output keeps its columns (PLAY RECAP): long lines scroll sideways in their box instead of breaking.
- On a phone the search's results line up their titles.
- The launch form no longer moves while it loads (the inventory's groups take their place from the start), and **Another branch or commit, a limit** comes before the mode and **Launch**, so a limit is seen before launching.
- **Limit** is applied: a run limited to some hosts runs on those only. Before, it ran on every host it targeted.
- **Stop** stops a running run at once, and a run asked to stop never ends as succeeded; its hosts show as stopped.
- A run that reached no host (none of its targets is in the inventory) fails, saying so, rather than "went well".
- A run whose image could not be pulled says why, not only "The run produced no events". An image environment whose pulls all failed is refused at launch, and its page no longer says runs get an earlier build.
- A run that fails after an approval was rejected says who rejected it and why, not Ansible's exit code; the email about a rejection no longer says "The run goes on."
- While a run goes on after an approval, the steps before it keep their results on the canvas.
- **Open in Text Editor** on a run's or flow's canvas opens the flow's file on the project's Files tab.
- The launch page of a configuration whose flow was deleted says why it cannot launch, not "The server answered 422"; a missing flow's page offers no **Edit** or new configuration.
- Saves of a flow's draft are listed among the pushes through the server. After **Copy the flow**, the copy's page closes the form and shows the new commit. The notice of what a flow was imported from goes once the import is taken back.
- **Delete the flow** cannot be sent twice; signing out leaves the address of the last page; the token form starts from its defaults; a credential that launch configurations use cannot be deleted; deleting an environment returns to Environments.
- A project started from the **Edge baseline** sample runs: its steps use the roles the sample brings. Before, its first run failed with "the role netops.baseline.push_ntp_aaa was not found", and Push baseline showed as an empty subflow. A project made from it before keeps that flow; start a new one, or copy the sample's flow over it.
- After going to another page, the keyboard focus is on the new page's title, not at the top of the document. Esc in the search field empties it and leaves the cursor there; `/` and Ctrl+K open the search while the flow canvas has the focus too. Esc closes the phone menu, whose button says **Close menu** while it is open.
- Screen readers hear which schedule a **Change**, **Pause** or **Delete** button is for.
- The sign-in page no longer logs an error in the browser's console, and its card no longer shows the picture through it.
- Small layout fixes: the dot of a status line sits outside the "active" badge; the "Added …" note goes when you switch tabs; **Launch…** and a branch's buttons line up at the right of their rows; tabs keep their width when opened; unchosen radio buttons show in the dark theme; file choosers follow the theme; a flow's long name is shortened on one line beside its buttons; a run's title lines up with its breadcrumbs; gaps under hints and fact lists; **Replace the certificate** is ruled off from the history; a sent test message is shown in green; the delivery log no longer repeats an address; collections found have no list bullets.
- Two runs of different projects that started in the same second could not both run: the second failed with "The run produced no events" (its container's name was taken). Each run's container now has a name of its own.
- A save in one tab now takes in what the same person is still typing in another tab of the draft (a background tab too); before, that typing was lost. The save waits only until each page has sent its typing. A page whose typing could not be sent says so.
- After **Save with the draft's side** (now: per place), the flow's page shows the new commit at once, not the one shown before editing.
- Your own push to the branch while you edit is "You changed this flow", not your name and "theirs"; your own save made in another tab says "You saved the draft".
- Ctrl+Z with nothing to undo, and a save that clashes with the branch, no longer log errors in the browser's console.
- A status line that wraps (a project's, a launch configuration's) no longer starts a line with a dot.
- A long credential name on a launch configuration's form wraps, instead of making the page scroll sideways.
- The Files tab no longer makes the window scroll by a few pixels; after deleting the picked file or folder and saving, the pane no longer says it is not there.
- The Help page's descriptions line up in every section; the side menu's **Workspaces** link is as easy to hit as the others.
- A field with a problem keeps its red mark while it has the focus.
- A flow just made with **New flow** (the first of a project too) opens for editing again; it sometimes opened read only, showing "No steps yet".

## 1.0.0 — First release

The first release of Ansible Flow Server, with Ansible Flow Designer 1.0: it reads and runs the
flows of designer 1.x. The image is `ghcr.io/chistokhinsv/ansible-flow-server` and
`chistokhinsv/ansible-flow-server` on Docker Hub; the Ansible collection `chistokhinsv.ansible_flow`
has the server's version from now on.

### Added

- A user guide in [docs/guide](docs/guide/README.md), with screenshots and a walkthrough of a first project (a workspace, a project from a sample, a launch and an approval); the README is a short introduction with a quick start.
- Release candidates: each version is tested by hand as a candidate (`X.Y.Z-rc.N`, a GitHub pre-release and an image tagged with its exact version) before it is released. See [RELEASING.md](RELEASING.md).
- What a run gives back: a flow's outputs (set in the designer) are kept with each run, per host, shown on the run's page under Outputs, and returned to a flow that launched it (the Ansible collection's `run` and `run_info`), over the API (the run's view) and over MCP (`run_status`).
- Every run has the Ansible collection `chistokhinsv.ansible_flow` and the server's address with a token of the run (acting as whoever launched it, deciding no approval, ending with the run), so a flow can launch another flow, wait for it or stop it with no settings. `AFS_RUN_URL` sets the address runs use and `AFS_RUN_VERIFY_TLS` whether they check the certificate. The collection can also stop a run and run one again.
- An Ansible collection, `chistokhinsv.ansible_flow` on Ansible Galaxy: launch runs and wait for them, read runs, decide approvals, and keep workspaces, projects, launch configurations, credentials, schedules and grants as code. See [Ansible collection](docs/guide/collection.md).
- Lists of runs are columns: state first, then the run, its launch configuration, mode, who started it, when, and the commit, so a list can be read down a column. On a phone or in a narrow pane a run is two lines.
- Pages to work on use the width of the screen. An execution environment shows what runs get now beside a wide spec: collections are a table of names and versions with one line to find or add one, Python and Debian packages are side by side, the base image and certificate authorities are folded, and Delete is the last section. A project's Files is one of its tabs: a bar with the branch and what adds files, the tree, and the file beside it as tall as the window; the README or the first file is open when you come. A launch configuration's settings are rows of two fields with one chooser for the execution environment (the server's default, an environment, or an image by name).
- The runs list has a Mine choice and, for a chosen project, a choice of one of its launch configurations; both are kept in the address. A launch configuration's Runs tab lists all of its runs, older ones a page at a time. A project's Overview says how each flow's last run went, with a link to the run. Over the API, runs are filtered by launch configuration (`config`) and by who asked for them (`by`), and paging no longer skips runs made at the same moment; launch configurations and a project's flows say their newest run (`lastRun`); administrators read what one person reaches (`GET /users/:id/access`) and where a group is named (`GET /groups/:id/grants`) in one request. Agents get the same in `run_list` and `launch_config_list`. See [Runs](docs/guide/runs.md).
- The pages are arranged by what people do on them; long pages are split into tabs, each with its own address. A workspace has Projects, Execution environments, Credentials and Access (who can do what comes first). A project shows its state in one line and has Overview (launch configurations with their last run and a Launch button, flows, the newest runs), Runs, Files, Branches and Settings. A launch configuration has Launch (the form and the button on top), Runs, Schedules and Settings. A flow's page links to its launch configurations and newest runs, and Home lists the configurations you launched lately. A run's page leads through its workspace, project and launch configuration, shows the hosts with a problem first and has a button to its output; the runs list filters by project and loads older runs. The administration's pages are in the side menu: People and Groups are tabs with adding behind a button, a person's page shows what they reach in each workspace, the certificate page shows the certificate and its history before the ways to replace it, Notifications opens on the delivery log, and My account has Profile and Access tokens. See [The web pages](docs/guide/web-pages.md).
- Every page now has the new look: workspaces, projects and the administration's pages are rows divided by thin lines; runs are rows with their state in words and are filtered with a row of choices; approvals waiting for you are each a tinted box with the decision in it, others' are rows with why not; forms being filled in sit on a quiet surface. See [The web pages](docs/guide/web-pages.md).
- A new look for the pages: dark by default with a light theme beside it (the theme button goes dark, light, as the device), calm flat sections, and colour only where something needs you. A side menu replaces the top bar, with the count of approvals waiting for you and your workspaces. Sign-in is a card over a picture of a flow. A new Home says how the day went, lists the approvals waiting for you, the latest runs and the workspaces; the workspaces list moved to `/workspaces`. A run's page shows the run on its canvas with, beside it, the approval that waits, its hosts with problems first, and why a host failed. See [The web pages](docs/guide/web-pages.md).
- A flow library: an administrator makes a project a library, and its flows' subflows are offered to every project (to people who may read the library's workspace) on a new Library page and in **Insert Shared Subflow…** while editing a flow in the pages. A copy is pinned to the library flow's version and commit; a flow's page lists its library copies and which are behind, with **Update** while its draft is edited. The same over the API. See [Flow library](docs/guide/web-pages.md#flow-library).
- A project's files in the pages: **Files of the project** shows the tree of a branch; read and download any file, edit text files with highlighting, add, upload (also a folder as zip), move and delete files and folders. The changes are kept until **Save**, one commit on the branch by you; it goes on top of a branch that moved, and is refused with the files listed when the branch changed the same files. The same over the API. See [Files of a project](docs/guide/web-pages.md#files-of-a-project).
- Runs find the repository's own modules (`library/` with `module_utils/`), plugins (`filter_plugins/`, `lookup_plugins/`, `test_plugins/`, `action_plugins/`), the callbacks its `ansible.cfg` enables, and `group_vars/` and `host_vars/` at the repository root, as runs from VS Code do; a relative file a step reads is the repository's. See [Runs](docs/guide/runs.md).
- The server certificate's private keys are kept sealed with the master key in the data folder, so a copy of the folder without the master key does not give them away. Keys kept plain by an older version are sealed at the next start, and `secrets rotate` seals them again. Keep the master key outside the data folder for this to help. See [HTTPS and the certificate](docs/guide/certificates.md).
- Push hooks from GitHub: the hook's token is GitHub's webhook secret, and the server checks GitHub's signature of each call. A project's page has a **Push hook** section to set one up (the address and token shown once, with how to enter them at GitHub, GitLab and Gitea), make a new token or remove it. See [Workspaces and projects](docs/guide/workspaces-and-projects.md).
- A project's source over SSH signs in with an SSH key from the workspace's credentials, with or without a passphrase, for reading it and for passing pushes on. SSH host keys are trusted on first use and kept in the data folder; the project's page shows the fingerprint, and a host that shows another key later stops the project until an administrator accepts the new key. See [Credentials and the master key](docs/guide/credentials.md).
- Manage a project's branches on its page and over the API: each with its newest commit and the commits not on the project's branch; make one from a branch or a commit, delete one, and (administrators) make another the branch that runs. For a project with a source the change is made at the source. The branch that runs and branches launch configurations use are not deleted, and a branch with unmerged commits is deleted only when you confirm. See [Branches](docs/guide/workspaces-and-projects.md#branches).
- Start a project the server hosts from a sample project (Hello, Edge baseline, Firewall upgrade) or from an archive of your files (zip or tar.gz), when adding it or on its page while it is empty; the same over the API. Archives are checked before anything is committed: no paths outside the project, no links, no `.git` folder, at most `AFS_ARCHIVE_MAX_MB` unpacked. See [Starting a hosted project from a sample or an archive](docs/guide/workspaces-and-projects.md#starting-a-hosted-project-from-a-sample-or-an-archive).
- Install a server certificate from a PFX (PKCS#12) file: `cert install <file.pfx> --passphrase-file <file>`, a PFX upload with its passphrase on the Server certificate page, and the same over the API. The certificate, its chain and its key go through the usual checks; the passphrase is never an argument or a log line and is kept nowhere. See [HTTPS and the certificate](docs/guide/certificates.md).
- Edit flows in the pages, together: **Edit** on a flow's page opens the designer in full. Everyone editing one flow edits one shared draft and sees the others' changes at once, with who is here and what they changed; Ctrl+Z takes back your own last edit; **Save** makes one commit on the branch with everyone who edited as co-authors (merged step by step when the branch moved, conflicts listed); **Discard** drops the draft. Binding a step searches the module catalog read from the flow's execution environment image. See [Editing flows in the pages](docs/guide/web-pages.md#editing-flows-in-the-pages).
- When someone changes a flow you have open, a bar on the canvas says who and how much, with Show changes (the Changes lens against the version you had) and Update. The Changes lens compares with any earlier commit of the flow, and a project's page lists the flows changed while it is open. The same over the API: a project's event stream, the changes between two commits, and a flow's history. See [The web pages](docs/guide/web-pages.md).
- Sign in with a directory (LDAP, Active Directory): people type their directory login and password in the usual form. Administrators add directories on the Sign-in page from an Active Directory or OpenLDAP preset, map the directory's groups (nested AD groups too) to server groups or administrator, and test a login. A sync on a timer disables people who left the directory or were disabled in Active Directory, and their open sessions stop at once; a directory that does not answer disables nobody. See [People, groups and sign-in](docs/guide/people-and-sign-in.md).
- Sign in with your organisation (OIDC: Keycloak, Entra ID, Google and others): administrators add providers on the new Sign-in page, with what the provider's groups are here (server groups or administrator). People are made at their first sign-in; their groups follow the provider at each sign-in, while what was set here by hand stays. Passwords can be kept for administrators only. See [People, groups and sign-in](docs/guide/people-and-sign-in.md).
- Operations: `/metrics` for Prometheus (runs by state, queue depth, run and build durations, approvals waiting, notification deliveries, certificate expiry, requests), behind `AFS_METRICS_TOKEN`; `/readyz` says ready, degraded or unavailable check by check (database, data folder, disk space, container engine); `backup` and `restore` commands that take everything the server keeps while it runs and restore it into SQLite or PostgreSQL; an upgrade guide. See [Operations](docs/guide/operations.md).
- Install as a Linux service: a bundle per architecture (x64, arm64) with the server and Node.js on each release, and `install.sh`, which installs, upgrades (settings and data kept) and removes it as a systemd service. Runs use rootless podman as a service user of their own, or docker. SELinux systems are set up for it. A command line, `ansible-flow-server`, manages users, certificates and secrets. See [Install as a Linux service](docs/guide/install.md#install-as-a-linux-service).
- Run with docker compose: the server image (GitHub's registry and Docker Hub, amd64 and arm64, published for each release), a compose file with SQLite by default and a PostgreSQL profile, and an `.env` example. Runs start as sibling containers through the engine's socket; the data may be any volume, since the server finds where the engine has it (or `AFS_ENGINE_DATA_DIR` says). See [Run with docker compose](docs/guide/install.md#run-with-docker-compose).
- The server speaks HTTPS itself. At first start it makes a self-signed certificate; the `cert` commands request a certificate from your authority, install one, roll back, or make a new self-signed one, and the server uses a new certificate without a restart. Behind a proxy that does HTTPS, set `AFS_TLS=off`. See [HTTPS and the certificate](docs/guide/certificates.md).
- A Server certificate page for administrators, and the same actions over the API: the certificate in use with its days left, a request made and downloaded for your certificate authority, the signed certificate installed (or replaced with a certificate and key), a new self-signed one, a rollback, the history. A refused certificate is shown with every reason. Administrators see a banner on every page while the certificate has 30 days or fewer left.
- Settings from the environment or a `.env` file; SQLite by default, or PostgreSQL with `AFS_DATABASE_URL`. See [Configuration](docs/guide/configuration.md).
- People and groups, with sign-in by password. The first administrator is made with a setup code from the server's log, or with `user add --admin` on the server's machine. See [People, groups and sign-in](docs/guide/people-and-sign-in.md).
  - After five wrong passwords for a login in fifteen minutes, sign-in for it waits.
  - The `user` commands set a password, enable, disable and make administrators when nobody can sign in.
- Personal access tokens for programs (git, scripts, the VS Code extension): sent as a bearer token or as the password of a git sign-in. A token can be read-only, expires (90 days unless set), and cannot make tokens or set passwords. See [Access tokens](docs/guide/people-and-sign-in.md#access-tokens).
- Workspaces and projects. A project is a git repository: one the server keeps, or an existing one the server mirrors and looks at on a timer, on request, or when the git host calls the project's push hook. See [Workspaces and projects](docs/guide/workspaces-and-projects.md).
- Every project can be cloned, fetched and pushed through the server, signed in with an access token. A push to a project with an external repository is passed on to it and accepted only if that repository accepts it. The project's branch cannot be deleted or rewritten through the server. Who pushed what is listed per project.
- Web pages at the server's address: first-run setup, sign-in, workspaces, projects with their state, branches, flows and pushes, and your access tokens. Light and dark, at phone width too. See [The web pages](docs/guide/web-pages.md).
- Pages for people and groups, for administrators: add people, administrators and service accounts; change their profile, make or unmake administrators, disable, set a password, see and revoke tokens (and make them for a service account), delete; add, rename and delete groups, set their email address, webhook and members. See [The web pages](docs/guide/web-pages.md).
- A project's flows are listed with their errors and warnings, and a flow opens on the designer's canvas, read-only.
- Run on a flow's canvas opens the designer's launch dialog over one of the flow's launch configurations: its start values, the inventory's groups, and the hosts the targets match, counted again as you type; Run launches it and shows the run on the canvas.
- A launch configuration's page shows the hosts a launch would touch, read from the inventory in the launch's image: how many, which names the inventory does not have, and what looks like production. Also over the API: `POST /api/v1/launch-configs/:id/facts`. See [Launch configurations](docs/guide/launch-configurations.md).
- Credentials kept encrypted with a master key outside the database: SSH keys, logins, become passwords, vault passwords, git tokens, registry sign-ins and environment variables. A secret goes in and is never shown again. `secrets status` and `secrets rotate` manage the key; rotating seals again every secret the server keeps, runs' inputs included. See [Credentials and the master key](docs/guide/credentials.md).
- Runs use SSH keys with a passphrase: the key is unlocked into an ssh-agent inside the run, and a wrong passphrase fails the run with a clear reason. A registry credential signs in to the image's registry and pulls a private image before the run, without touching the engine's own sign-ins.
- A workspace's page lists its credentials, what each holds and how much uses it; administrators add one with a form for its kind, change it, replace its secret (never shown, not filled in by the browser; a private key from a file) and delete one nothing uses. An external project chooses its git sign-in when added and on its page, and says when its source asks for one.
- A project with a private repository over HTTPS signs in to it with a git token or login credential, also when passing pushes on.
- Launch configurations: a flow with its inventory, execution environment, check or real mode, limit, start values and credentials, saved only if it could run. Ask what a launch would run (commit, inputs, hosts) before running it. By default the newest commit of the project's branch runs; a launch can name another branch or a commit. See [Launch configurations](docs/guide/launch-configurations.md).
- Launching puts a numbered run in a queue kept in the database; runs can be listed and cancelled. At most `AFS_MAX_RUNS` runs at once (4), and `AFS_MAX_RUNS_PER_PROJECT` of one project (1). See [Runs](docs/guide/runs.md).
- The server runs flows: Ansible in an execution environment container (docker or podman), the same way VS Code runs them. See [How a run is run](docs/guide/runs.md).
  - The repository at the run's commit, with the flow's code generated fresh from the flow.
  - The image from the launch configuration, else `AFS_EE_IMAGE`. With no container engine, runs wait in the queue.
  - SSH keys, login and become passwords, vault passwords and environment variables from the credentials store; secret values are hidden in the output.
  - A run's output and how it went, step by step, are kept; a run longer than `AFS_RUN_TIMEOUT_MINUTES` (240) is stopped.
  - The server can itself run in a container, with the engine's socket.
- Runs can be watched as they go. See [Runs](docs/guide/runs.md).
  - **Runs** page: every run, filtered by state. A project's page lists its recent runs.
  - A run's page: what ran, the run on the flow's canvas live (hosts through each step), and Ansible's output as it comes. Administrators can **Stop** a run and **Run again** an ended one with the same commit, inputs and credentials.
  - On the canvas, a step's host output, the flow's earlier runs and Stop work as in VS Code.
  - Scripts can follow a run with `GET /api/v1/runs/<id>/events` (server-sent events).
  - Ended runs are removed after `AFS_RUNS_KEEP_DAYS` (90), and beyond `AFS_RUNS_KEEP_PER_FLOW` (200) of one flow.
- `/api/v1/meta` says which flow formats the server reads, what a client may rely on (`features`) and which designer canvas the pages carry. See [Compatibility with the designer](docs/guide/getting-started.md#compatibility-with-the-designer).
- Search in the top bar of every page (`/` or Ctrl+K): workspaces, projects, flows, launch configurations, runs (by number too), environments and settings pages as you type, only what you may see; people and groups for administrators. See [The web pages](docs/guide/web-pages.md).
- A launch configuration's page shows what its flow needs (the collections its steps run, and the project's `collections/requirements.yml`) against what its environment's image holds, and makes an environment for the flow in one step. Collections can be searched on Galaxy, or the configured hub, when writing a spec. See [Execution environments](docs/guide/environments.md).
- Execution environments: a workspace keeps the images its runs happen in, built by the server from a spec (ansible-core, collections with a version, a range or latest, Python and Debian packages, certificate authorities) or an image that exists already. A build settles versions into a lock, reads what the image really holds, keeps a log, and old images are removed. A launch configuration chooses an environment and gets its newest good build. The same environment can be taken to AWX or AAP as an ansible-builder file. See [Execution environments](docs/guide/environments.md).
- Schedules: a launch configuration runs by itself on a cron in a time zone, or once at a set time, as the schedule's owner, whose access is checked each time. A schedule has its own mode, input values and optionally a pinned commit; after downtime it runs once or skips; while its last run goes it skips or queues. Its page shows the next times and how the last fire went; administrators can hand a schedule to a service account. See [Schedules](docs/guide/schedules.md).
- Dev runs: someone who may push sends work they have not pushed yet, committed or not, and the server checks it with the flow's launch configuration, in check mode only. The work is kept a day under a ref nobody else sees and never reaches a branch or an external source; the run is marked a dev run. See [Dev runs](docs/guide/runs.md#dev-runs).
- Agents (Claude Code, Codex, Cursor) use the server over MCP at `/mcp`, signed in with an access token. See [Agents (MCP)](docs/guide/api-and-mcp.md#agents-mcp).
  - They read the projects' flows with the designer's flow tools, and list, check, launch, follow and stop runs, seeing and doing only what the token's owner may.
  - Approvals stay with people: an agent decides one only with a token made to allow it.
  - What an agent changes is in the audit log as coming from an agent.
- Notifications by email and webhook. See [Notifications](docs/guide/notifications.md).
  - Approvers are asked when a run waits for them; who launched a run is told when its approval is approved, rejected or times out; the approval's `notify` list is told of both.
  - A launch configuration can tell people and groups when its runs fail, or whenever they end.
  - Everyone sets their own email address on My account; webhooks are set by administrators.
  - Administrators are told as the server certificate nears its end (30, 14, 7, 3 and 1 days before, and once it has ended).
  - Email through a mail server set on the new Notifications page; its password is kept encrypted. Webhooks get the event as JSON with a `text` line for chat tools, signed with a key administrators make.
  - Messages are tried again when the mail server or receiver is busy or unreachable, survive a restart, and are listed in a delivery log with Try again. A message never holds a run's inputs or a secret.
- Approvals: a flow with approval steps stops at each one until someone allowed decides, then goes on with the hosts that waited. See [Approvals](docs/guide/approvals.md).
  - Whoever has the `approve` grant decides; when the approval names its approvers in the flow, only they. Who launched the run does not, unless the workspace allows it.
  - Decide with a comment on the **Approvals** page, on the run's page, on the canvas, or over the API. Who decided, when and why is shown with the run and kept in the audit log.
  - An approval with a timeout that nobody decides in time sends its hosts through its timeout port.
  - A waiting run holds no container, and still waits after the server restarts.
  - The `approve` grant lets its holder see the flows and runs they decide.
- Access levels: administrators give a user or a group `ro`, `operator`, `rw` or `approve` on a whole workspace or on one flow, on the workspace's page or over the API. See [Access levels](docs/guide/people-and-sign-in.md#access-levels).
  - `ro` sees the workspace's projects, flows, launch configurations and runs, and clones; `operator` also launches as a configuration says and stops runs; `rw` also launches another branch or commit, manages launch configurations and pushes through the server.
  - A grant on one flow replaces the workspace's for that flow; the highest of a person's own and their groups' grants counts.
  - **Who can do what** on the workspace's page lists every person with access as their grants come out.
  - People who are not administrators now see only what they were given: give grants after upgrading.
- The API is described as an OpenAPI 3.1 document at `/api/v1/openapi.json`, and the **API reference** page shows it by subject: what each address does, who may call it, what it takes. See [The API](docs/guide/api-and-mcp.md#the-api).
- Service accounts: an identity for a pipeline or program, with no password, signed in only with tokens an administrator makes for it (`"service": true`, or `user add --service`). See [Service accounts](docs/guide/people-and-sign-in.md#service-accounts).
- An access token can be limited to one workspace: it reaches that workspace's projects, credentials, launch configurations, runs and repositories, and nothing that spans workspaces. Choose it when making the token, or `user token --workspace`.
- Launching from the pages. See [Launch configurations](docs/guide/launch-configurations.md).
  - A project's page lists its launch configurations; administrators add, change and delete them, choosing the flow, branch or pinned commit, inventory, image, mode, limit and credentials.
  - A configuration's page has the launch form: the flow's inputs (secret ones typed hidden and never kept), check or real, another branch or a commit, and the limit.
  - **What would run** shows the commit, inputs and hosts before anything runs, with any problem shown at its field. **Launch** starts the run and opens its page. **Keep as start values** saves the typed values as the configuration's.
- An audit log of who did what and when: sign-ins (refused ones too), tokens, people and groups, workspaces, projects, credentials, launch configurations, runs launched, stopped and run again, pushes (refused ones too), and the server's `user`, `cert` and `secrets` commands. See [The audit log](docs/guide/audit.md).
  - Each entry names who, from where (pages, API, git, server command), what, to what, and how it ended. No secret values are kept.
  - Administrators read it on the **Audit log** page, filtered by person, subject, result, source and dates, and export it as CSV or JSON; `GET /api/v1/audit` for scripts.
  - Entries are kept for `AFS_AUDIT_KEEP_DAYS` (365); `0` keeps them all.
- Running a flow from its canvas: the choice of launch configuration also offers New configuration…, which opens the page that adds one for this flow (also when the flow has none yet). The canvas's launch dialog has Save as Launch Configuration…: a new configuration like the one chosen, with the dialog's mode and inputs (secret inputs are never kept). On a launch configuration's Launch tab, host lists suggest the inventory's groups; under Settings, Whom suggests the server's people and groups.
- Administrators delete a project on its Settings tab and a workspace on its Access tab, after typing its key; what goes with it is said first, and a refusal (a run going, a workspace not empty) is shown.
- My account has a Password section: change your own password (your other sessions are signed out).
- Flows are made, copied and deleted in the pages: New flow on a project's Flows (the designer's starting flow, opened on its page), Copy the flow… and Delete the flow… in the More (⋯) menu of a flow's page (the copy gets its own id and key; Delete says which launch configurations run it). Each is one commit on the project's branch, for people with rw on the workspace.

### Changed

- Insert Shared Subflow… opens a small picker over the canvas, also in full screen, closed with Cancel or Escape; with no library yet it says how a project becomes one. A flow's library copies are a line each above the canvas.
- New flow opens the new flow for editing, and an empty project the server hosts offers New flow too (its first commit).
- A check (skeleton) run passes its approvals by itself, as a skeleton run in VS Code does, and notifies nobody; only real runs wait for the approvers.
- Built on Ansible Flow Designer 0.86.0.
- Clearer pages: every approval waiting for you is tinted on Home, waiting is amber on the approvals pages too and Reject reads clearly beside Approve; the day's line on Home says how many runs failed and wait, not only how many went well; New branch, Make a token and Add a directory sit at the head of their sections; Keep as start values, To the output and a file's Download are buttons; a launch configuration's notification fields are Notify when and Recipients; the commit message field of a flow being edited is labelled; an empty library says how a project becomes one; an empty reason in the notifications log shows a dash.
- The top bar is as wide as the page under it, so the search box ends where the page does, and a page's breadcrumbs sit in the bar beside it instead of a row of their own. On a flow's page, Full screen (the canvas, viewing or editing) and Open on its own page (with the draft while editing) are icon buttons beside Edit.

### Fixed

- A run's page no longer repeats the run on its canvas: the canvas leaves the run's state, hosts, outputs, Stop and Run again to the page, and points to the steps for what each host did. On a flow's page the canvas offers Run only to those who may launch the flow, and Stop only to those who may stop a run. The canvas's earlier runs say how many hosts each ran on and how many failed (they said "0 hosts, did not finish").
- The audit log names what an entry is about: workspaces, projects, launch configurations and runs by name, linked to their pages while they exist, and said to be deleted when they are not; a push lists each branch as `main: 37e668ed → 71595cb5`; the whole detail of an entry opens under it. Over the API, a page of the log has `refs` with those names and pages.
- Links on a flow's canvas open in a new tab: a link in a note did nothing, and a step's Full Docs opened inside the page and was blocked.
- A run's page and a flow's page show a step's module docs in its Binding (they said "Reading the docs" for good), and the modules of the collection `chistokhinsv.ansible_flow` that every run has are found when adding a step and documented while editing.
- While you edit a flow in the pages, a note says when someone changes or removes it on the branch (a push from VS Code, another save), and what Save will do with both.
- When saving a draft finds the branch changed the same places, the notice is one short row with its choices, apart from the Save row under it, and can be closed with Not now.
- Stopping a run that waits for approval ends it on its canvas too: the run says who stopped it instead of waiting, and the approval says who cancelled it.
- Fields side by side stay on one line when the hint under one of them wraps.
- A workspace's Add project button shows on its Projects tab only.
- Finding a collection for an execution environment lists the collection named by the words first, and finds a full name such as `fortinet.fortios`, which found nothing before.
- An execution environment's page says under its title how the newest build went: built and whether runs get its image, failed and what runs get meanwhile, or still going; whether the spec changed since, and whether building again can bring newer versions. The button reads Build again once built.
- Building an execution environment while its spec has changes not saved no longer builds the old spec without a word: the page says the changes are not saved, and the button reads Save and build, which saves them first.
- The ansible-builder file of an execution environment follows its saved spec: collections added since the last build are in it, given as the spec writes them; collections the last build installed stay pinned to that version while it still meets the spec. With changes not saved, the page's link reads Save and get ansible-builder file and saves them first.
- Show Terminal on a run's canvas goes to the run's output without loading the page again, and outlines it for a moment; from elsewhere it opens the run's page at its output. The output is headed Terminal output and shows Ansible's colours and bold text; All of it as text and agents still get plain text.
- The suggestions for host lists and Whom show: they keep what is already typed in the field, so a field that starts filled (`all`, `olga`) offers the rest after it. A host list also shows the inventory's groups as buttons under the field, read when the Launch tab opens; a button adds its group or takes it out.
- Approvers see the runs of the workspaces and flows they approve in run lists (Runs, Home, a project's recent runs, the canvas's earlier runs); before, only one run at a time could be opened.
- The Add project form no longer stays open over a workspace's other tabs, and the search box empties when another page opens.
- A workspace's Access tab and the administration pages say they are for administrators to someone else, instead of an empty page or Nothing here.
- Pages line up: the dot between items of a status line is no longer underlined with the link after it, a page head's buttons and links are centred, filter choices are as tall as the box beside them, the e-mail settings' two buttons sit side by side, the audit log's Since and Until stay together, API rows that do not open line up with those that do, and the sign-in title does not leave one word alone.
- A project's page no longer draws two lines with nothing between them where one section ends and the next begins.
