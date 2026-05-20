import os, time, shutil, subprocess, socket, json, hmac, hashlib, urllib.parse
from functools import wraps
from flask import Flask, jsonify, render_template, request, Response
from flask_sock import Sock
import pty, select, fcntl, termios, struct, signal
from urllib.request import Request, urlopen

app = Flask(__name__)
sock = Sock(app)
PASSWORD = os.getenv('DASHBOARD_PASSWORD', 'change-me')
REFRESH_SECONDS = int(os.getenv('REFRESH_SECONDS', '5'))
ALLOWED_TG_USER_ID = os.getenv('ALLOWED_TG_USER_ID', '')
TERMINAL_PIN = os.getenv('TERMINAL_PIN', '')
TERMINAL_PASSWORD_FALLBACK = os.getenv('TERMINAL_PASSWORD_FALLBACK', 'false').lower() == 'true'


def parse_vps_targets():
    raw = os.getenv('VPS_TARGETS', '').strip()
    targets = [{'id': 'local', 'name': os.getenv('VPS_LOCAL_NAME', 'Local VPS'), 'type': 'local'}]
    if not raw:
        return targets
    try:
        arr = json.loads(raw)
        if isinstance(arr, list):
            for i, item in enumerate(arr, start=1):
                if not isinstance(item, dict):
                    continue
                vid = str(item.get('id') or f'vps{i}').strip()
                name = str(item.get('name') or vid).strip()
                url = str(item.get('url') or '').strip().rstrip('/')
                password = str(item.get('password') or '')
                if not vid or not url:
                    continue
                targets.append({'id': vid, 'name': name, 'type': 'remote', 'url': url, 'password': password})
    except Exception as e:
        print(f"[VPS] Invalid VPS_TARGETS: {e}")
    return targets


VPS_TARGETS = parse_vps_targets()


def find_vps_target(vps_id):
    for t in VPS_TARGETS:
        if t.get('id') == vps_id:
            return t
    return None


def telegram_token():
    return os.getenv('TELEGRAM_BOT_TOKEN', '')

def verify_tg_init_data(init_data):
    token = telegram_token()
    if not token or not init_data:
        print("[VERIFY] Missing token or initData")
        return False
    parsed = dict(urllib.parse.parse_qsl(init_data, keep_blank_values=True))
    recv_hash = parsed.pop('hash', '')
    if not recv_hash:
        print("[VERIFY] No hash in initData")
        return False
    data_check = '\n'.join(f'{k}={v}' for k,v in sorted(parsed.items()))
    print(f"[VERIFY] data_check string:\n{data_check[:200]}")
    secret = hmac.new(b'WebAppData', token.encode(), hashlib.sha256).digest()
    calc = hmac.new(secret, data_check.encode(), hashlib.sha256).hexdigest()
    print(f"[VERIFY] recv_hash: {recv_hash[:20]}...")
    print(f"[VERIFY] calc_hash: {calc[:20]}...")
    if not hmac.compare_digest(calc, recv_hash):
        print("[VERIFY] Hash mismatch!")
        return False
    try:
        user=json.loads(parsed.get('user','{}'))
        user_id = str(user.get('id'))
        allowed_id = str(ALLOWED_TG_USER_ID)
        print(f"[VERIFY] user_id={user_id}, allowed={allowed_id}")
        return user_id == allowed_id
    except Exception as e:
        print(f"[VERIFY] Exception: {e}")
        return False

def auth_ok():
    if PASSWORD in ('', 'change-me'):
        print("[AUTH] Password not configured")
        return False
    auth = request.authorization
    if auth and auth.password == PASSWORD:
        print("[AUTH] ✓ Basic auth OK")
        return True
    if request.cookies.get('vpsmon_auth') == PASSWORD or request.headers.get('X-Dashboard-Password') == PASSWORD:
        print("[AUTH] ✓ Cookie/header auth OK")
        return True
    init_data = request.headers.get('X-Telegram-Init-Data','') or request.args.get('tg','')
    print(f"[AUTH] Telegram initData: {init_data[:50]}..." if init_data else "[AUTH] No Telegram initData")
    if verify_tg_init_data(init_data):
        print("[AUTH] ✓ Telegram auth OK")
        return True
    print("[AUTH] ✗ All auth methods failed")
    return False

