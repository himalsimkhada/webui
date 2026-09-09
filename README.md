<div align="center">

```
 _    _  _____  ____  _   _  ___
| |  | ||  ___|| __ )| | | ||_ _|
| |\/| || |__  |  _ \| | | | | |
| |  | ||  __| | |_) | |_| | | |
|_|  |_||_|    |____/ \___/  |_|
```

### One admin console for your self-hosted services

**A lightweight, dependency-free web facade** that gives you a single login and a
single dashboard for your web services — it proxies the APIs of `nginx-webui`,
`bind9-webui`, and any other backend you register, and renders every one of them
in one place. No database, no build step, ~35 MB RAM.

<!-- badges (static, no network lookups) -->
![Python](https://img.shields.io/badge/Python-3.10+-blue?logo=python&logoColor=white)
![Stack](https://img.shields.io/badge/Flask-Docker-Vanilla%20JS-green)
![Docker](https://img.shields.io/badge/Docker-24273D?logo=docker&logoColor=white)
![Style](https://img.shields.io/badge/dark%20%2F%20light-mode-blueviolet)
![License](https://img.shields.io/badge/license-MIT-orange)
![maintained](https://img.shields.io/badge/maintained-yes-2ea44f)
![PRs](https://img.shields.io/badge/PRs-welcome-2ea44f)

This is the **portal frontend**. The backends it manages — nginx and BIND9 —
are pure JSON APIs with no UI of their own. Point this facade at them over plain
HTTP and the full management dashboards appear here, in your browser.

</div>

---

## Install — one line

Copy-paste this. No cloning, no setup — the installer bootstraps itself, then asks
which deployment you want:

```bash
curl -fsSL https://raw.githubusercontent.com/himalsimkhada/webui/main/install.sh | bash
```

> The **nginx-webui** and **bind9-webui** installers detect when this portal is
> not running and offer to install it for you — so a typical stack is still one
> command plus a couple of *"want the dashboard too?"* prompts.
>
> Not ready yet? `./install.sh --check` does a safe dry run and reports what the
> installer would detect on your machine without changing anything.

---

## Table of Contents

- [Why webui?](#why-webui)
- [Features](#features)
- [Quick start](#quick-start)
- [Requirements](#requirements)
- [Deployment options](#deployment-options)
  - [1. Docker](#option-1--docker)
  - [2. Manual (bare-metal)](#option-2--manual-bare-metal)
- [Configuration](#configuration)
- [Adding backends](#adding-backends)
- [Security notes](#security-notes)
- [API reference](#api-reference)
- [Development](#development)
- [Project structure](#project-structure)
- [How it works](#how-it-works)
- [License](#license)

---

## Why webui?

Self-hosting usually means one dashboard per service, each with its own port,
its own login and its own look. This project collapses that into **one portal**:
register your backend services (nginx, BIND9, anything with the same API shape),
and the facade proxies them into a single UI behind one shared password.

The backends stay yours — this portal just makes logging into and browsing them
pleasant.

---

## Features

| | |
|---|---|
| **Single admin console** | One login, one dashboard, one port. A *Services* page shows every registered backend with live health/ready probes and working proxy links. |
| **Service registry (UI-managed)** | Add/remove/enable backends from the *Services* page (name + type + URL + port). Multiple instances of the same type are supported (e.g. one nginx per server). Stored in a small JSON file, seeded from `PORTAL_MODULES`. |
| **Port-based facade** | `/api/module/<name>/proxy/<path>` forwards to a backend and auto-logs-in using the shared `WEBUI_PASSWORD` when a backend answers 401 — you never type the password twice. |
| **Full nginx dashboard** | The *Nginx* page browses/edits config files, manages sites (create reverse-proxy sites, edit, enable/disable, delete), runs `nginx -t` and reload — fed by the `nginx-webui` backend. |
| **Full BIND9 dashboard** | The *BIND* page manages zones (add/edit/index zones, records, raw zone files, dig, host mapper, config files), rndc controls and logs — fed by the `bind9-webui` backend. |
| **Built-in metrics** | `/metrics`, `/healthz`, `/readyz` (Prometheus text, dependency-free) for this portal, plus aggregated backend metrics on the dashboard. |
| **System status** | Host uptime, load, CPU cores, memory/swap/disk usage. |
| **Access protection** | Shared password, 30-min *remember me* auto-logout, brute-force lockout (5 failures → 15 min), dark/light mode. |

---

## Quick start

Install in one command — the installer **bootstraps itself** when streamed, cloning the repo before it runs:

```bash
curl -fsSL https://raw.githubusercontent.com/himalsimkhada/webui/main/install.sh | bash
```

Or clone and run directly:

```bash
git clone https://github.com/himalsimkhada/webui.git
cd webui
./install.sh
```

You'll be asked which deployment you want:

```
  1) Docker   - admin facade in a container (recommended)
  2) Manual   - admin facade installed directly on this machine
```

Open http://localhost:8080 and log in with the password you chose.

> **Dry run first:** `./install.sh --check` reports what the installer detects
> on your machine (distro, Docker + compose, python3) without changing a thing.

---

## Requirements

- Linux (Docker mode) or Linux + Python 3.10+ (manual mode)
- `sudo` access
- Docker is **optional** — needed only for the containerized deployment
- Backend services (`nginx-webui`, `bind9-webui`) are **optional** — install any
  that you want this portal to manage. The installer of each backend offers to
  install this portal when it is not running.

Supported distros: Debian/Ubuntu (apt), RHEL/Fedora (dnf), Arch (pacman).

---

## Deployment options

| Option | What runs where | When to pick it |
|---|---|---|
| **1. Docker** | The portal in a container (pulls the published image) | You want the backends containerized too, hassle-free |
| **2. Manual** | Everything on this machine, systemd service | Minimal footprint, single server |

### Option 1 — Docker

The compose file pulls the published image (`ghcr.io/himalsimkhada/webui:latest`)
and publishes the portal on **8080**. It reaches backends on the Docker host via
`host.docker.internal` (added automatically with `extra_hosts`):

```bash
./install.sh    # choose 1) Docker
```

By hand:

```bash
cp .env.example .env     # set PORTAL_MODULES, WEBUI_PASSWORD, SECRET_KEY
docker compose up -d
```

### Option 2 — Manual (bare-metal)

Everything on this one machine, managed as a systemd service. Portal at
`http://localhost:8080`.

```bash
./install.sh    # choose 2) Manual
```

By hand:

```bash
python3 -m venv venv
./venv/bin/pip install -r requirements.txt
WEBUI_PASSWORD='your-password' SECRET_KEY='a-long-random-string' \
PORTAL_MODULES='nginx=http://127.0.0.1:8400,bind=http://127.0.0.1:5000' \
./venv/bin/python app.py
```

As a boot-starting service:

```bash
sudo cp webui.service /etc/systemd/system/
# edit /path/to/webui and add your env as an EnvironmentFile (or the installer does it)
sudo systemctl daemon-reload
sudo systemctl enable --now webui
```

---

## Configuration

All container settings live in `.env` (see `.env.example`); bare-metal uses
environment variables or the systemd `EnvironmentFile` (`/etc/webui.env` when
installed via `install.sh`):

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORTAL_MODULES` | `nginx=http://host.docker.internal:8400,bind=http://host.docker.internal:5000` | Comma-separated `name=base_url` list that **seeds** the service registry on first run |
| `SERVICE_REGISTRY_FILE` | `services.json` | Where registered services persist (a named volume `/data/services.json` in Docker) |
| `WEBUI_PASSWORD` | *(empty = auth off)* | Single shared password. **Every backend must use the same value** so the facade can log in automatically |
| `SECRET_KEY` | *(dev default)* | Secret used to sign the session cookie; set a random value |
| `WEBUI_PORT` | `8080` | Host port the portal is published on |
| `BACKEND_TIMEOUT` | `5` | Seconds to wait for backend responses |

---

## Adding backends

The facade expects each backend to expose:

- `/healthz`, `/readyz` — liveness/readiness probes (unauthenticated)
- `/metrics` — Prometheus text metrics (auth-gated; the facade logs in for you)
- `/api/*` — JSON API, `POST /api/session` to probe auth state, `POST /api/login` for login

The bundled backends match this out of the box:

| Module | Repo | Expected URL |
|---|---|---|
| `nginx` | [`himalsimkhada/nginx-webui`](https://github.com/himalsimkhada/nginx-webui) (backend-only) | `http://127.0.0.1:8400` |
| `bind` | [`himalsimkhada/bind9-webui`](https://github.com/himalsimkhada/bind9-webui) | `http://127.0.0.1:5000` |

`PORTAL_MODULES` e.g. `nginx=http://127.0.0.1:8400,bind=http://127.0.0.1:5000`
**only seeds the registry on first run** — after that, add services from the
*Services* page in the UI, which persists them to `SERVICE_REGISTRY_FILE`.

> **Important:** every backend should use the **same `WEBUI_PASSWORD`** so the
> facade can log in automatically (server-to-server). The backend installers
> prompt for it — enter the same value you gave the portal.

---

## Security notes

- Authentication is a single shared password compared against the configured `WEBUI_PASSWORD` — nothing stored on disk, no user database.
- Sessions use a signed cookie (set `SECRET_KEY`!), with **brute-force lockout** (5 failed logins → 15 min block).
- Backend access goes through `host.docker.internal` / explicit URLs only — the portal never exposes or proxies arbitrary external hosts beyond the registered services (path-traversal safe).
- `/healthz` and `/readyz` are open (probes); `/metrics` and every `/api/*` endpoint require auth when a password is set.
- No build step, no runtime downloads, no telemetry, no analytics.

---

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

---

## Development

```bash
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt -r requirements-dev.txt

pytest                      # full suite (registry, proxy, auth, probes)
node --check static/app.js  # frontend syntax check
```

The suite covers the service registry, proxy auto-login, auth + lockout,
system info, and the metrics/health probes. CI runs on GitHub Actions for every
push and PR.

---

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
├── requirements.txt  # flask
├── Dockerfile        # Container image (published to ghcr.io)
├── docker-compose.yml # Portal image + named volume + host.docker.internal
├── install.sh        # bootstrapping one-shot installer (--check safe)
├── webui.service     # Systemd unit (bare-metal)
├── .env.example      # Container configuration template
└── LICENSE           # MIT
```

> The backend services live in the companion repos
> [himalsimkhada/nginx-webui](https://github.com/himalsimkhada/nginx-webui) and
> [himalsimkhada/bind9-webui](https://github.com/himalsimkhada/bind9-webui) —
> API-only, with installers that offer to install this portal for you.

---

## How it works

- **Registry** — backend services are seeded from `PORTAL_MODULES` on first run,
  then maintained from the *Services* page; persisted to `SERVICE_REGISTRY_FILE`.
- **Proxy** — the facade answers the browser on `/api/module/<name>/proxy/<path>`,
  forwards to the backend, and on a 401 replays the request with an automatic
  login using the shared `WEBUI_PASSWORD`.
- **Frontend** — a single-page UI (vanilla JS, no frameworks) that renders each
  module's dashboard from the proxied API, with a Services page for management.
- **Probes & metrics** — `/healthz`/`/readyz` for orchestration and `/metrics`
  (Prometheus text) for monitoring, plus aggregated backend gauges for the
  dashboard.

No database for the portal itself (just the small `services.json` registry), no
magic — plain HTTP and JSON end to end.

---

<div align="center">

**Poke around, file an issue, open a PR — feedback welcome.**

</div>

## License

MIT