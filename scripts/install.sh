#!/usr/bin/env bash
# Telegram VPS Monitor Mini App — one-command installer
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/zcuss/realtime-telegram-vps-monitor-terminal-ai-miniapp/Main/scripts/install.sh | bash
#
# Run as the user that will own the service (NOT root).
# Tested on: Ubuntu 22.04 / 24.04, Debian 12

set -euo pipefail

# ────────────────────────────────────────────────────────────
# Config
# ────────────────────────────────────────────────────────────
REPO_URL="https://github.com/zcuss/realtime-telegram-vps-monitor-terminal-ai-miniapp.git"
INSTALL_DIR="${INSTALL_DIR:-$HOME/telegram-vps-monitor-terminal-ai-miniapp}"
SERVICE_NAME="telegram-vps-monitor"
DEFAULT_PORT="${PORT:-8787}"
DEFAULT_HOST="${HOST:-127.0.0.1}"

# ────────────────────────────────────────────────────────────
# Helpers
# ────────────────────────────────────────────────────────────
c_blue()   { printf '\033[1;34m%s\033[0m\n' "$*"; }
c_green()  { printf '\033[1;32m%s\033[0m\n' "$*"; }
c_yellow() { printf '\033[1;33m%s\033[0m\n' "$*"; }
c_red()    { printf '\033[1;31m%s\033[0m\n' "$*"; }
c_dim()    { printf '\033[2m%s\033[0m\n' "$*"; }

step()  { echo; c_blue "▸ $*"; }
ok()    { c_green "  ✓ $*"; }
warn()  { c_yellow "  ⚠ $*"; }
err()   { c_red "  ✗ $*"; exit 1; }

ask() {
  local prompt="$1" var_name="$2" default="${3:-}"
  local value
  if [[ -n "$default" ]]; then
    read -rp "  $prompt [$default]: " value
    value="${value:-$default}"
  else
    read -rp "  $prompt: " value
  fi
  printf -v "$var_name" '%s' "$value"
}

ask_secret() {
  local prompt="$1" var_name="$2"
  local value
  read -rsp "  $prompt: " value
  echo
  printf -v "$var_name" '%s' "$value"
}

random_password() {
  # 32 chars, alphanumeric + safe special
  openssl rand -base64 32 2>/dev/null | tr -d '/+=' | head -c 32
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || err "Missing required command: $1. Install it and retry."
}

# ────────────────────────────────────────────────────────────
# Pre-flight
# ────────────────────────────────────────────────────────────
step "Pre-flight checks"

if [[ "$EUID" -eq 0 ]]; then
  err "Don't run as root. Use a normal user (e.g. ubuntu) — sudo will be requested when needed."
fi

require_cmd git
require_cmd python3
require_cmd curl
require_cmd openssl

PYV=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
PYV_MAJOR=$(echo "$PYV" | cut -d. -f1)
PYV_MINOR=$(echo "$PYV" | cut -d. -f2)
if [[ "$PYV_MAJOR" -lt 3 ]] || { [[ "$PYV_MAJOR" -eq 3 ]] && [[ "$PYV_MINOR" -lt 10 ]]; }; then
  err "Python >= 3.10 required, found $PYV"
fi
ok "Python $PYV"

if ! python3 -c 'import venv' 2>/dev/null; then
  warn "python3-venv missing, installing..."
  sudo apt-get update -qq && sudo apt-get install -y python3-venv >/dev/null
fi
ok "python3-venv available"

if ! sudo -n true 2>/dev/null; then
  warn "sudo will prompt for password during systemd setup"
fi

# ────────────────────────────────────────────────────────────
# Clone or update repo
# ────────────────────────────────────────────────────────────
step "Fetching code"

if [[ -d "$INSTALL_DIR/.git" ]]; then
  ok "Repo already exists at $INSTALL_DIR — pulling latest"
  (cd "$INSTALL_DIR" && git pull --ff-only origin Main >/dev/null)
else
  if [[ -e "$INSTALL_DIR" ]]; then
    err "$INSTALL_DIR exists but is not a git repo. Move it aside and retry."
  fi
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR" >/dev/null
  ok "Cloned to $INSTALL_DIR"
fi

cd "$INSTALL_DIR"

# ────────────────────────────────────────────────────────────
# Python venv + deps
# ────────────────────────────────────────────────────────────
step "Setting up Python environment"

if [[ ! -d ".venv" ]]; then
  python3 -m venv .venv
  ok "Created venv"
fi

# shellcheck disable=SC1091
source .venv/bin/activate
pip install --quiet --upgrade pip wheel
pip install --quiet -r requirements.txt
# Ensure gunicorn even if requirements.txt forgets it
pip install --quiet gunicorn
ok "Dependencies installed"

# ────────────────────────────────────────────────────────────
# Configure .env
# ────────────────────────────────────────────────────────────
step "Configuring .env"

if [[ -f ".env" ]]; then
  warn ".env already exists — keeping it. Edit manually if needed: $INSTALL_DIR/.env"
