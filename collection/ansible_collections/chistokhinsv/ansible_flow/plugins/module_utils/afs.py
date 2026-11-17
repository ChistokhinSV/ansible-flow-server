# -*- coding: utf-8 -*-
# Copyright (c) 2026 Sergei Chistokhin
# MIT License (see https://opensource.org/license/mit)
"""Shared code of the chistokhinsv.ansible_flow modules and plugins.

The HTTP client of the Ansible Flow Server API, its errors, the lookups of objects by key or name,
the compare-and-patch helper the resource modules share, and the wait for a run.
Python standard library and ansible-core only.
"""

from __future__ import annotations

import json
import socket
import time

from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode

from ansible.module_utils.common.text.converters import to_native, to_text
from ansible.module_utils.basic import env_fallback
from ansible.module_utils.urls import ConnectionError as UrlsConnectionError
from ansible.module_utils.urls import SSLValidationError, open_url

API = "/api/v1"

# A run's states, as the server's queue names them (src/server/runs/queue.ts).
ACTIVE_STATES = ("queued", "running", "waiting")
FINAL_STATES = ("succeeded", "failed", "cancelled", "lost")
FAILED_STATES = ("failed", "cancelled", "lost")

# Answers worth asking again for a read: the server or a proxy in front of it was busy.
_RETRY_STATUS = (502, 503, 504)


def connection_argument_spec():
    """The options every module takes to reach the server (see the connection doc fragment)."""
    return dict(
        url=dict(type="str", fallback=(env_fallback, ["AFS_URL"])),
        token=dict(type="str", no_log=True, fallback=(env_fallback, ["AFS_TOKEN"])),
        validate_certs=dict(type="bool", default=True, fallback=(env_fallback, ["AFS_VALIDATE_CERTS"])),
        ca_path=dict(type="path", fallback=(env_fallback, ["AFS_CA_PATH"])),
        timeout=dict(type="int", default=30),
    )


class AFSError(Exception):
    """The server refused a request, or could not be reached.

    ``status`` is the HTTP status (0 when there was no answer), ``error`` the server's error code
    (``not_found``, ``taken``, ``invalid``...) and ``body`` the parsed answer, when it was JSON.
    The message never carries the token: only the method, the path and what the server said.
    """

    def __init__(self, message, status=0, error=None, body=None):
        super(AFSError, self).__init__(message)
        self.message = message
        self.status = status
        self.error = error
        self.body = body if isinstance(body, dict) else {}

    def __str__(self):
        return self.message


