'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const net = require('net');
const { spawn } = require('child_process');
const { pidOnPort, isEngramProcess, killPid, freePort } = require('../lib/port');

function tmpListen(host = '127.0.0.1') {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, host, () => resolve(s));
  });
}
function addrPort(s) {
  return s.address().port;
}

test('pidOnPort finds the process bound to a port', async () => {
  const s = await tmpListen();
  const pid = pidOnPort(addrPort(s));
  assert.ok(pid > 0);
  s.close();
});

test('foreign (non-engram) process is not treated as engram', async () => {
  const src = `
    const net = require('net');
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      console.log('port=' + s.address().port);
      setInterval(() => {}, 1000);
    });
  `;
  const child = spawn(process.execPath, ['-e', src], { stdio: ['ignore', 'pipe', 'ignore'] });
  const port = await new Promise((resolve) => {
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString();
      const m = buf.match(/port=(\d+)/);
      if (m) resolve(Number(m[1]));
    });
  });
  const exited = new Promise((r) => child.once('exit', r));
  const pid = pidOnPort(port);
  assert.equal(pid, child.pid);
  assert.equal(isEngramProcess(pid), false);
  const killed = await killPid(pid);
  assert.equal(killed, true);
  await exited;
  assert.equal(pidOnPort(port), null);
});

test('a process whose command line references engram is recognized', async () => {
  const helper = require('path').join(__dirname, 'helper-listener.js');
  const child = spawn(process.execPath, [helper], { stdio: ['ignore', 'pipe', 'ignore'] });
  const port = await new Promise((resolve, reject) => {
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString();
      const m = buf.match(/p=(\d+)/);
      if (m) resolve(Number(m[1]));
    });
    child.on('exit', () => reject(new Error('helper exited early')));
    setTimeout(() => reject(new Error('timeout')), 5000);
  });
  assert.equal(pidOnPort(port), child.pid);
  assert.equal(isEngramProcess(child.pid), true);
  await killPid(child.pid);
});

test('freePort returns a usable free port', async () => {
  const p = await freePort('127.0.0.1', 8041);
  assert.ok(p > 8041 && p < 8041 + 500);
  const s = net.createServer();
  await new Promise((resolve) => s.listen(p, '127.0.0.1', resolve));
  s.close();
});