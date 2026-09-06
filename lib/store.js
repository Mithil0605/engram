'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { encryptBlob, decryptBlob, MAGIC } = require('./crypto');
const { tokenize, search } = require('./bm25');
const { ensureDir, chmod600 } = require('./paths');

const MAX_RECORDS = 10000;
const SIM_THRESHOLD = 0.9;

class LockedError extends Error {
  constructor() {
    super('store is encrypted and locked');
    this.code = 'LOCKED';
  }
}

function normText(s) {
  return String(s).toLowerCase().replace(/\s+/g, ' ').trim();
}

function sim(a, b) {
  const shingles = (s) => {
    const out = new Set();
    const t = s;
    if (t.length <= 4) return new Set([t]);
    for (let i = 0; i <= t.length - 4; i++) out.add(t.slice(i, i + 4));
    return out;
  };
  const A = shingles(a);
  const B = shingles(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

function sortTags(tags) {
  const cleaned = (Array.isArray(tags) ? tags : [])
    .map((t) => String(t).trim().slice(0, 40))
    .filter(Boolean);
  return [...new Set(cleaned)].sort();
}

class Store {
  constructor(file, project) {
    this.file = file;
    this.project = project || null;
    this.mutex = Promise.resolve();
    this.records = [];
    this.loaded = false;
    this.password = null;
    this.encrypted = false;
  }

  _lock() {
    let release;
    const next = new Promise((r) => (release = r));
    const prev = this.mutex;
    this.mutex = prev.then(() => next);
    return prev.then(() => release);
  }

  _loadLocked() {
    if (this.loaded) return;
    if (!fs.existsSync(this.file)) {
      this.loaded = true;
      return;
    }
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (e) {
      throw new Error(`cannot read store: ${e.message}`);
    }
    if (raw.startsWith(MAGIC)) {
      this.encrypted = true;
      if (!this.password) throw new LockedError();
      try {
        raw = decryptBlob(raw, this.password);
      } catch (_) {
        throw new LockedError();
      }
    }
    this.records = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        this.records.push(JSON.parse(line));
      } catch (_) {
        /* skip corrupt line */
      }
    }
    this.loaded = true;
  }

  async init(password) {
    if (password !== undefined && password !== null && password !== '') {
      this.password = String(password);
    }
    this._loadLocked();
    if (this.password && !this.encrypted) {
      this.encrypted = true;
    }
    return this;
  }

  _serialize() {
    return this.records.map((r) => JSON.stringify(r)).join('\n') + (this.records.length ? '\n' : '');
  }

  async _persist() {
    const data = this._serialize();
    const dir = path.dirname(this.file);
    ensureDir(dir);
    const tmp = this.file + '.' + process.pid + '.tmp';
    let out = data;
    if (this.encrypted) {
      out = encryptBlob(data, this.password);
    }
    fs.writeFileSync(tmp, out);
    chmod600(tmp);
    fs.renameSync(tmp, this.file);
  }

  enableEncryption(password) {
    if (this.encrypted && this.password && this.password !== String(password)) {
      this._loadLocked();
    }
    this.password = String(password);
    this.encrypted = true;
    return this._persist();
  }

  async add({ text, tags, pinned, source, session }) {
    const release = await this._lock();
    try {
      this._loadLocked();
      const clean = String(text).trim();
      if (!clean) throw new Error('text required');
      const norm = normText(clean);
      const sess = session !== undefined && session !== null && String(session).trim() !== ''
        ? String(session).trim().slice(0, 200)
        : null;
      // an agent session is identified by `session` and stored exactly once:
      // re-sending the same session updates the existing record in place.
      if (sess) {
        const existing = this.records.find((r) => r.session === sess);
        if (existing) {
          existing.text = clean;
          existing.session = sess;
          if (source !== undefined) existing.source = String(source);
          if (tags !== undefined) existing.tags = sortTags(tags);
          if (pinned !== undefined) existing.pinned = Boolean(pinned);
          existing.updatedAt = new Date().toISOString();
          await this._persist();
          return { record: existing, updated: true, dedupe: 'session' };
        }
      }
      for (const r of this.records) {
        if (sim(norm, normText(r.text)) >= SIM_THRESHOLD) {
          r.text = clean;
          if (session !== undefined) r.session = sess;
          if (source !== undefined) r.source = String(source);
          if (tags !== undefined) r.tags = sortTags(tags);
          if (pinned !== undefined) r.pinned = Boolean(pinned);
          r.updatedAt = new Date().toISOString();
          await this._persist();
          return { record: r, updated: true };
        }
      }
      if (this.records.length >= MAX_RECORDS) {
        throw new Error(`store full (${MAX_RECORDS} records)`);
      }
      const rec = {
        id: crypto.randomUUID(),
        project: this.project,
        text: clean,
        tags: sortTags(tags),
        pinned: Boolean(pinned),
        source: source !== undefined ? String(source) : 'manual',
        session: sess,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      this.records.push(rec);
      await this._persist();
      return { record: rec, updated: false };
    } finally {
      release();
    }
  }

  async update(id, fields) {
    const release = await this._lock();
    try {
      this._loadLocked();
      const r = this.records.find((x) => x.id === id);
      if (!r) return null;
      if (fields.text !== undefined) r.text = String(fields.text).trim();
      if (fields.tags !== undefined) r.tags = sortTags(fields.tags);
      if (fields.pinned !== undefined) r.pinned = Boolean(fields.pinned);
      if (fields.source !== undefined) r.source = String(fields.source);
      if (fields.session !== undefined) r.session = fields.session;
      r.updatedAt = new Date().toISOString();
      await this._persist();
      return r;
    } finally {
      release();
    }
  }

  async forget(id) {
    const release = await this._lock();
    try {
      this._loadLocked();
      const before = this.records.length;
      this.records = this.records.filter((x) => x.id !== id);
      if (this.records.length === before) return false;
      await this._persist();
      return true;
    } finally {
      release();
    }
  }

  async forgetSession(session) {
    const release = await this._lock();
    try {
      this._loadLocked();
      const target = session === undefined || session === null ? '' : String(session).trim();
      if (!target) return 0;
      const before = this.records.length;
      this.records = this.records.filter((r) => !(r.session === target));
      const removed = before - this.records.length;
      if (removed) await this._persist();
      return removed;
    } finally {
      release();
    }
  }

  snapshot() {
    this._loadLocked();
    return this.records.slice();
  }

  searchRecords(query, limit = 20, pinnedFirst = false) {
    this._loadLocked();
    const recs = this.snapshot();
    if (!query || !String(query).trim()) {
      const sorted = recs
        .slice()
        .sort((a, b) => Number(b.pinned) - Number(a.pinned) || (b.updatedAt < a.updatedAt ? -1 : 1));
      return sorted.slice(0, Math.max(1, Math.min(limit, 200)));
    }
    const hits = search(recs.map((r) => r.text), String(query), limit);
    const out = hits.map((h) => ({ ...recs[h.index], score: h.score }));
    const remaining = recs
      .filter((r) => !hits.some((h) => recs[h.index].id === r.id))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned));
    if (pinnedFirst) {
      return [...out, ...remaining].slice(0, Math.max(1, Math.min(limit, 200)));
    }
    return out;
  }

  export() {
    return this.snapshot();
  }
}

function projectFileName(root, project) {
  return crypto.createHash('sha256').update(String(project)).digest('hex') + '.store';
}

module.exports = { Store, LockedError, projectFileName, normText, sim };