'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const MCP_CMD = 'engram';
const MCP_ARGS = ['serve-mcp'];
const MCP_NAME = 'engram';
const CONF = {
  claude: () => ({ json: path.join(os.homedir(), '.claude.json') }),
  codex: () => ({ toml: path.join(os.homedir(), '.codex', 'config.toml') }),
  gemini: () => ({ json: path.join(os.homedir(), '.gemini', 'settings.json') }),
  opencode: () => ({ jsonc: opencodeConfigPath() }),
  cline: () => ({ json: clineConfigPath() }),
  cursor: () => ({ json: path.join(os.homedir(), '.cursor', 'mcp.json') }),
};

function opencodeConfigPath() {
  const dir = path.join(os.homedir(), '.config', 'opencode');
  const json = path.join(dir, 'opencode.json');
  const jsonc = path.join(dir, 'opencode.jsonc');
  if (fs.existsSync(json)) return json;
  return jsonc;
}

function clineConfigPath() {
  const home = os.homedir();
  const cli = path.join(home, '.cline', 'data', 'settings', 'cline_mcp_settings.json');
  const ext = path.join(home, '.cline', 'cline_mcp_settings.json');
  if (fs.existsSync(cli)) return cli;
  return ext;
}

function isClineCli() {
  try {
    const v = execFileSync('cline', ['--version'], { encoding: 'utf8' }).trim();
    return /^\d+\.\d+\.\d+$/.test(v);
  } catch (_) {
    return false;
  }
}

function cmdExists(name) {
  try {
    execFileSync('which', [name], { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

function readFile(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (_) {
    return null;
  }
}

function exists(p) {
  return p != null && fs.existsSync(p);
}

function backup(p) {
  try {
    if (fs.existsSync(p)) {
      fs.copyFileSync(p, p + '.engram-bak');
      return true;
    }
  } catch (_) { /* ignore */ }
  return false;
}

function stripJsonComments(src) {
  let out = '';
  let inStr = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\') { out += n; i++; }
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 1;
      continue;
    }
    out += c;
  }
  return out;
}

function loadJsonc(p) {
  const s = readFile(p);
  if (s === null) return { ok: false, missing: true };
  try {
    return { ok: true, value: JSON.parse(s), comments: false };
  } catch (_) { /* fall through */ }
  try {
    return { ok: true, value: JSON.parse(stripJsonComments(s)), comments: true };
  } catch (_) {
    return { ok: false, error: 'unparseable' };
  }
}

function deepSet(obj, keys, value) {
  let node = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (typeof node[k] !== 'object' || node[k] === null) node[k] = {};
    node = node[k];
  }
  node[keys[keys.length - 1]] = value;
}

function hasDeep(obj, keys) {
  let node = obj;
  for (const k of keys) {
    if (node == null || typeof node !== 'object' || !(k in node)) return false;
    node = node[k];
  }
  return true;
}

function mcpEntry() {
  return { command: MCP_CMD, args: MCP_ARGS };
}

function freebuffEntry() {
  return { type: 'stdio', command: MCP_CMD, args: MCP_ARGS };
}

function inToml(content, header) {
  const needle = '[' + header + ']';
  return content.split('\n').some((l) => l.trim() === needle);
}

function appendToml(p, header, body) {
  const cur = readFile(p) || '';
  if (inToml(cur, header)) return { ok: false, message: 'already configured' };
  backup(p);
  const add = (cur.trim() === '' ? '' : '\n') + `[${header}]\n` + body.map((l) => `  ${l}`).join('\n') + '\n';
  fs.writeFileSync(p, cur + add);
  return { ok: true, message: 'added' };
}

function tryExec(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: 'ignore' });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function maybeCleanup(ctx, note) {
  return Object.assign({ ok: false, message: note }, ctx);
}