def require_auth(fn):
    @wraps(fn)
    def wrap(*a, **kw):
        if not auth_ok():
            # Don't send WWW-Authenticate header if accessed from Telegram (prevents Basic Auth prompt)
            user_agent = request.headers.get('User-Agent', '')
            if 'Telegram' in user_agent or request.headers.get('X-Telegram-Init-Data'):
                return Response('Unauthorized - Please open from Telegram bot menu', 401)
            return Response('Unauthorized', 401, {'WWW-Authenticate': 'Basic realm="vps-monitor"'})
        return fn(*a, **kw)
    return wrap

def read_kv(path):
    out = {}
    with open(path) as f:
        for line in f:
            if ':' in line:
                k,v=line.split(':',1); out[k]=v.strip()
    return out

def cpu_times():
    vals = list(map(int, open('/proc/stat').readline().split()[1:]))
    idle = vals[3] + vals[4]
    total = sum(vals)
    return idle, total
_last_cpu = cpu_times()

def cpu_pct():
    global _last_cpu
    idle,total = cpu_times(); li,lt = _last_cpu; _last_cpu=(idle,total)
    dt=total-lt; di=idle-li
    return round((1 - di/dt)*100, 1) if dt else 0

def fmt_uptime(sec):
    d=int(sec//86400); h=int(sec%86400//3600); m=int(sec%3600//60)
    return f'{d}d {h}h {m}m'

def level(p):
    return 'danger' if p >= 90 else 'warn' if p >= 75 else 'ok'

def proc_name(pid):
    try: return open(f'/proc/{pid}/comm').read().strip()
    except: return ''

def top_processes(limit=8):
    rows=[]
    try:
        out=subprocess.check_output(['ps','-eo','pid,pcpu,pmem,comm','--sort=-pcpu'], text=True, timeout=2).splitlines()[1:limit+1]
        for l in out:
            p=l.split(None,3)
            if len(p)>=4: rows.append({'pid':p[0],'cpu':p[1],'mem':p[2],'cmd':p[3]})
    except Exception: pass
    return rows

def svc_status(name, cmd):
    try:
        r=subprocess.run(cmd, shell=True, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=4)
        txt=r.stdout.strip()
        return {'name': name, 'ok': r.returncode==0, 'status': 'online' if r.returncode==0 else 'issue', 'detail': txt.split('\n')[0][:140] if txt else ''}
    except Exception as e:
        return {'name': name, 'ok': False, 'status': 'issue', 'detail': str(e)[:140]}

def metrics():
    mem=read_kv('/proc/meminfo')
    mt=int(mem['MemTotal'].split()[0]); ma=int(mem['MemAvailable'].split()[0])
    used=mt-ma
    du=shutil.disk_usage('/')
    load=os.getloadavg(); cores=os.cpu_count() or 1
    up=float(open('/proc/uptime').read().split()[0])
    cp=cpu_pct(); rp=round(used/mt*100,1); dp=round(du.used/du.total*100,1); lpc=round(load[0]/cores,2)
    services=[
        svc_status('Hermes Bot', 'pgrep -f "hermes_cli.main gateway" >/dev/null'),
        svc_status('9Router', 'curl -fsS --max-time 2 http://127.0.0.1:20128 >/dev/null'),
        svc_status('Dashboard', 'pgrep -f "python app.py" >/dev/null')
    ]
    alerts=[]
    if rp>=75: alerts.append(f'RAM {rp}%')
    if dp>=75: alerts.append(f'Disk {dp}%')
    if lpc>=1.5: alerts.append(f'Load/core {lpc}')
    if not all(x['ok'] for x in services): alerts.append('Service issue')
    health='danger' if any(x.startswith('RAM') and rp>=90 or x.startswith('Disk') and dp>=90 for x in alerts) else 'warn' if alerts else 'ok'
    return {
      'ts': int(time.time()), 'host': socket.gethostname(), 'uptime_sec': int(up), 'uptime': fmt_uptime(up),
      'health': {'level': health, 'label': 'CRITICAL' if health=='danger' else 'ATTENTION' if health=='warn' else 'HEALTHY', 'alerts': alerts},
      'cpu': {'pct': cp, 'level': level(cp), 'cores': cores, 'load1': round(load[0],2), 'load5': round(load[1],2), 'load15': round(load[2],2), 'load_per_core': lpc},
      'ram': {'total_gb': round(mt/1024/1024,2), 'used_gb': round(used/1024/1024,2), 'avail_gb': round(ma/1024/1024,2), 'pct': rp, 'level': level(rp)},
      'disk': {'total_gb': round(du.total/1e9,2), 'used_gb': round(du.used/1e9,2), 'free_gb': round(du.free/1e9,2), 'pct': dp, 'level': level(dp)},
      'top': [x for x in top_processes() if x['cmd'] not in ('ps','head')],
      'services': services
    }

@app.route('/')
def index_redirect():
    # Serve page without auth - auth will be checked on API calls
    return render_template('index.html', refresh=REFRESH_SECONDS)

@app.route('/debug')
def debug(): return render_template('debug.html')

def fetch_remote_metrics(target):
    headers = {'Accept': 'application/json'}
    pw = target.get('password', '')
    if pw:
        headers['X-Dashboard-Password'] = pw
    req = Request(f"{target['url']}/api/metrics", headers=headers)
    with urlopen(req, timeout=5) as resp:
        body = resp.read().decode('utf-8')
        return json.loads(body)


@app.route('/api/vps')
@require_auth
def api_vps():
    return jsonify([
        {'id': t['id'], 'name': t['name'], 'type': t['type']}
        for t in VPS_TARGETS
    ])


@app.route('/api/metrics')
@require_auth
def api_metrics():
    vps_id = request.args.get('vps', 'local')
    target = find_vps_target(vps_id)
    if not target:
        return jsonify({'error': 'vps_not_found'}), 404
    if target.get('type') == 'local':
        return jsonify(metrics())
    try:
        data = fetch_remote_metrics(target)
        data['_target'] = {'id': target['id'], 'name': target['name'], 'type': 'remote'}
        return jsonify(data)
    except Exception as e:
        return jsonify({'error': 'remote_unreachable', 'detail': str(e)[:180], '_target': {'id': target['id'], 'name': target['name']}}), 502

@app.route('/login', methods=['POST'])
def login():
    pw=request.form.get('password','')
    if pw == PASSWORD:
        resp=Response('OK'); resp.set_cookie('vpsmon_auth', pw, httponly=True, samesite='Strict', max_age=86400*30); return resp
    return Response('Bad password', 403)


@app.route('/terminal')
@require_auth
def terminal(): return render_template('terminal.html')

@app.route('/claude')
@require_auth
def claude_terminal(): return render_template('terminal.html', auto='claude')

@app.route('/codex')
@require_auth
def codex_terminal(): return render_template('terminal.html', auto='codex')

def ws_auth(ws):
    init = ''
    try:
        init = request.args.get('tg','') or request.headers.get('X-Telegram-Init-Data','')
    except Exception:
        pass
    pin_ok = (not TERMINAL_PIN) or request.args.get('pin','') == TERMINAL_PIN
    if verify_tg_init_data(init) and pin_ok: return True
    if TERMINAL_PASSWORD_FALLBACK:
        pw = request.args.get('pw','')
        return bool(PASSWORD and pw == PASSWORD and pin_ok)
    return False

@sock.route('/ws/terminal')
def ws_terminal(ws):
    if not ws_auth(ws):
        ws.send('\r\nUnauthorized\r\n'); return
    cmd = request.args.get('cmd','bash')
    if cmd == 'claude': argv=['/home/ubuntu/.npm-global/bin/claude']
    elif cmd == 'codex': argv=['/home/ubuntu/.local/bin/codex'] if os.path.exists('/home/ubuntu/.local/bin/codex') else ['/usr/bin/env','codex']
    else: argv=['/bin/bash','-l']
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir('/home/ubuntu')
        os.environ['TERM']='xterm-256color'
        os.execv(argv[0], argv)
    try:
        fcntl.fcntl(fd, fcntl.F_SETFL, os.O_NONBLOCK)
        ws.send('\r\nConnected. Type `claude` to open Claude Code, or use /claude.\r\n\r\n')
        while True:
            r,_,_ = select.select([fd], [], [], 0.05)
            if fd in r:
                try:
                    data=os.read(fd,4096)
                    if not data: break
                    ws.send(data.decode(errors='ignore'))
                except OSError: break
            try:
                msg=ws.receive(timeout=0.01)
            except Exception:
                msg=None
            if msg is not None:
                if isinstance(msg, bytes): os.write(fd,msg)
                elif msg.startswith('__resize__:'):
                    try:
                        _, cols, rows = msg.split(':')
                        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', int(rows), int(cols), 0, 0))
                    except Exception: pass
                else:
                    os.write(fd,msg.encode())
    finally:
        try: os.kill(pid, signal.SIGHUP)
        except Exception: pass
        try: os.close(fd)
        except Exception: pass

if __name__ == '__main__':
    app.run(host=os.getenv('HOST','127.0.0.1'), port=int(os.getenv('PORT','8787')))
