'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../lib/store');
const { search, tokenize } = require('../lib/bm25');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'engram-'));
}

test('bm25 ranks relevant docs first', () => {
  const texts = [
    'tests should use npm test',
    'the weather in tokyo today',
    'npm test runs, npm test again',
    'buy milk',
  ];
  const hits = search(texts, 'npm test', 4);
  assert.equal(hits.length, 2);
  assert.equal(hits[0].index, 2);
  assert.equal(hits[1].index, 0);
  assert.ok(hits[0].score > hits[1].score);
});

test('tokenize is unicode-safe and drops stopwords', () => {
  const t = tokenize('The quick brown-FOX jumps over the lazy dog 🦊');
  assert.ok(t.includes('fox'));
  assert.ok(t.includes('quick'));
  assert.ok(t.includes('lazy'));
  assert.ok(!t.includes('the'));
});

test('add, dedupe, update, forget, search roundtrip', async () => {
  const dir = tmp();
  const s = await new Store(path.join(dir, 'p.store'), 'p').init();
  const a = await s.add({ text: 'run tests with npm test', tags: ['tests'] });
  assert.equal(a.updated, false);
  assert.ok(a.record.id);
  // near-duplicate triggers update, not new record
  const b = await s.add({ text: 'Run tests with npm test!', tags: ['tests'] });
  assert.equal(b.updated, true);
  assert.equal(b.record.id, a.record.id);
  assert.equal(s.snapshot().length, 1);
  // search finds it
  const hits = s.searchRecords('run tests');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, a.record.id);
  // update tags/pin
  await s.update(a.record.id, { pinned: true });
  assert.equal(s.snapshot()[0].pinned, true);
  // forget
  assert.equal(await s.forget(a.record.id), true);
  assert.equal(s.snapshot().length, 0);
});

test('encryption roundtrip + LockedError', async () => {
  const dir = tmp();
  const file = path.join(dir, 'p.store');
  const s1 = await new Store(file, 'p').init('s3cret-pw');
  await s1.add({ text: 'encrypted hello world' });
  const onDisk = fs.readFileSync(file, 'utf8');
  assert.ok(onDisk.startsWith('ENGRAM_ENC_V2:'));
  assert.ok(!onDisk.includes('hello world'));
  // second store with no password must be locked
  const s2 = new Store(file, 'p');
  await assert.rejects(s2.init(), (e) => e.code === 'LOCKED');
  // with correct password loads
  const s3 = await new Store(file, 'p').init('s3cret-pw');
  assert.equal(s3.records[0].text, 'encrypted hello world');
});

test('plaintext store is written as JSON lines', async () => {
  const dir = tmp();
  const file = path.join(dir, 'p.store');
  const s = await new Store(file, 'p').init();
  await s.add({ text: 'plain hello' });
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(raw.includes('"text":"plain hello"'));
});

test('corrupt lines are skipped safely', async () => {
  const dir = tmp();
  const file = path.join(dir, 'p.store');
  fs.writeFileSync(file, '{"id":"1","text":"ok"}\nnot json at all\n');
  const s = await new Store(file, 'p').init();
  assert.equal(s.records.length, 1);
  assert.equal(s.records[0].text, 'ok');
});

test('store caps at MAX_RECORDS', async () => {
  const dir = tmp();
  const s = await new Store(path.join(dir, 'p.store'), 'p').init();
  // preload the store to the cap without hitting disk
  s.records = [];
  for (let i = 0; i < 10000; i++) s.records.push({ id: 'x' + i, text: 'unique filler ' + i });
  await assert.rejects(s.add({ text: 'completely unique new text here' }));
});

test('an agent session is stored once (upsert by session) and deleted wholly', async () => {
  const dir = tmp();
  const s = await new Store(path.join(dir, 'p.store'), 'p').init();
  const r1 = await s.add({ text: 'first message', session: 'sess-1', source: 'agent' });
  const r2 = await s.add({ text: 'second message', session: 'sess-1', source: 'agent' });
  const r3 = await s.add({ text: 'another session', session: 'sess-2' });
  assert.equal(r1.updated, false);
  assert.equal(r2.updated, true, 'same session must not duplicate');
  assert.equal(r2.dedupe, 'session');
  assert.equal(r2.record.id, r1.record.id);
  assert.equal(r2.record.text, 'second message');
  assert.equal(s.snapshot().length, 2);

  const removed = await s.forgetSession('sess-1');
  assert.equal(removed, 1);
  const left = s.snapshot();
  assert.equal(left.length, 1);
  assert.equal(left[0].session, 'sess-2');
});

test('records without a session keep text-similarity dedupe', async () => {
  const dir = tmp();
  const s = await new Store(path.join(dir, 'p.store'), 'p').init();
  const a = await s.add({ text: 'build the bridge' });
  const b = await s.add({ text: 'build the bridge' });
  assert.equal(b.updated, true);
  assert.equal(b.record.id, a.record.id);
  const c = await s.add({ text: 'completely unrelated fact' });
  assert.equal(c.updated, false);
  assert.equal(s.snapshot().length, 2);
});