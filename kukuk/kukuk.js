#!/usr/bin/env node
'use strict';
// Kukuk – príkazový riadok. Spusti `node kukuk.js help`.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { loadConfig, KUKUK_DIR } = require('./lib/store');

const KUKUK_JS = __filename;
const HOOK_MARK = 'kukuk.js" hook';
const WAIT_SECONDS = Number(process.env.KUKUK_WAIT || 570); // pod 600 s timeoutom hooku

function agent() {
  const config = loadConfig({ create: !process.env.KUKUK_TOKEN && process.argv[2] !== 'hook' });
  const token = process.env.KUKUK_TOKEN || config?.agentToken;
  const base = (process.env.KUKUK_URL || `http://127.0.0.1:${process.env.KUKUK_PORT || config?.port || 8787}`).replace(/\/+$/, '');
  return { token, base };
}

async function api(method, pathname, body, timeoutMs = 5000) {
  const { token, base } = agent();
  if (!token) throw new Error('Chýba token – spusti najprv: node kukuk.js start');
  const res = await fetch(base + pathname, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && res.status !== 404) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
  return data;
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    setTimeout(() => resolve(data), 3000).unref();
  });
}

// ---------------- hook pre Claude Code ----------------
// Nikdy nesmie rozbiť Claude Code: pri akejkoľvek chybe skončí bez výstupu (= bežný dialóg v termináli).
async function hook() {
  let input;
  try {
    input = JSON.parse((await readStdin()) || '{}');
  } catch {
    return;
  }
  const event = input.hook_event_name;

  if (event !== 'PermissionRequest') {
    await api('POST', '/api/agent/event', input, 2500).catch(() => {});
    return;
  }

  let id;
  try {
    ({ id } = await api('POST', '/api/agent/requests', input, 5000));
  } catch {
    return; // server nebeží → rozhodne sa v termináli
  }
  if (!id) return;

  const deadline = Date.now() + WAIT_SECONDS * 1000;
  let failures = 0;
  while (Date.now() < deadline) {
    const left = Math.max(1, Math.min(25, Math.round((deadline - Date.now()) / 1000)));
    let r;
    try {
      r = await api('GET', `/api/agent/requests/${id}/wait?timeout=${left}`, null, (left + 10) * 1000);
      failures = 0;
    } catch {
      if (++failures >= 3) return;
      await new Promise((ok) => setTimeout(ok, 1000));
      continue;
    }
    if (r.status === 'pending') continue;
    if (r.status === 'allow') {
      const decision = { behavior: 'allow' };
      if (Array.isArray(r.updatedPermissions) && r.updatedPermissions.length) decision.updatedPermissions = r.updatedPermissions;
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } }));
    } else if (r.status === 'deny') {
      const decision = { behavior: 'deny', message: r.message || 'Používateľ to zamietol cez Kukuk.' };
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } }));
    }
    return; // 'terminal' / 'elsewhere' / 'unknown' → bežný dialóg
  }
  await api('POST', `/api/agent/requests/${id}/cancel`, {}, 2000).catch(() => {});
}

// ---------------- inštalácia hookov ----------------
const HOOK_EVENTS = {
  PermissionRequest: 600,
  Notification: 10,
  Stop: 10,
  UserPromptSubmit: 5,
  PostToolUse: 5,
  SessionEnd: 5,
};

function settingsPath(args) {
  if (args.includes('--project')) return path.join(process.cwd(), '.claude', 'settings.local.json');
  return path.join(os.homedir(), '.claude', 'settings.json');
}

function stripKuk(settings) {
  for (const [event, groups] of Object.entries(settings.hooks || {})) {
    if (!Array.isArray(groups)) continue;
    const kept = groups
      .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !String(h.command || '').includes(HOOK_MARK)) }))
      .filter((g) => g.hooks.length > 0);
    if (kept.length) settings.hooks[event] = kept;
    else delete settings.hooks[event];
  }
  if (settings.hooks && !Object.keys(settings.hooks).length) delete settings.hooks;
  return settings;
}

function loadSettings(file) {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf8');
  try {
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    throw new Error(`${file} nie je platný JSON – oprav ho ručne a skús znova.`);
  }
}

