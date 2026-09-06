'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { stripJsonComments, loadJsonc, deepSet, appendToml } = require('../lib/agents');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'engram-agents-'));
}

test('stripJsonComments keeps strings intact and drops // and /* */', () => {
  const src = '{ "a": "https://opencode.ai/config.json", // hi\n "b": /* c */ 1, "c": [/* x */] }';
  const out = stripJsonComments(src);
  assert.ok(out.includes('"https://opencode.ai/config.json"'));
  assert.ok(out.includes('"b": '));
  assert.ok(!out.includes('hi'));
  assert.ok(!out.includes('c */'));
  assert.equal(JSON.parse(out).b, 1);
});

test('loadJsonc parses plain JSON and comment-stripped JSONC', () => {
  const f = path.join(tmp(), 'c.jsonc');
  fs.writeFileSync(f, '{\n  // note\n  "x": 1,\n  "y": "keep this" \n}\n');
  const r = loadJsonc(f);
  assert.equal(r.ok, true);
  assert.equal(r.value.x, 1);
  assert.equal(r.value.y, 'keep this');
});

test('deepSet creates nested objects and leaf values', () => {
  const obj = {};
  deepSet(obj, ['mcp', 'engram', 'enabled'], true);
  assert.deepEqual(obj, { mcp: { engram: { enabled: true } } });
});

test('appendToml adds a section once and reports already configured', () => {
  const f = path.join(tmp(), 'config.toml');
  fs.writeFileSync(f, 'model = "gpt-5.5"\n');
  let r = appendToml(f, 'mcp_servers.engram', ['command = "engram"', 'args = ["serve-mcp"]']);
  assert.equal(r.ok, true);
  const once = fs.readFileSync(f, 'utf8');
  assert.ok(once.includes('[mcp_servers.engram]'));
  assert.ok(once.includes('command = "engram"'));
  assert.equal(once.split('[mcp_servers.engram]').length - 1, 1);
  r = appendToml(f, 'mcp_servers.engram', ['command = "engram"', 'args = ["serve-mcp"]']);
  assert.equal(r.ok, false);
  assert.match(r.message, /already configured/);
  assert.equal(fs.readFileSync(f, 'utf8').split('[mcp_servers.engram]').length - 1, 1);
});