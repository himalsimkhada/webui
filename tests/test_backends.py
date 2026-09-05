"""Tests for the backend client (facade proxy + auto-login)."""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import backends  # noqa: E402


class FakeResponse:
    def __init__(self, status_code, text="", data=None, ctype="application/json"):
        self.status_code = status_code
        self.text = text
        self.content = text.encode()
        self._data = data
        self.headers = {"Content-Type": ctype}

    def json(self):
        return self._data


class FakeSession:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def request(self, method, url, **kw):
        self.calls.append((method, url))
        return self.responses.pop(0)

    def post(self, url, **kw):
        return self.request("POST", url, **kw)

    def get(self, url, **kw):
        return self.request("GET", url, **kw)


@pytest.fixture()
def modules(monkeypatch):
    old = dict(backends.MODULES)
    backends.MODULES.clear()
    backends.MODULES.update({"fake": "http://backend:8400"})
    yield backends.MODULES
    backends.MODULES.clear()
    backends.MODULES.update(old)


def test_module_names(modules):
    assert backends.module_names() == ["fake"]


def test_health_online(modules, monkeypatch):
    monkeypatch.setattr(backends, "_session", lambda name: FakeSession(
        [FakeResponse(200, "ok\n", ctype="text/plain")]))
    h = backends.health("fake")
    assert h["online"] is True
    assert h["ready"] is True


def test_health_offline(modules, monkeypatch):
    def boom(*a, **k):
        raise backends.requests.RequestException("conn refused")
    sess = FakeSession([])
    monkeypatch.setattr(sess, "get", boom)
    monkeypatch.setattr(backends, "_session", lambda name: sess)
    h = backends.health("fake")
    assert h["online"] is False


def test_call_autologin_once_on_401(modules, monkeypatch):
    sess = FakeSession([
        FakeResponse(401, data={"ok": False, "error": "Unauthorized"}),
        FakeResponse(200, data={"ok": True, "data": {"v": 1}}),
    ])
    monkeypatch.setattr(backends, "_session", lambda name: sess)
    monkeypatch.setattr(backends, "_login", lambda name: True)
    backends.WEBUI_PASSWORD = "pw"

    resp = backends.call("fake", "GET", "api/status")
    assert resp.status_code == 200
    assert len(sess.calls) == 2  # one 401, one retry


def test_call_no_login_without_password(modules, monkeypatch):
    sess = FakeSession([FakeResponse(401, data={"ok": False})])
    monkeypatch.setattr(backends, "_session", lambda name: sess)
    monkeypatch.setattr(backends, "_login", lambda name: False)
    backends.WEBUI_PASSWORD = ""
    resp = backends.call("fake", "GET", "x")
    assert resp.status_code == 401
    assert len(sess.calls) == 1


def test_call_unknown_module(monkeypatch):
    backends.WEBUI_PASSWORD = ""
    with pytest.raises(backends.BackendError):
        backends.call("nope", "GET", "x")


def test_raw_metrics_applies_login(modules, monkeypatch):
    sess = FakeSession([
        FakeResponse(401, data={"ok": False}),
        FakeResponse(200, "# metric 1", ctype="text/plain"),
    ])
    monkeypatch.setattr(backends, "_session", lambda name: sess)
    monkeypatch.setattr(backends, "_login", lambda name: True)
    backends.WEBUI_PASSWORD = "pw"
    assert backends.raw_metrics("fake") == "# metric 1"