class AFSClient(object):
    """A small client of the Ansible Flow Server API.

    Paths are given without the ``/api/v1`` prefix. JSON answers are parsed; 204 gives None.
    Reads are asked again on connection errors and 502/503/504, a few times.
    """

    def __init__(self, url, token, validate_certs=True, ca_path=None, timeout=30, retries=2, retry_delay=2.0,
                 sleep=time.sleep):
        if not url:
            raise AFSError("No server address: set url or the AFS_URL environment variable")
        if not token:
            raise AFSError("No access token: set token or the AFS_TOKEN environment variable")
        self.base = url.rstrip("/")
        if self.base.endswith(API):
            self.base = self.base[: -len(API)]
        self._token = token
        self.validate_certs = validate_certs
        self.ca_path = ca_path
        self.timeout = timeout
        self.retries = retries
        self.retry_delay = retry_delay
        self._sleep = sleep

    @classmethod
    def from_module(cls, module):
        p = module.params
        try:
            return cls(p["url"], p["token"], p["validate_certs"], p.get("ca_path"), p["timeout"])
        except AFSError as e:
            module.fail_json(msg=to_native(e))

    # --- the request itself

    def page_url(self, path):
        """An address of the server's pages (not the API), such as a run's page."""
        return self.base + path

    def _scrub(self, text):
        """Never let the token into an error message, whatever the server echoed."""
        text = to_text(text, errors="surrogate_or_strict")
        return text.replace(self._token, "********") if self._token else text

    def request(self, method, path, body=None, query=None, raw=False):
        url = self.base + API + path
        if query:
            params = dict((k, v) for k, v in query.items() if v is not None)
            if params:
                url += "?" + urlencode(params)
        headers = {
            "Authorization": "Bearer %s" % self._token,
            "Accept": "text/plain" if raw else "application/json",
            "User-Agent": "chistokhinsv.ansible_flow",
        }
        data = None
        if body is not None:
            data = json.dumps(body)
            headers["Content-Type"] = "application/json"
        where = "%s %s" % (method, API + path)
        attempts = 1 + (self.retries if method == "GET" else 0)
        for attempt in range(attempts):
            last = attempt == attempts - 1
            try:
                resp = open_url(
                    url,
                    data=data,
                    headers=headers,
                    method=method,
                    validate_certs=self.validate_certs,
                    ca_path=self.ca_path,
                    timeout=self.timeout,
                    follow_redirects="safe",
                    use_proxy=True,
                )
                status = resp.getcode()
                content = resp.read()
                return self._answer(status, content, raw)
            except HTTPError as e:
                if e.code in _RETRY_STATUS and not last:
                    self._sleep(self.retry_delay)
                    continue
                raise self._refusal(where, e)
            except SSLValidationError as e:
                raise AFSError(
                    "%s: the server's certificate could not be checked (%s). Set ca_path to the CA "
                    "that signed it, or validate_certs: false for a lab server" % (where, self._scrub(to_text(e))))
            except (URLError, UrlsConnectionError, socket.timeout, OSError) as e:
                if not last:
                    self._sleep(self.retry_delay)
                    continue
                raise AFSError("%s: cannot reach %s: %s" % (where, self.base, self._scrub(to_text(e))))
        raise AFSError("%s: no answer" % where)  # not reached

    @staticmethod
    def _answer(status, content, raw):
        if status == 204 or not content:
            return "" if raw else None
        text = to_text(content, errors="surrogate_or_replace")
        if raw:
            return text
        try:
            return json.loads(text)
        except ValueError:
            return text

    def _refusal(self, where, e):
        body = {}
        try:
            content = e.read()
            body = json.loads(to_text(content, errors="surrogate_or_replace")) if content else {}
        except Exception:  # pylint: disable=broad-except
            body = {}
        if not isinstance(body, dict):
            body = {}
        error = body.get("error")
        said = body.get("message") or error or getattr(e, "reason", None) or "no reason given"
        message = "%s answered %s%s: %s" % (where, e.code, " %s" % error if error else "", self._scrub(said))
        problems = body.get("problems")
        if isinstance(problems, list) and len(problems) > 1:
            extra = "; ".join(self._scrub(p.get("message", "")) for p in problems[1:] if isinstance(p, dict))
            if extra:
                message += " (also: %s)" % extra
        return AFSError(message, status=e.code, error=error, body=body)

    # --- verbs

    def get(self, path, query=None, missing_ok=False):
        try:
            return self.request("GET", path, query=query)
        except AFSError as e:
            if missing_ok and e.status == 404:
                return None
            raise

    def text(self, path):
        return self.request("GET", path, raw=True)

    def post(self, path, body=None):
        return self.request("POST", path, body=body if body is not None else {})

    def patch(self, path, body):
        return self.request("PATCH", path, body=body)

    def delete(self, path, missing_ok=True):
        try:
            self.request("DELETE", path)
            return True
        except AFSError as e:
            if missing_ok and e.status == 404:
                return False
            raise

    # --- finding things by key or name

    def workspace(self, key_or_id):
        """A workspace by key or id; None when there is none."""
        return self.get("/workspaces/%s" % seg(key_or_id), missing_ok=True)

    def need_workspace(self, key_or_id):
        found = self.workspace(key_or_id)
        if not found:
            raise AFSError("There is no workspace %s (or the token may not see it)" % key_or_id, status=404,
                           error="not_found")
        return found

    def project(self, workspace, key_or_id):
        """A project of a workspace by key or id; None when there is none."""
        for p in self.get("/workspaces/%s/projects" % seg(workspace)) or []:
            if key_or_id in (p.get("key"), p.get("id")):
                return p
        return None

    def need_project(self, workspace, key_or_id):
        found = self.project(workspace, key_or_id)
        if not found:
            raise AFSError("Workspace %s has no project %s" % (workspace, key_or_id), status=404,
                           error="not_found")
        return found

    def launch_config(self, project_id, name_or_id):
        for c in self.get("/projects/%s/launch-configs" % seg(project_id)) or []:
            if name_or_id in (c.get("name"), c.get("id")):
                return c
        return None

    def need_launch_config(self, project_id, name_or_id, where=""):
        found = self.launch_config(project_id, name_or_id)
        if not found:
            raise AFSError("There is no launch configuration %s%s" % (name_or_id, where), status=404,
                           error="not_found")
        return found

    def credential(self, workspace, name_or_id):
        for c in self.get("/workspaces/%s/credentials" % seg(workspace)) or []:
            if name_or_id in (c.get("name"), c.get("id")):
                return c
        return None

    def credential_id(self, workspace, name_or_id):
        found = self.credential(workspace, name_or_id)
        if not found:
            raise AFSError("Workspace %s has no credential %s" % (workspace, name_or_id), status=404,
                           error="not_found")
        return found["id"]

    def environment_id(self, workspace, name_or_id):
        for env in self.get("/workspaces/%s/environments" % seg(workspace)) or []:
            if name_or_id in (env.get("name"), env.get("id")):
                return env["id"]
        raise AFSError("Workspace %s has no execution environment %s" % (workspace, name_or_id), status=404,
                       error="not_found")

    def resolve_config(self, launch_config, workspace=None, project=None):
        """A launch configuration by id, or by name in a project of a workspace."""
        if workspace and project:
            proj = self.need_project(workspace, project)
            return self.need_launch_config(proj["id"], launch_config, " in %s/%s" % (workspace, project))
        if workspace or project:
            raise AFSError("Name both workspace and project to find a launch configuration by name")
        found = self.get("/launch-configs/%s" % seg(launch_config), missing_ok=True)
        if not found:
            raise AFSError("There is no launch configuration with id %s: to find one by name, give workspace "
                           "and project too" % launch_config, status=404, error="not_found")
        return found

    # --- runs

    def run(self, run_id):
        return self.get("/runs/%s" % seg(run_id))

    def run_view(self, run_id):
        """How the run went, as the designer shows it; None before it started."""
        return self.get("/runs/%s/view" % seg(run_id), missing_ok=True)

    def run_approvals(self, run_id):
        return self.get("/runs/%s/approvals" % seg(run_id)) or []

    def run_url(self, run_id):
        return self.page_url("/runs/%s" % seg(run_id))


