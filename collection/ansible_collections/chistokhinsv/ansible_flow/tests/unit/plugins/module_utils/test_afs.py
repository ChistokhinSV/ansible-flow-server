# -*- coding: utf-8 -*-
# Copyright (c) 2026 Sergei Chistokhin
# MIT License (see https://opensource.org/license/mit)

from __future__ import annotations

import io
import json
import socket

from urllib.error import HTTPError

import pytest

from ansible_collections.chistokhinsv.ansible_flow.plugins.module_utils import afs
from ansible_collections.chistokhinsv.ansible_flow.plugins.module_utils.afs import (
    AFSClient,
    AFSError,
    changes_between,
    decide_approval,
    diff_of,
    ensure_present,
    host_outcomes,
    input_texts,
    run_result,
    wait_for_run,
)

TOKEN = "afs_t0ken_s3cret_value"
URL = "https://afs.example.net"


class FakeResponse(object):
    def __init__(self, status, body):
        self.status = status
        self.body = body

    def getcode(self):
        return self.status

    def read(self):
        if self.body is None:
            return b""
        return self.body if isinstance(self.body, bytes) else json.dumps(self.body).encode()


def http_error(url, status, body):
    content = json.dumps(body).encode() if not isinstance(body, bytes) else body
    return HTTPError(url, status, "refused", {}, io.BytesIO(content))


@pytest.fixture
def calls(monkeypatch):
    """Records each request and answers from a queue of (status, body) or exceptions."""
    state = dict(answers=[], seen=[])

    def fake_open_url(url, data=None, headers=None, method=None, **kwargs):
        state["seen"].append(dict(url=url, data=json.loads(data) if data else None, headers=headers,
                                  method=method, kwargs=kwargs))
        answer = state["answers"].pop(0)
        if isinstance(answer, Exception):
            raise answer
        status, body = answer
        if status >= 400:
            raise http_error(url, status, body)
        return FakeResponse(status, body)

    monkeypatch.setattr(afs, "open_url", fake_open_url)
    return state


def client(**kwargs):
    return AFSClient(URL, TOKEN, sleep=lambda s: None, **kwargs)


# --- the client


def test_request_sends_bearer_token_and_json(calls):
    calls["answers"].append((201, {"id": "r1"}))
    out = client().post("/launch-configs/c1/launch", {"mode": "check"})
    assert out == {"id": "r1"}
    seen = calls["seen"][0]
    assert seen["url"] == URL + "/api/v1/launch-configs/c1/launch"
    assert seen["method"] == "POST"
    assert seen["headers"]["Authorization"] == "Bearer " + TOKEN
    assert seen["headers"]["Content-Type"] == "application/json"
    assert seen["data"] == {"mode": "check"}
    assert seen["kwargs"]["validate_certs"] is True
    assert seen["kwargs"]["timeout"] == 30


def test_base_url_with_api_prefix_and_query(calls):
    calls["answers"].append((200, []))
    AFSClient(URL + "/api/v1/", TOKEN).get("/runs", query={"state": "failed", "project": None, "limit": 5})
    url = calls["seen"][0]["url"]
    assert url.startswith(URL + "/api/v1/runs?")
    assert "state=failed" in url and "limit=5" in url and "project" not in url


def test_204_gives_none(calls):
    calls["answers"].append((204, None))
    assert client().request("DELETE", "/grants/g1") is None


def test_error_carries_server_reason_and_code(calls):
    calls["answers"].append((409, {"error": "taken", "message": "The workspace has a credential \"x\" already"}))
    with pytest.raises(AFSError) as e:
        client().post("/workspaces/net/credentials", {"name": "x"})
    assert e.value.status == 409
    assert e.value.error == "taken"
    assert "POST /api/v1/workspaces/net/credentials answered 409 taken" in str(e.value)
    assert "already" in str(e.value)


