#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');
const net = require('net');
const { EngramServer } = require('../lib/server');
const descriptor = require('../lib/descriptor');
const { dataDir, ensureDir } = require('../lib/paths');
const { pidOnPort, isEngramProcess, killPid, freePort } = require('../lib/port');

function parseArgs(argv) {
  const opts = { port: 8040, host: '127.0.0.1', claim: 'kill', dir: null, password: null, tlsKey: null, tlsCert: null, limits: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i];
    switch (a) {
      case '--port': opts.port = Number(val()); break;
      case '--host': opts.host = val(); break;
      case '--claim': opts.claim = val(); break;
      case '--dir': opts.dir = val(); break;
      case '--password': opts.password = val(); break;
      case '--tls-key': opts.tlsKey = val(); break;
      case '--tls-cert': opts.tlsCert = val(); break;
      case '--limits': {
        // e.g. --limits conn=100000,auth=100000 (per <bucket> per window)
        const out = {};
        for (const pair of val().split(',')) {
          const [k, v] = pair.split('=');
          if (k && v) out[k] = Number(v);
        }
        opts.limits = out;
        break;
      }
      case '--help':
      case '-h':
        console.log('Usage: engramd [--port 8040] [--host 127.0.0.1] [--claim kill|shift|refuse] [--dir DIR] [--password P] [--tls-key F --tls-cert F] [--limits conn=60,api=600,auth=30,pair=10,gen=20]');
        process.exit(0);
      default:
        if (a.startsWith('-')) {
          console.error(`unknown option: ${a}`);
          process.exit(2);
        }
    }
  }
  if (!['kill', 'shift', 'refuse'].includes(opts.claim)) {
    console.error('--claim must be kill, shift, or refuse');
    process.exit(2);
  }
  return opts;
}

function portInUse(host, port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(true));
    s.once('listening', () => s.close(() => resolve(false)));
    s.listen(port, host);
  });
}

async function acquirePort(opts) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!(await portInUse(opts.host, opts.port))) return opts.port;
    const pid = pidOnPort(opts.port);
    if (pid) {
      if (isEngramProcess(pid)) {
        console.log(`[engram] another engram daemon (pid ${pid}) is serving ${opts.host}:${opts.port}; adopting existing instance.`);
        process.exit(0);
      }
      if (opts.claim === 'kill') {
        console.log(`[engram] port ${opts.port} held by pid ${pid} (not engram); claiming it.`);
        await killPid(pid);
        continue;
      }
      if (opts.claim === 'shift') {
        const free = await freePort(opts.host, opts.port);
        if (!free) {
          console.error('[engram] no free port found; refusing to start.');
          process.exit(1);
        }
        console.log(`[engram] port ${opts.port} occupied; shifting to ${free}.`);
        return free;
      }
      console.error(`[engram] port ${opts.port} in use by pid ${pid}; refusing to start (use --claim kill or shift).`);
      process.exit(1);
    }
    // occupied but pid undiscoverable
    if (opts.claim === 'shift') {
      const free = await freePort(opts.host, opts.port);
      if (free) {
        console.log(`[engram] port ${opts.port} occupied; shifting to ${free}.`);
        return free;
      }
    }
    console.error(`[engram] port ${opts.port} is in use and cannot be claimed.`);
    process.exit(1);
  }
  process.exit(1);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dir = opts.dir || dataDir();
  ensureDir(dir);
  ensureDir(path.join(dir, 'stores'));

  let desc;
  try {
    process.env.ENGRAM_DIR = opts.dir || process.env.ENGRAM_DIR || dir;
    desc = descriptor.read({ host: opts.host, port: opts.port });
  } catch (e) {
    console.error('[engram] descriptor error: ' + e.message);
    process.exit(1);
  }

  const actualPort = await acquirePort({...opts, port: desc.port});
  if (actualPort !== desc.port) {
    descriptor.updatePartial({ host: opts.host, port: actualPort });
    desc = descriptor.read();
  }
  if (desc.error) {
    console.error('[engram] ' + desc.error);
    process.exit(1);
  }

  const server = new EngramServer({
    token: desc.token,
    host: opts.host,
    dataDir: dir,
    password: opts.password,
    tls: Boolean(opts.tlsKey && opts.tlsCert),
    limits: opts.limits || undefined,
  });

  try {
    await server.listen(actualPort, opts.host);
  } catch (e) {
    if (e.code === 'EADDRINUSE') {
      console.error(`[engram] could not bind ${opts.host}:${actualPort} (EADDRINUSE). Run with --claim kill|shift or change --port.`);
      process.exit(1);
    }
    throw e;
  }

  const scheme = opts.tlsKey && opts.tlsCert ? 'https' : 'http';
  console.log('');
  console.log('  ███████╗███████╗ ██████╗ ██████╗  █████╗ ███╗   ███╗');
  console.log('  ██╔════╝██╔════╝██╔════╝ ██╔══██╗██╔══██╗████╗ ████║');
  console.log('  █████╗  █████╗  ██║      ██████╔╝███████║██╔████╔██║');
  console.log('  ██╔══╝  ██╔══╝  ██║      ██╔══██╗██╔══██║██║╚██╔╝██║');
  console.log('  ███████╗███████╗╚██████╗ ██║  ██║██║  ██║██║ ╚═╝ ██║');
  console.log('  ╚══════╝╚══════╝ ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝     ╚═╝');
  console.log('  Every agent. One memory.');
  console.log('');
  console.log(`  Dashboard : ${scheme}://${opts.host === '0.0.0.0' ? 'localhost' : opts.host}:${actualPort}`);
  console.log(`  Mobile    : ${scheme}://${opts.host === '0.0.0.0' ? '<lan-ip>' : opts.host}:${actualPort}/m   (pair with the 6-digit code)`);
  console.log(`  Data dir  : ${dir}`);
  console.log(`  Storage   : ${opts.password ? 'AES-256-GCM (locked until unlock)' : 'plaintext (encrypt with --password or POST /v1/unlock)'}`);
  console.log(`  Port claim: ${opts.claim}`);
  console.log('');
}

main().catch((e) => {
  console.error('[engram] fatal: ' + e.stack);
  process.exit(1);
});