const ADAPTERS = {
  claude: {
    label: 'Claude Code',
    detect: () => cmdExists('claude') || exists(CONF.claude().json),
    integrate: () => {
      const p = CONF.claude().json;
      const j = exists(p) ? loadJsonc(p) : { ok: false };
      if (j.ok && hasDeep(j.value, ['mcpServers', MCP_NAME])) {
        return { ok: false, message: 'already configured in ~/.claude.json' };
      }
      if (!cmdExists('claude')) return maybeCleanup({}, 'claude binary missing; cannot register');
      const r = tryExec('claude', ['mcp', 'add', MCP_NAME, '--scope', 'user', '--', ...MCP_CMD.split(' '), ...MCP_ARGS]);
      const after = loadJsonc(p);
      if (after.ok && hasDeep(after.value, ['mcpServers', MCP_NAME])) {
        return { ok: true, message: 'claude mcp add engram (user scope)' };
      }
      return maybeCleanup({ error: r.error }, 'claude mcp add failed: ' + (r.error || 'unknown'));
    },
    describe: () => path.join(os.homedir(), '.claude.json'),
  },
  codex: {
    label: 'Codex CLI',
    detect: () => cmdExists('codex') || exists(CONF.codex().toml),
    integrate: () => {
      if (cmdExists('codex')) {
        const r = tryExec('codex', ['mcp', 'add', MCP_NAME, '--', ...MCP_CMD.split(' '), ...MCP_ARGS]);
        if (r.ok) return { ok: true, message: 'codex mcp add engram' };
      }
      const p = CONF.codex().toml;
      if (!exists(p)) return maybeCleanup({}, 'no codex config to edit');
      return appendToml(p, 'mcp_servers.engram', ['command = "engram"', 'args = ["serve-mcp"]']);
    },
    describe: () => CONF.codex().toml,
  },
  gemini: {
    label: 'Gemini CLI',
    detect: () => cmdExists('gemini') || exists(CONF.gemini().json),
    integrate: () => {
      const p = CONF.gemini().json;
      if (!exists(p)) return maybeCleanup({}, 'no gemini settings.json to edit');
      const j = loadJsonc(p);
      if (!j.ok) return maybeCleanup({}, 'gemini settings unparseable');
      if (hasDeep(j.value, ['mcpServers', MCP_NAME])) return { ok: false, message: 'already configured' };
      backup(p);
      deepSet(j.value, ['mcpServers', MCP_NAME], mcpEntry());
      fs.writeFileSync(p, JSON.stringify(j.value, null, 2) + '\n');
      return { ok: true, message: 'added mcpServers.engram to ' + p };
    },
    describe: () => CONF.gemini().json,
  },
  opencode: {
    label: 'opencode',
    detect: () => cmdExists('opencode') || exists(opencodeConfigPath()),
    integrate: () => {
      const p = opencodeConfigPath();
      if (!exists(p)) {
        const dir = path.dirname(p);
        fs.mkdirSync(dir, { recursive: true });
        return { ok: false, message: 'no opencode config yet; created ' + dir };
      }
      const j = loadJsonc(p);
      if (!j.ok) return maybeCleanup({}, 'opencode config unparseable');
      if (hasDeep(j.value, ['mcp', MCP_NAME])) return { ok: false, message: 'already configured' };
      backup(p);
      if (!j.value.mcp) j.value.mcp = {};
      j.value.mcp[MCP_NAME] = Object.assign({ type: 'local' }, mcpEntry(), { enabled: true });
      fs.writeFileSync(p, JSON.stringify(j.value, null, 2) + '\n');
      return { ok: true, message: 'added mcp.engram to ' + p };
    },
    describe: opencodeConfigPath,
  },
  cline: {
    label: 'Cline',
    detect: () => cmdExists('cline') || fs.existsSync(path.join(os.homedir(), '.cline')),
    integrate: () => {
      const cli = isClineCli();
      const p = cli
        ? path.join(os.homedir(), '.cline', 'data', 'settings', 'cline_mcp_settings.json')
        : path.join(os.homedir(), '.cline', 'cline_mcp_settings.json');
      const dir = path.dirname(p);
      fs.mkdirSync(dir, { recursive: true });
      const j = loadJsonc(p);
      const obj = j.ok && typeof j.value === 'object' ? j.value : { mcpServers: {} };
      if (!obj.mcpServers || typeof obj.mcpServers !== 'object') obj.mcpServers = {};
      if (hasDeep(obj, ['mcpServers', MCP_NAME])) return { ok: false, message: 'already configured' };
      backup(p);
      obj.mcpServers[MCP_NAME] = cli
        ? { transport: { type: 'stdio', command: MCP_CMD, args: MCP_ARGS } }
        : mcpEntry();
      fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
      const fmt = cli ? 'transport (cli 3.x)' : 'legacy flat (extension)';
      return { ok: true, message: 'added mcpServers.engram (' + fmt + ') to ' + p };
    },
    describe: () => CONF.cline().json,
  },
  cursor: {
    label: 'Cursor',
    detect: () => cmdExists('cursor') || fs.existsSync(path.join(os.homedir(), '.cursor')),
    integrate: () => {
      const p = CONF.cursor().json;
      if (!fs.existsSync(p)) return maybeCleanup({}, 'no ~/.cursor/mcp.json (create in editor UI)');
      const j = loadJsonc(p);
      if (!j.ok) return maybeCleanup({}, 'cursor mcp.json unparseable');
      if (hasDeep(j.value, ['mcpServers', MCP_NAME])) return { ok: false, message: 'already configured' };
      backup(p);
      deepSet(j.value, ['mcpServers', MCP_NAME], mcpEntry());
      fs.writeFileSync(p, JSON.stringify(j.value, null, 2) + '\n');
      return { ok: true, message: 'added mcpServers.engram to ' + p };
    },
    describe: () => CONF.cursor().json,
  },
  freebuff: {
    label: 'Freebuff',
    detect: () => cmdExists('freebuff'),
    integrate: () => {
      const base = path.join(os.homedir(), '.agents');
      const p = path.join(base, 'mcp.json');
      fs.mkdirSync(base, { recursive: true });
      const j = loadJsonc(p);
      const obj = j.ok && typeof j.value === 'object' ? j.value : { mcpServers: {} };
      if (!obj.mcpServers || typeof obj.mcpServers !== 'object') obj.mcpServers = {};
      if (hasDeep(obj, ['mcpServers', MCP_NAME])) return { ok: false, message: 'already configured' };
      backup(p);
      obj.mcpServers[MCP_NAME] = freebuffEntry();
      fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
      return { ok: true, message: 'added mcpServers.engram to ' + p + ' (Freebuff/Codebuff loads .agents/mcp.json: cwd, parent, ~/.agents)' };
    },
    describe: () => path.join(os.homedir(), '.agents', 'mcp.json'),
  },
};