def test_error_never_contains_the_token(calls):
    # A server (or a proxy) that echoes the header back must not leak it into the message.
    calls["answers"].append((401, {"error": "unauthorized", "message": "Bad token Bearer " + TOKEN}))
    with pytest.raises(AFSError) as e:
        client().get("/session")
    assert TOKEN not in str(e.value)
    assert TOKEN not in repr(e.value.args)
    assert "********" in str(e.value)


def test_unreachable_server_message_has_no_token(calls):
    calls["answers"].extend([socket.timeout("timed out with " + TOKEN)] * 3)
    with pytest.raises(AFSError) as e:
        client().get("/runs/r1")
    assert e.value.status == 0
    assert "cannot reach" in str(e.value)
    assert TOKEN not in str(e.value)


def test_reads_are_retried_on_busy_answers(calls):
    calls["answers"].extend([(503, {"error": "busy"}), (200, {"id": "r1", "state": "running"})])
    assert client().get("/runs/r1")["state"] == "running"
    assert len(calls["seen"]) == 2


def test_writes_are_not_retried(calls):
    calls["answers"].extend([(503, {"error": "busy"}), (201, {"id": "r2"})])
    with pytest.raises(AFSError):
        client().post("/launch-configs/c1/launch", {})
    assert len(calls["seen"]) == 1


def test_missing_ok_gives_none_on_404(calls):
    calls["answers"].append((404, {"error": "not_found", "message": "No such workspace"}))
    assert client().workspace("nope") is None


def test_problems_of_a_refused_launch_are_listed(calls):
    calls["answers"].append((422, {"error": "not_ready", "message": "devices is required",
                                   "problems": [{"message": "devices is required"},
                                                {"message": "No inventory"}]}))
    with pytest.raises(AFSError) as e:
        client().post("/launch-configs/c1/launch", {})
    assert "devices is required" in str(e.value) and "No inventory" in str(e.value)


def test_no_token_is_refused_before_any_request():
    with pytest.raises(AFSError) as e:
        AFSClient(URL, "")
    assert "AFS_TOKEN" in str(e.value)


def test_resolve_config_by_name(calls):
    calls["answers"].extend([
        (200, [{"id": "p1", "key": "edge"}]),
        (200, [{"id": "c1", "name": "Patch edge"}, {"id": "c2", "name": "Backup"}]),
    ])
    assert client().resolve_config("Patch edge", "network", "edge")["id"] == "c1"
    assert calls["seen"][0]["url"].endswith("/api/v1/workspaces/network/projects")
    assert calls["seen"][1]["url"].endswith("/api/v1/projects/p1/launch-configs")


def test_path_segments_are_quoted(calls):
    calls["answers"].append((200, []))
    client().get("/workspaces/%s/projects" % afs.seg("a b/c"))
    assert calls["seen"][0]["url"].endswith("/workspaces/a%20b%2Fc/projects")


# --- compare and patch


def test_changes_only_what_differs():
    current = {"name": "Network", "description": "Edge", "selfApprove": False, "projects": 2}
    wanted = {"name": "Network", "description": "Edge and core", "selfApprove": None}
    assert changes_between(current, wanted) == {"description": "Edge and core"}


def test_empty_string_clears_a_nullable_field():
    assert changes_between({"limit": "edge-r1"}, {"limit": ""}, nullable=("limit",)) == {"limit": None}
    # Already empty (absent on the server): nothing to send.
    assert changes_between({}, {"limit": ""}, nullable=("limit",)) == {}


def test_unordered_lists_and_nested_dicts():
    current = {"credentials": ["a", "b"], "inputs": {"devices": ["r1", "r2"], "n": 3}}
    assert changes_between(current, {"credentials": ["b", "a"]}, unordered=("credentials",)) == {}
    assert changes_between(current, {"credentials": ["b", "a"]}) == {"credentials": ["b", "a"]}
    assert changes_between(current, {"inputs": {"devices": ["r1", "r2"], "n": 3}}) == {}
    assert changes_between(current, {"inputs": {"devices": ["r1"], "n": 3}}) == {
        "inputs": {"devices": ["r1"], "n": 3}}


