'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

function dataDir() {
  if (process.env.ENGRAM_DIR && process.env.ENGRAM_DIR.length) {
    return path.resolve(process.env.ENGRAM_DIR);
  }
  const home = os.homedir();
  if (process.platform === 'win32') {
    return process.env.APPDATA
      ? path.join(process.env.APPDATA, 'engramd')
      : path.join(home, 'AppData', 'Roaming', 'engramd');
  }
  const xdg = process.env.XDG_DATA_HOME;
  return xdg && xdg.length
    ? path.join(xdg, 'engramd')
    : path.join(home, '.local', 'share', 'engramd');
}

function configDir() {
  if (process.env.ENGRAM_CONFIG_DIR && process.env.ENGRAM_CONFIG_DIR.length) {
    return path.resolve(process.env.ENGRAM_CONFIG_DIR);
  }
  return dataDir();
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function chmod600(file) {
  try {
    fs.chmodSync(file, 0o600);
  } catch (_) {
    /* best effort on platforms without POSIX modes */
  }
}

module.exports = { dataDir, configDir, ensureDir, chmod600 };