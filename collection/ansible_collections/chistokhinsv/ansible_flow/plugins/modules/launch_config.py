#!/usr/bin/python
# -*- coding: utf-8 -*-
# Copyright (c) 2026 Sergei Chistokhin
# MIT License (see https://opensource.org/license/mit)

from __future__ import annotations

DOCUMENTATION = r"""
module: launch_config
short_description: Manage launch configurations of Ansible Flow Server
description:
  - Creates, changes and deletes a launch configuration of an Ansible Flow Server project - a flow of the
    project with what its runs get - branch or commit, inventory, execution environment, mode, limit, start
    values of its inputs, credentials, and whom its runs tell.
  - Idempotent - only the options given are compared, and only what differs is changed.
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
  project:
    description:
      - The key (or id) of the project.
    type: str
    required: true
  name:
    description:
      - The configuration's name, unique in the project.
    type: str
    required: true
  description:
    description:
      - What the configuration is for. V("") clears it.
    type: str
  flow_file:
    description:
      - The flow's file in the repository, such as V(flows/patch/patch.flow.yaml). Required to create one.
    type: str
  git_ref:
    description:
      - Another branch than the project's to run the newest commit of. V("") for the project's branch.
    type: str
  commit:
    description:
      - Pin the configuration to one commit (40 hex characters). V("") to unpin.
    type: str
  inventory:
    description:
      - The inventory in the repository. V("") for what the repository's C(ansible.cfg) names.
    type: str
  ee_image:
    description:
      - The execution environment image the runs use. V("") for the server's default.
    type: str
  environment:
    description:
      - An execution environment of the workspace (its name or id) whose newest good build the runs use,
        before O(ee_image). V("") for none.
    type: str
  mode:
    description:
      - What a launch is unless it says otherwise - V(check) (a check run) or V(real). The server makes V(check).
    type: str
    choices: [check, real]
  limit:
    description:
      - Ansible's C(--limit) for the runs. V("") for none.
    type: str
  inputs:
    description:
      - Start values of the flow's inputs, by input name, of the kind each input takes (a list for a host list).
      - The server refuses a value for an input that looks secret - give it at launch, or use a credential.
    type: dict
  credentials:
    description:
      - The credentials (names or ids, of the same workspace) the runs get. V([]) for none.
      - At most one each of V(ssh_key), V(login), V(become).
    type: list
    elements: str
  notify:
    description:
      - Whom the runs tell, and when. Give V({}) to tell nobody.
    type: dict
    suboptions:
      when:
        description:
          - V(failed) - when a run fails; V(ended) - whenever a run ends.
        type: str
        choices: [failed, ended]
      to:
        description:
          - Logins and group names of the server.
        type: list
        elements: str
  state:
    description:
      - V(present) makes the configuration as described; V(absent) deletes it.
    type: str
    choices: [present, absent]
    default: present
notes:
  - Making and changing a launch configuration needs rw on its flow.
"""

EXAMPLES = r"""
- name: Patch edge, as a check run unless a launch says otherwise
  chistokhinsv.ansible_flow.launch_config:
    url: https://afs.example.net
    token: "{{ afs_token }}"
    workspace: network
    project: edge
    name: Patch edge
    description: Patch the edge routers, one site at a time
    flow_file: flows/patch/patch.flow.yaml
    inventory: inventories/prod/hosts.yml
    mode: check
    inputs:
      devices: [edge-r1, edge-r2]
      maintenance_window: 30
    credentials: [netops-ssh, edge-enable]
    notify:
      when: failed
      to: [dana, netops]

- name: Unpin the commit and drop the limit
  chistokhinsv.ansible_flow.launch_config:
    workspace: network
    project: edge
    name: Patch edge
    commit: ""
    limit: ""
"""

