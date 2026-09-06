'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { configDir, ensureDir, chmod600 } = require('./paths');

const FILE = 'engram.json';

function create() {
  const token = crypto.randomBytes(32).toString('hex');
  const desc = {
    token,
    host: '127.0.0.1',
    port: 8040,
    tls: false,
    keyId: crypto.randomBytes(8).toString('hex'),
    createdAt: new Date().toISOString(),
    version: 1,
  };
  return desc;
}

function read(override) {
  const dir = ensureDir(configDir());
  const file = path.join(dir, FILE);
  let desc;
  if (fs.existsSync(file)) {
    try {
      desc = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_) {
      return { error: `descriptor ${file} is corrupt; delete it and restart` };
    }
  } else {
    desc = create();
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(desc, null, 2) + '\n');
    chmod600(tmp);
    fs.renameSync(tmp, file);
  }
  if (override) {
    let changed = false;
    for (const k of ['host', 'port', 'tls']) {
      if (override[k] !== undefined && override[k] !== desc[k]) {
        desc[k] = override[k];
        changed = true;
      }
    }
    if (changed) {
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(desc, null, 2) + '\n');
      chmod600(tmp);
      fs.renameSync(tmp, file);
    }
  }
  return desc;
}

function rootToken() {
  const desc = read();
  if (desc.error) throw new Error(desc.error);
  return desc.token;
}

function updatePartial(patch) {
  const dir = ensureDir(configDir());
  const file = path.join(dir, FILE);
  const desc = read();
  Object.assign(desc, patch);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(desc, null, 2) + '\n');
  chmod600(tmp);
  fs.renameSync(tmp, file);
  return desc;
}

module.exports = { read, rootToken, updatePartial, FILE };