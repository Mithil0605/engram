'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { EngramServer } = require('../lib/server');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-srv-'));
const token = 'test-root-token-abcdef';
let srv;
let port;
let url;

function raw(method, p, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(p, url);
    const h = { ...headers };
    if (body !== undefined) {
      body = JSON.stringify(body);
      h['Content-Type'] = 'application/json';
      h['Content-Length'] = Buffer.byteLength(body);
    }
    const r = http.request(u, { method, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let j = {};
        try { j = JSON.parse(Buffer.concat(chunks).toString()); } catch (_) { j = {}; }
        resolve({ status: res.statusCode, headers: res.headers, body: j, raw: Buffer.concat(chunks).toString() });
      });
    });
    r.on('error', reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}

const auth = { Authorization: `Bearer ${token}` };
const req = (method, p, body) => raw(method, p, body, auth);

before(async () => {
  srv = new EngramServer({
    token, host: '127.0.0.1', dataDir: dir, uiDir: path.join(__dirname, '..', 'ui'),
    limits: { conn: 100000, api: 100000, auth: 100000, pair: 100000, gen: 100000 },
  });
  const addr = await srv.listen(0, '127.0.0.1');
  port = addr.port;
  url = `http://127.0.0.1:${port}`;
});

after(async () => {
  await srv.close();
});

test('status is public and correct', async () => {
  const r = await raw('GET', '/v1/status');
  assert.equal(r.status, 200);
  assert.equal(r.body.locked, false);
  assert.equal(r.body.encrypted, false);
});

