import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import formbody from '@fastify/formbody';
import fastifyStatic from '@fastify/static';
import dotenv from 'dotenv';
import axios from 'axios';
import pty from 'node-pty';
import si from 'systeminformation';

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = Fastify({ logger: true });
const execFileAsync = promisify(execFile);
await app.register(websocket);
await app.register(formbody);
await app.register(fastifyStatic, { root: path.join(__dirname, 'static'), prefix: '/static/' });

const PASSWORD = process.env.DASHBOARD_PASSWORD || 'change-me';
const REFRESH = Number(process.env.REFRESH_SECONDS || 5);
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8787);
const TG_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const ALLOWED_TG_USER_ID = String(process.env.ALLOWED_TG_USER_ID || '').trim();
const BOT_PUBLIC_URL = String(process.env.BOT_PUBLIC_URL || process.env.PUBLIC_URL || '').trim();
const TERMINAL_PIN = String(process.env.TERMINAL_PIN || '').trim();
const TERMINAL_PASSWORD_FALLBACK = String(process.env.TERMINAL_PASSWORD_FALLBACK || 'false').toLowerCase() === 'true';
const terminalSessions = new Set();

function parseTargets() {
  const out = [{ id: 'local', name: process.env.VPS_LOCAL_NAME || 'Local VPS', type: 'local' }];
  try {
    const raw = process.env.VPS_TARGETS?.trim();
    if (!raw) return out;
    const arr = JSON.parse(raw);
    for (const x of arr) {
      if (!x?.id || !x?.url) continue;
      out.push({ id: String(x.id), name: x.name || x.id, type: 'remote', url: String(x.url).replace(/\/$/, ''), password: x.password || '' });
    }
  } catch {}
  return out;
}
const TARGETS = parseTargets();

async function renderTemplate(name, data = {}) {
  let html = await fs.readFile(path.join(__dirname, 'templates', name), 'utf8');
  html = html.replaceAll('<%= it.refresh %>', String(data.refresh ?? ''));
  html = html.replaceAll('<%= it.auto || "" %>', String(data.auto ?? ''));
  return html;
}

async function telegram(method, body) {
  if (!TG_TOKEN) return null;
  const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) {
    const hint = data.error_code === 404 ? 'TELEGRAM_BOT_TOKEN salah/tidak lengkap. Ambil ulang dari @BotFather.' : data.description;
    throw new Error(`${method}: ${hint}`);
  }
  return data.result;
}

async function setupTelegramMiniApp() {
  if (!TG_TOKEN) {
    app.log.warn('TELEGRAM_BOT_TOKEN kosong, skip Telegram Mini App setup');
    return;
  }
  if (!BOT_PUBLIC_URL) {
    app.log.warn('BOT_PUBLIC_URL/PUBLIC_URL kosong, skip Telegram Mini App setup');
    return;
  }
  app.log.info(`Setting Telegram Mini App menu to ${BOT_PUBLIC_URL}`);
  await telegram('setMyCommands', { commands: [{ command: 'start', description: 'Open VPS dashboard' }] });
  await telegram('setChatMenuButton', { menu_button: { type: 'web_app', text: 'VPS', web_app: { url: BOT_PUBLIC_URL } } });
  app.log.info(`Telegram Mini App menu set to ${BOT_PUBLIC_URL}`);
}

function unauthorized(reply) {
  return reply.header('WWW-Authenticate', 'Basic realm="vps-monitor"').code(401).send('Unauthorized');
}

