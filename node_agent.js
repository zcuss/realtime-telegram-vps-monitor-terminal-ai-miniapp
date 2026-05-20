import os from 'node:os';
import Fastify from 'fastify';
import dotenv from 'dotenv';
import si from 'systeminformation';

dotenv.config();
const app = Fastify({ logger: true });
const PASS = process.env.NODE_PASSWORD || process.env.DASHBOARD_PASSWORD || 'change-me';
const HOST = process.env.NODE_HOST || process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.NODE_PORT || process.env.PORT || 8788);

function auth(req){
  const h = req.headers['x-dashboard-password'];
  return !!h && h === PASS;
}

app.get('/health', async ()=>({ok:true,host:os.hostname(),ts:Math.floor(Date.now()/1000)}));
app.get('/api/metrics', async (req, reply)=>{
  if(!auth(req)) return reply.code(401).send('Unauthorized');
  const [load, mem, fsSize, cpu] = await Promise.all([si.currentLoad(), si.mem(), si.fsSize(), si.cpu()]);
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
    top: [], services: []
  };
});

app.listen({host:HOST, port:PORT});
