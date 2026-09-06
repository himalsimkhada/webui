import os
import re
import time
from collections import defaultdict
from datetime import timedelta

from flask import Flask, jsonify, request, render_template, session, Response
import backends
import metrics
import registry
import system_info

app = Flask(__name__)

# Password gate: if WEBUI_PASSWORD is empty/not set, authentication is disabled.
WEBUI_PASSWORD = os.environ.get("WEBUI_PASSWORD", "").strip()
app.secret_key = os.environ.get("SECRET_KEY", "webui-dev-secret-change-me")
app.config["PERMANENT_SESSION_LIFETIME"] = timedelta(minutes=30)

# Brute-force protection: N failed logins per IP within the window = temporary lockout.
MAX_LOGIN_FAILURES = 5
LOGIN_FAIL_WINDOW = 900
LOGIN_LOCKOUT = 900
_login_failures = defaultdict(list)
_login_locked_until = {}

# Health/readiness for probes live outside the auth gate.
OPEN_PATHS = ("/healthz", "/readyz")


def _client_ip():
    return (request.headers.get("X-Forwarded-For", "").split(",")[0].strip()
            or request.remote_addr or "unknown")


def _lockout_remaining(ip):
    until = _login_locked_until.get(ip, 0)
    remaining = int(until - time.time())
    if remaining > 0:
        return remaining
    if until:
        _login_locked_until.pop(ip, None)
    return 0


def _record_failure(ip):
    now = time.time()
    _login_failures[ip] = [t for t in _login_failures[ip] if now - t < LOGIN_FAIL_WINDOW]
    _login_failures[ip].append(now)
    if len(_login_failures[ip]) >= MAX_LOGIN_FAILURES:
        _login_locked_until[ip] = now + LOGIN_LOCKOUT
        _login_failures.pop(ip, None)


def _clear_failures(ip):
    _login_failures.pop(ip, None)
    _login_locked_until.pop(ip, None)


def is_authenticated():
    return bool(session.get("auth"))


def _ok(data=None, msg=None):
    r = {"ok": True}
    if data is not None:
        r["data"] = data
    if msg:
        r["message"] = msg
    return jsonify(r)


def _err(msg, code=400):
    return jsonify({"ok": False, "error": str(msg)}), code


@app.before_request
def hooks():
    metrics.record_request_started()


@app.after_request
def record_status(response):
    metrics.record_request_finished(response.status_code)
    return response


@app.before_request
def protect_endpoints():
    if not WEBUI_PASSWORD:
        return None
    if request.path in OPEN_PATHS:
        return None
    if request.endpoint in ("index", "static", "api_login", "api_session"):
        return None
    if not is_authenticated():
        return _err("Unauthorized", code=401)
    return None


@app.route("/")
def index():
    return render_template("index.html")


# ── Probes & own metrics ─────────────────────────────────────────────────

@app.route("/healthz")
def healthz():
    return Response("ok\n", mimetype="text/plain")


@app.route("/readyz")
def readyz():
    if metrics.ready():
        return Response("ok\n", mimetype="text/plain")
    return Response("not ready\n", mimetype="text/plain", status=503)


@app.route("/metrics")
def api_metrics():
    return Response(metrics.metrics_text(), mimetype="text/plain; version=0.0.4; charset=utf-8")


@app.route("/api/metrics/portal")
def api_metrics_portal():
    text = metrics.metrics_text()
    s = metrics.summarize(text)
    for line in text.splitlines():
        if line.startswith("http_requests_total{") and 'code="total"' in line:
            try:
                s["http_requests_total"] = float(line.rstrip().split()[-1])
            except (ValueError, IndexError):
                pass
            break
    return _ok(s)


# ── Authentication ──────────────────────────────────────────────────────────

@app.route("/api/session")
def api_session():
    if not WEBUI_PASSWORD:
        return _ok({"auth": True, "auth_required": False})
    return _ok({"auth": is_authenticated(), "auth_required": True})


@app.route("/api/login", methods=["POST"])
def api_login():
    if not WEBUI_PASSWORD:
        return _err("Authentication is not enabled")
    ip = _client_ip()
    remaining = _lockout_remaining(ip)
    if remaining > 0:
        return _err(f"Too many failed attempts. Try again in {int(remaining / 60)} minute(s).", code=429)
    data = request.json or {}
    password = data.get("password", "")
    if password != WEBUI_PASSWORD:
        _record_failure(ip)
        return _err("Incorrect password", code=401)
    _clear_failures(ip)
    session["auth"] = True
    session.permanent = bool(data.get("remember", False))
    session.permanent_session_lifetime = app.config["PERMANENT_SESSION_LIFETIME"]
    return _ok({"auth": True, "auth_required": True})


@app.route("/api/logout", methods=["POST"])
def api_logout():
    session.clear()
    return _ok(msg="Logged out")


# ── Dashboard ───────────────────────────────────────────────────────────────

@app.route("/api/system")
def api_system():
    return _ok(system_info.get_system_status())


