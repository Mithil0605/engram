'use strict';

const http = require('http');
const readline = require('readline');

const TOOLS = [
  {
    name: 'remember',
    description: 'Persist a fact/preference/decision for a project so every agent shares it.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        text: { type: 'string' },
        session: { type: 'string', description: 'agent session id; sends store the session once, re-sends update in place' },
        tags: { type: 'array', items: { type: 'string' } },
        pinned: { type: 'boolean' },
      },
      required: ['text'],
    },
  },
  {
    name: 'endsession',
    description: 'Permanently delete an agent session and every memory stored under it.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        session: { type: 'string', description: 'session id to delete' },
      },
      required: ['session'],
    },
  },
  {
    name: 'recall',
    description: 'Ranked search over shared project memory.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        query: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['query'],
    },
  },
  {
    name: 'list',
    description: 'List recent memories for a project.',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string' }, limit: { type: 'number' } },
    },
  },
  {
    name: 'update',
    description: 'Update an existing memory by id.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        id: { type: 'string' },
        text: { type: 'string' },
        pinned: { type: 'boolean' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['id'],
    },
  },
  {
    name: 'forget',
    description: 'Delete a memory by id.',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string' }, id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'prune',
    description: 'Delete memories matching query/tags (commit=true to delete).',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        query: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        commit: { type: 'boolean' },
      },
    },
  },
];

let _api = null;
function apiFor(conf) {
  if (_api) return _api;
  const { url, token } = conf;
  _api = {
    req(method, p, body) {
      return new Promise((resolve, reject) => {
        const u = new URL(p, url);
        const headers = { Authorization: `Bearer ${token}` };
        if (body !== undefined) {
          const raw = JSON.stringify(body);
          headers['Content-Type'] = 'application/json';
          headers['Content-Length'] = Buffer.byteLength(raw);
          body = raw;
        }
        const r = http.request(u, { method, headers }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            let j = {};
            try { j = JSON.parse(Buffer.concat(chunks).toString()); } catch (_) { j = {}; }
            resolve({ status: res.statusCode, body: j });
          });
        });
        r.on('error', reject);
        if (body !== undefined) r.write(body);
        r.end();
      });
    },
  };
  return _api;
}

async function callTool(conf, name, args = {}) {
  const a = apiFor(conf);
  const project = args.project || 'default';
  switch (name) {
    case 'remember': {
      const r = await a.req('POST', '/v1/remember', {
        project, text: args.text, tags: args.tags, pinned: args.pinned, session: args.session, source: 'mcp',
      });
      if (r.status !== 200) return { isError: true, content: [{ type: 'text', text: JSON.stringify(r.body) }] };
      return { content: [{ type: 'text', text: `remembered ${r.body.record.id}${r.body.updated ? ' (updated)' : ''}` }] };
    }
    case 'endsession': {
      const r = await a.req('POST', '/v1/prune', { project, session: args.session, commit: true });
      if (r.status !== 200) return { isError: true, content: [{ type: 'text', text: JSON.stringify(r.body) }] };
      return { content: [{ type: 'text', text: `ended session ${args.session}: ${r.body.deleted} memory deleted` }] };
    }
    case 'recall': {
      const q = encodeURIComponent(args.query || '');
      const l = Number(args.limit) || 10;
      const r = await a.req('GET', `/v1/recall?project=${encodeURIComponent(project)}&query=${q}&limit=${l}`);
      const lines = (r.body.results || []).map((it) => `- [${it.score ? it.score.toFixed(2) : '-'}] ${it.id}: ${it.text}`);
      return { content: [{ type: 'text', text: lines.length ? lines.join('\n') : '(no memories)' }] };
    }
    case 'list': {
      const l = Number(args.limit) || 20;
      const r = await a.req('GET', `/v1/list?project=${encodeURIComponent(project)}&limit=${l}`);
      const lines = (r.body.results || []).map((it) => `- ${it.id}${it.pinned ? ' ★' : ''}: ${it.text}`);
      return { content: [{ type: 'text', text: lines.length ? lines.join('\n') : '(empty)' }] };
    }
    case 'update': {
      const r = await a.req('PATCH', '/v1/update', {
        project, id: args.id, text: args.text, pinned: args.pinned, tags: args.tags,
      });
      return { content: [{ type: 'text', text: JSON.stringify(r.body) }] };
    }
    case 'forget': {
      const r = await a.req('DELETE', '/v1/forget/', { project, id: args.id });
      return { content: [{ type: 'text', text: r.status === 200 ? 'deleted' : JSON.stringify(r.body) }] };
    }
    case 'prune': {
      const r = await a.req('POST', '/v1/prune', {
        project, query: args.query, tags: args.tags, commit: Boolean(args.commit),
      });
      return { content: [{ type: 'text', text: JSON.stringify(r.body) }] };
    }
    default:
      return { isError: true, content: [{ type: 'text', text: `unknown tool ${name}` }] };
  }
}

function frame(msg) {
  const b = Buffer.from(JSON.stringify(msg));
  return Buffer.concat([Buffer.from(`Content-Length: ${b.length}\r\n\r\n`), b]);
}

function serveMCP(conf) {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const out = process.stdout;
  let initialized = false;

  rl.on('line', async (line) => {
    if (!line) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (_) {
      return;
    }
    if (msg.method === 'initialize') {
      initialized = true;
      out.write(frame({
        jsonrpc: '2.0', id: msg.id,
        result: {
          protocolVersion: msg.params && msg.params.protocolVersion ? msg.params.protocolVersion : '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'engram-mcp', version: require('../package.json').version },
        },
      }));
      return;
    }
    if (msg.method === 'notifications/initialized') return;
    if (msg.method === 'tools/list') {
      out.write(frame({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } }));
      return;
    }
    if (msg.method === 'tools/call') {
      const name = msg.params && msg.params.name;
      const args = (msg.params && msg.params.arguments) || {};
      try {
        const result = await callTool(conf, name, args);
        out.write(frame({ jsonrpc: '2.0', id: msg.id, result }));
      } catch (e) {
        out.write(frame({
          jsonrpc: '2.0', id: msg.id,
          error: { code: -32000, message: e.message || String(e) },
        }));
      }
      return;
    }
    if (msg.method === 'ping') {
      out.write(frame({ jsonrpc: '2.0', id: msg.id, result: {} }));
      return;
    }
    if (msg.id !== undefined) {
      out.write(frame({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } }));
    }
  });
  void initialized;
}

module.exports = { serveMCP, TOOLS, callTool };