def seg(value):
    """One path segment, quoted."""
    return quote(to_text(value), safe="")


# --- compare and patch


def _same(have, want, unordered=False):
    if isinstance(want, dict):
        if not isinstance(have, dict) or set(have) != set(want):
            return False
        return all(_same(have[k], want[k]) for k in want)
    if isinstance(want, list):
        if not isinstance(have, list) or len(have) != len(want):
            return False
        if unordered:
            return sorted(json.dumps(x, sort_keys=True) for x in have) == sorted(
                json.dumps(x, sort_keys=True) for x in want)
        return all(_same(h, w) for h, w in zip(have, want))
    return have == want


def changes_between(current, wanted, nullable=(), unordered=()):
    """What a PATCH must send to make ``current`` what ``wanted`` asks.

    ``wanted`` maps API field names to the values the user gave; None means "not given" and is
    left as it is. For a ``nullable`` field, an empty string asks to clear it: it compares equal
    to an absent field and is sent as null. ``unordered`` lists are compared as sets.
    """
    out = {}
    current = current or {}
    for field, want in wanted.items():
        if want is None:
            continue
        have = current.get(field)
        if field in nullable and want == "":
            if have not in (None, ""):
                out[field] = None
            continue
        if not _same(have, want, field in unordered):
            out[field] = want
    return out


def diff_of(current, changes, hidden=()):
    """A ``--diff`` before/after of the changed fields; ``hidden`` ones show as ``********``."""
    before, after = {}, {}
    for field, value in changes.items():
        before[field] = "********" if field in hidden else (current or {}).get(field)
        after[field] = "********" if field in hidden else value
    return dict(before=before, after=after)


def _masked(values, hidden):
    return dict((k, "********" if k in hidden else v) for k, v in values.items())


def ensure_present(check_mode, current, wanted, create, update, nullable=(), unordered=(), hidden=(), force=None):
    """Makes an object as ``wanted`` says: creates it when ``current`` is None, else patches only
    the fields that differ.

    ``create()`` makes it (and gets nothing: the caller knows its body); ``update(changes)`` sends
    the PATCH. ``force`` adds fields sent even when they compare equal (a write-only secret).
    Returns ``(changed, object, diff)``; in check mode nothing is sent and the object is what it
    would be.
    """
    if current is None:
        shown = dict((k, v) for k, v in wanted.items() if v is not None and v != "")
        diff = dict(before={}, after=_masked(shown, hidden))
        if check_mode:
            return True, shown, diff
        return True, create(), diff
    changes = changes_between(current, wanted, nullable, unordered)
    if force:
        changes.update(force)
    if not changes:
        return False, current, dict(before={}, after={})
    diff = diff_of(current, changes, hidden)
    if check_mode:
        after = dict(current)
        after.update(dict((k, v) for k, v in changes.items() if k not in hidden))
        return True, after, diff
    return True, update(changes), diff