function writeSettings(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.kukuk-zaloha`);
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
}

function install(args) {
  const file = settingsPath(args);
  const settings = stripKuk(loadSettings(file));
  const command = `"${process.execPath}" "${KUKUK_JS}" hook`;
  settings.hooks = settings.hooks || {};
  for (const [event, timeout] of Object.entries(HOOK_EVENTS)) {
    settings.hooks[event] = settings.hooks[event] || [];
    settings.hooks[event].push({ hooks: [{ type: 'command', command, timeout }] });
  }
  writeSettings(file, settings);
  loadConfig();
  console.log(`✓ Hooky Kukuk pridané do ${file}`);
  console.log('  Reštartuj bežiace relácie Claude Code, aby sa načítali.');
}

function uninstall(args) {
  const file = settingsPath(args);
  if (!fs.existsSync(file)) return console.log('Nič na odstránenie.');
  writeSettings(file, stripKuk(loadSettings(file)));
  console.log(`✓ Hooky Kukuk odstránené z ${file}`);
}

// ---------------- lišta Macu (SwiftBar / xbar) ----------------
function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  return `${Math.round(s / 3600)} h`;
}

const clean = (s, n = 60) => String(s || '').replace(/[\r\n|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

async function menubar() {
  const { base } = agent();
  const action = (...params) =>
    `bash="${process.execPath}" ${[KUKUK_JS, ...params].map((p, i) => `param${i + 1}="${p}"`).join(' ')} terminal=false refresh=true`;
  let st;
  try {
    st = await api('GET', '/api/agent/state', null, 2000);
  } catch {
    console.log('kukuk ✕ | sfimage=eye.slash');
    console.log('---');
    console.log('Server Kukuk nebeží');
    console.log(`Spustiť server | bash="${process.execPath}" param1="${KUKUK_JS}" param2=start terminal=true`);
    return;
  }
  const working = st.sessions.filter((s) => s.status === 'working').length;
  const idle = st.sessions.filter((s) => s.status === 'idle').length;
  if (st.pending.length) console.log(`👀 ${st.pending.length} | color=#ff9f0a`);
  else if (idle) console.log('kukuk ? | color=#ff9f0a');
  else if (working) console.log('kukuk ⋯');
  else console.log('kukuk');
  console.log('---');

  if (st.pending.length) {
    console.log('Čaká na schválenie | size=11');
    for (const r of st.pending) {
      console.log(`${clean(r.project, 20)} · ${clean(r.tool, 15)}: ${clean(r.summary, 50)}`);
      console.log(`--${clean(r.summary, 80)} | font=Menlo size=11`);
      console.log(`--pred ${ago(st.now - r.createdAt)} | size=11`);
      console.log('-----');
      console.log(`--✅ Povoliť | ${action('decide', r.id, 'allow')}`);
      if (r.canAlways) console.log(`--✅ Vždy povoliť | ${action('decide', r.id, 'always')}`);
      console.log(`--⛔ Zamietnuť | ${action('decide', r.id, 'deny')}`);
      console.log(`--⌨️ Rozhodnem v termináli | ${action('decide', r.id, 'terminal')}`);
    }
    console.log('---');
  }

  const label = { working: 'pracuje ⋯', waiting: 'čaká na povolenie', idle: 'čaká na teba', done: 'hotovo ✓' };
  if (st.sessions.length) {
    console.log('Relácie | size=11');
    for (const s of st.sessions.slice(0, 8)) {
      console.log(`${clean(s.project, 25)} — ${label[s.status] || s.status} | size=13`);
      if (s.message) console.log(`--${clean(s.message, 90)} | size=11`);
    }
  } else console.log('Žiadne aktívne relácie | size=12');
  console.log('---');
  const phones = st.devices.length;
  console.log(`Zariadenia: ${phones}${phones ? ` (${st.devices.filter((d) => d.push).length}× push)` : ''} | size=11`);
  console.log(`Otvoriť Kukuk | href=${base}`);
  console.log(`Nový párovací kód | bash="${process.execPath}" param1="${KUKUK_JS}" param2=pair terminal=true`);
}

function menubarInstall(args) {
  const dir = args[0] || [
    path.join(os.homedir(), 'Library/Application Support/SwiftBar/Plugins'),
    path.join(os.homedir(), 'Library/Application Support/xbar/plugins'),
  ].find((d) => fs.existsSync(d));
  if (!dir) {
    console.log('Nenašiel som priečinok s pluginmi SwiftBar/xbar. Zadaj ho: node kukuk.js menubar-install <priečinok>');
    process.exitCode = 1;
    return;
  }
  const template = fs.readFileSync(path.join(__dirname, 'menubar', 'kukuk.3s.sh'), 'utf8');
  const out = path.join(dir, 'kukuk.3s.sh');
  fs.writeFileSync(out, template.replace('__NODE__', process.execPath).replace('__KUKUK_JS__', KUKUK_JS), { mode: 0o755 });
  console.log(`✓ Plugin do lišty uložený: ${out}`);
}

