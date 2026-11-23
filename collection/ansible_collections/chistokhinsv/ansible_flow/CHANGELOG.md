# Changelog

## Unreleased

### Added

- `run_relaunch` takes `hosts` (`not-ok`, `failed`, `unreachable`, `stopped`, or host names), `include_handled`,
  `mode`, `commit` (`same` or `newest`), `step` and `pause_points`: run only the hosts that did not go well, in
  check mode, at the newest commit, or step by step.

## 1.0.3

### Changed

- Released with Ansible Flow Server 1.0.3. The modules are as in 1.0.2.

## 1.0.2

### Changed

- Released with Ansible Flow Server 1.0.2. The modules are as in 1.0.1.

## 1.0.1

### Changed

- Released with Ansible Flow Server 1.0.1. The modules are as in 1.0.0.

## 1.0.0

### Changed

- The collection has Ansible Flow Server's version and is released with it: 1.0.0 with the
  server's 1.0.0. The modules are as in 0.0.3.

## 0.0.3

### Added

- `run`, `run_relaunch` (with `wait: true`) and `run_info` return `outputs`: what the run gave back
  per host, the flow's outputs set in the designer (Ansible Flow Designer 0.97 and Ansible Flow
  Server with it).

### Changed

- `url` and `token` are no longer marked required: each can come from `AFS_URL` and
  `AFS_TOKEN`, which every run on the server has, and a module still fails clearly without them.

## 0.0.2

### Added

- `run_cancel` stops a run, and can wait until it has stopped; a run that ended or was asked to
  stop already is left as it is.
- `run_relaunch` runs a run again (same commit, flow, mode, inputs and credentials), and can wait
  for the new run and fail when it fails.
- In a flow on Ansible Flow Server the collection needs no settings: the server gives each run the
  collection, its address and a token of the run.

## 0.0.1

### Added

- `run` launches a launch configuration, optionally waits for the run to end, returns how each host
  ended and a link to the run's page, and fails when the run did not succeed. A run that waits for an
  approval is returned as waiting, or waited through.
- `run_info` reads a run: its state, how each host ended, its approvals and the end of its output.
- `approval` approves or rejects an approval a run waits at; deciding it again the same way changes
  nothing.
- `workspace`, `project`, `launch_config`, `credential`, `schedule` and `grant` keep the server's
  objects as code, with check mode and diff. `project` can start a hosted project from a sample and
  look at its source now.
- Credentials send their secret only when made, unless `update_secret: always`.
- The `runs` lookup lists runs by project, launch configuration, flow, state or who launched them.
- One `module_defaults` group, `afs`, sets the server address and token for every module; they can
  also come from `AFS_URL` and `AFS_TOKEN`.
