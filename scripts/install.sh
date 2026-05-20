#!/usr/bin/env bash
# Telegram VPS Monitor Mini App — one-command installer
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/zcuss/realtime-telegram-vps-monitor-terminal-ai-miniapp/Main/scripts/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/zcuss/realtime-telegram-vps-monitor-terminal-ai-miniapp/Main/scripts/install.sh | INSTALL_MODE=node bash
#
# Run as the user that will own the service (NOT root).
# Tested on: Ubuntu 22.04 / 24.04, Debian 12

set -euo pipefail

# ────────────────────────────────────────────────────────────
# Config
# ────────────────────────────────────────────────────────────
REPO_URL="https://github.com/zcuss/realtime-telegram-vps-monitor-terminal-ai-miniapp.git"
INSTALL_MODE="${INSTALL_MODE:-${1:-panel}}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/telegram-vps-monitor-terminal-ai-miniapp}"

if [[ "$INSTALL_MODE" == "node" || "$INSTALL_MODE" == "node-only" ]]; then
  INSTALL_MODE="node"
  SERVICE_NAME="vps-node-agent"
  DEFAULT_PORT="${NODE_PORT:-8788}"
  DEFAULT_HOST="${NODE_HOST:-0.0.0.0}"
else
  INSTALL_MODE="panel"
  SERVICE_NAME="telegram-vps-monitor"
  DEFAULT_PORT="${PORT:-8787}"
  DEFAULT_HOST="${HOST:-127.0.0.1}"
fi

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

upsert_env() {
  local key="$1" value="$2" file="$3"
  if grep -qE "^${key}=" "$file"; then
    sed -i "s|^${key}=.*$|${key}=${value}|" "$file"
  else
    echo "${key}=${value}" >> "$file"
  fi
}

# ────────────────────────────────────────────────────────────
# Pre-flight
# ────────────────────────────────────────────────────────────
step "Pre-flight checks"

if [[ "$EUID" -eq 0 ]]; then
  SUDO=""
  RUN_USER="root"
  warn "Running as root"
else
  SUDO="sudo"
  RUN_USER="$USER"
fi

require_cmd git
require_cmd curl
require_cmd openssl

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  warn "Node.js/npm missing, installing NodeSource 22.x"
  if [[ -n "$SUDO" ]]; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO -E bash -
    $SUDO apt-get install -y nodejs build-essential python3 make g++ >/dev/null
  else
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs build-essential python3 make g++ >/dev/null
  fi
fi
ok "Node $(node -v), npm $(npm -v)"

if [[ -n "$SUDO" ]] && ! $SUDO -n true 2>/dev/null; then
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
# Node deps
# ────────────────────────────────────────────────────────────
step "Installing Node dependencies"

npm install --omit=dev
ok "Dependencies installed"

# ────────────────────────────────────────────────────────────
# Configure .env
# ────────────────────────────────────────────────────────────
step "Configuring .env"

if [[ -f ".env" ]]; then
  warn ".env already exists — keeping it. Edit manually if needed: $INSTALL_DIR/.env"
else
  cp .env.example .env

  ask "Service host (bind address)" SVC_HOST "$DEFAULT_HOST"
  ask "Service port" SVC_PORT "$DEFAULT_PORT"

  if [[ "$INSTALL_MODE" == "node" ]]; then
    NODE_PW=$(random_password)
    upsert_env "NODE_PASSWORD" "$NODE_PW" .env
    upsert_env "NODE_HOST" "$SVC_HOST" .env
    upsert_env "NODE_PORT" "$SVC_PORT" .env
    upsert_env "HOST" "$SVC_HOST" .env
    upsert_env "PORT" "$SVC_PORT" .env
    chmod 600 .env
    ok ".env written (mode 600)"
    c_dim "    NODE_PASSWORD: $NODE_PW"
  else
    echo
    c_dim "Telegram bot setup:"
    c_dim "  1. Create a bot via @BotFather → get token"
    c_dim "  2. Message @userinfobot to get your numeric user ID"
    echo

    ask_secret "Telegram bot token (from @BotFather)" TG_TOKEN
    ask "Your Telegram numeric user ID" TG_USER_ID

    DASH_PW=$(random_password)

    upsert_env "DASHBOARD_PASSWORD" "$DASH_PW" .env
    upsert_env "ALLOWED_TG_USER_ID" "$TG_USER_ID" .env
    upsert_env "TELEGRAM_BOT_TOKEN" "$TG_TOKEN" .env
    upsert_env "TERMINAL_PASSWORD_FALLBACK" "false" .env
    upsert_env "HOST" "$SVC_HOST" .env
    upsert_env "PORT" "$SVC_PORT" .env
    chmod 600 .env
    ok ".env written (mode 600)"
    c_dim "    DASHBOARD_PASSWORD: $(printf '%s' "$DASH_PW" | head -c 6)... (saved to .env)"
  fi
fi

