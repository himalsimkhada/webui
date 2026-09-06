"""Tests for the persistent service registry."""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import registry  # noqa: E402

PASS = ("admin", "http://127.0.0.1:8400")


@pytest.fixture()
def reg(tmp_path, monkeypatch):
    monkeypatch.setattr(registry, "SERVICE_REGISTRY_FILE", str(tmp_path / "services.json"))
    registry.reset()
    yield registry
    registry.reset()


def test_seeds_from_env_when_no_file(reg, monkeypatch):
    monkeypatch.setenv("PORTAL_MODULES", "nginx=http://a:1,bind=http://b:2")
    entries = reg.load()
    assert [(e["name"], e["url"]) for e in entries] == [("nginx", "http://a:1"), ("bind", "http://b:2")]
    assert entries[0]["type"] == "nginx"
    assert entries[0]["enabled"] is True


def test_load_skips_malformed_entries(reg):
    reg._persist([
        {"name": "a", "url": "http://x:1"},
        {"name": "b", "url": "http://y:2"},
        {"broken": True},
        "junk",
    ])
    reg.reset()
    entries = reg.load()
    assert [e["name"] for e in entries] == ["a", "b"]


def test_add_and_persist(reg):
    reg.add("nginx-us", "192.168.1.10:8400", type="nginx")
    entry = reg.get("nginx-us")
    assert entry["url"] == "http://192.168.1.10:8400"  # scheme auto-added
    reg.reset()
    assert reg.get("nginx-us")["type"] == "nginx"       # survived a reload


def test_add_duplicate_rejected(reg):
    reg.add("a", "http://x:1")
    with pytest.raises(ValueError):
        reg.add("a", "http://y:2")


def test_add_requires_valid_url(reg):
    with pytest.raises(ValueError):
        reg.add("bad", "")
    with pytest.raises(ValueError):
        reg.add("bad", "ftp://nope:1")


def test_name_required(reg):
    with pytest.raises(ValueError):
        reg.add("   ", "http://x:1")


def test_update_and_disable(reg):
    reg.add("a", "http://x:1", type="nginx")
    reg.update("a", url="http://y:2", enabled=False)
    e = reg.get("a")
    assert e["url"] == "http://y:2"
    assert e["enabled"] is False
    with pytest.raises(ValueError):
        reg.update("nope", url="http://z:3")


def test_remove(reg):
    reg.add("a", "http://x:1")
    reg.remove("a")
    assert reg.get("a") is None
    # remove is idempotent
    reg.remove("a")