#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-panel}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/telegram-vps-monitor-terminal-ai-miniapp}"

if [[ "$MODE" == "node" || "$MODE" == "node-only" ]]; then
  MODE="node"
  SERVICE_NAME="vps-node-agent"
else
  MODE="panel"
  SERVICE_NAME="telegram-vps-monitor"
fi

SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

echo "[uninstall] mode=$MODE service=$SERVICE_NAME"

if systemctl list-unit-files | grep -q "^${SERVICE_NAME}.service"; then
  echo "[uninstall] stopping $SERVICE_NAME"
  sudo systemctl stop "$SERVICE_NAME" || true
  sudo systemctl disable "$SERVICE_NAME" || true
fi

if [[ -f "$SERVICE_FILE" ]]; then
  echo "[uninstall] removing service file $SERVICE_FILE"
  sudo rm -f "$SERVICE_FILE"
  sudo systemctl daemon-reload
fi

if [[ -d "$INSTALL_DIR" ]]; then
  read -rp "[uninstall] remove install dir '$INSTALL_DIR'? (y/N): " ans
  if [[ "$ans" =~ ^[Yy]$ ]]; then
    rm -rf "$INSTALL_DIR"
    echo "[uninstall] removed $INSTALL_DIR"
  else
    echo "[uninstall] skipped removing $INSTALL_DIR"
  fi
fi

echo "[uninstall] done"
