'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { hashToken, safeEqual } = require('./crypto');
const { ensureDir, chmod600 } = require('./paths');

const PAIR_TTL_MS = 120_000;
const MAX_DEVICES = 64;

class DeviceRegistry {
  constructor(file, opts = {}) {
    this.file = file;
    this.devices = [];
    this.pendingPairs = [];
    this.rateLimit = opts.onPairAttempt || null;
    this._load();
  }

  _load() {
    ensureDir(path.dirname(this.file));
    if (fs.existsSync(this.file)) {
      try {
        this.devices = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      } catch (_) {
        this.devices = [];
      }
    }
  }

  _persist() {
    const tmp = this.file + '.tmp';
    ensureDir(path.dirname(this.file));
    fs.writeFileSync(tmp, JSON.stringify(this.devices, null, 2));
    chmod600(tmp);
    fs.renameSync(tmp, this.file);
  }

  startPair(opts = {}) {
    if (this.devices.filter((d) => !d.revoked).length >= MAX_DEVICES) {
      return { error: 'max-devices' };
    }
    this._expire();
    const deviceId = 'dev_' + crypto.randomBytes(6).toString('hex');
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    const token = crypto.randomBytes(32).toString('hex');
    const entry = {
      deviceId,
      code,
      name: opts.name || null,
      token,
      tokenHash: hashToken(token),
      scopes: ['*'],
      createdAt: new Date().toISOString(),
      expiresAt: Date.now() + PAIR_TTL_MS,
      revoked: false,
    };
    this.pendingPairs.push(entry);
    this.pendingPairs = this.pendingPairs.slice(-20);
    return { deviceId, code, expiresIn: PAIR_TTL_MS, token };
  }

  claimPair(code, opts = {}) {
    this._expire();
    if (this.rateLimit && !this.rateLimit('pair:' + String(code)).ok) {
      return { error: 'rate-limited' };
    }
    const idx = this.pendingPairs.findIndex((p) => p.code === code);
    if (idx < 0) return { error: 'invalid-code' };
    const p = this.pendingPairs[idx];
    this.pendingPairs.splice(idx, 1);
    const rec = {
      deviceId: p.deviceId,
      name: opts.name || p.name || 'Mobile',
      tokenHash: p.tokenHash,
      scopes: p.scopes,
      createdAt: p.createdAt,
      lastSeen: new Date().toISOString(),
      revoked: false,
    };
    this.devices.push(rec);
    this._persist();
    return { deviceId: rec.deviceId, token: p.token };
  }

  _expire(now = Date.now()) {
    const before = this.pendingPairs.length;
    this.pendingPairs = this.pendingPairs.filter((p) => p.expiresAt > now);
    return before !== this.pendingPairs.length;
  }

  lookupDeviceByToken(token) {
    const h = hashToken(token);
    const d = this.devices.find((x) => !x.revoked && safeEqual(x.tokenHash, h));
    if (d) {
      d.lastSeen = new Date().toISOString();
      this._persist();
    }
    return d || null;
  }

  isRevoked(deviceId) {
    const d = this.devices.find((x) => x.deviceId === deviceId);
    return !d || d.revoked;
  }

  revoke(deviceId) {
    const d = this.devices.find((x) => x.deviceId === deviceId);
    if (!d) return false;
    d.revoked = true;
    this._persist();
    return true;
  }

  list() {
    return this.devices.map((d) => ({
      deviceId: d.deviceId,
      name: d.name,
      scopes: d.scopes,
      createdAt: d.createdAt,
      lastSeen: d.lastSeen,
      revoked: d.revoked,
    }));
  }
}

module.exports = { DeviceRegistry, PAIR_TTL_MS };