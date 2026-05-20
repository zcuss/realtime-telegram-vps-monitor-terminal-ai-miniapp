import { spawn } from 'node:child_process';

const procs = new Set();

function run(name, script) {
  const child = spawn(process.execPath, [script], {
    stdio: 'inherit',
    env: process.env,
  });

  procs.add(child);

  child.on('exit', code => {
    procs.delete(child);
    if (code && code !== 0) {
      console.error(`${name} exited with code ${code}`);
      shutdown('SIGTERM', code);
    }
  });

  return child;
}

function shutdown(signal = 'SIGTERM', code = 0) {
  for (const child of procs) {
    try { child.kill(signal); } catch {}
  }
  setTimeout(() => process.exit(code), 300).unref();
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

run('panel', 'server.js');
run('bot', 'bot.js');
