#!/usr/bin/env bash
#
# Web UI Admin — interactive installer.
#
# The admin facade that hosts the dashboard for the companion backends
# (nginx-webui, bind9-webui). Offers two deployment modes:
#   1. Docker  : the facade in a container (pulls the published image)
#   2. Manual  : the facade installed directly on this machine (systemd + venv)
#
# Usage:  sudo ./install.sh   (or: ./install.sh --check | --help)
# One-liner:  curl -fsSL https://raw.githubusercontent.com/himalsimkhada/webui/main/install.sh | bash
# Headless:   WEBUI_MODE=1 WEBUI_PASSWORD=x TARGET_DIR=~/webui curl -fsSL ... | bash

set -euo pipefail

REPO_URL="https://github.com/himalsimkhada/webui.git"

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

# ── Output helpers ───────────────────────────────────────────────────────

if [ -t 1 ]; then
  C_RESET=$'\e[0m'; C_GREEN=$'\e[32m'; C_YELLOW=$'\e[33m'; C_RED=$'\e[31m'; C_BOLD=$'\e[1m'
else
  C_RESET=""; C_GREEN=""; C_YELLOW=""; C_RED=""; C_BOLD=""
fi

info()  { printf '%s\n' "${C_BOLD}==>${C_RESET} $*"; }
ok()    { printf '%s%s%s\n' "${C_GREEN}    $*${C_RESET}"; }
warn()  { printf '%s%s%s\n' "${C_YELLOW}!!  $*${C_RESET}"; }
die()   { printf '%s%s%s\n' "${C_RED}FATAL:$*${C_RESET}" >&2; exit 1; }

has_cmd() { command -v "$1" >/dev/null 2>&1; }

# ── Input helpers ────────────────────────────────────────────────────────
# Under `curl ... | bash` stdin is the script stream, and a nested run
# (`bash ../webui/install.sh` from another streamed installer) inherits that
# consumed stream, so bare `read` gets EOF instantly. Read from the
# controlling terminal when one exists; headless runs use env vars instead.

have_tty() { ( exec </dev/tty ) 2>/dev/null; }

read_input() {
  local var="$1" prompt="${2:-}"
  local envval=""
  case "$var" in
    target) envval="${TARGET_DIR:-}";;
    choice) envval="${WEBUI_MODE:-}";;
    ans)    envval="${WEBUI_YES:-}";;
  esac
  if [ -n "$envval" ]; then
    printf -v "$var" '%s' "$envval"
    return 0
  fi
  if have_tty; then
    read -r -p "$prompt" "$var" < /dev/tty
  else
    die "No terminal available and \$$var was not set (${prompt%:}). Re-run from a terminal or set the env var."
  fi
}

read_input_silent() {
  local var="$1" prompt="${2:-}"
  if have_tty; then
    read -r -s -p "$prompt" "$var" < /dev/tty
  else
    die "No terminal available for password input. Set WEBUI_PASSWORD=... and re-run."
  fi
  echo ""
}

# ── Self-bootstrap ────────────────────────────────────────────────────────
# Support one-liner installs (curl ... | bash): when the script is streamed
# there is no repo checkout in $DIR, so fetch the repository first and then
# re-run this installer from inside it (finishes with the user's chosen mode).

if [ ! -f "$DIR/app.py" ] || [ ! -f "$DIR/docker-compose.yml" ]; then
  echo "==> One-liner install: no repo checkout in \"$DIR\"."
  has_cmd git || die "git is required for the one-liner install (curl | bash)."
  has_cmd curl || has_cmd wget || warn "Neither curl nor wget found; check the URL you piped."

  default_target="$HOME/webui"
  target=""
  read_input target "Install the project into [$default_target]: " || true
  target="${target:-$default_target}"

  mkdir -p "$(dirname "$target")"
  if [ -d "$target" ] && [ -f "$target/app.py" ]; then
    info "Updating existing checkout at $target"
    (cd "$target" && git pull --ff-only) >/dev/null 2>&1 || true
  else
    info "Cloning $REPO_URL into $target"
    git clone --quiet --depth 1 "$REPO_URL" "$target"
  fi
  cd "$target"
  exec bash "$target/install.sh" "$@"
fi

# ── System detection ─────────────────────────────────────────────────────

OS_ID="unknown"
OS_NAME="unknown"
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  OS_ID="${ID:-unknown}"
  OS_NAME="${NAME:-$OS_ID}"
