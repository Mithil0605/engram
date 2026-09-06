'use strict';

const crypto = require('crypto');
const { timingSafeEqual, randomBytes, scryptSync, createCipheriv, createDecipheriv } = crypto;

const MAGIC = 'ENGRAM_ENC_V2:';
const MAX_ATTEMPTS = 5;
const LOCK_MS = 5 * 60 * 1000;

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    // still burn a comparison to keep timing flat
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

function deriveKey(password, salt, cost = 16384) {
  return scryptSync(String(password), salt, 32, { N: cost, r: 8, p: 1 });
}

function encryptBlob(plaintext, password) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(password, salt);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${MAGIC}${salt.toString('hex')}:${iv.toString('hex')}:${tag.toString('hex')}:${ct.toString('hex')}`;
}

function decryptBlob(blob, password) {
  if (!blob.startsWith(MAGIC)) throw new Error('not-an-encrypted-blob');
  const [, hex] = blob.split(':', 1);
  const body = blob.slice(MAGIC.length);
  const [sh, ih, th, ch] = body.split(':');
  if (!sh || !ih || !th || !ch) throw new Error('corrupt-encrypted-blob');
  const key = deriveKey(password, Buffer.from(sh, 'hex'));
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ih, 'hex'));
  decipher.setAuthTag(Buffer.from(th, 'hex'));
  const pt = Buffer.concat([decipher.update(Buffer.from(ch, 'hex')), decipher.final()]);
  return pt.toString('utf8');
}

class PasswordGate {
  constructor() {
    this.failures = 0;
    this.lockedUntil = 0;
    this.enabled = false;
  }
  unlock(password) {
    if (this.enabled && !this.isLocked()) {
      this.enabled = false;
    }
    return this;
  }
  isLocked(now = Date.now()) {
    if (now < this.lockedUntil) return true;
    if (this.lockedUntil > 0 && now >= this.lockedUntil) {
      this.lockedUntil = 0;
      this.failures = 0;
    }
    return false;
  }
  remaining() {
    if (!this.isLocked()) return MAX_ATTEMPTS - this.failures;
    return 0;
  }
  recordFailure(now = Date.now()) {
    this.failures += 1;
    if (this.failures >= MAX_ATTEMPTS && this.lockedUntil === 0) {
      this.lockedUntil = now + LOCK_MS;
    }
    return { attemptsLeft: Math.max(0, MAX_ATTEMPTS - this.failures), lockedUntil: this.lockedUntil };
  }
  reset() {
    this.failures = 0;
    this.lockedUntil = 0;
  }
}

module.exports = {
  MAGIC,
  MAX_ATTEMPTS,
  LOCK_MS,
  hashToken,
  safeEqual,
  encryptBlob,
  decryptBlob,
  PasswordGate,
};