function basicAuthOk(req) {
  const raw = req.headers.authorization || '';
  if (!raw.startsWith('Basic ')) return false;
  try {
    const decoded = Buffer.from(raw.slice(6), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    return idx >= 0 && decoded.slice(idx + 1) === PASSWORD;
  } catch {
    return false;
  }
}

function verifyTelegramInitData(initData) {
  if (!TG_TOKEN || !initData) return false;
  const params = new URLSearchParams(initData);
  const recvHash = params.get('hash') || '';
  params.delete('hash');
  if (!recvHash) return false;
  const dataCheck = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(TG_TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(dataCheck).digest('hex');
  if (calc.length !== recvHash.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(recvHash))) return false;
  try {
    const user = JSON.parse(params.get('user') || '{}');
    return String(user.id || '') === ALLOWED_TG_USER_ID;
  } catch {
    return false;
  }
}

function auth(req) {
  if (PASSWORD === 'change-me' || !PASSWORD) return false;
  if (basicAuthOk(req)) return true;
  const h = req.headers['x-dashboard-password'];
  if (h && h === PASSWORD) return true;
  const cookie = req.headers.cookie || '';
  if (cookie.includes(`vpsmon_auth=${PASSWORD}`)) return true;
  const tg = req.headers['x-telegram-init-data'] || req.query?.tg || '';
  return verifyTelegramInitData(String(tg));
}

function wsAuth(req) {
  if (verifyTelegramInitData(String(req.query?.tg || ''))) return true;
  if (TERMINAL_PASSWORD_FALLBACK && PASSWORD && req.query?.pw === PASSWORD) return true;
  return !!TERMINAL_PIN && req.query?.pin === TERMINAL_PIN;
}

async function topProcesses(procs) {
  try {
    const { stdout } = await execFileAsync('ps', ['-eo', 'pid,pcpu,pmem,comm', '--sort=-pcpu'], { timeout: 3000, maxBuffer: 1024 * 1024 });
    const rows = stdout.trim().split('\n').slice(1, 9).map(line => {
      const [pid, cpu, mem, ...cmd] = line.trim().split(/\s+/);
      return { pid, cpu: Number(cpu || 0).toFixed(1), mem: Number(mem || 0).toFixed(1), cmd: (cmd.join(' ') || 'proc').slice(0, 80) };
    });
    if (rows.length) return rows;
  } catch {}
  return (procs?.list || [])
    .map(p => ({ pid: String(p.pid), cpu: Number(p.pcpu || p.cpu || 0), mem: Number(p.pmem || 0), cmd: String(p.command || p.name || 'proc') }))
    .filter(p => p.cpu > 0 || p.mem > 0)
    .sort((a, b) => b.cpu - a.cpu)
    .slice(0, 8)
    .map(p => ({ ...p, cpu: p.cpu.toFixed(1), mem: p.mem.toFixed(1) }));
}

async function serviceStatus() {
  const names = ['telegram-vps-monitor', 'vps-node-agent', 'nginx', 'ssh', 'docker'];
  const out = [];
  for (const name of names) {
    try {
      const { stdout } = await execFileAsync('systemctl', ['is-active', name], { timeout: 1500 });
      out.push({ name, status: stdout.trim() === 'active' ? 'ok' : 'warn' });
    } catch {
      out.push({ name, status: 'down' });
    }
  }
  return out;
}

async function localMetrics() {
  const [load, mem, fsSize, cpu, procs] = await Promise.all([
    si.currentLoad(), si.mem(), si.fsSize(), si.cpu(), si.processes()
  ]);
  const cores = os.cpus().length || cpu.cores || 1;
  const [load1, load5, load15] = os.loadavg();
  const disk = fsSize.find(d => d.mount === '/') || fsSize.find(d => d.mount?.startsWith('/')) || fsSize[0] || { size: 1, used: 0, available: 0 };
  const usedMem = Math.max(0, mem.total - mem.available);
  const rp = +(usedMem / mem.total * 100).toFixed(1);
  const dp = +(disk.used / disk.size * 100).toFixed(1);
  const cp = +load.currentLoad.toFixed(1);
  const lpc = +(load1 / cores).toFixed(2);
  const [top, services] = await Promise.all([topProcesses(procs), serviceStatus()]);
  return {
    ts: Math.floor(Date.now()/1000), host: os.hostname(), uptime_sec: os.uptime(), uptime: `${Math.floor(os.uptime()/86400)}d ${Math.floor((os.uptime()%86400)/3600)}h ${Math.floor((os.uptime()%3600)/60)}m`,
    health: { level: rp>=90||dp>=90?'danger':(rp>=75||dp>=75||lpc>=1.5?'warn':'ok'), label: rp>=90||dp>=90?'CRITICAL':(rp>=75||dp>=75||lpc>=1.5?'ATTENTION':'HEALTHY'), alerts: [] },
    cpu: { pct: cp, cores, load1: +load1.toFixed(2), load5: +load5.toFixed(2), load15: +load15.toFixed(2), load_per_core: lpc },
    ram: { total_gb: +(mem.total/1e9).toFixed(2), used_gb: +(usedMem/1e9).toFixed(2), avail_gb: +(mem.available/1e9).toFixed(2), pct: rp },
    swap: { total_gb: +(mem.swaptotal/1e9).toFixed(2), used_gb: +(mem.swapused/1e9).toFixed(2), free_gb: +(mem.swapfree/1e9).toFixed(2), pct: mem.swaptotal ? +(mem.swapused/mem.swaptotal*100).toFixed(1) : 0 },
    disk: { total_gb: +(disk.size/1e9).toFixed(2), used_gb: +(disk.used/1e9).toFixed(2), free_gb: +(disk.available/1e9).toFixed(2), pct: dp },
    top, services
  };
}

app.get('/', async (_req, reply) => reply.type('text/html').send(await renderTemplate('index.html', { refresh: REFRESH })));
app.get('/terminal', async (_req, reply) => reply.type('text/html').send(await renderTemplate('terminal.html', { auto: '' })));
app.get('/claude', async (_req, reply) => reply.type('text/html').send(await renderTemplate('terminal.html', { auto: 'claude' })));
app.get('/codex', async (_req, reply) => reply.type('text/html').send(await renderTemplate('terminal.html', { auto: 'codex' })));

app.get('/api/vps', async (req, reply) => {
  if (!auth(req, reply)) return unauthorized(reply);
  return TARGETS.map(t => ({ id: t.id, name: t.name, type: t.type }));
});

app.get('/api/metrics', async (req, reply) => {
  if (!auth(req, reply)) return unauthorized(reply);
  const vps = req.query?.vps || 'local';
  const t = TARGETS.find(x => x.id === vps);
  if (!t) return reply.code(404).send({ error: 'vps_not_found' });
  if (t.type === 'local') return localMetrics();
  try {
    const res = await axios.get(`${t.url}/api/metrics`, { headers: { 'X-Dashboard-Password': t.password || '' }, timeout: 5000 });
    return res.data;
  } catch (e) {
    return reply.code(502).send({ error: 'remote_unreachable', detail: e.message });
  }
});

app.post('/login', async (req, reply) => {
  const pw = req.body?.password || '';
  if (pw !== PASSWORD) return reply.code(403).send('Bad password');
  reply.header('set-cookie', `vpsmon_auth=${PASSWORD}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`);
  return 'OK';
});

app.get('/api/telegram/setup', async (req, reply) => {
  if (!auth(req)) return unauthorized(reply);
  await setupTelegramMiniApp();
  return { ok: true, url: BOT_PUBLIC_URL || null };
});

app.get('/ws/terminal', { websocket: true }, (socket, req) => {
  if (!wsAuth(req)) {
    socket.send('\r\nUnauthorized\r\n');
    socket.close();
    return;
  }
  const cmd = req.query?.cmd;
  const argv = cmd === 'claude' ? ['claude'] : cmd === 'codex' ? ['codex'] : ['/bin/bash', '-l'];
  const shell = pty.spawn(argv[0], argv.slice(1), { name: 'xterm-256color', cols: 120, rows: 40, cwd: process.env.HOME || '/tmp', env: process.env });
  terminalSessions.add(shell);
  socket.send('Connected\r\n');
  shell.onData(d => socket.send(d));
  shell.onExit(() => terminalSessions.delete(shell));
  socket.on('message', msg => {
    const s = msg.toString();
    if (s.startsWith('__resize__:')) {
      const [,c,r] = s.split(':');
      shell.resize(Number(c)||120, Number(r)||40);
      return;
    }
    shell.write(s);
  });
  socket.on('close', () => {
    terminalSessions.delete(shell);
    shell.kill();
  });
});

async function shutdown(signal) {
  app.log.info(`${signal} received, shutting down`);
  for (const shell of terminalSessions) {
    try { shell.kill(); } catch {}
  }
  await app.close();
  process.exit(0);
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

await setupTelegramMiniApp().catch(err => app.log.warn(err.message));
await app.listen({ host: HOST, port: PORT });