def test_ensure_present_patches_once_and_is_idempotent():
    sent = []
    current = {"id": "w1", "name": "Network", "description": "Edge"}

    def update(changes):
        sent.append(changes)
        return dict(current, **changes)

    changed, obj, diff = ensure_present(False, current, {"name": "Network", "description": "Core"},
                                        lambda: None, update)
    assert changed and sent == [{"description": "Core"}]
    assert diff == {"before": {"description": "Edge"}, "after": {"description": "Core"}}
    changed, obj, diff = ensure_present(False, obj, {"name": "Network", "description": "Core"},
                                        lambda: None, update)
    assert not changed and len(sent) == 1


def test_ensure_present_check_mode_sends_nothing():
    def fail(*args):
        raise AssertionError("nothing is sent in check mode")

    changed, obj, diff = ensure_present(True, None, {"name": "Edge", "description": None}, fail, fail)
    assert changed and obj == {"name": "Edge"}
    changed, obj, diff = ensure_present(True, {"name": "Edge"}, {"name": "Edge 2"}, fail, fail)
    assert changed and obj == {"name": "Edge 2"}


def test_forced_secret_is_sent_and_hidden_in_diff():
    sent = []
    current = {"id": "k1", "name": "netops-ssh", "fields": {"username": "netops"}}
    changed, obj, diff = ensure_present(
        False, current, {"name": "netops-ssh", "fields": {"username": "netops"}}, lambda: None,
        lambda changes: sent.append(changes) or current, hidden=("secret",),
        force={"secret": {"password": "hunter2"}})
    assert changed and sent == [{"secret": {"password": "hunter2"}}]
    assert "hunter2" not in json.dumps(diff)


def test_diff_of_masks_hidden_fields():
    assert diff_of({"secret": None}, {"secret": {"x": "y"}}, hidden=("secret",)) == {
        "before": {"secret": "********"}, "after": {"secret": "********"}}


def test_input_texts():
    # A host list reads names separated by commas, not JSON: plain names go that way.
    assert input_texts({"devices": ["r1", "r2"], "n": 30, "dry": True, "name": "edge", "opts": {"a": 1}}) == {
        "devices": "r1, r2", "n": "30", "dry": "true", "name": "edge", "opts": '{"a": 1}'}
    # Items a comma would split stay JSON (a list input reads it).
    assert input_texts({"words": ["a, b", "c"]}) == {"words": '["a, b", "c"]'}


# --- a run's outcome and the wait


def test_host_outcomes():
    view = {"summary": {"hosts": ["r1", "r2", "r3"], "outcome": {"r2": "open port fail of [backup]"},
                        "unreachable": ["r3"]}}
    assert host_outcomes(view) == {
        "r1": {"status": "ok"},
        "r2": {"status": "failed", "reason": "open port fail of [backup]"},
        "r3": {"status": "unreachable"},
    }
    assert host_outcomes(None) == {}


class FakeRuns(object):
    """A client whose run goes through the given states, one per look."""

    def __init__(self, states):
        self.states = list(states)
        self.looks = 0

    def run(self, run_id):
        self.looks += 1
        state = self.states.pop(0) if len(self.states) > 1 else self.states[0]
        return {"id": run_id, "number": 7, "state": state}


class Clock(object):
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds


@pytest.mark.parametrize("states,final", [
    (["queued", "running", "succeeded"], "succeeded"),
    (["queued", "running", "failed"], "failed"),
    (["running", "cancelled"], "cancelled"),
    (["running", "lost"], "lost"),
])
def test_wait_until_the_run_ends(states, final):
    clock = Clock()
    runs = FakeRuns(states)
    run, timed_out = wait_for_run(runs, "r1", 600, 5, sleep=clock.sleep, clock=clock)
    assert run["state"] == final and not timed_out
    assert runs.looks == len(states)


def test_wait_returns_at_an_approval():
    clock = Clock()
    runs = FakeRuns(["running", "waiting", "running", "succeeded"])
    run, timed_out = wait_for_run(runs, "r1", 600, 5, sleep=clock.sleep, clock=clock)
    assert run["state"] == "waiting" and not timed_out


