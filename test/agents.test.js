'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('node:child_process');
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

test('cline integrate writes the CLI transport format under .cline/data/settings', () => {
  const script = `
    const a = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'agents.js'))});
    process.stdout.write(JSON.stringify(a.integrate('cline')));
  `;
  const home = tmp();
  fs.mkdirSync(path.join(home, '.cline', 'data', 'settings'), { recursive: true });
  const res = spawnSync(process.execPath, ['-e', script], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.ok, true);
  assert.match(out.message, /transport/i);
  const cfg = JSON.parse(fs.readFileSync(path.join(home, '.cline', 'data', 'settings', 'cline_mcp_settings.json'), 'utf8'));
  assert.deepEqual(cfg.mcpServers.engram, { transport: { type: 'stdio', command: 'engram', args: ['serve-mcp'] } });
  const again = JSON.parse(spawnSync(process.execPath, ['-e', script], { env: { ...process.env, HOME: home }, encoding: 'utf8' }).stdout);
  assert.equal(again.ok, false);
  assert.match(again.message, /already configured/);
  const finalCfg = JSON.parse(fs.readFileSync(path.join(home, '.cline', 'data', 'settings', 'cline_mcp_settings.json'), 'utf8'));
  assert.deepEqual(finalCfg.mcpServers.engram, { transport: { type: 'stdio', command: 'engram', args: ['serve-mcp'] } });
});

test('freebuff integrate writes the stdio format to ~/.agents/mcp.json', () => {
  const script = `
    const a = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'agents.js'))});
    process.stdout.write(JSON.stringify(a.integrate('freebuff')));
  `;
  const home = tmp();
  const res = spawnSync(process.execPath, ['-e', script], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.ok, true);
  const p = path.join(home, '.agents', 'mcp.json');
  const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.deepEqual(cfg.mcpServers.engram, { type: 'stdio', command: 'engram', args: ['serve-mcp'] });
  const again = JSON.parse(spawnSync(process.execPath, ['-e', script], { env: { ...process.env, HOME: home }, encoding: 'utf8' }).stdout);
  assert.equal(again.ok, false);
  assert.match(again.message, /already configured/);
});