#!/usr/bin/python
# -*- coding: utf-8 -*-
# Copyright (c) 2026 Sergei Chistokhin
# MIT License (see https://opensource.org/license/mit)

from __future__ import annotations

DOCUMENTATION = r"""
module: project
short_description: Manage projects of Ansible Flow Server
description:
  - Creates, changes and deletes a project of an Ansible Flow Server workspace. A project is a git
    repository of flows - a mirror of a repository elsewhere (O(git_url)), or one the server hosts itself.
  - A hosted project can start from one of the server's sample projects (O(sample)).
  - Idempotent - only the options given are compared, and only what differs is changed.
  - With O(sync=true) the server looks at the project's source now, as its Sync button does.
author:
  - Sergei Chistokhin (@ChistokhinSV)
extends_documentation_fragment:
  - chistokhinsv.ansible_flow.connection
  - ansible.builtin.action_common_attributes
attributes:
  check_mode:
    support: full
  diff_mode:
    support: full
  platform:
    platforms: all
options:
  workspace:
    description:
      - The key (or id) of the workspace.
    type: str
    required: true
  key:
    description:
      - The project's key, a lowercase slug such as V(edge). It cannot change.
    type: str
    required: true
  name:
    description:
      - The project's name as people read it. Required to create one.
    type: str
  git_url:
    description:
      - The address of the repository to mirror (C(https://) or C(ssh://), or C(git@host:path)).
      - Leave it out to have the server host the repository. Whether a project is hosted is settled when it is made.
    type: str
  git_credential:
    description:
      - The credential (its name or id, in the same workspace) the server signs in to O(git_url) with.
      - V("") takes it away.
    type: str
  git_ref:
    description:
      - The branch whose commits may run. The server uses V(main) when it is not given.
    type: str
  poll_seconds:
    description:
      - How often the server looks at O(git_url) for new commits, in seconds; V(0) for never.
    type: int
  library:
    description:
      - Offer the subflows of this project's flows to every project of the server.
    type: bool
  sample:
    description:
      - The key of a sample project the server ships, such as V(hello), for the first commit of a new hosted project.
      - Used only when the project is created; ignored for an existing project.
    type: str
  sync:
    description:
      - After the project is as described, have the server look at its source now.
      - The result is changed when the project's commit moved.
    type: bool
    default: false
  state:
    description:
      - V(present) makes the project as described; V(absent) deletes it (the server refuses while its runs go).
    type: str
    choices: [present, absent]
    default: present
notes:
  - Making, changing and deleting projects needs an administrator's token; O(sync) needs rw on the workspace.
"""

EXAMPLES = r"""
- name: Mirror the edge repository
  chistokhinsv.ansible_flow.project:
    url: https://afs.example.net
    token: "{{ afs_admin_token }}"
    workspace: network
    key: edge
    name: Edge
    git_url: https://git.example.net/netops/edge-flows.git
    git_credential: git-reader
    git_ref: main
    poll_seconds: 300

- name: A hosted project from the hello sample
  chistokhinsv.ansible_flow.project:
    workspace: network
    key: hello
    name: Hello
    sample: hello

- name: Look at the source now
  chistokhinsv.ansible_flow.project:
    workspace: network
    key: edge
    sync: true
"""

RETURN = r"""
project:
  description: The project as the server answers it (in check mode, as it would be); null after V(absent).
  returned: success
  type: dict
  sample:
    id: 2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d
    workspace: network
    key: edge
    name: Edge
    hosted: false
    gitUrl: https://git.example.net/netops/edge-flows.git
    gitRef: main
    commit: 3f9a1c7e5b2d4f6a8c0e1b3d5f7a9c2e4b6d8f0a
    sync: {state: ok, at: "2026-11-16T09:44:37.000Z"}
    pollSeconds: 300
"""

from ansible.module_utils.basic import AnsibleModule
from ansible.module_utils.common.text.converters import to_native

from ansible_collections.chistokhinsv.ansible_flow.plugins.module_utils.afs import (
    AFSClient,
    AFSError,
    connection_argument_spec,
    ensure_absent,
    ensure_present,
    seg,
)


def main():
    spec = connection_argument_spec()
    spec.update(
        workspace=dict(type="str", required=True),
        key=dict(type="str", required=True, no_log=False),
        name=dict(type="str"),
        git_url=dict(type="str"),
        git_credential=dict(type="str", no_log=False),
        git_ref=dict(type="str"),
        poll_seconds=dict(type="int"),
        library=dict(type="bool"),
        sample=dict(type="str"),
        sync=dict(type="bool", default=False),
        state=dict(type="str", default="present", choices=["present", "absent"]),
    )
    module = AnsibleModule(argument_spec=spec, supports_check_mode=True, mutually_exclusive=[("git_url", "sample")])
    p = module.params
    client = AFSClient.from_module(module)
    key = p["key"].strip().lower()
    try:
        workspace = client.need_workspace(p["workspace"])
        current = client.project(workspace["id"], key)
        if p["state"] == "absent":
            changed, diff = ensure_absent(module.check_mode, current,
                                          lambda: client.delete("/projects/%s" % seg(current["id"])))
            module.exit_json(changed=changed, diff=diff, project=None)

        if current is None and not p["name"]:
            module.fail_json(msg="Project %s/%s does not exist: give its name to create it" % (p["workspace"], key))
        credential = p["git_credential"]
        if credential:
            credential = client.credential_id(workspace["id"], credential)
        wanted = dict(name=p["name"], gitUrl=p["git_url"], gitCredential=credential, gitRef=p["git_ref"],
                      pollSeconds=p["poll_seconds"])
        if current is not None and current.get("hosted") and p["git_url"]:
            module.fail_json(msg="Project %s/%s is hosted by the server: it cannot get a source" % (
                p["workspace"], key))

        def create():
            body = dict(key=key, name=p["name"])
            for field in ("gitUrl", "gitCredential", "gitRef", "pollSeconds"):
                if wanted[field] not in (None, ""):
                    body[field] = wanted[field]
            if p["sample"]:
                body["sample"] = p["sample"]
            made = client.post("/workspaces/%s/projects" % seg(workspace["id"]), body)
            # Making one does not take library: it is set after.
            if p["library"] is not None and made.get("library") != p["library"]:
                made = client.patch("/projects/%s" % seg(made["id"]), dict(library=p["library"]))
            return made

        changed, project, diff = ensure_present(
            module.check_mode, current, dict(wanted, library=p["library"]), create,
            lambda changes: client.patch("/projects/%s" % seg(current["id"]), changes),
            nullable=("gitCredential",),
        )

        if p["sync"] and not module.check_mode:
            before = project.get("commit")
            project = client.post("/projects/%s/sync" % seg(project["id"]))
            changed = changed or project.get("commit") != before
            state = (project.get("sync") or {})
            if state.get("state") == "error":
                module.fail_json(msg="The server could not read the source of %s/%s: %s" % (
                    p["workspace"], key, state.get("error") or "no reason given"), project=project)
    except AFSError as e:
        module.fail_json(msg=to_native(e), status=e.status, error=e.error)
    module.exit_json(changed=changed, diff=diff, project=project)


if __name__ == "__main__":
    main()
