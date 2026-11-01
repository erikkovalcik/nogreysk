'use strict';
// Konfigurácia a trvalé dáta v ~/.kukuk (prístup len pre vlastníka).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { generateVapidKeys } = require('./webpush');

const KUKUK_DIR = process.env.KUKUK_DIR || path.join(os.homedir(), '.kukuk');
const CONFIG_FILE = path.join(KUKUK_DIR, 'config.json');
const STATE_FILE = path.join(KUKUK_DIR, 'state.json');

function ensureDir() {
  fs.mkdirSync(KUKUK_DIR, { recursive: true, mode: 0o700 });
}

function writeJson(file, data) {
  ensureDir();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function loadConfig({ create = true } = {}) {
  let config = readJson(CONFIG_FILE);
  if (!config && create) {
    config = {
      agentToken: crypto.randomBytes(32).toString('base64url'),
      port: 8787,
      vapid: generateVapidKeys(),
    };
    writeJson(CONFIG_FILE, config);
  }
  return config;
}

function loadState() {
  const state = readJson(STATE_FILE) || {};
  state.devices = Array.isArray(state.devices) ? state.devices : [];
  return state;
}

function saveState(state) {
  writeJson(STATE_FILE, state);
}

module.exports = { KUKUK_DIR, CONFIG_FILE, STATE_FILE, loadConfig, loadState, saveState, writeJson, readJson };
