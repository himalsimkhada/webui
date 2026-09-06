"""Port-based backend client for the admin UI.

The admin UI is a facade: it proxies /api requests to each registered module
(nginx-webui, bind9-webui, ...) over HTTP ports. Backends share the same
WEBUI_PASSWORD, so the facade logs in on its own session when a backend
returns 401 and retries once.

Modules are defined by the persistent service registry (registry.py), which
is seeded from PORTAL_MODULES on first run.
"""
import os
import re

import requests
import registry

WEBUI_PASSWORD = os.environ.get("WEBUI_PASSWORD", "").strip()
BACKEND_TIMEOUT = float(os.environ.get("BACKEND_TIMEOUT", "5"))

MODULES = {}
_sessions = {}


def sync_modules(entries=None):
    """Rebuild the enabled module map from registry entries."""
    MODULES.clear()
    for e in (entries if entries is not None else registry.load()):
        if e.get("enabled", True) and e.get("url"):
            MODULES[e["name"]] = e["url"]


def entries():
    """All registry entries (enabled and disabled), with module url."""
    return registry.load()


sync_modules()


class BackendError(Exception):
    """Raised when a backend cannot be reached or refuses to authenticate."""


def module_names():
    return sorted(MODULES)


def base_url(name):
    return MODULES.get(name, "")


def _session(name):
    return _sessions.setdefault(name, requests.Session())


def _login(name):
    """Authenticate this facade against a backend using the shared password."""
    if not WEBUI_PASSWORD:
        return False
    try:
        r = _session(name).post(
            MODULES[name] + "/api/login",
            json={"password": WEBUI_PASSWORD, "remember": False},
            timeout=BACKEND_TIMEOUT,
        )
        return r.status_code == 200
    except requests.RequestException:
        return False


def auth_state(name):
    """Ask a backend whether it requires auth and whether we are logged in."""
    if name not in MODULES:
        raise BackendError(f"Unknown module '{name}'")
    try:
        r = _session(name).get(MODULES[name] + "/api/session", timeout=BACKEND_TIMEOUT)
        if r.status_code == 200:
            data = r.json().get("data", {})
            return {
                "ok": True,
                "auth_required": bool(data.get("auth_required")),
                "authenticated": bool(data.get("auth")),
            }
        return {"ok": True, "auth_required": True, "authenticated": False}
    except requests.RequestException as e:
        return {"ok": False, "error": str(e)}


def health(name):
    """Probe a backend: try /healthz first, fall back to /api/session."""
    if name not in MODULES:
        raise BackendError(f"Unknown module '{name}'")
    url = MODULES[name]
    try:
        r = _session(name).get(url + "/healthz", timeout=2.0)
        if r.status_code == 200:
            return {"ok": True, "online": True, "ready": "not ready" not in r.text.lower(),
                    "endpoint": "/healthz", "code": r.status_code}
    except requests.RequestException:
        pass
    try:
        r = _session(name).get(url + "/api/session", timeout=2.0)
        return {"ok": True, "online": r.status_code == 200, "ready": True,
                "endpoint": "/api/session", "code": r.status_code}
    except requests.RequestException as e:
        return {"ok": False, "online": False, "ready": False, "error": str(e)}


def raw_metrics(name):
    """Fetch the Prometheus /metrics text of a backend."""
    if name not in MODULES:
        raise BackendError(f"Unknown module '{name}'")
    url = MODULES[name]
    sess = _session(name)
    try:
        r = sess.get(url + "/metrics", timeout=BACKEND_TIMEOUT)
    except requests.RequestException as e:
        raise BackendError(f"{name} unreachable: {e}")
    if r.status_code == 401 and WEBUI_PASSWORD and _login(name):
        r = sess.get(url + "/metrics", timeout=BACKEND_TIMEOUT)
    if r.status_code == 401:
        raise BackendError(f"{name} requires a login; set WEBUI_PASSWORD")
    if r.status_code != 200:
        raise BackendError(f"{name} /metrics returned HTTP {r.status_code}")
    return r.text


def call(name, method, path, params=None, json_body=None, form=None, files=None):
    """Proxy a request to a backend, auto-logging in on a single 401."""
    if name not in MODULES:
        raise BackendError(f"Unknown module '{name}'")
    url = MODULES[name] + "/" + path.lstrip("/")
    sess = _session(name)

    def _do():
        return sess.request(
            method, url, params=params, json=json_body, data=form, files=files,
            timeout=BACKEND_TIMEOUT,
        )

    try:
        resp = _do()
        if resp.status_code == 401 and WEBUI_PASSWORD and _login(name):
            resp = _do()
        return resp
    except requests.RequestException as e:
        raise BackendError(f"{name} unreachable: {e}")


_SAFE_NAME = re.compile(r"^[\w-]+$")


def valid_name(name):
    return bool(name) and bool(_SAFE_NAME.match(name))