"""Tests for the admin UI Flask app: auth, probes, modules, proxy, metrics."""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import app as a  # noqa: E402
import backends  # noqa: E402
import metrics  # noqa: E402

PASSWORD = "test-password-123"


@pytest.fixture()
def client():
    a.WEBUI_PASSWORD = PASSWORD
    a._login_failures.clear()
    a._login_locked_until.clear()
    a.app.config["TESTING"] = True
    return a.app.test_client()


def _login(client, password=PASSWORD, remember=False):
    return client.post("/api/login", json={"password": password, "remember": remember})


# ── Auth ───────────────────────────────────────────────────────────────

def test_api_requires_auth(client):
    assert client.get("/api/system").status_code == 401


def test_metrics_requires_auth(client):
    assert client.get("/metrics").status_code == 401


def test_probes_are_open(client):
    assert client.get("/healthz").status_code == 200
    assert client.get("/readyz").status_code == 200


def test_login_ok_and_session(client):
    assert _login(client).status_code == 200
    assert client.get("/api/session").get_json()["data"]["auth"] is True


def test_login_wrong_password(client):
    assert _login(client, password="wrong").status_code == 401


def test_lockout_after_failures(client):
    for _ in range(5):
        _login(client, password="wrong")
    r = _login(client, password=PASSWORD)
    assert r.status_code == 429


def test_metrics_after_login(client):
    _login(client)
    r = client.get("/metrics")
    assert r.status_code == 200
    assert "process_resident_memory_bytes" in r.get_data(as_text=True)


def test_portal_metrics_parsed(client):
    _login(client)
    r = client.get("/api/metrics/portal")
    assert r.status_code == 200
    assert "process_resident_memory_bytes" in r.get_json()["data"]


# ── Modules / proxy ────────────────────────────────────────────────────

class FakeResp:
    def __init__(self, status=200, data=None, text="", ctype="application/json"):
        self.status_code = status
        self._json = data
        self.content = (text or "").encode()
        self.headers = {"Content-Type": ctype}

    def json(self):
        return self._json


def test_modules_lists_backends(client, monkeypatch):
    monkeypatch.setattr(backends, "MODULES", {"x": "http://b:1"})
    monkeypatch.setattr(backends, "health",
                        lambda name: {"ok": True, "online": True, "ready": True, "endpoint": "/healthz"})
    _login(client)
    r = client.get("/api/modules")
    assert r.status_code == 200
    mods = r.get_json()["data"]
    assert mods[0]["name"] == "x"
    assert mods[0]["online"] is True


def test_proxy_forwards_and_returns_json(client, monkeypatch):
    monkeypatch.setattr(backends, "MODULES", {"x": "http://b:1"})

    def fake_call(name, method, path, **kw):
        assert name == "x"
        assert method == "GET"
        assert path == "api/status"
        return FakeResp(200, data={"ok": True, "data": {"v": 1}})

    monkeypatch.setattr(backends, "call", fake_call)
    _login(client)
    r = client.get("/api/module/x/proxy/api/status")
    assert r.status_code == 200
    assert r.get_json()["data"]["v"] == 1


def test_proxy_passthrough_error_status(client, monkeypatch):
    monkeypatch.setattr(backends, "MODULES", {"x": "http://b:1"})
    monkeypatch.setattr(backends, "call",
                        lambda *a, **k: FakeResp(404, data={"ok": False, "error": "nope"}))
    _login(client)
    r = client.get("/api/module/x/proxy/api/whatever")
    assert r.status_code == 404
    assert r.get_json()["error"] == "nope"


def test_proxy_unknown_module(client, monkeypatch):
    monkeypatch.setattr(backends, "MODULES", {"x": "http://b:1"})
    _login(client)
    r = client.get("/api/module/nope/proxy/api/x")
    assert r.status_code == 400
    assert "Unknown module" in r.get_json()["error"]


def test_module_metrics_parsed_route(client, monkeypatch):
    monkeypatch.setattr(backends, "raw_metrics",
                        lambda name: "# TYPE process_resident_memory_bytes gauge\nprocess_resident_memory_bytes 1234\n")
    _login(client)
    r = client.get("/api/module/x/metrics/parsed")
    assert r.status_code == 200
    assert r.get_json()["data"]["process_resident_memory_bytes"] == 1234.0


def test_modate_requires_valid_module_name(client, monkeypatch):
    monkeypatch.setattr(backends, "MODULES", {"x": "http://b:1"})
    _login(client)
    r = client.post("/api/module/../proxy/x", json={})
    assert r.status_code in (400, 404)