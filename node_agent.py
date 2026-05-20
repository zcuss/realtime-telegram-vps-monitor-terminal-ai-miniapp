import os, time, shutil, subprocess, socket, json
from functools import wraps
from flask import Flask, jsonify, request, Response

app = Flask(__name__)
NODE_PASSWORD = os.getenv('NODE_PASSWORD') or os.getenv('DASHBOARD_PASSWORD', 'change-me')
NODE_HOST = os.getenv('NODE_HOST') or os.getenv('HOST', '0.0.0.0')
NODE_PORT = int(os.getenv('NODE_PORT') or os.getenv('PORT', '8788'))


def require_node_auth(fn):
    @wraps(fn)
    def wrap(*args, **kwargs):
        if NODE_PASSWORD in ('', 'change-me'):
            return Response('Node password not configured', 503)
        auth = request.authorization
        header_pw = request.headers.get('X-Dashboard-Password', '')
        if header_pw == NODE_PASSWORD or (auth and auth.password == NODE_PASSWORD):
            return fn(*args, **kwargs)
        return Response('Unauthorized', 401)
    return wrap


def read_kv(path):
    out = {}
    with open(path) as f:
        for line in f:
            if ':' in line:
                k, v = line.split(':', 1)
                out[k] = v.strip()
    return out


def cpu_times():
    vals = list(map(int, open('/proc/stat').readline().split()[1:]))
    idle = vals[3] + vals[4]
    total = sum(vals)
    return idle, total


_last_cpu = cpu_times()


def cpu_pct():
    global _last_cpu
    idle, total = cpu_times()
    last_idle, last_total = _last_cpu
    _last_cpu = (idle, total)
    delta_total = total - last_total
    delta_idle = idle - last_idle
    return round((1 - delta_idle / delta_total) * 100, 1) if delta_total else 0


def fmt_uptime(sec):
    d = int(sec // 86400)
    h = int(sec % 86400 // 3600)
    m = int(sec % 3600 // 60)
    return f'{d}d {h}h {m}m'


def level(p):
    return 'danger' if p >= 90 else 'warn' if p >= 75 else 'ok'


def top_processes(limit=8):
    rows = []
    try:
        out = subprocess.check_output(
            ['ps', '-eo', 'pid,pcpu,pmem,comm', '--sort=-pcpu'],
            text=True,
            timeout=2,
        ).splitlines()[1:limit + 1]
        for line in out:
            parts = line.split(None, 3)
            if len(parts) >= 4:
                rows.append({'pid': parts[0], 'cpu': parts[1], 'mem': parts[2], 'cmd': parts[3]})
    except Exception:
        pass
    return rows


def svc_status(name, cmd):
    try:
        r = subprocess.run(cmd, shell=True, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=4)
        txt = r.stdout.strip()
        return {
            'name': name,
            'ok': r.returncode == 0,
            'status': 'online' if r.returncode == 0 else 'issue',
            'detail': txt.split('\n')[0][:140] if txt else '',
        }
    except Exception as e:
        return {'name': name, 'ok': False, 'status': 'issue', 'detail': str(e)[:140]}


def service_checks():
    raw = os.getenv('NODE_SERVICE_CHECKS', '').strip()
    if not raw:
        return []
    try:
        checks = json.loads(raw)
        if not isinstance(checks, list):
            return []
        rows = []
        for item in checks:
            if not isinstance(item, dict):
                continue
            name = str(item.get('name') or '').strip()
            cmd = str(item.get('cmd') or '').strip()
            if name and cmd:
                rows.append(svc_status(name, cmd))
        return rows
    except Exception as e:
        return [{'name': 'NODE_SERVICE_CHECKS', 'ok': False, 'status': 'issue', 'detail': str(e)[:140]}]


def metrics():
    mem = read_kv('/proc/meminfo')
    mem_total = int(mem['MemTotal'].split()[0])
    mem_avail = int(mem['MemAvailable'].split()[0])
    mem_used = mem_total - mem_avail
    disk = shutil.disk_usage('/')
    load = os.getloadavg()
    cores = os.cpu_count() or 1
    uptime = float(open('/proc/uptime').read().split()[0])
    cp = cpu_pct()
    rp = round(mem_used / mem_total * 100, 1)
    dp = round(disk.used / disk.total * 100, 1)
    lpc = round(load[0] / cores, 2)
    services = service_checks()
    alerts = []
    if rp >= float(os.getenv('ALERT_RAM_PCT', '85')):
        alerts.append(f'RAM {rp}%')
    if dp >= float(os.getenv('ALERT_DISK_PCT', '85')):
        alerts.append(f'Disk {dp}%')
    if lpc >= float(os.getenv('ALERT_LOAD_PER_CORE', '2.0')):
        alerts.append(f'Load/core {lpc}')
    if services and not all(x['ok'] for x in services):
        alerts.append('Service issue')
    health = 'danger' if rp >= 90 or dp >= 90 else 'warn' if alerts else 'ok'
    return {
        'ts': int(time.time()),
        'host': socket.gethostname(),
        'uptime_sec': int(uptime),
        'uptime': fmt_uptime(uptime),
        'health': {'level': health, 'label': 'CRITICAL' if health == 'danger' else 'ATTENTION' if health == 'warn' else 'HEALTHY', 'alerts': alerts},
        'cpu': {'pct': cp, 'level': level(cp), 'cores': cores, 'load1': round(load[0], 2), 'load5': round(load[1], 2), 'load15': round(load[2], 2), 'load_per_core': lpc},
        'ram': {'total_gb': round(mem_total / 1024 / 1024, 2), 'used_gb': round(mem_used / 1024 / 1024, 2), 'avail_gb': round(mem_avail / 1024 / 1024, 2), 'pct': rp, 'level': level(rp)},
        'disk': {'total_gb': round(disk.total / 1e9, 2), 'used_gb': round(disk.used / 1e9, 2), 'free_gb': round(disk.free / 1e9, 2), 'pct': dp, 'level': level(dp)},
        'top': [x for x in top_processes() if x['cmd'] not in ('ps', 'head')],
        'services': services,
    }


@app.route('/health')
def health():
    return jsonify({'ok': True, 'host': socket.gethostname(), 'ts': int(time.time())})


@app.route('/api/metrics')
@require_node_auth
def api_metrics():
    return jsonify(metrics())


if __name__ == '__main__':
    app.run(host=NODE_HOST, port=NODE_PORT)
