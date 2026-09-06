# Web UI Admin

A lightweight admin facade for your self-hosted web services. One login, one
dashboard — it proxies the APIs of backend modules (nginx-webui, bind9-webui, …)
over plain HTTP ports and shows everything in a single UI.

- **Same stack as bind9-webui** — Flask + vanilla HTML/CSS/JS, no database, no build step.
- **Service registry (UI-managed)** — add/remove/enable backends from the *Services* page
  (name + type + URL + port). Multiple instances of the same type are supported
  (e.g. one nginx per server). Stored in a small JSON file, seeded from `PORTAL_MODULES`.
- **Port-based facade** — `/api/module/<name>/proxy/<path>` forwards to a backend and
  auto-logs-in using the shared `WEBUI_PASSWORD` when a backend answers 401.
- **Full nginx editing from the UI** — the *Nginx* page can browse/edit config files,
  manage sites (create reverse-proxy sites, edit, enable/disable, delete), run
  `nginx -t` and reload — the nginx-webui backend is API-only and has no UI of its own.
- **Built-in metrics** — `/metrics`, `/healthz`, `/readyz` (prometheus text format,
  dependency-free): per-process memory, CPU, I/O, uptime, open fds, threads, active
  requests + HTTP counters; aggregated backend metrics for the dashboard.
- **System status** — host uptime, load, CPU cores, memory/swap/disk usage.
- **Access protection** — shared password, 30-min *remember me* auto-logout, brute-force
  lockout (5 failures → 15 min), dark/light mode.

## Quick start

```bash
git clone git@github.com:himalsimkhada/webui.git
cd webui
python3 -m venv venv && ./venv/bin/pip install -r requirements.txt
WEBUI_PASSWORD='your-password' SECRET_KEY='a-long-random-string' ./venv/bin/python app.py
```

Open http://localhost:8080.

### Docker

```bash
cp .env.example .env     # set PORTAL_MODULES, WEBUI_PASSWORD, SECRET_KEY
docker compose up -d --build
```

## Backend modules

The facade expects each backend to expose:

- `/healthz`, `/readyz` — liveness/readiness probes (unauthenticated)
- `/metrics` — Prometheus text metrics (auth-gated; the facade logs in for you)
- `/api/*` — JSON API, `POST /api/session` to probe auth state, `POST /api/login` for login

Point it at the bundled backends:

| Module | Repo | Expected URL |
|---|---|---|
| `nginx` | `nginx-webui` (backend-only) | `http://127.0.0.1:8400` |
| `bind` | `bind9-webui` | `http://127.0.0.1:5000` |

`PORTAL_MODULES` (e.g. `nginx=http://127.0.0.1:8400,bind=http://127.0.0.1:5000`)
**only seeds the registry on first run** — after that, add services from the
*Services* page in the UI, which persists them to `SERVICE_REGISTRY_FILE`
(default `services.json`).

Every backend should use the **same `WEBUI_PASSWORD`** so the facade can log
in automatically (server-to-server).

## Metrics

Each web UI service exposes the same standard indicators:

```
process_resident_memory_bytes   # RSS
process_virtual_memory_bytes    # VSZ
process_cpu_seconds_total       # CPU time
process_start_time_seconds      # process start
process_uptime_seconds          # uptime
process_io_read_bytes           # I/O read
process_io_write_bytes          # I/O write
process_read_syscalls / write   # syscall counters
process_open_fds / threads
http_requests_total             # by HTTP code
http_requests_active            # in-flight
http_requests_errors_total      # 5xx
webui_service_healthy           # liveness
webui_service_ready             # readiness
```

The dashboard's *Portal* card shows this service's own values; the *Metrics*
button on a module tile shows the backend's aggregated values.

## API reference

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/session` | Auth state |
| POST | `/api/login` | Login (shared password) |
| POST | `/api/logout` | Logout |
| GET | `/api/system` | Host status (uptime/load/mem/disk) |
| GET · POST | `/api/services` | List / register backend services |
| PUT · DELETE | `/api/services/<name>` | Update / remove a service |
| POST | `/api/services/<name>/test` | Probe a service |
| GET | `/api/modules` | Service health overview (with type + enabled) |
| GET | `/api/module/<name>/auth` | Backend auth state |
| POST | `/api/module/<name>/login` | Force backend login |
| GET | `/api/module/<name>/metrics` | Backend metrics (raw Prometheus) |
| GET | `/api/module/<name>/metrics/parsed` | Backend metrics (JSON gauges) |
| *any* | `/api/module/<name>/proxy/<path>` | Reverse proxy to the backend |
| GET | `/healthz` `/readyz` | Probes (open) |
| GET | `/metrics` | This service's metrics (auth-gated) |
| GET | `/api/metrics/portal` | This service's metrics (JSON gauges) |

## Development

```bash
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt -r requirements-dev.txt
pytest
```

CI runs on GitHub Actions for every push/PR.

## Project structure

```
webui/
├── app.py            # Flask facade — auth, dashboard, proxy, probes
├── backends.py       # proxy client (auto-login), module map from the registry
├── registry.py       # persistent service registry (services.json, UI-managed)
├── metrics.py        # dependency-free prometheus metrics
├── system_info.py    # host status from /proc
├── templates/ static/  # single-page UI (vanilla JS, dark/light)
├── tests/            # pytest suite
├── Dockerfile · docker-compose.yml · .env.example
├── webui.service     # systemd unit
└── .github/workflows/ci.yml
```

## License

MIT