def test_wait_through_approvals():
    clock = Clock()
    runs = FakeRuns(["running", "waiting", "waiting", "running", "succeeded"])
    run, timed_out = wait_for_run(runs, "r1", 600, 5, through_approvals=True, sleep=clock.sleep, clock=clock)
    assert run["state"] == "succeeded" and not timed_out


def test_wait_times_out():
    clock = Clock()
    runs = FakeRuns(["running"])
    run, timed_out = wait_for_run(runs, "r1", 30, 10, sleep=clock.sleep, clock=clock)
    assert timed_out and run["state"] == "running"
    assert clock.now == 30
    assert runs.looks == 4


# --- approvals


class FakeApprovals(object):
    def __init__(self, gates):
        self.gates = gates
        self.posted = []

    def run_approvals(self, run_id):
        return self.gates

    def post(self, path, body):
        self.posted.append((path, body))
        gate = dict(self.gates[0], status=body["decision"], decidedBy="dana")
        return gate


def gate(status, **more):
    out = {"id": "g1", "node": {"id": "01NODE", "key": "approve-change", "title": "Approve"}, "status": status,
           "mayDecide": status == "waiting"}
    out.update(more)
    return out


def test_approve_a_waiting_approval():
    client = FakeApprovals([gate("waiting")])
    changed, after = decide_approval(client, "r1", "approve-change", "approved", "CHG-1042")
    assert changed and after["status"] == "approved"
    assert client.posted == [("/runs/r1/approvals/01NODE", {"decision": "approved", "comment": "CHG-1042"})]


def test_already_decided_the_same_way_is_unchanged():
    client = FakeApprovals([gate("approved", decidedBy="dana")])
    changed, after = decide_approval(client, "r1", "approve-change", "approved")
    assert not changed and client.posted == []


def test_decided_otherwise_fails_with_who():
    client = FakeApprovals([gate("rejected", decidedBy="omar")])
    with pytest.raises(AFSError) as e:
        decide_approval(client, "r1", "01NODE", "approved")
    assert "rejected by omar" in str(e.value) and e.value.status == 409
    assert client.posted == []


def test_not_mine_to_decide_fails_with_the_reason():
    client = FakeApprovals([gate("waiting", mayDecide=False, why="Only netops may decide this approval")])
    with pytest.raises(AFSError) as e:
        decide_approval(client, "r1", "approve-change", "approved")
    assert "Only netops" in str(e.value)


def test_unknown_approval_names_the_ones_reached():
    client = FakeApprovals([gate("waiting")])
    with pytest.raises(AFSError) as e:
        decide_approval(client, "r1", "other", "approved")
    assert "approve-change" in str(e.value) and e.value.status == 404


def test_check_mode_decides_nothing():
    client = FakeApprovals([gate("waiting")])
    changed, after = decide_approval(client, "r1", "approve-change", "rejected", check_mode=True)
    assert changed and after["status"] == "rejected" and client.posted == []


class FakeView(object):
    """A client with one ended run and its view."""

    def __init__(self, summary):
        self.summary = summary

    def run_view(self, run_id):
        return {"summary": self.summary}

    def run_approvals(self, run_id):
        return []

    def run_url(self, run_id):
        return URL + "/runs/" + run_id


def test_run_result_gives_the_outputs_per_host():
    view = FakeView({"hosts": ["r1", "r2"], "outcome": {}, "unreachable": [],
                     "outputs": {"r1": {"backup_file": "/b/r1.cfg"}}})
    out = run_result(view, {"id": "x1", "number": 3, "state": "succeeded"})
    assert out["outputs"] == {"r1": {"backup_file": "/b/r1.cfg"}}
    # A flow that gives nothing back, or a run not looked at closely: none.
    assert run_result(FakeView({"hosts": []}), {"id": "x2", "state": "succeeded"})["outputs"] == {}
    assert run_result(view, {"id": "x3", "state": "queued"}, with_view=False)["outputs"] == {}
