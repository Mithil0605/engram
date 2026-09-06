#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { dataDir } = require('../lib/paths');
const descriptor = require('../lib/descriptor');

function baseURL(override) {
  if (override) return override.replace(/\/$/, '');
  const d = descriptor.read();
  if (d.error) return null;
  return `http://${d.host}:${d.port}`;
}

function token() {
  return process.env.ENGRAM_TOKEN || descriptor.read().token;
}

function req(method, url, body, tok) {
  const u = new URL(url);
  const headers = {};
  if (body !== undefined) {
    body = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(body);
  }
  const t = tok || token();
  if (t) headers.Authorization = `Bearer ${t}`;
  return new Promise((resolve, reject) => {
    const http = u.protocol === 'https:' ? require('https') : require('http');
    const r = http.request(
      u,
      { method, headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let j = {};
          try { j = JSON.parse(raw); } catch (_) { j = { raw }; }
          resolve({ status: res.statusCode, body: j, raw });
        });
      }
    );
    r.on('error', reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}

const HELP = `engram — shared memory for every AI agent

  engram status
  engram remember "<text>" [--project p] [--tag t] [--pinned]
  engram recall "<query>" [--project p] [--limit n]
  engram list [--project p] [--limit n]
  engram update <id> [--text ".."] [--tag t] [--pinned] [--project p]
  engram forget <id> [--project p]
  engram prune [--query ".."] [--tag t] [--commit] [--project p]
  engram export [--project p]
  engram devices
  engram pair          # start a pairing code (needs root token)
  engram unlock        # set/enter store password
  engram agents [scan|install]   # detect AI agents on this machine & wire them to engram
  engram serve-mcp     # run MCP stdio server for any AI agent
  Use ENGRAM_URL=... to point at a remote daemon, ENGRAM_TOKEN=... to auth.
`;

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const args = argv.slice(1);
  const optOf = (flag) => {
    const i = args.findIndex((x) => x === flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const has = (flag) => args.includes(flag);
  const url = baseURL(process.env.ENGRAM_URL);
  if (!url) {
    console.error('engram: cannot find daemon descriptor; is engramd running? (set ENGRAM_DIR or ENGRAM_URL)');
    process.exit(1);
  }
  const project = optOf('--project') || 'default';
  const limit = Number(optOf('--limit')) || 20;

  if (cmd === 'agents') {
    const agents = require('../lib/agents');
    const sub = args[0] || 'scan';
    if (sub === 'scan') {
      const found = agents.scan();
      if (found.length === 0) {
        console.log('No known AI agents detected on this machine.');
        return;
      }
      console.log('AI agents detected on this machine:');
      for (const f of found) {
        console.log(`  ${f.name.padEnd(10)} ${f.label}${f.config ? '  — ' + f.config : ''}`);
      }
      console.log('\nRun "engram agents install" to wire each one to engram.');
      return;
    }
    if (sub === 'install') {
      const results = agents.install();
      if (results.length === 0) {
        console.log('No known AI agents detected on this machine.');
        return;
      }
      console.log('Integrating AI agents with engram:');
      for (const r of results) {
        const icon = r.ok ? '✓' : '·';
        console.log(`  ${icon} ${r.label.padEnd(12)} ${r.message}`);
      }
      return;
    }
    console.log('usage: engram agents [scan|install]');
    return;
  }

  switch (cmd) {
    case 'status': {
      const r = await req('GET', `${url}/v1/status`);
      console.log(JSON.stringify(r.body, null, 2));
      break;
    }
    case 'remember': {
      const text = args.find((x) => !x.startsWith('-') && !x.startsWith('--')) || '';
      if (!text.trim()) return console.error('text required');
      const tags = [];
      for (let i = 0; i < args.length; i++) {
        if ((args[i] === '--tag' || args[i] === '-t') && args[i + 1]) tags.push(args[i + 1]);
      }
      const r = await req('POST', `${url}/v1/remember`, {
        project,
        text,
        tags,
        pinned: has('--pinned'),
        session: optOf('--session') || undefined,
        source: 'cli',
      });
      console.log(r.body.record ? `remembered ${r.body.record.id}${r.body.updated ? ' (updated existing)' : ''}` : JSON.stringify(r.body));
      break;
    }
    case 'recall': {
      const query = args.find((x) => !x.startsWith('-')) || '';
      const r = await req('GET', `${url}/v1/recall?project=${encodeURIComponent(project)}&query=${encodeURIComponent(query)}&limit=${limit}`);
      for (const it of r.body.results || []) {
        console.log(`[${it.score ? it.score.toFixed(2) : '  - '}] ${it.id}${it.pinned ? ' ★' : ''}`);
        console.log(`    ${it.text.slice(0, 150)}`);
      }
      break;
    }
    case 'list': {
      const r = await req('GET', `${url}/v1/list?project=${encodeURIComponent(project)}&limit=${limit}`);
      for (const it of r.body.results || []) {
        console.log(`${it.pinned ? '★' : ' '} ${it.id}  ${it.text.slice(0, 120)}`);
      }
      break;
    }
    case 'update': {
      const id = args.find((x) => !x.startsWith('-'));
      if (!id) return console.error('id required');
      const r = await req('PATCH', `${url}/v1/update`, {
        project,
        id,
        text: optOf('--text'),
        tags: optOf('--tag') ? [optOf('--tag')] : undefined,
        pinned: has('--pinned') ? true : undefined,
      });
      console.log(JSON.stringify(r.body));
      break;
    }
    case 'forget': {
      const id = args.find((x) => !x.startsWith('-'));
      if (!id) return console.error('id required');
      const r = await req('DELETE', `${url}/v1/forget/`, { project, id });
      console.log(r.status === 200 ? 'forgotten' : JSON.stringify(r.body));
      break;
    }
    case 'prune': {
      const q = optOf('--query');
      const r = await req('POST', `${url}/v1/prune`, {
        project,
        query: q || undefined,
        tag: undefined,
        tags: optOf('--tag') ? [optOf('--tag')] : undefined,
        session: optOf('--session') || undefined,
        commit: has('--commit'),
      });
      console.log(JSON.stringify(r.body));
      break;
    }
    case 'export': {
      const r = await req('GET', `${url}/v1/export?project=${encodeURIComponent(project)}`);
      console.log(JSON.stringify(r.body, null, 2));
      break;
    }
    case 'devices': {
      const r = await req('GET', `${url}/v1/devices`);
      console.log(JSON.stringify(r.body, null, 2));
      break;
    }
    case 'pair': {
      const r = await req('POST', `${url}/v1/pair/start`, {});
      console.log(`code: ${r.body.code}  device: ${r.body.deviceId}  expires in ${r.body.expiresIn / 1000}s`);
      console.log('On the mobile page (URL/m) enter this code to connect this machine.');
      break;
    }
    case 'unlock': {
      const password = optOf('--password');
      if (!password) return console.error('usage: engram unlock --password <password>');
      const r = await req('POST', `${url}/v1/unlock`, { password });
      console.log(JSON.stringify(r.body));
      break;
    }
    case 'serve-mcp':
      return require('../lib/mcp').serveMCP({ url, token: token() });
    default:
      console.log(HELP);
  }
}

main().catch((e) => {
  console.error('engram: ' + e.message);
  process.exit(1);
});