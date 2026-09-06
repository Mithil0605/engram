#!/usr/bin/env node
'use strict';

/*
 * Engram DAST probe — dynamic security testing against a live daemon.
 * Zero deps. Spawns ephemeral daemons in temp dirs, runs probes, exits non-zero on FAIL.
 *   Usage: node scripts/dast.js
 */

const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
let PASS = 0, FAIL = 0, SKIP = 0;
const fails = [];

function check(name, cond, extra) {
  if (cond) { PASS++; console.log(`  PASS ${name}`); }
  else { FAIL++; fails.push(name); console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}

function freePortSync() {
  const srv = net.createServer();
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

function request(port, method, p, { body, token, headers } = {}) {
  return new Promise((resolve, reject) => {
    const h = Object.assign({}, headers || {});
    if (token) h.Authorization = `Bearer ${token}`;
    if (body !== undefined) {
      body = typeof body === 'string' ? body : JSON.stringify(body);
      h['Content-Type'] = 'application/json';
      h['Content-Length'] = Buffer.byteLength(body);
    }
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, raw: Buffer.concat(chunks).toString() }));
    });
    r.on('error', reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}

function boot(opts) {
  return new Promise((resolve, reject) => {
    const args = ['bin/engramd.js', '--host', '127.0.0.1', '--port', String(opts.port), '--dir', opts.dir, '--claim', opts.claim || 'refuse'];
    if (opts.password) args.push('--password', opts.password);
    if (opts.limits) args.push('--limits', opts.limits);
    const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', opts.log ? 'pipe' : 'ignore', 'pipe'] });
    let out = '';
    child.stderr.on('data', (d) => (out += d));
    child.on('exit', (code) => {
      if (code !== 0 && opts.expectExit !== code) reject(new Error('daemon exited ' + code + ': ' + out));
      else resolve({ child, code, out });
    });
    if (!opts.expectExit) {
      setTimeout(() => resolve({ child, out }), 700);
    }
  });
}