# ────────────────────────────────────────────────────────────
# systemd service
# ────────────────────────────────────────────────────────────
step "Installing systemd service"

SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
NODE_BIN="$(command -v node)"
ENV_FILE="$INSTALL_DIR/.env"

if [[ "$INSTALL_MODE" == "node" ]]; then
  ENV_PORT=$(grep -E '^NODE_PORT=' "$ENV_FILE" | head -1 | cut -d= -f2 | tr -d '"' || echo "$DEFAULT_PORT")
  ENV_HOST=$(grep -E '^NODE_HOST=' "$ENV_FILE" | head -1 | cut -d= -f2 | tr -d '"' || echo "$DEFAULT_HOST")
  SERVICE_DESC="VPS Node Agent Fastify"
  EXEC_START="$NODE_BIN node_agent.js"
else
  ENV_PORT=$(grep -E '^PORT=' "$ENV_FILE" | head -1 | cut -d= -f2 | tr -d '"' || echo "$DEFAULT_PORT")
  ENV_HOST=$(grep -E '^HOST=' "$ENV_FILE" | head -1 | cut -d= -f2 | tr -d '"' || echo "$DEFAULT_HOST")
  SERVICE_DESC="Telegram VPS Monitor Fastify"
  EXEC_START="$NODE_BIN start.js"
fi

if [[ -n "$SUDO" ]]; then
  $SUDO tee "$SERVICE_FILE" >/dev/null <<EOF
[Unit]
Description=$SERVICE_DESC
After=network.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$INSTALL_DIR
ExecStart=$EXEC_START
Restart=always
RestartSec=5
KillMode=mixed
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

  $SUDO systemctl daemon-reload
  $SUDO systemctl enable "$SERVICE_NAME" >/dev/null 2>&1 || true
  $SUDO systemctl restart "$SERVICE_NAME"
else
  tee "$SERVICE_FILE" >/dev/null <<EOF
[Unit]
Description=$SERVICE_DESC
After=network.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$INSTALL_DIR
ExecStart=$EXEC_START
Restart=always
RestartSec=5
KillMode=mixed
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME" >/dev/null 2>&1 || true
  systemctl restart "$SERVICE_NAME"
fi
ok "Service $SERVICE_NAME enabled + started"

# ────────────────────────────────────────────────────────────
# Verify
# ────────────────────────────────────────────────────────────
step "Verifying"

sleep 3

if systemctl is-active --quiet "$SERVICE_NAME"; then
  ok "systemd: active"
else
  if [[ -n "$SUDO" ]]; then
    err "Service failed to start. Check: sudo journalctl -u $SERVICE_NAME -n 50 --no-pager"
  else
    err "Service failed to start. Check: journalctl -u $SERVICE_NAME -n 50 --no-pager"
  fi
fi

if [[ "$INSTALL_MODE" == "node" ]]; then
  HEALTH_URL="http://127.0.0.1:${ENV_PORT}/health"
  OK_CODES="^(200)$"
else
  HEALTH_URL="http://${ENV_HOST}:${ENV_PORT}/"
  OK_CODES="^(200|401)$"
fi

HEALTH_CODE=$(curl -s -o /dev/null -w '%{http_code}' "$HEALTH_URL" || echo "000")
if [[ "$HEALTH_CODE" =~ $OK_CODES ]]; then
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
echo "  Mode:       $INSTALL_MODE"
echo "  Service:    $SERVICE_NAME (systemctl status $SERVICE_NAME)"
echo "  Local URL:  http://${ENV_HOST}:${ENV_PORT}"
echo "  Install:    $INSTALL_DIR"
if [[ -n "$SUDO" ]]; then
  echo "  Logs:       sudo journalctl -u $SERVICE_NAME -f"
else
  echo "  Logs:       journalctl -u $SERVICE_NAME -f"
fi
echo
c_yellow "  Next steps:"
if [[ "$INSTALL_MODE" == "node" ]]; then
  NODE_PW_SHOW=$(grep -E '^NODE_PASSWORD=' "$INSTALL_DIR/.env" | head -1 | cut -d= -f2-)
  echo "  1. Add this node to Main Panel VPS_TARGETS:"
  echo "       {\"id\":\"node1\",\"name\":\"Node 1\",\"url\":\"http://THIS_NODE_IP:${ENV_PORT}\",\"password\":\"$NODE_PW_SHOW\"}"
  echo "  2. Test from Main VPS:"
  echo "       curl -H 'X-Dashboard-Password: $NODE_PW_SHOW' http://THIS_NODE_IP:${ENV_PORT}/api/metrics"
else
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
fi
echo
if [[ -n "$SUDO" ]]; then
  c_dim "  Update later: cd $INSTALL_DIR && git pull && sudo systemctl restart $SERVICE_NAME"
else
  c_dim "  Update later: cd $INSTALL_DIR && git pull && systemctl restart $SERVICE_NAME"
fi
echo
