import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Fastify from 'fastify';
import dotenv from 'dotenv';
import si from 'systeminformation';

dotenv.config();
const app = Fastify({ logger: true });
const execFileAsync = promisify(execFile);
const PASS = process.env.NODE_PASSWORD || process.env.DASHBOARD_PASSWORD || 'change-me';
const HOST = process.env.NODE_HOST || process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.NODE_PORT || process.env.PORT || 8788);

function auth(req){
  const h = req.headers['x-dashboard-password'];
  return !!h && h === PASS;
}

async function topProcesses(procs) {
  const fromSi = (procs?.list || [])
    .map(p => ({ pid: String(p.pid), cpu: Number(p.pcpu || p.cpu || 0), mem: Number(p.pmem || 0), cmd: String(p.command || p.name || 'proc') }))
    .filter(p => p.cpu > 0 || p.mem > 0)
    .sort((a, b) => b.cpu - a.cpu)
    .slice(0, 8)
    .map(p => ({ ...p, cpu: p.cpu.toFixed(1), mem: p.mem.toFixed(1) }));
  if (fromSi.length) return fromSi;
  try {
    const { stdout } = await execFileAsync('ps', ['-eo', 'pid,pcpu,pmem,args', '--sort=-pcpu'], { timeout: 3000, maxBuffer: 1024 * 1024 });
    return stdout.trim().split('\n').slice(1, 9).map(line => {
      const [pid, cpu, mem, ...cmd] = line.trim().split(/\s+/);
      return { pid, cpu: Number(cpu || 0).toFixed(1), mem: Number(mem || 0).toFixed(1), cmd: (cmd.join(' ') || 'proc').slice(0, 80) };
    });
  } catch {
    return [];
  }
}

async function serviceStatus() {
  const names = ['vps-node-agent', 'nginx', 'ssh', 'docker'];
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

app.get('/health', async ()=>({ok:true,host:os.hostname(),ts:Math.floor(Date.now()/1000)}));
app.get('/api/metrics', async (req, reply)=>{
  if(!auth(req)) return reply.code(401).send('Unauthorized');
  const [load, mem, fsSize, cpu, procs] = await Promise.all([si.currentLoad(), si.mem(), si.fsSize(), si.cpu(), si.processes()]);
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
    disk: { total_gb: +(disk.size/1e9).toFixed(2), used_gb: +(disk.used/1e9).toFixed(2), free_gb: +(disk.available/1e9).toFixed(2), pct: dp },
    top, services
  };
});

app.listen({host:HOST, port:PORT});
