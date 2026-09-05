"""Host-level system information for the admin dashboard, dependency-free."""
import os
import platform
import shutil
import time


def _read_proc(path):
    try:
        return open(path).read()
    except FileNotFoundError:
        return ""


def _boot_time():
    uptime = float(_read_proc("/proc/uptime").split()[0] or 0)
    return time.time() - uptime


def _meminfo():
    info = {}
    for line in _read_proc("/proc/meminfo").splitlines():
        if ":" in line:
            key, _, val = line.partition(":")
            info[key.strip()] = int(val.strip().split()[0]) * 1024  # kB -> bytes
    return info


def _loadavg():
    parts = _read_proc("/proc/loadavg").split()
    return float(parts[0]) if parts else 0.0


def _disk():
    try:
        u = shutil.disk_usage("/")
        return {"total": u.total, "used": u.used, "free": u.free}
    except (OSError, ValueError):
        return {"total": 0, "used": 0, "free": 0}


def get_system_status():
    mem = _meminfo()
    total = mem.get("MemTotal", 0)
    available = mem.get("MemAvailable", total)
    swap_total = mem.get("SwapTotal", 0)
    swap_free = mem.get("SwapFree", 0)
    disk = _disk()
    boot = _boot_time()
    return {
        "host": platform.node(),
        "platform": f"{platform.system()} {platform.release()}",
        "uptime_seconds": max(0.0, time.time() - boot),
        "boot_time": boot,
        "cpu_cores": os.cpu_count() or 1,
        "load_1m": _loadavg(),
        "memory_total": total,
        "memory_used": max(0, total - available),
        "memory_available": available,
        "swap_total": swap_total,
        "swap_used": max(0, swap_total - swap_free),
        "disk": disk,
        "python": platform.python_version(),
    }