const ORDER = [
  ['claude', ADAPTERS.claude],
  ['codex', ADAPTERS.codex],
  ['gemini', ADAPTERS.gemini],
  ['opencode', ADAPTERS.opencode],
  ['cline', ADAPTERS.cline],
  ['cursor', ADAPTERS.cursor],
  ['freebuff', ADAPTERS.freebuff],
];

function scan() {
  const found = [];
  for (const [name, ad] of ORDER) {
    let detected = false;
    try { detected = ad.detect(); } catch (_) { detected = false; }
    if (detected) {
      let desc = '';
      try { desc = ad.describe(); } catch (_) { desc = ''; }
      found.push({ name, label: ad.label, config: desc });
    }
  }
  return found;
}

function integrate(agent) {
  const ad = ADAPTERS[agent];
  if (!ad) return { ok: false, message: 'no adapter for ' + agent };
  try {
    return ad.integrate();
  } catch (e) {
    return { ok: false, message: e.message || String(e) };
  }
}

function install() {
  const found = scan();
  const results = [];
  for (const f of found) {
    const r = integrate(f.name);
    results.push({ name: f.name, label: f.label, ok: r.ok, message: r.message });
  }
  return results;
}

module.exports = {
  scan, integrate, install, stripJsonComments, loadJsonc, deepSet, opencodeConfigPath, clineConfigPath, isClineCli, appendToml, cmdExists,
};