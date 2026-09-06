"""Persistent service registry for the admin UI.

The registry is a plain JSON file (no database). Each entry describes a
backend service the facade talks to over HTTP:

    {"name": "nginx", "type": "nginx", "url": "http://127.0.0.1:8400",
     "enabled": true, "created": 1234567890}

- `name`: unique slug used as the module key (/api/module/<name>/...) and the
  handle for the UI.
- `type`: which management panel a service belongs to ("nginx", "bind", or
  "other"). Several instances may share a type (e.g. an nginx on each server).
- `url`: base URL of the backend (scheme://host:port).

On first load the registry is seeded from PORTAL_MODULES for backward
compat with the previous static config. The file is only written when an
entry is added/updated/removed.
"""
import json
import os
import threading
import uuid
from pathlib import Path
from urllib.parse import urlparse

SERVICE_REGISTRY_FILE = os.environ.get("SERVICE_REGISTRY_FILE", "services.json")
KNOWN_TYPES = ("nginx", "bind")
_LOCK = threading.RLock()
_cache = None
_loaded_once = False


def _seed():
    raw = os.environ.get(
        "PORTAL_MODULES",
        "nginx=http://127.0.0.1:8400,bind=http://127.0.0.1:5000",
    )
    out = []
    for part in raw.split(","):
        part = part.strip()
        if not part or "=" not in part:
            continue
        name, url = part.split("=", 1)
        name = name.strip()
        url = url.strip().rstrip("/")
        if not url:
            continue
        typ = name if name in KNOWN_TYPES else "other"
        out.append({"name": name, "type": typ, "url": url, "enabled": True,
                    "created": int(__import__("time").time())})
    return out


def _normalize(entry):
    name = str(entry.get("name", "")).strip()
    typ = str(entry.get("type", "")).strip() or "other"
    url = str(entry.get("url", "")).strip().rstrip("/")
    enabled = bool(entry.get("enabled", True))
    created = entry.get("created", int(__import__("time").time()))
    return {"name": name, "type": typ, "url": url, "enabled": enabled,
            "created": int(created)}


def _load_file():
    path = Path(SERVICE_REGISTRY_FILE)
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text())
        entries = data if isinstance(data, list) else data.get("services", [])
        return [_normalize(e) for e in entries if isinstance(e, dict) and e.get("name")]
    except (OSError, ValueError):
        return None


def _persist(entries):
    path = Path(SERVICE_REGISTRY_FILE)
    if path.parent and str(path.parent) != ".":
        path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(entries, indent=2))


def load():
    """Latest registry entries (in-memory cache, seeded on first call)."""
    global _cache, _loaded_once
    with _LOCK:
        if _loaded_once and _cache is not None:
            return _cache
        entries = _load_file()
        if entries is None:
            entries = _seed()
        _cache = entries
        _loaded_once = True
        return list(_cache)


def reset():
    """Clear the cache (used by tests)."""
    global _cache, _loaded_once
    _cache = None
    _loaded_once = False


def reload():
    """Re-read the registry from disk and invalidate the cache."""
    return _force_reload()


def _force_reload():
    global _cache, _loaded_once
    with _LOCK:
        entries = _load_file()
        if entries is None:
            entries = _seed()
        _cache = entries
        _loaded_once = True
        return list(_cache)


def get(name):
    for e in load():
        if e["name"] == name:
            return e
    return None


def add(name, url, type="other", enabled=True):
    """Add an entry, persist it, and return the new entry."""
    global _cache
    name = name.strip()
    if not name:
        raise ValueError("Name is required")
    if get(name):
        raise ValueError(f"A service named '{name}' already exists")
    url = _validate_url(url)
    type = (type or "other").strip().lower() or "other"
    entry = {"name": name, "type": type, "url": url, "enabled": bool(enabled),
             "created": int(__import__("time").time())}
    with _LOCK:
        entries = load()
        entries.append(entry)
        _cache = entries
        _persist(entries)
    return entry


def update(old_name, url=None, type=None, enabled=None, name=None):
    """Update an entry (optionally renaming it), persist it, and return it."""
    global _cache
    entry = get(old_name)
    if not entry:
        raise ValueError(f"Unknown service '{old_name}'")
    new_name = name if name is not None else old_name
    new_name = (new_name or "").strip()
    if not new_name:
        raise ValueError("Name is required")
    if new_name != old_name and get(new_name):
        raise ValueError(f"A service named '{new_name}' already exists")
    entry["name"] = new_name
    if url is not None:
        entry["url"] = _validate_url(url)
    if type is not None:
        entry["type"] = (type or "other").strip().lower() or "other"
    if enabled is not None:
        entry["enabled"] = bool(enabled)
    with _LOCK:
        entries = load()
        entries = [_normalize(e) if e["name"] != old_name else entry for e in entries]
        _cache = entries
        _persist(entries)
    return entry


def remove(name):
    global _cache
    with _LOCK:
        entries = [e for e in load() if e["name"] != name]
        _cache = entries
        _persist(entries)
    return True


def _validate_url(url):
    url = (url or "").strip().rstrip("/")
    if not url:
        raise ValueError("URL is required")
    if "://" not in url:
        url = "http://" + url
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ValueError(f"Invalid URL: {url}")
    return url