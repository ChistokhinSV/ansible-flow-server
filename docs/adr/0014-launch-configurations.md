# ADR-0014: Launch configurations, and settling a launch

- Status: accepted (2026-11-13, AFS-18). Builds on ADR-0003 (which commit runs), ADR-0012
  (flows), ADR-0013 (credentials)
- Context: a run needs a flow, a commit, inputs, an inventory, an execution environment and
  credentials. People should choose that once and launch many times; a schedule and an API call
  need the same thing by name

## Decision

**A launch configuration** (`src/server/launch/configs.ts`) belongs to a project and names: a
flow file, optionally a branch or a pinned commit, an inventory path in the repository, an
execution environment image, check or real, a limit, start values for the flow's inputs, and
credentials. It holds **no secret** and **no copy of the flow**.

**Saved only if it could run now.** Everything it says is checked against the project when it
is made or changed: the flow exists at the commit and has no errors; the inventory path exists;
the branch or commit exists; each start value is for an input the flow has and reads as that
input's type; the credentials are the workspace's, of a kind a run takes, and one each of the
ways to sign in (`ssh_key`, `login`) and to become another user. A refusal names the setting it
is about (`field`), for a form.

**No secret-looking input is kept.** The designer's own rule decides what looks like a secret
(`launchFields`). Such a value is given at launch or comes from a credential.

**Settling a launch** (`launch/prepare.ts`) turns a configuration and what a person adds into
exactly what would run, or the list of everything in the way:

- **Which commit:** what the launch names (a branch or a commit), else what the configuration
  names, else the newest commit of the project's branch. For a project with a source the server
  looks at the source first. A source that cannot be read stops the launch: it would run an
  older commit than the person thinks.
- **The inputs:** typed text is read as each input's type with the designer's code
  (`readFields`), so `fw-edge-01, fw-edge-02` is a host list here as it is in VS Code.
- **The answer** names the commit, the flow and its version, the mode, the inputs, the hosts and
  groups the flow starts on, the credentials. A secret-looking input's value is not repeated in
  the answer.

**Two requests:** `GET …/form` is the flow's inputs as a form (it does not ask the source, so a
page opens fast); `POST …/check` settles a launch and runs nothing. The run itself is made from
the same settled launch by the queue (AFS-19).

**A credential a configuration names is in use**: it is counted and not deleted until taken
out. A configuration goes with its project.

**Who** (until AFS-27): everyone signed in reads and asks; administrators make and change.

## Not in this decision

- Starting the run (AFS-19, AFS-20), the pages (AFS-65).
- The hosts a launch would touch as the inventory has them, which needs the probe in the
  execution environment (AFS-20).
- Whether real runs may be limited to the project's branch (AFS-27).
- Which images may be used (AFS-32).

## Alternatives considered

- **Checking only at launch.** Saving never fails. But a configuration that cannot run is found
  by the schedule at night instead of by the person who made the mistake.
- **Keeping inputs as typed text.** Simple. But a start value would be read differently if the
  flow's input changed type; kept as values, the change is caught when the configuration is
  next saved or launched.
- **A copy of the flow in the configuration.** Launches would not depend on git. But two texts
  of one flow is what ADR-0003 exists to prevent.

## Consequences

- Changing a flow's inputs can make a saved configuration not ready: the launch says which
  input, and the configuration is fixed by saving it again.
- A configuration made for one flow and pointed at another must have its start values replaced
  in the same change.

## Amendment: the pages (2026-11-13, AFS-65)

- **One page per configuration, with its launch form on it:** settings above, the form below.
  The form is read from `GET .../form` for the chosen mode, branch or commit, so its fields are
  the flow's inputs at the commit that would run; what was typed into a field of the same name
  stays when the form is read again.
- **The server judges the form:** the page sends what was typed and shows each problem at its
  field (`problems[].field`); the browser's own checks do not stop the question first, so a
  person sees the same words a script gets.
- **Start values are kept from the launch form** ("Keep as start values"), not from the add or
  change page: the inputs are known only once the flow is read at a commit, and that is where a
  person types them anyway. Secret-looking inputs are never kept, as before.
- **Anyone signed in may ask what would run;** only administrators launch, add, change and
  delete, until access levels (AFS-27).
- Not in this amendment: the hosts as found in the inventory (launch facts) and launching from
  the canvas's own Run dialog.

## Amendment: the hosts, and Run on the canvas (2026-11-14, AFS-67)

- **The inventory is read where the run reads it:** the designer's probe runs in the launch's
  image (else the server's), over the repository at the launch's commit, with the
  configuration's `env` credentials only (a dynamic source's token; no keys, no passwords). Its
  answers are the designer's own (`launchFacts`, `inventoryGroups`), so VS Code and the server
  say the same hosts. A registry credential pulls a private image first (AFS-66).
- **A probe is kept for a while:** the dialog asks again while someone types; starting a
  container each time would take seconds. One probe per project, commit, image, inventory and
  credentials; closed two minutes after its last answer, at most four, all closed when the
  server stops. Their containers carry the worker label, so a stopped server's are removed at
  start, and their checkouts are `run-probe-*` folders, swept the same way.
- **`operator` asks for the hosts** (`POST .../facts`): it starts a container, which `ro` must
  not be able to do at will. `check` stays `ro` and says the targets only.
- **Inputs that do not read yet are left out**, as the designer's dialog does (`checkInputs`):
  only a host list that does not read holds the count back, and then it says which input.
- **Run on the canvas opens the designer's dialog** (LaunchPlan) over a launch configuration of
  the flow: none: the canvas says to add one; several: the person picks. The plan's fields come
  from the form, its groups and facts from `facts`; Run launches the configuration with the
  dialog's values as typed text. The vault password comes from the configuration's
  credentials, so the dialog never asks for it; the flow at an older commit (a run's) is not
  launched from its canvas.
- **Not in this amendment:** a credential's passphrase-protected key or vault password for an
  inventory that needs them (only `env` credentials reach the probe).
