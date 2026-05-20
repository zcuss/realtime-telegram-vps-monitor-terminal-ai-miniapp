import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import formbody from '@fastify/formbody';
import fastifyStatic from '@fastify/static';
import fastifyView from '@fastify/view';
import dotenv from 'dotenv';
import eta from 'eta';
import axios from 'axios';
import pty from 'node-pty';
import si from 'systeminformation';

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = Fastify({ logger: true });
await app.register(websocket);
await app.register(formbody);
await app.register(fastifyStatic, { root: path.join(__dirname, 'static'), prefix: '/static/' });
await app.register(fastifyView, { engine: { eta }, root: path.join(__dirname, 'templates') });

const PASSWORD = process.env.DASHBOARD_PASSWORD || 'change-me';
const REFRESH = Number(process.env.REFRESH_SECONDS || 5);
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8787);
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const ALLOWED_TG_USER_ID = String(process.env.ALLOWED_TG_USER_ID || '');
const TERMINAL_PIN = process.env.TERMINAL_PIN || '';
const TERMINAL_PASSWORD_FALLBACK = String(process.env.TERMINAL_PASSWORD_FALLBACK || 'false').toLowerCase() === 'true';

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

function unauthorized(reply) { return reply.code(401).send('Unauthorized'); }

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
  const h = req.headers['x-dashboard-password'];
  if (h && h === PASSWORD) return true;
  const cookie = req.headers.cookie || '';
  if (cookie.includes(`vpsmon_auth=${PASSWORD}`)) return true;
  const tg = req.headers['x-telegram-init-data'] || req.query?.tg || '';
  return verifyTelegramInitData(String(tg));
}

function wsAuth(req) {
  const pinOk = !TERMINAL_PIN || req.query?.pin === TERMINAL_PIN;
  if (!pinOk) return false;
  if (verifyTelegramInitData(String(req.query?.tg || ''))) return true;
  return TERMINAL_PASSWORD_FALLBACK && PASSWORD && req.query?.pw === PASSWORD;
}

async function localMetrics() {
  const [load, mem, fsSize, cpu, procs] = await Promise.all([
    si.currentLoad(), si.mem(), si.fsSize(), si.cpu(), si.processes()
  ]);
  const disk = fsSize[0] || { size: 1, used: 0, available: 0 };
  const rp = +(mem.used / mem.total * 100).toFixed(1);
  const dp = +(disk.used / disk.size * 100).toFixed(1);
  const cp = +load.currentLoad.toFixed(1);
  const lpc = +(load.avgLoad / (cpu.cores || 1)).toFixed(2);
  return {
    ts: Math.floor(Date.now()/1000), host: os.hostname(), uptime_sec: os.uptime(), uptime: `${Math.floor(os.uptime()/86400)}d ${Math.floor((os.uptime()%86400)/3600)}h ${Math.floor((os.uptime()%3600)/60)}m`,
    health: { level: rp>=90||dp>=90?'danger':(rp>=75||dp>=75||lpc>=2?'warn':'ok'), label: rp>=90||dp>=90?'CRITICAL':(rp>=75||dp>=75||lpc>=2?'ATTENTION':'HEALTHY'), alerts: [] },
    cpu: { pct: cp, cores: cpu.cores || 1, load1: +load.avgLoad.toFixed(2), load5: +load.avgLoad.toFixed(2), load15: +load.avgLoad.toFixed(2), load_per_core: lpc },
    ram: { total_gb: +(mem.total/1e9).toFixed(2), used_gb: +(mem.used/1e9).toFixed(2), avail_gb: +(mem.available/1e9).toFixed(2), pct: rp },
    disk: { total_gb: +(disk.size/1e9).toFixed(2), used_gb: +(disk.used/1e9).toFixed(2), free_gb: +(disk.available/1e9).toFixed(2), pct: dp },
    top: procs.list.slice(0,8).map(p=>({pid:String(p.pid),cpu:String(p.pcpu||0),mem:String(p.pmem||0),cmd:p.name||p.command||'proc'})), services: []
  };
}

app.get('/', async (_req, reply) => reply.view('index.html', { refresh: REFRESH }));
app.get('/terminal', async (_req, reply) => reply.view('terminal.html', { auto: '' }));
app.get('/claude', async (_req, reply) => reply.view('terminal.html', { auto: 'claude' }));
app.get('/codex', async (_req, reply) => reply.view('terminal.html', { auto: 'codex' }));

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

app.get('/ws/terminal', { websocket: true }, (socket, req) => {
  if (!wsAuth(req)) {
    socket.send('\r\nUnauthorized\r\n');
    socket.close();
    return;
  }
  const cmd = req.query?.cmd;
  const argv = cmd === 'claude' ? ['claude'] : cmd === 'codex' ? ['codex'] : ['/bin/bash', '-l'];
  const shell = pty.spawn(argv[0], argv.slice(1), { name: 'xterm-256color', cols: 120, rows: 40, cwd: process.env.HOME || '/tmp', env: process.env });
  socket.send('Connected\r\n');
  shell.onData(d => socket.send(d));
  socket.on('message', msg => {
    const s = msg.toString();
    if (s.startsWith('__resize__:')) {
      const [,c,r] = s.split(':');
      shell.resize(Number(c)||120, Number(r)||40);
      return;
    }
    shell.write(s);
  });
  socket.on('close', () => shell.kill());
});

app.listen({ host: HOST, port: PORT });