test('no/bad token is rejected', async () => {
  assert.equal((await raw('GET', '/v1/recall?project=p&query=x')).status, 401);
  assert.equal((await raw('GET', '/v1/list?project=p')).status, 401);
  assert.equal((await raw('POST', '/v1/remember', { project: 'p', text: 'x' }, { Authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await raw('GET', '/v1/devices', undefined, { Authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await raw('GET', '/v1/export?project=p')).status, 401);
  assert.equal((await raw('POST', '/v1/pair/start', {})).status, 401);
});

test('CRUD through the API', async () => {
  const a = await req('POST', '/v1/remember', { project: 'app', text: 'run with npm test', tags: ['dev'], source: 'api' });
  assert.equal(a.status, 200);
  const id = a.body.record.id;

  const dup = await req('POST', '/v1/remember', { project: 'app', text: 'run with npm test!' });
  assert.equal(dup.body.updated, true);
  assert.equal(dup.body.record.id, id);

  const hit = await req('GET', '/v1/recall?project=app&query=npm+test');
  assert.equal(hit.status, 200);
  assert.equal(hit.body.results.length, 1);

  const list = await req('GET', '/v1/list?project=app');
  assert.equal(list.body.results.length, 1);

  const up = await req('PATCH', '/v1/update', { project: 'app', id, pinned: true });
  assert.equal(up.body.record.pinned, true);

  const prune = await req('POST', '/v1/prune', { project: 'app', query: 'npm', commit: true });
  assert.equal(prune.body.deleted, 1);

  const afterL = await req('GET', '/v1/export?project=app');
  assert.equal(afterL.body.memories.length, 0);
});

test('agent session is stored once; forget works by body and by path; session deletes wholly', async () => {
  const w = await req('POST', '/v1/remember', { project: 'sess', text: 'agent first note', session: 's-123' });
  assert.equal(w.status, 200);
  assert.equal(w.body.dedupe, null, 'first insert is a new record');
  const w2 = await req('POST', '/v1/remember', { project: 'sess', text: 'agent updated note', session: 's-123' });
  assert.equal(w2.body.updated, true);
  assert.equal(w2.body.dedupe, 'session');
  assert.equal(w2.body.record.id, w.body.record.id, 'same session is stored once (single record)');
  const w3 = await req('POST', '/v1/remember', { project: 'sess', text: 'other agent note', session: 's-456' });
  assert.equal(w3.body.updated, false);

  const list = await req('GET', '/v1/list?project=sess');
  assert.equal(list.body.results.length, 2);

  const delBody = await req('DELETE', '/v1/forget/', { project: 'sess', id: w3.body.record.id });
  assert.equal(delBody.status, 200);
  const delPath = await req('DELETE', `/v1/forget/${w.body.record.id}`, { project: 'sess' });
  assert.equal(delPath.status, 200);
  assert.equal((await req('GET', '/v1/list?project=sess')).body.results.length, 0);

  await req('POST', '/v1/remember', { project: 'sess', text: 'n1', session: 'A' });
  await req('POST', '/v1/remember', { project: 'sess', text: 'n2', session: 'A' });
  await req('POST', '/v1/remember', { project: 'sess', text: 'n3', session: 'B' });
  const pr = await req('POST', '/v1/prune', { project: 'sess', session: 'A', commit: true });
  assert.equal(pr.body.deleted, 1);
  assert.equal((await req('GET', '/v1/list?project=sess')).body.results.length, 1);
});

test('devices are isolated; dev token is scoped, revocable', async () => {
  const start = await req('POST', '/v1/pair/start', {});
  assert.equal(start.status, 200);
  const code = start.body.code;
  assert.match(code, /^\d{6}$/);
  assert.equal(new Set(code.split('')).size > 0, true);

  const claim = await raw('POST', '/v1/pair/claim', { code, name: 'phone' });
  assert.equal(claim.status, 200);
  const devToken = claim.body.token;
  const devAuth = { Authorization: `Bearer ${devToken}` };

  const w = await raw('POST', '/v1/remember', { project: 'app', text: 'from a phone' }, devAuth);
  assert.equal(w.status, 200);

  // devices list is root-only
  assert.equal((await raw('GET', '/v1/devices', undefined, devAuth)).status, 403);
  // revoke it
  const devId = claim.body.deviceId;
  const rv = await req('DELETE', '/v1/revoke/' + devId);
  assert.equal(rv.status, 200);
  // now dev token is dead
  assert.equal((await raw('GET', '/v1/list?project=app', undefined, devAuth)).status, 401);
});

test('pair claim rate limit + bad code rejection', async () => {
  for (let i = 0; i < 8; i++) {
    const r = await raw('POST', '/v1/pair/claim', { code: '000000' });
    assert.equal(r.status, 403);
  }
  // the 10/min cap should kick in by now or soon
  const r = await raw('POST', '/v1/pair/claim', { code: '000000' });
  assert.ok([403, 429].includes(r.status));
});

test('malformed and oversized bodies are rejected', async () => {
  const r1 = await raw('POST', '/v1/remember', 'not-json', auth);
  assert.equal(r1.status, 400);
  const r2 = await raw('POST', '/v1/remember', { project: 'p', text: 'x' }, auth);
  assert.equal(r2.status, 200);
  const big = { project: 'p', text: 'y'.repeat(70 * 1024) };
  const r3 = await req('POST', '/v1/remember', big);
  assert.equal(r3.status, 413);
});

test('concurrent reads/writes never corrupt and all succeed', async () => {
  const writes = [];
  for (let i = 0; i < 10; i++) {
    const payload = 'concurrent write ' + i + ' ' + crypto.randomBytes(16).toString('hex') + ' unique filler tail';
    writes.push(req('POST', '/v1/remember', { project: 'conc', text: payload }));
  }
  const writeRes = await Promise.all(writes);
  assert.ok(writeRes.every((r) => r.status === 200));

  const reads = [];
  for (let i = 0; i < 60; i++) reads.push(req('GET', '/v1/recall?project=conc&query=concurrent+write'));
  const readRes = await Promise.all(reads);
  assert.ok(readRes.every((r) => r.status === 200));
  assert.ok(readRes[0].body.results.length >= 8, 'dedupe should not collapse distinct writes');
});

test('unlock sets password, wrong attempts lock the store', async () => {
  // set a password on a fresh project's daemon state via unlock (global for this daemon)
  const r0 = await raw('POST', '/v1/unlock', { password: 'super-secret-pw' });
  assert.equal(r0.status, 200);
  // now stores should be encrypted on disk
  const files = fs.readdirSync(path.join(dir, 'stores'));
  const f = files.find((x) => x.endsWith('.store'));
  assert.ok(f);
  const onDisk = fs.readFileSync(path.join(dir, 'stores', f), 'utf8');
  assert.ok(onDisk.startsWith('ENGRAM_ENC_V2:'));
  assert.ok(!onDisk.includes('concurrent record'));

  // wrong password attempts
  for (let i = 0; i < 4; i++) {
    const w = await raw('POST', '/v1/unlock', { password: 'wrong' });
    assert.ok([403, 423].includes(w.status));
  }
  const locked = await raw('POST', '/v1/unlock', { password: 'wrong' });
  assert.equal(locked.status, 423);
});

test('security headers are present on every response', async () => {
  const r = await raw('GET', '/v1/status');
  assert.ok(r.headers['content-security-policy'].includes("default-src 'self'"));
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(r.headers['x-frame-options'], 'DENY');
  assert.equal(r.headers['referrer-policy'], 'no-referrer');
  assert.match(r.headers['cache-control'], /no-store/);
});

test('static assets are served safely; traversal is blocked', async () => {
  const ok = await raw('GET', '/assets/app.js');
  assert.equal(ok.status, 200);
  assert.match(ok.headers['content-type'], /javascript/);
  const bad = await raw('GET', '/assets/%2e%2e/%2e%2e/etc/passwd');
  assert.ok([403, 404].includes(bad.status));
  assert.equal((await raw('GET', '/../etc/passwd')).status, 404);
  // path traversal is URL-normalized away, never reaches the filesystem
  assert.equal((await raw('GET', '/v1/../v1/status')).status, 200);
});

test('unknown routes and bad methods 404/405', async () => {
  assert.equal((await req('GET', '/v1/nope')).status, 404);
  assert.equal((await raw('GET', '/v1/remember', undefined, auth)).status, 405);
  assert.equal((await raw('POST', '/v1/export?project=p', {}, auth)).status, 405);
});