RETURN = r"""
launch_config:
  description: The configuration as the server answers it (in check mode, as it would be); null after V(absent).
  returned: success
  type: dict
  sample:
    id: 4d1c2a8e-5b7f-4e0a-9c3d-2f6b8a1e7c90
    project: 2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d
    name: Patch edge
    flowFile: flows/patch/patch.flow.yaml
    mode: check
    inputs: {devices: [edge-r1, edge-r2], maintenance_window: 30}
    credentials: [7c8d9e0f-1a2b-4c3d-8e4f-5a6b7c8d9e0f]
    notify: {when: failed, to: [dana, netops]}
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

# Text settings the server keeps as null when they are empty.
NULLABLE = ("description", "gitRef", "commit", "inventory", "eeImage", "environment", "limit")


def main():
    spec = connection_argument_spec()
    spec.update(
        workspace=dict(type="str", required=True),
        project=dict(type="str", required=True),
        name=dict(type="str", required=True),
        description=dict(type="str"),
        flow_file=dict(type="str"),
        git_ref=dict(type="str"),
        commit=dict(type="str"),
        inventory=dict(type="str"),
        ee_image=dict(type="str"),
        environment=dict(type="str"),
        mode=dict(type="str", choices=["check", "real"]),
        limit=dict(type="str"),
        inputs=dict(type="dict"),
        credentials=dict(type="list", elements="str", no_log=False),
        notify=dict(type="dict", options=dict(
            when=dict(type="str", choices=["failed", "ended"]),
            to=dict(type="list", elements="str"),
        )),
        state=dict(type="str", default="present", choices=["present", "absent"]),
    )
    module = AnsibleModule(argument_spec=spec, supports_check_mode=True)
    p = module.params
    client = AFSClient.from_module(module)
    try:
        workspace = client.need_workspace(p["workspace"])
        project = client.need_project(workspace["id"], p["project"])
        current = client.launch_config(project["id"], p["name"])
        if p["state"] == "absent":
            changed, diff = ensure_absent(module.check_mode, current,
                                          lambda: client.delete("/launch-configs/%s" % seg(current["id"])))
            module.exit_json(changed=changed, diff=diff, launch_config=None)

        if current is None and not p["flow_file"]:
            module.fail_json(msg="Launch configuration %s does not exist: give its flow_file to create it" % p["name"])

        environment = p["environment"]
        if environment:
            environment = client.environment_id(workspace["id"], environment)
        credentials = None
        if p["credentials"] is not None:
            credentials = [client.credential_id(workspace["id"], c) for c in p["credentials"]]
        notify = None
        if p["notify"] is not None:
            given = dict((k, v) for k, v in p["notify"].items() if v)
            if given and not (given.get("when") and given.get("to")):
                module.fail_json(msg="notify takes both when and to; {} tells nobody")
            notify = given

        wanted = dict(
            name=p["name"], description=p["description"], flowFile=p["flow_file"], gitRef=p["git_ref"],
            commit=p["commit"], inventory=p["inventory"], eeImage=p["ee_image"], environment=environment,
            mode=p["mode"], limit=p["limit"], inputs=p["inputs"], credentials=credentials,
        )
        current_view = current
        if current is not None and notify is not None:
            # The server leaves notify out when nobody is told: compare {} with that.
            current_view = dict(current, notify=current.get("notify") or {})
            wanted["notify"] = notify

        def create():
            body = dict((k, v) for k, v in wanted.items() if v is not None and v != "")
            if notify:
                body["notify"] = notify
            return client.post("/projects/%s/launch-configs" % seg(project["id"]), body)

        def update(changes):
            if changes.get("notify") == {}:
                changes["notify"] = None
            return client.patch("/launch-configs/%s" % seg(current["id"]), changes)

        changed, config, diff = ensure_present(
            module.check_mode, current_view, wanted, create, update,
            nullable=NULLABLE, unordered=("credentials",),
        )
        if current is None and notify:
            diff["after"]["notify"] = notify
    except AFSError as e:
        module.fail_json(msg=to_native(e), status=e.status, error=e.error)
    module.exit_json(changed=changed, diff=diff, launch_config=config)


if __name__ == "__main__":
    main()
