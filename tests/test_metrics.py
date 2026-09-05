"""Tests for the shared dependency-free metrics module."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import metrics  # noqa: E402


def test_process_metrics_shape():
    p = metrics.process_metrics()
    for k in ("process_resident_memory_bytes", "process_virtual_memory_bytes",
              "process_cpu_seconds_total", "process_start_time_seconds",
              "process_uptime_seconds", "process_io_read_bytes",
              "process_io_write_bytes", "process_open_fds",
              "process_io_read_syscalls", "process_io_write_syscalls",
              "process_threads"):
        assert k in p, k
    assert p["process_resident_memory_bytes"] > 0
    assert p["process_open_fds"] > 0


def test_metrics_text_contains_gauges():
    m = metrics.metrics_text()
    assert "process_resident_memory_bytes" in m
    assert "process_start_time_seconds" in m
    assert "webui_service_healthy" in m
    assert "webui_service_ready" in m
    assert "http_requests_total" in m


def test_request_counters():
    before = metrics.summarize(metrics.metrics_text()).get("http_requests_total", 0)
    metrics.record_request_started()
    metrics.record_request_finished(200)
    after = metrics.summarize(metrics.metrics_text()).get("http_requests_total", 0)
    assert after >= before


def test_ready_flag():
    metrics.set_ready(False)
    assert "webui_service_ready{service=\"webui\"} 0" in metrics.metrics_text()
    metrics.set_ready(True)
    assert "webui_service_ready{service=\"webui\"} 1" in metrics.metrics_text()


def test_summarize_parses_values():
    text = "abc 123\nx_y 4.5\n# comment\nz{label=\"a\"} 9\n"
    s = metrics.summarize(text)
    assert s["abc"] == 123.0
    assert s["x_y"] == 4.5
    assert s["z"] == 9.0