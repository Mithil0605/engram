'use strict';

class RateLimiter {
  constructor(opts = {}) {
    this.windowMs = opts.windowMs || 60_000;
    this.max = opts.max || 120;
    this.buckets = new Map();
    this.cleanupTimer = setInterval(() => this._cleanup(), this.windowMs * 2);
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
  }

  _cleanup(now = Date.now()) {
    for (const [k, v] of this.buckets) {
      if (v.resetAt <= now) this.buckets.delete(k);
    }
  }

  hit(key) {
    const now = Date.now();
    const b = this.buckets.get(key);
    if (!b || b.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return { ok: true };
    }
    b.count += 1;
    if (b.count > this.max) {
      return { ok: false, retryAfter: Math.ceil((b.resetAt - now) / 1000) };
    }
    return { ok: true };
  }

  close() {
    clearInterval(this.cleanupTimer);
  }
}

module.exports = { RateLimiter };