def ensure_absent(check_mode, current, delete):
    """Deletes an object when there is one. Returns ``(changed, diff)``."""
    if current is None:
        return False, dict(before={}, after={})
    if not check_mode:
        delete()
    return True, dict(before=current, after={})


# --- inputs of a launch or a schedule


def input_text(value):
    """A launch takes each input as text and reads it as the input's type: a host list as names
    separated by commas (it reads no JSON), another list as JSON or comma-separated items, a dict
    as JSON, booleans as true/false, numbers as digits. A list of plain names (no comma, quote or
    bracket in them) goes as names separated by commas, which both kinds of list read."""
    if isinstance(value, str):
        return value
    if isinstance(value, (list, tuple)) and all(
        isinstance(v, str) and v.strip() and not any(c in v for c in (",", "[", "]", '"', "'")) for v in value
    ):
        return ", ".join(v.strip() for v in value)
    return json.dumps(value)


def input_texts(inputs):
    return dict((k, input_text(v)) for k, v in (inputs or {}).items())


# --- a run's outcome


def host_outcomes(view):
    """Each host's end, from a run's view: ok, failed (with the reason) or unreachable."""
    summary = (view or {}).get("summary") or {}
    failed = summary.get("outcome") or {}
    unreachable = set(summary.get("unreachable") or [])
    hosts = list(summary.get("hosts") or [])
    hosts += [h for h in list(failed) + sorted(unreachable) if h not in hosts]
    out = {}
    for host in hosts:
        if host in unreachable:
            out[host] = dict(status="unreachable")
        elif host in failed:
            out[host] = dict(status="failed", reason=failed[host])
        else:
            out[host] = dict(status="ok")
    return out


def wait_for_run(client, run_id, timeout, interval, through_approvals=False, sleep=time.sleep,
                 clock=time.monotonic):
    """Asks for the run until it ends, or waits for an approval, or the time is up.

    Returns ``(run, timed_out)``. A run that waits for an approval is returned at once unless
    ``through_approvals``: then the wait goes on while someone decides.
    """
    deadline = clock() + max(timeout, 0)
    while True:
        run = client.run(run_id)
        state = run.get("state")
        if state in FINAL_STATES:
            return run, False
        if state == "waiting" and not through_approvals:
            return run, False
        left = deadline - clock()
        if left <= 0:
            return run, True
        sleep(min(max(interval, 1), left))


def run_result(client, run, with_view=True):
    """What the run modules return about one run."""
    run_id = run["id"]
    view = client.run_view(run_id) if with_view else None
    out = dict(
        run=run,
        id=run_id,
        number=run.get("number"),
        state=run.get("state"),
        url=client.run_url(run_id),
        hosts=host_outcomes(view),
        summary=(view or {}).get("summary"),
        # What the run gave back (its flow's outputs), per host.
        outputs=((view or {}).get("summary") or {}).get("outputs") or {},
        approvals=client.run_approvals(run_id) if run.get("state") == "waiting" else [],
    )
    if run.get("error"):
        out["error"] = run["error"]
    return out


# --- approvals


def decide_approval(client, run_id, node, decision, comment=None, check_mode=False):
    """Decides a run's approval, once.

    Returns ``(changed, gate)``. Already decided the same way: unchanged. Decided otherwise, timed
    out, or not this person's to decide: AFSError with the reason.
    """
    gates = client.run_approvals(run_id)
    gate = None
    for g in gates:
        n = g.get("node") or {}
        if node in (n.get("key"), n.get("id")):
            gate = g
            break
    if gate is None:
        reached = ", ".join(sorted((g.get("node") or {}).get("key", "?") for g in gates)) or "none"
        raise AFSError("Run %s did not reach the approval %s (approvals reached: %s)" % (run_id, node, reached),
                       status=404, error="not_found")
    status = gate.get("status")
    if status == decision:
        return False, gate
    if status != "waiting":
        by = gate.get("decidedBy")
        raise AFSError("The approval %s of run %s is %s%s, not %s" % (
            node, run_id, status, " by %s" % by if by else "", decision), status=409, error="decided", body=gate)
    if not gate.get("mayDecide", True):
        raise AFSError("You may not decide the approval %s of run %s: %s" % (
            node, run_id, gate.get("why") or "no reason given"), status=403, error="forbidden", body=gate)
    if check_mode:
        after = dict(gate)
        after["status"] = decision
        return True, after
    body = dict(decision=decision)
    if comment is not None:
        body["comment"] = comment
    node_id = (gate.get("node") or {}).get("id") or node
    return True, client.post("/runs/%s/approvals/%s" % (seg(run_id), seg(node_id)), body)