else
  cp .env.example .env

  echo
  c_dim "Telegram bot setup:"
  c_dim "  1. Create a bot via @BotFather → get token"
  c_dim "  2. Message @userinfobot to get your numeric user ID"
  echo

  ask_secret "Telegram bot token (from @BotFather)" TG_TOKEN
  ask "Your Telegram numeric user ID" TG_USER_ID
  ask "Service host (bind address)" SVC_HOST "$DEFAULT_HOST"
  ask "Service port" SVC_PORT "$DEFAULT_PORT"

  DASH_PW=$(random_password)
  TERM_FALLBACK_PW=$(random_password)

  # Write .env safely
  python3 - <<PY
import os, re
path = os.path.join("$INSTALL_DIR", ".env")
with open(path) as f:
    content = f.read()

updates = {
    "DASHBOARD_PASSWORD": "$DASH_PW",
    "ALLOWED_TG_USER_ID": "$TG_USER_ID",
    "TELEGRAM_BOT_TOKEN": "$TG_TOKEN",
    "TERMINAL_PASSWORD_FALLBACK": "$TERM_FALLBACK_PW",
    "HOST": "$SVC_HOST",
    "PORT": "$SVC_PORT",
}
for key, value in updates.items():
    pattern = re.compile(rf"^{re.escape(key)}=.*$", re.MULTILINE)
    if pattern.search(content):
        content = pattern.sub(f"{key}={value}", content)
    else:
        content += f"\n{key}={value}\n"

with open(path, "w") as f:
    f.write(content)
PY

  chmod 600 .env
  ok ".env written (mode 600)"
  c_dim "    DASHBOARD_PASSWORD: $(printf '%s' "$DASH_PW" | head -c 6)... (saved to .env)"
fi

# ────────────────────────────────────────────────────────────
# systemd service
# ────────────────────────────────────────────────────────────
step "Installing systemd service"

SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
GUNICORN_BIN="$INSTALL_DIR/.venv/bin/gunicorn"
ENV_FILE="$INSTALL_DIR/.env"

# Read PORT from .env so service binds to the configured port
ENV_PORT=$(grep -E '^PORT=' "$ENV_FILE" | head -1 | cut -d= -f2 | tr -d '"' || echo "$DEFAULT_PORT")
ENV_HOST=$(grep -E '^HOST=' "$ENV_FILE" | head -1 | cut -d= -f2 | tr -d '"' || echo "$DEFAULT_HOST")

sudo tee "$SERVICE_FILE" >/dev/null <<EOF
[Unit]
Description=Telegram VPS Monitor Mini App
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$GUNICORN_BIN -k gthread --threads 8 -b ${ENV_HOST}:${ENV_PORT} app:app
Restart=always
RestartSec=5
KillMode=mixed
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME" >/dev/null 2>&1 || true
sudo systemctl restart "$SERVICE_NAME"
ok "Service $SERVICE_NAME enabled + started"

# ────────────────────────────────────────────────────────────
# Verify
# ────────────────────────────────────────────────────────────
step "Verifying"

sleep 3

if systemctl is-active --quiet "$SERVICE_NAME"; then
  ok "systemd: active"
else
  err "Service failed to start. Check: sudo journalctl -u $SERVICE_NAME -n 50 --no-pager"
fi

HEALTH_CODE=$(curl -s -o /dev/null -w '%{http_code}' "http://${ENV_HOST}:${ENV_PORT}/" || echo "000")
if [[ "$HEALTH_CODE" =~ ^(200|401)$ ]]; then
  ok "HTTP responsive (code: $HEALTH_CODE)"
else
  warn "Unexpected HTTP code: $HEALTH_CODE — check service logs"
fi

# ────────────────────────────────────────────────────────────
# Done
# ────────────────────────────────────────────────────────────
echo
c_green "═══════════════════════════════════════════════════════════"
c_green "  ✓ Installation complete"
c_green "═══════════════════════════════════════════════════════════"
echo
echo "  Service:    $SERVICE_NAME (systemctl status $SERVICE_NAME)"
echo "  Local URL:  http://${ENV_HOST}:${ENV_PORT}"
echo "  Install:    $INSTALL_DIR"
echo "  Logs:       sudo journalctl -u $SERVICE_NAME -f"
echo
c_yellow "  Next steps:"
echo "  1. Expose via HTTPS (Cloudflare Tunnel recommended):"
echo "       cloudflared tunnel --url http://${ENV_HOST}:${ENV_PORT} --no-autoupdate"
echo
echo "  2. Set Telegram menu button to your HTTPS URL:"
echo "       BOT_TOKEN=\$(grep TELEGRAM_BOT_TOKEN $INSTALL_DIR/.env | cut -d= -f2)"
echo "       URL=https://your-domain.example"
echo "       curl -X POST \"https://api.telegram.org/bot\$BOT_TOKEN/setChatMenuButton\" \\"
echo "         -H 'Content-Type: application/json' \\"
echo "         -d '{\"menu_button\":{\"type\":\"web_app\",\"text\":\"VPS\",\"web_app\":{\"url\":\"'\$URL'\"}}}'"
echo
echo "  3. Open Telegram → tap VPS menu button → enjoy."
echo
c_dim "  Update later: cd $INSTALL_DIR && git pull && sudo systemctl restart $SERVICE_NAME"
echo