// ---------------- automatické spúšťanie na Macu ----------------
function autostart() {
  if (process.platform !== 'darwin') throw new Error('Automatické spúšťanie je len pre macOS (launchd).');
  const label = 'sk.nogrey.kukuk';
  const plist = path.join(os.homedir(), 'Library/LaunchAgents', `${label}.plist`);
  const log = path.join(KUKUK_DIR, 'server.log');
  const env = ['KUKUK_PORT', 'KUKUK_HOST', 'KUKUK_CONTACT'].filter((k) => process.env[k]);
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  fs.writeFileSync(
    plist,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array><string>${process.execPath}</string><string>${KUKUK_JS}</string><string>start</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>${env.length ? `
  <key>EnvironmentVariables</key><dict>${env.map((k) => `<key>${k}</key><string>${process.env[k]}</string>`).join('')}</dict>` : ''}
</dict></plist>
`,
  );
  try {
    execFileSync('launchctl', ['unload', plist], { stdio: 'ignore' });
  } catch {}
  execFileSync('launchctl', ['load', plist]);
  console.log(`✓ Kukuk sa bude spúšťať pri prihlásení (${plist}). Log: ${log}`);
}

// ---------------- ostatné príkazy ----------------
async function pair() {
  const { code, expiresAt } = await api('POST', '/api/agent/pair-code', {});
  const { base } = agent();
  console.log(`\n  Párovací kód: ${code.slice(0, 3)} ${code.slice(3)}   (platí do ${new Date(expiresAt).toLocaleTimeString('sk-SK')})`);
  console.log(`  Otvor Kukuk na telefóne (napr. https://<tvoj-mac>.ts.net) alebo ${base} a zadaj kód.\n`);
}

async function decideCmd([id, decision]) {
  const always = decision === 'always';
  await api('POST', `/api/agent/requests/${id}/decide`, { decision: always ? 'allow' : decision, always, by: 'lišta Macu' });
}

async function status() {
  const st = await api('GET', '/api/agent/state', null, 3000);
  console.log(`Server: OK · zariadenia: ${st.devices.map((d) => `${d.name}${d.push ? ' 🔔' : ''}${d.passkey ? ' 🔐' : ''}`).join(', ') || '—'}`);
  console.log(`Čaká: ${st.pending.length} · relácie: ${st.sessions.map((s) => `${s.project} (${s.status})`).join(', ') || '—'}`);
}

const HELP = `Kukuk 👀 – schvaľovanie Claude Code z telefónu a z lišty Macu

  node kukuk.js start              spustí server (párovací kód sa vypíše)
  node kukuk.js install [--project] pridá hooky do ~/.claude/settings.json (alebo .claude/settings.local.json)
  node kukuk.js uninstall [--project]
  node kukuk.js pair               nový párovací kód pre telefón
  node kukuk.js status             stav servera, zariadení a relácií
  node kukuk.js menubar-install [priečinok]   plugin do lišty (SwiftBar / xbar)
  node kukuk.js autostart          spúšťať server pri prihlásení (macOS)
  node kukuk.js decide <id> allow|always|deny|terminal

Premenné: KUKUK_PORT, KUKUK_HOST, KUKUK_URL, KUKUK_TOKEN, KUKUK_WAIT, KUKUK_CONTACT, KUKUK_MAC_NOTIFY=0, KUKUK_DIR`;

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'hook':
      return hook();
    case 'start':
    case 'server':
      return require('./server').start();
    case 'install':
      return install(args);
    case 'uninstall':
      return uninstall(args);
    case 'pair':
      return pair();
    case 'status':
      return status();
    case 'menubar':
      return menubar();
    case 'menubar-install':
      return menubarInstall(args);
    case 'autostart':
      return autostart();
    case 'decide':
      return decideCmd(args);
    default:
      console.log(HELP);
  }
}

main().catch((err) => {
  if (process.argv[2] === 'hook') return; // hook nikdy nezlyhá
  console.error(`Chyba: ${err.cause?.code === 'ECONNREFUSED' ? 'server Kukuk nebeží (node kukuk.js start)' : err.message}`);
  process.exitCode = 1;
});