fi

is_deb() { case "$OS_ID" in debian|ubuntu|linuxmint|pop|elementary|kali|raspbian) return 0;; *) return 1;; esac; }
is_rpm() { case "$OS_ID" in rhel|fedora|centos|almalinux|rocky|ol|amazon) return 0;; *) return 1;; esac; }
is_arch() { case "$OS_ID" in arch|manjaro|endeavouros) return 0;; *) return 1;; esac; }

pkg_install() {
  if is_deb; then
    sudo apt-get update -qq
    sudo apt-get install -y -qq "$@"
  elif is_rpm; then
    if command -v dnf >/dev/null 2>&1; then sudo dnf install -y "$@"
    else sudo yum install -y "$@"; fi
  elif is_arch; then
    sudo pacman -S --noconfirm --needed "$@"
  else
    die "Unsupported distro ($OS_NAME). Please install dependencies manually."
  fi
}

# ── Generic helpers ──────────────────────────────────────────────────────

random_secret() {
  if has_cmd openssl; then
    openssl rand -hex 32
  else
    od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
  fi
}

ask_password() {
  # Accepts WEBUI_PASSWORD from the environment (headless runs) or prompts.
  # IMPORTANT: use the SAME value as the backends you want the facade to log
  # into automatically (nginx-webui, bind9-webui share WEBUI_PASSWORD).
  if [ -z "${WEBUI_PASSWORD:-}" ]; then
    WEBUI_PASSWORD=""
    while [ -z "$WEBUI_PASSWORD" ]; do
      read_input_silent WEBUI_PASSWORD "    Web UI password (used to log in): "
      if [ -z "$WEBUI_PASSWORD" ]; then
        warn "Password cannot be empty. Leaving it blank is not supported."
      else
        read_input_silent WEBUI_PASSWORD_CONFIRM "    Confirm password: "
        if [ "$WEBUI_PASSWORD" != "$WEBUI_PASSWORD_CONFIRM" ]; then
          warn "Passwords do not match. Try again."
          WEBUI_PASSWORD=""
        fi
      fi
    done
  else
    ok "Using WEBUI_PASSWORD from the environment"
  fi
  SECRET_KEY="$(random_secret)"
}

write_env_file() {
  # Writes .env from an array of KEY=VALUE lines passed on stdin.
  local envpath="$DIR/.env"
  info "Writing $envpath"
  cat > "$envpath"
  chmod 600 "$envpath" 2>/dev/null || true
}

ensure_docker() {
  if ! has_cmd docker || ! docker compose version >/dev/null 2>&1; then
    warn "Docker with the compose plugin is required but not installed."
    read_input ans "    Install Docker now? [y/N] "
    if [ "${ans:-n}" != "y" ] && [ "${ans:-n}" != "Y" ]; then
      die "Docker is required for this mode. Re-run after installing Docker."
    fi
    info "Installing Docker"
    if is_deb; then
      sudo apt-get update -qq
      sudo apt-get install -y -qq docker.io docker-compose-v2
    elif is_rpm; then
      sudo dnf install -y moby-engine docker-compose-plugin 2>/dev/null \
        || sudo dnf install -y moby-engine || \
        warn "Could not auto-install Docker. Install it manually and re-run."
    elif is_arch; then
      sudo pacman -S --noconfirm --needed docker docker-compose 2>/dev/null \
        || sudo pacman -S --noconfirm --needed docker
    else
      die "Unsupported distro for automatic Docker install. Install Docker manually."
    fi
  fi

  if ! docker compose version >/dev/null 2>&1; then
    die "Docker compose plugin is missing. Install docker-compose and re-run."
  fi
  if ! docker info >/dev/null 2>&1; then
    warn "Docker daemon is not reachable. Starting the docker service..."
    sudo systemctl enable --now docker >/dev/null 2>&1 || true
    sleep 2
  fi
  docker info >/dev/null 2>&1 \
    || die "Docker daemon is not reachable. Start it (sudo systemctl start docker) and re-run."
  ok "Docker + compose plugin available and the daemon is running"
}

ensure_python_tools() {
  if is_deb; then
    pkg_install python3 python3-venv
  elif is_rpm; then
    pkg_install python3 python3-pip
  elif is_arch; then
    pkg_install python python-virtualenv
  fi
  has_cmd python3 || die "python3 is required"
}

