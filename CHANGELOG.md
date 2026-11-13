# Changelog

All notable changes to Ansible Flow Server.

## Unreleased — first version

Nothing is released yet. The server does not run flows yet: launched runs wait in the queue.

### Added

- The server speaks HTTPS itself. At first start it makes a self-signed certificate; the `cert` commands request a certificate from your authority, install one, roll back, or make a new self-signed one, and the server uses a new certificate without a restart. Behind a proxy that does HTTPS, set `AFS_TLS=off`. See [HTTPS and the certificate](README.md#https-and-the-certificate).
- Settings from the environment or a `.env` file; SQLite by default, or PostgreSQL with `AFS_DATABASE_URL`. See [Configuration](README.md#configuration).
- People and groups, with sign-in by password. The first administrator is made with a setup code from the server's log, or with `user add --admin` on the server's machine. See [People, groups and sign-in](README.md#people-groups-and-sign-in).
  - After five wrong passwords for a login in fifteen minutes, sign-in for it waits.
  - The `user` commands set a password, enable, disable and make administrators when nobody can sign in.
- Personal access tokens for programs (git, scripts, the VS Code extension): sent as a bearer token or as the password of a git sign-in. A token can be read-only, expires (90 days unless set), and cannot make tokens or set passwords. See [Access tokens](README.md#access-tokens).
- Workspaces and projects. A project is a git repository: one the server keeps, or an existing one the server mirrors and looks at on a timer, on request, or when the git host calls the project's push hook. See [Workspaces and projects](README.md#workspaces-and-projects).
- Every project can be cloned, fetched and pushed through the server, signed in with an access token. A push to a project with an external repository is passed on to it and accepted only if that repository accepts it. The project's branch cannot be deleted or rewritten through the server. Who pushed what is listed per project.
- Web pages at the server's address: first-run setup, sign-in, workspaces, projects with their state, branches, flows and pushes, and your access tokens. Light and dark, at phone width too. See [The web pages](README.md#the-web-pages).
- A project's flows are listed with their errors and warnings, and a flow opens on the designer's canvas, read-only.
- Credentials kept encrypted with a master key outside the database: SSH keys, logins, become passwords, vault passwords, git tokens, registry sign-ins and environment variables. A secret goes in and is never shown again. `secrets status` and `secrets rotate` manage the key. See [Credentials and the master key](README.md#credentials-and-the-master-key).
- A project with a private repository over HTTPS signs in to it with a git token or login credential, also when passing pushes on.
- Launch configurations: a flow with its inventory, execution environment, check or real mode, limit, start values and credentials, saved only if it could run. Ask what a launch would run (commit, inputs, hosts) before running it. By default the newest commit of the project's branch runs; a launch can name another branch or a commit. See [Launch configurations](README.md#launch-configurations).
- Launching puts a numbered run in a queue kept in the database; runs can be listed and cancelled. At most `AFS_MAX_RUNS` runs at once (4), and `AFS_MAX_RUNS_PER_PROJECT` of one project (1). See [Runs](README.md#runs).
