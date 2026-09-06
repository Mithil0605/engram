'use strict';

const { execFileSync } = require('child_process');

function pidOnPort(port) {
  const p = String(port);
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('netstat', ['-ano', '-p', 'tcp'], { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });
      for (const line of out.split('\n')) {
        const m = line.trim().match(/TCP\s+\S+:(?:0*)?(\d+)\s+\S+:0*(\d+)\s+LISTENING\s+(\d+)/);
        if (m && m[2] === p) return Number(m[3]);
      }
      return null;
    }
    try {
      const out = execFileSync('lsof', ['-ti', `tcp:${port}`, '-s', 'tcp:LISTEN'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf8',
      });
      const pid = out.trim().split('\n')[0];
      if (pid && /^\d+$/.test(pid)) return Number(pid);
    } catch (_) {
      /* lsof exit 1 = nothing listening */
    }
    if (process.platform === 'linux') {
      try {
        const out = execFileSync('ss', ['-ltnp'], { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });
        const re = new RegExp(`\\b0?\\.0\\.0\\.0:${port}\\b|\\b\\[::\\]:${port}\\b|\\b127\\.0\\.0\\.1:${port}\\b`);
        for (const line of out.split('\n')) {
          if (!re.test(line)) continue;
          const m = line.match(/pid=(\d+)/);
          if (m) return Number(m[1]);
        }
      } catch (_) {
        /* ss may need privileges */
      }
    }
  } catch (_) {
    return null;
  }
  return null;
}

function procName(pid) {
  try {
    if (process.platform === 'linux') {
      const cmd = require('fs').readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      return cmd.replace(/\0/g, ' ').trim();
    }
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    });
    return out.trim();
  } catch (_) {
    return '';
  }
}

function isEngramProcess(pid) {
  return /engram/.test(procName(pid));
}

async function killPid(pid) {
  try {
    process.kill(pid, 'SIGTERM');
  } catch (_) {
    return false;
  }
  await new Promise((r) => setTimeout(r, 1200));
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore' });
      return true;
    }
    process.kill(pid, 0);
    process.kill(pid, 'SIGKILL');
  } catch (_) {
    return true;
  }
  await new Promise((r) => setTimeout(r, 150));
  try {
    process.kill(pid, 0);
    return false;
  } catch (_) {
    return true;
  }
}

function freePort(host, fromPort) {
  const net = require('net');
  for (let p = fromPort + 1; p < fromPort + 500; p++) {
    try {
      const srv = net.createServer();
      srv.listen(p, host);
      return new Promise((resolve) => {
        srv.once('listening', () => {
          srv.close(() => resolve(p));
        });
        srv.once('error', () => resolve(null));
      });
    } catch (_) {
      /* try next */
    }
  }
  return Promise.resolve(null);
}

module.exports = { pidOnPort, isEngramProcess, killPid, freePort, procName };