# ── Mode 1: Docker ───────────────────────────────────────────────────────

mode_docker() {
  info "Mode 1: Docker (admin facade in a container)"
  ensure_docker
  ask_password
  write_env_file <<EOF
PORTAL_MODULES=nginx=http://host.docker.internal:8400,bind=http://host.docker.internal:5000
SERVICE_REGISTRY_FILE=/data/services.json
WEBUI_PASSWORD=$WEBUI_PASSWORD
SECRET_KEY=$SECRET_KEY
WEBUI_PORT=8080
BACKEND_TIMEOUT=5
EOF

  info "Starting the admin facade container (pulls the image on first run)"
  docker compose up -d
  ok "Deployed. Open http://localhost:8080"
  ok "The facade proxies the backends on 8400 (nginx-webui) and 5000 (bind9-webui)."
}

# ── Mode 2: Manual (all on host) ─────────────────────────────────────────

mode_manual() {
  info "Mode 2: Manual install (admin facade on this machine)"
  ensure_python_tools

  info "Setting up Python venv"
  python3 -m venv "$DIR/venv"
  "$DIR/venv/bin/pip" install -q -r "$DIR/requirements.txt"
  ok "Dependencies installed"

  ask_password
  info "Writing credentials to /etc/webui.env"
  local envout="/etc/webui.env"
  sudo tee "$envout" >/dev/null <<EOF
PORTAL_MODULES=nginx=http://127.0.0.1:8400,bind=http://127.0.0.1:5000
SERVICE_REGISTRY_FILE=$DIR/services.json
WEBUI_PASSWORD=$WEBUI_PASSWORD
SECRET_KEY=$SECRET_KEY
BACKEND_TIMEOUT=5
EOF
  sudo chmod 600 "$envout"

  info "Installing systemd service"
  {
    echo "[Unit]"
    echo "Description=Web UI Admin (dashboard for bind9-webui / nginx-webui)"
    echo "After=network-online.target"
    echo "Wants=network-online.target"
    echo ""
    echo "[Service]"
    echo "Type=simple"
    echo "User=root"
    echo "WorkingDirectory=$DIR"
    echo "ExecStart=$DIR/venv/bin/python3 app.py"
    echo "EnvironmentFile=-/etc/webui.env"
    echo "Restart=on-failure"
    echo "RestartSec=3"
    echo ""
    echo "[Install]"
    echo "WantedBy=multi-user.target"
  } | sudo tee /etc/systemd/system/webui.service >/dev/null

  sudo systemctl daemon-reload
  sudo systemctl enable webui
  sudo systemctl restart webui
  ok "Deployed. Open http://localhost:8080"
  ok "Manage with: sudo systemctl status webui"
}

# ── Main menu / flags ────────────────────────────────────────────────────

show_menu() {
  echo ""
  echo "Select how you want to run the Web UI Admin facade:"
  echo ""
  echo "  1) Docker   - admin facade in a container (recommended)"
  echo "  2) Manual   - admin facade installed directly on this machine"
  echo ""
  while :; do
    read_input choice "Enter your choice [1-2]: "
    case "$choice" in
      1) mode_docker; return;;
      2) mode_manual; return;;
      *) warn "Please choose 1 or 2.";;
    esac
  done
}

do_check() {
  echo "── System check ─────────────────────────────"
  echo "Distro        : $OS_NAME ($OS_ID)"
  echo "Package tool  : $(is_deb && echo 'apt' || (is_rpm && echo 'rpm/dnf' || (is_arch && echo 'pacman' || echo 'unknown')))"
  echo ""
  if has_cmd docker && docker compose version >/dev/null 2>&1; then
    echo "Docker+compose: available"
  else
    echo "Docker+compose: missing"
  fi
  if has_cmd python3; then
    echo "python3       : $(command -v python3)"
  else
    echo "python3       : missing"
  fi
  echo ""
}

case "${1:-}" in
  --check|-c) do_check; exit 0;;
  --help|-h)
    sed -n '1,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0;;
  "")
    if [ "$(id -u)" -eq 0 ]; then
      warn "Running as root. Prefer running as a normal sudo user on some distros."
    fi
    show_menu
    echo ""
    echo "Done!"
    ;;
  *) echo "Unknown option: $1 (use --help)"; exit 1;;
esac