@app.route("/api/modules")
def api_modules():
    mods = []
    for e in backends.entries():
        entry = {
            "name": e["name"],
            "type": e.get("type", "other"),
            "url": e["url"],
            "enabled": e.get("enabled", True),
        }
        if entry["enabled"]:
            h = backends.health(e["name"])
            entry["online"] = h.get("online", False)
            entry.update({k: v for k, v in h.items() if k not in ("ok",)})
        else:
            entry["online"] = False
            entry["ready"] = False
            entry["endpoint"] = None
        mods.append(entry)
    return _ok(mods)


# ── Service registry ─────────────────────────────────────────────────────────

@app.route("/api/services", methods=["GET", "POST"])
def api_services():
    if request.method == "GET":
        out = []
        for e in backends.entries():
            svc = {"name": e["name"], "type": e.get("type", "other"),
                   "url": e["url"], "enabled": e.get("enabled", True),
                   "created": e.get("created")}
            if svc["enabled"]:
                h = backends.health(e["name"])
                svc["online"] = h.get("online", False)
                svc["ready"] = h.get("ready", False)
                if h.get("error"):
                    svc["error"] = h["error"]
            else:
                svc["online"] = False
                svc["ready"] = False
            out.append(svc)
        return _ok(out)
    body = request.get_json(silent=True) or {}
    if not backends.valid_name(body.get("name", "")):
        return _err("Name must be letters, digits, '-' or '_'")
    try:
        entry = registry.add(
            body["name"], body.get("url", ""),
            type=body.get("type", "other"),
            enabled=body.get("enabled", True),
        )
    except ValueError as e:
        return _err(str(e))
    backends.sync_modules()
    return _ok(entry, msg="Service added")


@app.route("/api/services/<name>", methods=["PUT", "DELETE"])
def api_service(name):
    if not backends.valid_name(name):
        return _err("Invalid service name")
    if request.method == "DELETE":
        try:
            registry.remove(name)
        except (ValueError, OSError) as e:
            return _err(str(e))
        backends.sync_modules()
        return _ok(msg="Service removed")
    body = request.get_json(silent=True) or {}
    try:
        entry = registry.update(
            name,
            url=body.get("url"),
            type=body.get("type"),
            enabled=body.get("enabled"),
        )
    except ValueError as e:
        return _err(str(e))
    backends.sync_modules()
    return _ok(entry, msg="Service updated")


@app.route("/api/services/<name>/test", methods=["POST"])
def api_service_test(name):
    entry = registry.get(name)
    if not entry:
        return _err("Unknown service")
    h = backends.health(name)
    entry = dict(entry)
    entry["online"] = h.get("online", False)
    entry["ready"] = h.get("ready", False)
    if h.get("error"):
        entry["error"] = h["error"]
    return _ok(entry)


@app.route("/api/module/<name>/auth")
def api_module_auth(name):
    try:
        return _ok(backends.auth_state(name))
    except backends.BackendError as e:
        return _err(str(e))


@app.route("/api/module/<name>/login", methods=["POST"])
def api_module_login(name):
    try:
        return _ok({"authenticated": backends._login(name)})
    except backends.BackendError as e:
        return _err(str(e))


@app.route("/api/module/<name>/metrics")
def api_module_metrics(name):
    try:
        return Response(backends.raw_metrics(name),
                        mimetype="text/plain; version=0.0.4; charset=utf-8")
    except backends.BackendError as e:
        return _err(str(e))


@app.route("/api/module/<name>/metrics/parsed")
def api_module_metrics_parsed(name):
    try:
        text = backends.raw_metrics(name)
        s = metrics.summarize(text)
        for line in text.splitlines():
            if line.startswith("http_requests_total{") and 'code="total"' in line:
                try:
                    s["http_requests_total"] = float(line.rstrip().split()[-1])
                except (ValueError, IndexError):
                    pass
                break
        return _ok(s)
    except backends.BackendError as e:
        return _err(str(e))


# ── Backend proxy (all methods) ─────────────────────────────────────────────

@app.route("/api/module/<path:name>/proxy/<path:subpath>", methods=["GET", "POST", "PUT", "DELETE", "PATCH"])
def api_module_proxy(name, subpath):
    if not backends.valid_name(name):
        return _err("Invalid module name")
    json_body = None
    if request.is_json:
        json_body = request.get_json(silent=True)
    form = request.form or None
    files = {k: (v.filename, v.stream, v.mimetype) for k, v in request.files.items()} or None
    try:
        resp = backends.call(
            name, request.method, subpath,
            params=request.args, json_body=json_body, form=form, files=files,
        )
    except backends.BackendError as e:
        return _err(str(e))
    ctype = resp.headers.get("Content-Type", "")
    if "application/json" in ctype:
        try:
            return (resp.json(), resp.status_code)
        except ValueError:
            pass
    return Response(resp.content, status=resp.status_code, content_type=ctype or "text/plain")


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("WEBUI_PORT", "8080")), debug=False)