# Changelog

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
