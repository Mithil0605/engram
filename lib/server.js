'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { safeEqual, hashToken, PasswordGate } = require('./crypto');
const { Store, LockedError, projectFileName } = require('./store');
const { DeviceRegistry } = require('./devices');
const { RateLimiter } = require('./limiter');

const MAX_BODY = 256 * 1024;
const MAX_TEXT = 64 * 1024;
const MAX_PROJECT = 128;

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cache-Control': 'no-store',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

function cleanProject(p) {
  if (typeof p !== 'string' || !p.length) return null;
  if (p.length > MAX_PROJECT) return { error: 'project too long' };
  if (/[\x00-\x1f\x7f]/.test(p)) return { error: 'project contains control characters' };
  return p.trim();
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) {
      const err = new Error('payload too large');
      err.code = 413;
      throw err;
    }
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  try {
    const j = JSON.parse(raw);
    if (typeof j !== 'object' || j === null || Array.isArray(j)) {
      const e = new Error('body must be a JSON object');
      e.code = 400;
      throw e;
    }
    return j;
  } catch (e) {
    if (e.code) throw e;
    const err = new Error('invalid JSON');
    err.code = 400;
    throw err;
  }
}

function capInt(v, def, min, max) {
  if (v === null || v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

class EngramServer {
  constructor(opts) {
    this.opts = opts;
    const dataDir = opts.dataDir;
    this.dataDir = dataDir;
    this.storesDir = path.join(dataDir, 'stores');
    this.rootTokenHash = hashToken(opts.token);
    this.gate = new PasswordGate();
    this.storePassword = opts.password || null;
    this.stores = new Map();
    this.registry = new DeviceRegistry(path.join(dataDir, 'devices.json'), {
      onPairAttempt: (k) => this.pairLimiter.hit(k),
    });
    const l = opts.limits || {};
    this.genLimiter = new RateLimiter({ windowMs: 60_000, max: l.gen || 20 });
    this.pairLimiter = new RateLimiter({ windowMs: 60_000, max: l.pair || 10 });
    this.apiLimiter = new RateLimiter({ windowMs: 60_000, max: l.api || 600 });
    this.connLimiter = new RateLimiter({ windowMs: 10_000, max: l.conn || 60 });
    this.authLimiter = new RateLimiter({ windowMs: 60_000, max: l.auth || 30 });
    this.startedAt = Date.now();
    this.ui = opts.uiDir || path.join(__dirname, '..', 'ui');
    this.sockets = new Set();
  }

  _pread() {
    const locked = Boolean(this.storePassword) || this.gate.enabled;
    return locked;
  }

  async _store(project) {
    const key = String(project);
    let s = this.stores.get(key);
    if (!s) {
      s = new Store(path.join(this.storesDir, projectFileName(key, key)), key);
      await s.init(this.storePassword || undefined);
      this.stores.set(key, s);
    }
    return s;
  }

  async _encryptAllStores(password) {
    for (const st of this.stores.values()) {
      if (!st.encrypted) {
        try {
          await st.enableEncryption(password);
        } catch (_) {
          /* keep any that fail; they will encrypt on next mutation */
        }
      }
    }
  }

  _principal(req) {
    const h = req.headers['authorization'] || '';
    const m = /^Bearer\s+(.+)$/i.exec(h.trim());
    if (!m) return { ok: false };
    const tok = m[1].trim();
    if (safeEqual(hashToken(tok), this.rootTokenHash)) {
      return { ok: true, role: 'root' };
    }
    const dev = this.registry.lookupDeviceByToken(tok);
    if (dev) return { ok: true, role: 'device', dev };
    return { ok: false };
  }

  _handleAuthError(req, res) {
    const rl = this.authLimiter.hit('ip:' + (req.socket.remoteAddress || '?'));
    if (!rl.ok) {
      this._json(res, 429, { error: 'too many attempts', retryAfter: rl.retryAfter });
      return;
    }
    this._json(res, 401, { error: 'unauthorized' });
  }

  _ensureUnlocked(req, res) {
    if (this.gate.isLocked()) {
      this._json(res, 423, {
        error: 'locked',
        retryAfter: Math.ceil((this.gate.lockedUntil - Date.now()) / 1000),
      });
      return false;
    }
    return true;
  }

  _runPublic(reason) {
    return !this._pread() || reason === 'pair' || reason === 'unlock';
  }

  async handleRoute(req, res, parts, qp) {
    const method = req.method;
    const p = parts;
    // Drain the request body for every method that may carry one so the
    // connection is always left in a parseable state for keep-alive reuse
    // (an unread body + response would poison the next request on the socket).
    let body = {};
    if (method !== 'GET' && method !== 'HEAD') {
      body = await readJsonBody(req);
    }

    if (p[0] !== 'v1') {
      this._json(res, 404, { error: 'not found' });
      return;
    }
    const r1 = p[1];

    if (r1 === 'status') {
      if (method !== 'GET') return this._json(res, 405, { error: 'method not allowed' });
      this._json(res, 200, {
        version: require('../package.json').version,
        uptimeMs: Date.now() - this.startedAt,
        encrypted: Boolean(this.storePassword) || this.gate.enabled,
        locked: this.gate.isLocked(),
        projects: this.stores.size,
        devices: this.registry.list().filter((d) => !d.revoked).length,
        host: this.opts.host,
        tls: Boolean(this.opts.tls),
      });
      return;
    }

    if (r1 === 'unlock') {
      if (method !== 'POST') return this._json(res, 405, { error: 'method not allowed' });
      const pass = body.password;
      if (typeof pass !== 'string' || !pass.length) return this._json(res, 400, { error: 'password required' });
      if (this.gate.isLocked()) {
        return this._json(res, 423, {
          error: 'locked',
          retryAfter: Math.ceil((this.gate.lockedUntil - Date.now()) / 1000),
        });
      }
      if (!this.storePassword) {
        this.storePassword = pass;
        this.gate.enabled = true;
        this.gate.reset();
        await this._encryptAllStores(pass);
        this._json(res, 200, { ok: true, set: true });
        return;
      }
      if (safeEqual(String(this.storePassword), String(pass))) {
        this.gate.reset();
        this._json(res, 200, { ok: true });
      } else {
        const r = this.gate.recordFailure();
        this._json(res, r.lockedUntil ? 423 : 403, { error: 'bad password', attemptsLeft: r.attemptsLeft });
      }
      return;
    }

    if (r1 === 'pair') {
      if (p[2] === 'start') {
        if (method !== 'POST') return this._json(res, 405, { error: 'method not allowed' });
        const auth = this._principal(req);
        if (!auth.ok) return this._handleAuthError(req, res);
        if (auth.role !== 'root') return this._json(res, 403, { error: 'forbidden' });
        const rl = this.genLimiter.hit('pair-start');
        if (!rl.ok) return this._json(res, 429, { error: 'rate limited' });
        const pair = this.registry.startPair({ name: body.name });
        if (pair.error) return this._json(res, 409, { error: pair.error });
        this._json(res, 200, { deviceId: pair.deviceId, code: pair.code, expiresIn: pair.expiresIn });
        return;
      }
      if (p[2] === 'claim') {
        if (method !== 'POST') return this._json(res, 405, { error: 'method not allowed' });
        const code = String(body.code || '').replace(/[^0-9]/g, '');
        if (code.length !== 6) return this._json(res, 400, { error: 'enter the 6-digit code' });
        const rl = this.pairLimiter.hit('claim:' + req.socket.remoteAddress || 'claim:?');
        if (!rl.ok) return this._json(res, 429, { error: 'too many pairing attempts' });
        const done = this.registry.claimPair(code, { name: body.name });
        if (done.error) return this._json(res, 403, { error: done.error === 'rate-limited' ? 'too many attempts' : 'invalid code' });
        this._json(res, 200, { deviceId: done.deviceId, token: done.token });
        return;
      }
      return this._json(res, 404, { error: 'not found' });
    }

    const auth = this._principal(req);
    if (!auth.ok) return this._handleAuthError(req, res);

    if (r1 === 'devices') {
      if (method !== 'GET' || auth.role !== 'root') {
        return auth.role !== 'root' ? this._json(res, 403, { error: 'forbidden' }) : this._json(res, 405, { error: 'method not allowed' });
      }
      return this._json(res, 200, { devices: this.registry.list() });
    }
    if (r1 === 'revoke' && p[2]) {
      if (method !== 'DELETE' || auth.role !== 'root') {
        return auth.role !== 'root' ? this._json(res, 403, { error: 'forbidden' }) : this._json(res, 405, { error: 'method not allowed' });
      }
      const ok = this.registry.revoke(p[2]);
      return this._json(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'device not found' });
    }

    const route = r1 + ':' + method;
    if (route === 'remember:POST') {
      if (!this._ensureUnlocked(req, res)) return;
      const proj = cleanProject(body.project);
      if (!proj || proj.error) return this._json(res, 400, { error: proj && proj.error ? proj.error : 'project required' });
      if (typeof body.text !== 'string' || !body.text.trim()) return this._json(res, 400, { error: 'text required' });
      if (body.text.length > MAX_TEXT) return this._json(res, 413, { error: 'text too long' });
      const rl = this.apiLimiter.hit('wr:' + String(proj) + req.socket.remoteAddress);
      if (!rl.ok) return this._json(res, 429, { error: 'rate limited' });
      try {
        const st = await this._store(proj);
        const out = await st.add({
          text: body.text,
          tags: body.tags,
          pinned: body.pinned,
          source: body.source,
          session: body.session,
        });
        this._json(res, 200, { record: out.record, updated: out.updated, dedupe: out.dedupe || null });
      } catch (e) {
        this._err(res, e);
      }
      return;
    }

    if (route === 'recall:GET') {
      const proj = qp.get('project');
      const cp = cleanProject(proj || '');
      if (!cp || cp.error) return this._json(res, 400, { error: cp && cp.error ? cp.error : 'project required' });
      const limit = capInt(qp.get('limit'), 20, 1, 200);
      if (!this._ensureUnlocked(req, res)) return;
      try {
        const st = await this._store(cp);
        const found = st.searchRecords(qp.get('query') || '', limit, qp.get('pinned') === '1');
        this._json(res, 200, { results: found });
      } catch (e) {
        this._err(res, e);
      }
      return;
    }

    if (route === 'list:GET') {
      const proj = qp.get('project');
      const cp = cleanProject(proj || '');
      if (!cp || cp.error) return this._json(res, 400, { error: cp && cp.error ? cp.error : 'project required' });
      const limit = capInt(qp.get('limit'), 50, 1, 200);
      if (!this._ensureUnlocked(req, res)) return;
      try {
        const st = await this._store(cp);
        this._json(res, 200, { results: st.searchRecords('', limit) });
      } catch (e) {
        this._err(res, e);
      }
      return;
    }

    if (route === 'update:PATCH') {
      if (!this._ensureUnlocked(req, res)) return;
      const proj = cleanProject(body.project);
      if (!proj || proj.error) return this._json(res, 400, { error: proj && proj.error ? proj.error : 'project required' });
      if (typeof body.id !== 'string' || !body.id) return this._json(res, 400, { error: 'id required' });
      const fields = {};
      if (body.text !== undefined) {
        if (typeof body.text !== 'string' || body.text.length > MAX_TEXT) return this._json(res, 400, { error: 'invalid text' });
        fields.text = body.text;
      }
      if (body.tags !== undefined) fields.tags = body.tags;
      if (body.pinned !== undefined) fields.pinned = Boolean(body.pinned);
      if (body.source !== undefined) fields.source = String(body.source).slice(0, 200);
      if (body.session !== undefined) fields.session = String(body.session).trim() ? String(body.session).trim().slice(0, 200) : null;
      try {
        const st = await this._store(proj);
        const r = await st.update(body.id, fields);
        this._json(res, r ? 200 : 404, r ? { record: r } : { error: 'not found' });
      } catch (e) {
        this._err(res, e);
      }
      return;
    }

    if (route === 'forget:DELETE') {
      if (!this._ensureUnlocked(req, res)) return;
      const proj = cleanProject(body.project);
      if (!proj || proj.error) return this._json(res, 400, { error: proj && proj.error ? proj.error : 'project required' });
      const id = p[2] || body.id;
      if (typeof id !== 'string' || !id) return this._json(res, 400, { error: 'id required' });
      try {
        const st = await this._store(proj);
        const ok = await st.forget(id);
        this._json(res, ok ? 200 : 404, { ok });
      } catch (e) {
        this._err(res, e);
      }
      return;
    }

    if (route === 'prune:POST') {
      if (!this._ensureUnlocked(req, res)) return;
      const proj = cleanProject(body.project);
      if (!proj || proj.error) return this._json(res, 400, { error: proj && proj.error ? proj.error : 'project required' });
      const commit = Boolean(body.commit);
      try {
        const st = await this._store(proj);
        const all = st.snapshot();
        let matched = all;
        if (typeof body.query === 'string' && body.query.trim()) {
          const hits = st.searchRecords(body.query, 200).map((r) => r.id);
          matched = matched.filter((r) => hits.includes(r.id));
        }
        if (Array.isArray(body.ids) && body.ids.length) {
          matched = matched.filter((r) => body.ids.includes(r.id));
        }
        if (Array.isArray(body.tags) && body.tags.length) {
          matched = matched.filter((r) => r.tags.some((t) => body.tags.includes(t)));
        }
        if (body.session !== undefined && String(body.session).trim() !== '') {
          const sess = String(body.session).trim();
          matched = matched.filter((r) => r.session === sess);
        }
        let deleted = 0;
        if (commit) {
          for (const r of matched) {
            if (await st.forget(r.id)) deleted++;
          }
        }
        this._json(res, 200, { matched: matched.length, deleted, commit });
      } catch (e) {
        this._err(res, e);
      }
      return;
    }

    if (route === 'export:GET') {
      const proj = qp.get('project');
      const cp = cleanProject(proj || '');
      if (!cp || cp.error) return this._json(res, 400, { error: cp && cp.error ? cp.error : 'project required' });
      if (!this._ensureUnlocked(req, res)) return;
      try {
        const st = await this._store(cp);
        this._json(res, 200, { project: cp, memories: st.export() });
      } catch (e) {
        this._err(res, e);
      }
      return;
    }

    const KNOWN = new Set(['remember', 'recall', 'list', 'update', 'forget', 'prune', 'export']);
    if (KNOWN.has(r1)) {
      res.setHeader('Allow', { remember: ['POST'], recall: ['GET'], list: ['GET'], update: ['PATCH'], forget: ['DELETE'], prune: ['POST'], export: ['GET'] }[r1].join(', '));
      return this._json(res, 405, { error: 'method not allowed' });
    }
    this._json(res, 404, { error: 'route not found' });
  }

  _err(res, e) {
    if (e.code === 'LOCKED' || (e && e.message && e.message.includes('locked'))) {
      return this._json(res, 423, { error: 'store is locked; unlock first' });
    }
    const code = Number(e.code) >= 400 && Number(e.code) < 600 ? Number(e.code) : 500;
    this._json(res, code, { error: e.message || 'internal error' });
  }

  _json(res, status, obj) {
    if (res.writableEnded) return;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  }

  _static(res, file, type) {
    try {
      const data = fs.readFileSync(file);
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length });
      res.end(data);
    } catch (_) {
      this._json(res, 404, { error: 'not found' });
    }
  }

  handler() {
    return (req, res) => {
      const cl = this.connLimiter.hit('ip:' + (req.socket.remoteAddress || '?'));
      if (!cl.ok) return this._json(res, 429, { error: 'connection rate limited' });
      res.setHeader('X-Content-Type-Options', 'nosniff');
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
      if (res.req && req.method === 'OPTIONS') {
        return this._json(res, 204, {});
      }
      let url;
      try {
        url = new URL(req.url, 'http://localhost');
      } catch (_) {
        return this._json(res, 400, { error: 'bad request' });
      }
      const rawPath = decodeURIComponent(url.pathname);
      const parts = rawPath.split('/').filter(Boolean);
      const qp = url.searchParams;

      if (!parts.length || parts[0] === 'index.html') {
        return this._static(res, path.join(this.ui, 'index.html'), 'text/html; charset=utf-8');
      }
      const first = parts[0];

      if (first === 'assets' && parts.length === 2) {
        const file = path.join(this.ui, parts[1]);
        const base = path.basename(file);
        if (base.includes('..') || !/^(app\.(js|css)|logo\.png)$/.test(base)) {
          return this._json(res, 403, { error: 'forbidden' });
        }
        const type = base.endsWith('.js') ? 'application/javascript' : base.endsWith('.css') ? 'text/css' : 'image/png';
        return this._static(res, file, type);
      }

      if (first === 'm') {
        return this._static(res, path.join(this.ui, 'mobile.html'), 'text/html; charset=utf-8');
      }

      if (first === 'v1') {
        this.handleRoute(req, res, parts, qp).catch((e) => {
          this._err(res, e);
        });
        return;
      }

      this._json(res, 404, { error: 'not found' });
    };
  }

  listen(port, host) {
    this.server = http.createServer();
    this.server.on('request', this.handler());
    this.server.on('connection', (sock) => {
      this.sockets.add(sock);
      sock.on('close', () => this.sockets.delete(sock));
    });
    this.server.timeout = 30_000;
    return new Promise((resolve, reject) => {
      const onErr = (e) => reject(e);
      this.server.once('error', onErr);
      this.server.listen(port, host, () => {
        this.server.removeListener('error', onErr);
        resolve(this.server.address());
      });
    });
  }

  close() {
    for (const [k, v] of this.genLimiter.buckets) void k;
    this.genLimiter.close();
    this.pairLimiter.close();
    this.apiLimiter.close();
    this.connLimiter.close();
    this.authLimiter.close();
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    if (this.server) return new Promise((r) => this.server.close(r));
    return Promise.resolve();
  }
}

module.exports = { EngramServer, SECURITY_HEADERS, MAX_BODY, MAX_TEXT, cleanProject };