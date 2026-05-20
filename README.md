# Telegram VPS Monitor Mini App (Fastify)

Dashboard + terminal VPS via Telegram Mini App, multi-VPS (panel + node-only).

## Stack

- Node.js 20+
- Fastify
- @fastify/websocket + node-pty
- systeminformation
- Vanilla HTML/CSS/JS + xterm.js

## Mode arsitektur

- Panel/Main VPS: `server.js` (UI + API + terminal + agregasi node)
- Node-only VPS: `node_agent.js` (endpoint metrics ringan)

## Install cepat

Panel:

```bash
curl -fsSL https://raw.githubusercontent.com/zcuss/realtime-telegram-vps-monitor-terminal-ai-miniapp/Main/scripts/install.sh | bash
```

Node-only:

```bash
curl -fsSL https://raw.githubusercontent.com/zcuss/realtime-telegram-vps-monitor-terminal-ai-miniapp/Main/scripts/install.sh | INSTALL_MODE=node bash
```

Uninstall panel:

```bash
curl -fsSL https://raw.githubusercontent.com/zcuss/realtime-telegram-vps-monitor-terminal-ai-miniapp/Main/scripts/uninstall.sh | bash
```

Uninstall node:

```bash
curl -fsSL https://raw.githubusercontent.com/zcuss/realtime-telegram-vps-monitor-terminal-ai-miniapp/Main/scripts/uninstall.sh | bash -s -- node
```

## Install manual

```bash
git clone https://github.com/zcuss/realtime-telegram-vps-monitor-terminal-ai-miniapp.git
cd realtime-telegram-vps-monitor-terminal-ai-miniapp
npm install
cp .env.example .env
```

Run panel:

```bash
npm run start
```

Run node-only:

```bash
npm run start:node
```

## Konfigurasi `.env` minimum panel

```env
DASHBOARD_PASSWORD=CHANGE_ME
ALLOWED_TG_USER_ID=123456789
TELEGRAM_BOT_TOKEN=YOUR_BOT_TOKEN
HOST=127.0.0.1
PORT=8787
TERMINAL_PASSWORD_FALLBACK=true
VPS_LOCAL_NAME=Main VPS
VPS_TARGETS=[{"id":"node1","name":"Node 1","url":"http://IP_NODE_1:8788","password":"nodepass1"}]
```

## Konfigurasi `.env` minimum node-only

```env
NODE_PASSWORD=nodepass1
NODE_HOST=0.0.0.0
NODE_PORT=8788
```

## Endpoint

- `GET /` dashboard
- `GET /terminal` terminal
- `GET /claude` terminal auto Claude
- `GET /codex` terminal auto Codex
- `GET /api/vps` list target
- `GET /api/metrics?vps=local|nodeid`
- `WS /ws/terminal`
- Node-only: `GET /health`, `GET /api/metrics`

## systemd panel

`/etc/systemd/system/telegram-vps-monitor.service`

```ini
[Unit]
Description=Telegram VPS Monitor Fastify
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/telegram-vps-monitor-terminal-ai-miniapp
EnvironmentFile=/home/ubuntu/telegram-vps-monitor-terminal-ai-miniapp/.env
ExecStart=/usr/bin/npm run start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

## systemd node-only

`/etc/systemd/system/vps-node-agent.service`

```ini
[Unit]
Description=VPS Node Agent Fastify
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/telegram-vps-monitor-terminal-ai-miniapp
EnvironmentFile=/home/ubuntu/telegram-vps-monitor-terminal-ai-miniapp/.env
ExecStart=/usr/bin/npm run start:node
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

## Update

```bash
cd ~/telegram-vps-monitor-terminal-ai-miniapp
git pull origin Main
npm install
sudo systemctl restart telegram-vps-monitor
```

## Test node dari panel

```bash
curl -H "X-Dashboard-Password: nodepass1" http://IP_NODE_1:8788/api/metrics
```

## Telegram menu button

```bash
BOT_TOKEN=YOUR_BOT_TOKEN
URL=https://your-domain.example
curl -X POST "https://api.telegram.org/bot$BOT_TOKEN/setChatMenuButton" \
  -H "Content-Type: application/json" \
  -d "{\"menu_button\":{\"type\":\"web_app\",\"text\":\"VPS\",\"web_app\":{\"url\":\"$URL\"}}}"
```

## Catatan

- Wajib HTTPS untuk Telegram Mini App.
- Jangan commit `.env`.
- `ALLOWED_TG_USER_ID` wajib ID Telegram numerik milik user yang diizinkan.
- Terminal = akses shell penuh VPS.