async function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-dast-'));
  const port = await freePortSync();
  // main daemon: believably high conn/api/auth so sections [1]-[6] stay functional;
  // pair stays at the default so [7] can brute-force it into a 429 on its own daemon.
  const { child } = await boot({ port, dir, limits: 'conn=100000,auth=100000,api=100000,gen=100000' });
  const token = JSON.parse(fs.readFileSync(path.join(dir, 'engram.json'), 'utf8')).token;
  const B = (m, p, o) => request(port, m, p, o);

  console.log('\n[1] Security headers on HTML, assets and API');
  for (const p of ['/', '/m', '/assets/app.js', '/v1/status']) {
    const r = await B('GET', p);
    check(`${p} has CSP`, /default-src 'self'/.test(r.headers['content-security-policy'] || ''), (r.headers['content-security-policy'] || '').slice(0, 40));
    check(`${p} nosniff`, r.headers['x-content-type-options'] === 'nosniff');
    check(`${p} frame DENY`, r.headers['x-frame-options'] === 'DENY');
    check(`${p} no-referrer`, r.headers['referrer-policy'] === 'no-referrer');
    check(`${p} no-store`, /no-store/.test(r.headers['cache-control'] || ''));
  }

  console.log('\n[2] Auth — no/bad token rejected on every protected endpoint');
  const protectedRoutes = [
    ['GET', '/v1/recall?project=p&query=q'],
    ['GET', '/v1/list?project=p'],
    ['GET', '/v1/export?project=p'],
    ['POST', '/v1/remember', { project: 'p', text: 'x' }],
    ['PATCH', '/v1/update', { project: 'p', id: 'x' }],
    ['DELETE', '/v1/forget/', { project: 'p', id: 'x' }],
    ['POST', '/v1/prune', { project: 'p' }],
    ['GET', '/v1/devices'],
    ['DELETE', '/v1/revoke/x'],
    ['POST', '/v1/pair/start'],
  ];
  for (const [m, p, body] of protectedRoutes) {
    const o = body === undefined ? {} : { body };
    const noTok = await B(m, p, o);
    const badTok = await B(m, p, Object.assign({}, o, { token: 'deadbeef' }));
    check(`no-token ${m} ${p} → 401`, noTok.status === 401, String(noTok.status));
    check(`bad-token ${m} ${p} → 401`, badTok.status === 401, String(badTok.status));
  }

  console.log('\n[3] Root-only endpoints require root, device gets 403');
  const a = await B('POST', '/v1/remember', { body: { project: 'auth', text: 'root seed' }, token });
  check('root write ok', a.status === 200);
  const pair = await B('POST', '/v1/pair/start', { token });
  check('pair start ok', pair.status === 200);
  const code = JSON.parse(pair.raw).code;
  const claim = await B('POST', '/v1/pair/claim', { body: { code, name: 'dast' } });
  check('claim ok', claim.status === 200);
  const devTok = JSON.parse(claim.raw).token;
  check('device list denied (403)', (await B('GET', '/v1/devices', { token: devTok })).status === 403);
  check('device revoke denied (403)', (await B('DELETE', '/v1/revoke/x', { token: devTok })).status === 403);
  check('device pair-start denied (403)', (await B('POST', '/v1/pair/start', { token: devTok })).status === 403);
  const devWrite = await B('POST', '/v1/remember', { body: { project: 'auth', text: 'from device' }, token: devTok });
  check('device can write', devWrite.status === 200);
  const devRec = JSON.parse(devWrite.raw).record;
  const revoke = await B('DELETE', '/v1/revoke/' + JSON.parse(claim.raw).deviceId, { token });
  check('revoke ok', revoke.status === 200);
  check('revoked token dead (401)', (await B('GET', '/v1/list?project=auth', { token: devTok })).status === 401);

  console.log('\n[4] Bad input handling');
  check('malformed JSON → 400', (await B('POST', '/v1/remember', { body: '{{{', token })).status === 400);
  check('body not object → 400', (await B('POST', '/v1/remember', { body: [1, 2], token })).status === 400);
  check('oversized → 413', (await B('POST', '/v1/remember', { body: { project: 'p', text: 'z'.repeat(300 * 1024) }, token })).status === 413);
  check('project w/ control chars → 400', (await B('GET', '/v1/recall?project=a%0a%0d&query=x', { token })).status === 400);
  check('missing project → 400', (await B('GET', '/v1/recall?query=x', { token })).status === 400);
  check('missing text → 400', (await B('POST', '/v1/remember', { body: { project: 'p' }, token })).status === 400);
  check('wrong method → 405', (await B('GET', '/v1/remember', { token })).status === 405);
  check('unknown route → 404', (await B('GET', '/v1/nope', { token })).status === 404);

  console.log('\n[5] Traversal & URL hygiene');
  check('assets traversal → 403/404', [403, 404].includes((await B('GET', '/assets/%2e%2e/etc/passwd', { token })).status));
  check('root-ish traversal → 404', (await B('GET', '/../etc/passwd', { token })).status === 404);
  check('encoded slash in path → safe', [400, 404].includes((await B('GET', '/assets/%2f..%2fetc/passwd', { token })).status));

  console.log('\n[6] Stored XSS into dashboard/mobile is escaped (payload never raw in HTML)');
  const xss = '</script><script>window.__pwned=1</script>';
  await B('POST', '/v1/remember', { body: { project: 'xss', text: xss, tags: [xss] }, token });
  for (const page of ['/', '/m']) {
    const r = await B('GET', page);
    if (r.raw.includes(xss)) { FAIL++; fails.push('XSS ' + page); console.log(`  FAIL XSS payload raw on ${page}`); }
    else { PASS++; console.log(`  PASS XSS payload not raw on ${page}`); }
  }
  check('CSP present on both pages', /script-src 'self'/.test((await B('GET', '/')).headers['content-security-policy'] || ''));

  console.log('\n[7] Rate limiting — pair claim brute force (dedicated default-limit daemon)');
  const drate = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-dast-rate-'));
  const prate = await freePortSync();
  const rateD = await boot({ port: prate, dir: drate });
  {
    let got429 = false;
    for (let i = 0; i < 30; i++) {
      const r = await request(prate, 'POST', '/v1/pair/claim', { body: { code: '000000' } });
      if (r.status === 429) { got429 = true; break; }
    }
    check('brute force pair claim throttled → 429', got429);
    rateD.child.kill();
  }

  console.log('\n[8] Unlock lockout — brute force password (dedicated daemon)');
  const dlk = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-dast-lock-'));
  const plk = await freePortSync();
  const lockD = await boot({ port: plk, dir: dlk });
  {
    const unlockOk = await request(plk, 'POST', '/v1/unlock', { body: { password: 'strong-pw-dast' } });
    check('unlock sets password', unlockOk.status === 200, String(unlockOk.status));
    let last = null;
    for (let i = 0; i < 7; i++) last = await request(plk, 'POST', '/v1/unlock', { body: { password: 'wrong' } });
    check('5 wrong ⇒ locked 423', last.status === 423, String(last.status));
    check('retryAfter advertised', /retryAfter/.test(last.raw));
    const lockedStatus = await request(plk, 'GET', '/v1/status');
    check('status reports locked', JSON.parse(lockedStatus.raw).locked === true);
    const rec = await request(plk, 'POST', '/v1/remember', { body: { project: 'lockedproj', text: 'secret' }, token: JSON.parse(fs.readFileSync(path.join(dlk, 'engram.json'), 'utf8')).token });
    check('encrypted store write locked → 423', rec.status === 423, String(rec.status));
    await new Promise((resolve) => lockD.child.kill() && lockD.child.on('exit', resolve));
  }

  console.log('\n[9] Encryption at rest (dedicated daemon, password set)');
  const denc = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-dast-enc-'));
  const penc = await freePortSync();
  const encD = await boot({ port: penc, dir: denc, password: 'at-rest-pw' });
  {
    await new Promise((r) => setTimeout(r, 300));
    const encTok = JSON.parse(fs.readFileSync(path.join(denc, 'engram.json'), 'utf8')).token;
    const wrt = await request(penc, 'POST', '/v1/remember', { body: { project: 'topsecret', text: 'the classified password is p@55' }, token: encTok });
    check('encrypted store write allowed after unlock', wrt.status === 200, String(wrt.status));
    const storeFiles = fs.readdirSync(path.join(denc, 'stores')).filter((f) => f.endsWith('.store'));
    let leaked = [];
    for (const f of storeFiles) {
      const raw = fs.readFileSync(path.join(denc, 'stores', f), 'utf8');
      if (!raw.includes('ENGRAM_ENC_V2:')) leaked.push(f);
      if (raw.includes('classified password')) leaked.push(f + '(plaintext leak)');
    }
    check('stores are AES-256-GCM, no plaintext leaks', storeFiles.length > 0 && leaked.length === 0, 'leaked: ' + leaked.join(','));
    const st = await request(penc, 'GET', '/v1/status');
    check('status.encrypted true', JSON.parse(st.raw).encrypted === true);
    await new Promise((resolve) => encD.child.kill() && encD.child.on('exit', resolve));
  }

  console.log('\n[10] Host binding defaults to loopback');
  const dd = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-dast2-'));
  const p2 = await freePortSync();
  const d2 = await boot({ port: p2, dir: dd });
  const desc2 = JSON.parse(fs.readFileSync(path.join(dd, 'engram.json'), 'utf8'));
  check('descriptor host is loopback by default', desc2.host === '127.0.0.1');
  await new Promise((r) => d2.child.kill() && d2.child.on('exit', r));

  console.log('\n[11] Port claim: kill foreign / shift / refuse');
  // foreign listener
  const fd = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-dast3-'));
  const fp = await freePortSync();
  const foreign = net.createServer();
  await new Promise((r) => foreign.listen(fp, '127.0.0.1', r));
  const killRes = await boot({ port: fp, dir: fd, claim: 'kill' });
  await new Promise((r) => setTimeout(r, 600));
  const killBind = await new Promise((r) => {
    const s = net.createServer();
    s.once('error', () => r(false));
    s.once('listening', () => s.close(() => r(true)));
    s.listen(fp, '127.0.0.1');
  });
  check('--claim kill takes the port from a foreign process', killBind);
  killRes.child.kill();
  foreign.close();

  const rd = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-dast4-'));
  const rport = await freePortSync();
  const occup = net.createServer();
  await new Promise((r) => occup.listen(rport, '127.0.0.1', r));
  const refuse = await boot({ port: rport, dir: rd, claim: 'refuse', expectExit: 1 });
  check('--claim refuse refuses to start', refuse.code === 1);
  occup.close();

  const sd = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-dast5-'));
  const sport = await freePortSync();
  const occ2 = net.createServer();
  await new Promise((r) => occ2.listen(sport, '127.0.0.1', r));
  const shift = await boot({ port: sport, dir: sd, claim: 'shift' });
  await new Promise((r) => setTimeout(r, 600));
  const sdesc = JSON.parse(fs.readFileSync(path.join(sd, 'engram.json'), 'utf8'));
  check('--claim shift moves to a new port and updates descriptor', sdesc.port !== sport && sdesc.port > 0);
  shift.child.kill();
  occ2.close();

  console.log('\n[12] Adopt existing engram (no double-bind)');
  const ad = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-dast6-'));
  const aport = await freePortSync();
  const first = await boot({ port: aport, dir: ad });
  await new Promise((r) => setTimeout(r, 500));
  const second = await boot({ port: aport, dir: ad, claim: 'kill', expectExit: 0 });
  check('second daemon adopts running instance (exit 0, no double bind)', second.code === 0);
  const stillUp = await request(aport, 'GET', '/v1/status');
  check('service still responsive', stillUp.status === 200);
  first.child.kill();

  child.kill();
  console.log(`\nDAST result: ${PASS} PASS, ${FAIL} FAIL, ${SKIP} SKIP`);
  if (fails.length) {
    console.log('Failing probes:\n - ' + fails.join('\n - '));
    process.exit(1);
  }
  process.exit(0);
}

run().catch((e) => { console.error('DAST runner error: ' + e.stack); process.exit(2); });