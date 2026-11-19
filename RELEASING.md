# Releasing

From 1.0 no version is released before it was tested by hand on **staging**: a release candidate
of the designer and the server, deployed on the GNS3 lab VM, through the
[release test plan](docs/testing/release-test-plan.md).

## Versions

- **Designer** (VS Code extension and `@ansible-flow/*` packages) and **server** have their own
  minor and patch versions; the **major** versions go together (server 1.x carries designer 1.x).
- The **Ansible collection** `chistokhinsv.ansible_flow` has the server's version (`galaxy.yml`)
  and goes out with the server's tag.
- A **release candidate** is `X.Y.Z-rc.N`. Its tag `vX.Y.Z-rc.N` publishes it where testers and
  staging get it, and nowhere users get it by default:

| Part                  | Release `vX.Y.Z`                                      | Candidate `vX.Y.Z-rc.N`                                 |
| --------------------- | ----------------------------------------------------- | ------------------------------------------------------- |
| Designer npm packages | npm, dist-tag `latest`                                | npm, dist-tag `next`                                    |
| Designer VSIX         | Marketplace, Open VSX, GitHub release                 | GitHub **pre-release** only                             |
| Server image          | ghcr.io and Docker Hub: `X.Y.Z`, `X.Y`, `X`, `latest` | ghcr.io and Docker Hub: `X.Y.Z-rc.N` only               |
| Server bundles        | GitHub release                                        | GitHub **pre-release**                                  |
| Collection            | Ansible Galaxy                                        | built and tested; not published (staging runs mount it) |

The server pins the designer's packages to one exact version, so a server candidate can carry a
designer candidate (`1.1.0-rc.2`) from npm, and CI builds it like any version. The `vendor/`
tarballs (`just afd-packages`) are only for trying an unpushed designer branch on one machine:
nothing built from them is tested on staging or released.

## Staging

One server on the GNS3 lab VM (`ssh gns3`, `192.168.200.128`), installed with this repository's
docker compose files and kept between candidates, so every candidate is also an **upgrade** of the
data the last one left:

| What             | Where                                                                                                                                                                |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Address          | `https://192.168.200.128:9443` (self-signed certificate)                                                                                                             |
| Folder on the VM | `~/afs-staging` (`compose.yaml`, `.env`; `AFS_VERSION` picks the image)                                                                                              |
| Database         | PostgreSQL (the `postgres` profile), kept in its volume                                                                                                              |
| Lab hosts        | the GNS3 lab's devices, reached from the VM                                                                                                                          |
| People           | `dana` (administrator), `olga` (operator), `andre` (approve, group `change-board`), `nina` (ro); passwords in the tester's password manager, never in the repository |

Set up once (on the VM):

```sh
mkdir -p ~/afs-staging && cd ~/afs-staging
curl -fsSLO https://raw.githubusercontent.com/ChistokhinSV/ansible-flow-server/main/deploy/compose/compose.yaml
curl -fsSL -o .env https://raw.githubusercontent.com/ChistokhinSV/ansible-flow-server/main/deploy/compose/.env.example
# .env: AFS_PUBLISH_PORT=9443, AFS_PUBLIC_URL=https://192.168.200.128:9443,
#       AFS_VERSION=<the version to start from>, AFS_DB_PASSWORD=<a password>,
#       AFS_DATABASE_URL=postgres://afs:<the same password>@postgres:5432/afs
docker compose --profile postgres up -d
docker compose logs server | grep -i "setup code"
```

Deploy a candidate (on the VM):

```sh
cd ~/afs-staging
docker compose exec server node dist/server.js backup /var/lib/afs/before-<version>.tar.gz
sed -i 's/^AFS_VERSION=.*/AFS_VERSION=<version>/' .env
docker compose --profile postgres pull server && docker compose --profile postgres up -d
docker compose logs --tail 50 server
```

Going back to the release before (a candidate failed and staging must be as users have it): set
`AFS_VERSION` back, `up -d`, and restore the backup if the candidate changed the database
(see [Backup and restore](docs/guide/operations.md#backup-and-restore)).

## A release, step by step

1. **Tickets and changelogs.** Every change has its YouTrack ticket and a line under
   `## Unreleased` in its CHANGELOG (designer, server, collection), with the knowledge base
   updated.
2. **Designer candidate** (when the designer changed): in the designer repository, set
   `package.json` to `X.Y.Z-rc.N` (`npm version X.Y.Z-rc.N --no-git-tag-version`), commit
   "Release candidate X.Y.Z-rc.N", tag `vX.Y.Z-rc.N`, push the tag. Publish puts the packages on
   npm's `next` tag and the VSIX on a GitHub pre-release.
3. **Server candidate:** on a branch `rc-X.Y.Z`: `npm install -E @ansible-flow/core@<designer
   version> @ansible-flow/node@… @ansible-flow/designer@… @ansible-flow/assets@…` (the designer
   candidate, or its release when only the server changed); `package.json` and `galaxy.yml` to
   `X.Y.Z-rc.N`; `just check`, `just test`. Commit, push the branch, tag `vX.Y.Z-rc.N` on it,
   push the tag. Image and Release publish the candidate.
4. **Deploy to staging** (above), and put the designer candidate into the tester's editors: in
   the designer's checkout `just try X.Y.Z-rc.N` (VS Code and Antigravity IDE), then **Developer:
   Reload Window**.
5. **Test** with the [release test plan](docs/testing/release-test-plan.md): every check of the
   core part, and a check for each line under Unreleased. Record the result in the release's
   YouTrack ticket (the plan's table, with what failed).
6. **A failure** is a ticket; its fix goes to `main`, then a new candidate `rc.N+1` from step 2.
   Staging is not patched by hand.
7. **Release**, once a candidate passed: the same commits, with the version `X.Y.Z`:
   - designer: version `X.Y.Z`, `## Unreleased` → `## X.Y.Z — <title>`, commit, tag, push
     (Marketplace, Open VSX, npm `latest`);
   - server: on `rc-X.Y.Z`, the designer packages to `X.Y.Z`, version and `galaxy.yml` to
     `X.Y.Z`, its CHANGELOG heading and the collection's; merge into `main`, tag `vX.Y.Z`, push
     (image, bundles, Galaxy).
8. **After:** deploy the release on staging (it stays as users have it), check `/api/v1/meta`
   says the release's versions, close the tickets, update the knowledge base's feature maps.

A fix that cannot wait (a security fix) still goes through one candidate; the test plan's core
part is the least it gets.
