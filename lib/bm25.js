'use strict';

const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'with',
  'is', 'are', 'was', 'were', 'it', 'its', 'this', 'that', 'as', 'at', 'by',
  'from', 'not', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does',
  'did', 'i', 'we', 'you', 'he', 'she', 'they', 'them', 'their', 'there',
]);

const K1 = 1.2;
const B = 0.75;
const EPS = 0.25;

function tokenize(text) {
  if (typeof text !== 'string') return [];
  const raw = text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) || [];
  return raw.filter((t) => t.length > 1 && !STOP.has(t));
}

function idf(term, df, n) {
  return Math.log(1 + (n - df + 0.5) / (df + 0.5));
}

function buildModel(docs) {
  const n = docs.length;
  const dlSum = docs.reduce((s, d) => s + d.terms.length, 0);
  const avgdl = n ? dlSum / n : 0;
  const df = new Map();
  for (const d of docs) {
    const seen = new Set();
    for (const t of d.terms) {
      if (!seen.has(t)) {
        seen.add(t);
        df.set(t, (df.get(t) || 0) + 1);
      }
    }
  }
  return { n, avgdl, df };
}

function scoreTerms(query, doc, model) {
  if (!model.n) return 0;
  const tf = new Map();
  for (const t of doc.terms) tf.set(t, (tf.get(t) || 0) + 1);
  const dl = doc.terms.length;
  let total = 0;
  for (const t of query) {
    const f = tf.get(t) || 0;
    if (!f) continue;
    const w = idf(t, model.df.get(t) || 0, model.n);
    total += (w * (f * (K1 + 1))) / (f + K1 * (1 - B + (B * dl) / (EPS + model.avgdl)));
  }
  return total;
}

function search(texts, query, limit = 50) {
  const docs = texts.map((t, i) => ({ i, terms: tokenize(t) }));
  const q = tokenize(query);
  if (!q.length) {
    return texts.map((t, i) => ({ index: i, score: 0 }));
  }
  const model = buildModel(docs);
  const results = docs.map((d) => ({ index: d.i, score: scoreTerms(q, d, model) }));
  return results
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Math.min(limit, 100)));
}

module.exports = { tokenize, search, buildModel, scoreTerms };