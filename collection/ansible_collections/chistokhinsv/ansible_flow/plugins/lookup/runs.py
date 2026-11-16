# -*- coding: utf-8 -*-
# Copyright (c) 2026 Sergei Chistokhin
# MIT License (see https://opensource.org/license/mit)

from __future__ import annotations

DOCUMENTATION = r"""
name: runs
short_description: List runs of Ansible Flow Server
description:
  - Lists runs of Ansible Flow Server, the newest first, narrowed by project, launch configuration, flow,
    state or who launched them.
  - Only the runs the token's owner may see are listed.
  - Takes no terms. Use it with C(query()) or O(ansible.builtin.lookup#lookup:wantlist=true) to get a list.
author:
  - Sergei Chistokhin (@ChistokhinSV)
extends_documentation_fragment:
  - chistokhinsv.ansible_flow.connection.lookup
options:
  workspace:
    description:
      - The key (or id) of the workspace of O(project), to name the project by its key.
    type: str
  project:
    description:
      - The project whose runs to list - its key with O(workspace), else its id.
    type: str
  config:
    description:
      - The launch configuration whose runs to list - its name with O(workspace) and O(project), else its id.
    type: str
  flow:
    description:
      - The flow's file in the repository; with O(project).
    type: str
  state:
    description:
      - Only runs in this state.
    type: str
    choices: [queued, running, waiting, succeeded, failed, cancelled, lost]
  by:
    description:
      - Only runs this login launched.
    type: str
  limit:
    description:
      - At most this many runs (1 to 200).
    type: int
    default: 20
"""

EXAMPLES = r"""
- name: The last five failed runs of Patch edge
  ansible.builtin.debug:
    msg: "{{ item.number }} {{ item.createdAt }} {{ item.error | default('') }}"
  loop: "{{ query('chistokhinsv.ansible_flow.runs', workspace='network', project='edge',
            config='Patch edge', state='failed', limit=5) }}"

- name: Does any run of the edge project wait for approval?
  ansible.builtin.set_fact:
    waiting_runs: "{{ query('chistokhinsv.ansible_flow.runs', url='https://afs.example.net',
                      workspace='network', project='edge', state='waiting') }}"
"""

RETURN = r"""
_raw:
  description:
    - The runs, the newest first, as the server answers them. Each has C(id), C(number), C(state),
      C(mode), C(flow), C(config), C(commit), C(requestedBy), C(createdAt) and, once ended, C(endedAt).
  type: list
  elements: dict
"""

from ansible.errors import AnsibleError
from ansible.module_utils.common.text.converters import to_native
from ansible.plugins.lookup import LookupBase

from ansible_collections.chistokhinsv.ansible_flow.plugins.module_utils.afs import AFSClient, AFSError


class LookupModule(LookupBase):

    def run(self, terms, variables=None, **kwargs):
        self.set_options(var_options=variables, direct=kwargs)
        opt = self.get_option
        try:
            client = AFSClient(opt("url"), opt("token"), opt("validate_certs"), opt("ca_path"), opt("timeout"))
            workspace, project, config = opt("workspace"), opt("project"), opt("config")
            project_id = None
            if project:
                if workspace:
                    ws = client.need_workspace(workspace)
                    project_id = client.need_project(ws["id"], project)["id"]
                else:
                    project_id = project
            config_id = None
            if config:
                if workspace and project:
                    config_id = client.need_launch_config(project_id, config,
                                                          " in %s/%s" % (workspace, project))["id"]
                else:
                    config_id = config
            limit = opt("limit")
            query = dict(project=project_id, config=config_id, flow=opt("flow"), state=opt("state"),
                         by=opt("by"), limit=max(1, min(int(limit), 200)) if limit else None)
            return client.get("/runs", query=query) or []
        except AFSError as e:
            raise AnsibleError("chistokhinsv.ansible_flow.runs: %s" % to_native(e))
