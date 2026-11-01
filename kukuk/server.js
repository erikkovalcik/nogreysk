'use strict';
// Kukuk server – prijíma požiadavky z Claude Code hookov, posiela push na telefón
// a čaká na rozhodnutie (Povoliť / Zamietnuť) z telefónu, prehliadača alebo lišty Macu.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { loadConfig, loadState, saveState } = require('./lib/store');
const { sendPush, b64u } = require('./lib/webpush');
const { verifyRegistration, verifyAssertion } = require('./lib/webauthn');

const PUBLIC_DIR = path.join(__dirname, 'public');
const POLL_GRACE_MS = 45_000; // hook sa neozval → požiadavka bola vybavená inde
const PAIR_TTL_MS = 10 * 60_000;
const MAX_HISTORY = 30;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const newId = () => crypto.randomBytes(9).toString('base64url');
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// ---------- zhrnutie nástroja pre človeka ----------
function summarize(tool, input = {}) {
  const s = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
  switch (tool) {
    case 'Bash':
      return input.command || '';
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'Read':
    case 'NotebookEdit':
      return input.file_path || input.notebook_path || '';
    case 'WebFetch':
      return input.url || '';
    case 'WebSearch':
      return input.query || '';
    case 'Glob':
    case 'Grep':
      return input.pattern || '';
    case 'Task':
    case 'Agent':
      return input.description || input.prompt || '';
    default:
      return s(input).slice(0, 300);
  }
}

function detail(tool, input = {}) {
  if (tool === 'Edit' && input.old_string !== undefined) {
    return `--- pôvodné\n${input.old_string}\n+++ nové\n${input.new_string}`.slice(0, 4000);
  }
  if (tool === 'Write' && typeof input.content === 'string') return input.content.slice(0, 4000);
  if (tool === 'Bash') return [input.description, input.command].filter(Boolean).join('\n\n').slice(0, 4000);
  return JSON.stringify(input, null, 2).slice(0, 4000);
}

function projectName(cwd) {
  return cwd ? path.basename(cwd) : 'Claude Code';
}

function createServer(opts = {}) {
  const config = opts.config || loadConfig();
  const state = opts.state || loadState();
  const persist = opts.persist || (() => saveState(state));
  const push = opts.sendPush || sendPush;
  const subject = process.env.KUKUK_CONTACT || config.contact || 'https://github.com/erikkovalcik/nogreysk';
  const macNotify = opts.macNotify ?? (process.platform === 'darwin' && process.env.KUKUK_MAC_NOTIFY !== '0');

  const requests = new Map(); // id → požiadavka
  const sessions = new Map(); // session_id → stav relácie
  const streams = new Set(); // SSE klienti
  let pairing = null; // { code, expires, attempts }

  // ---------- párovanie ----------
  function newPairingCode() {
    pairing = { code: String(crypto.randomInt(0, 1_000_000)).padStart(6, '0'), expires: Date.now() + PAIR_TTL_MS, attempts: 0 };
    return pairing;
  }

  // ---------- stav pre klientov ----------
  function publicRequest(r) {
    return {
      id: r.id,
      tool: r.tool,
      summary: r.summary,
      detail: r.detail,
      project: r.project,
      cwd: r.cwd,
      sessionId: r.sessionId,
      status: r.status,
      createdAt: r.createdAt,
      decidedAt: r.decidedAt,
      decidedBy: r.decidedBy,
      canAlways: Array.isArray(r.suggestions) && r.suggestions.length > 0,
      challenge: r.status === 'pending' ? r.challenge : undefined,
    };
  }

  function snapshot() {
    const all = [...requests.values()].sort((a, b) => b.createdAt - a.createdAt);
    return {
      pending: all.filter((r) => r.status === 'pending').map(publicRequest),
      history: all.filter((r) => r.status !== 'pending').slice(0, MAX_HISTORY).map(publicRequest),
      sessions: [...sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt),
      now: Date.now(),
    };
  }

  function broadcast() {
    const data = `event: state\ndata: ${JSON.stringify(snapshot())}\n\n`;
    for (const res of streams) res.write(data);
  }

  function touchSession(sessionId, cwd, status, message) {
    if (!sessionId) return;
    const prev = sessions.get(sessionId) || { id: sessionId };
    sessions.set(sessionId, {
      ...prev,
      project: projectName(cwd || prev.cwd),
      cwd: cwd || prev.cwd,
      status,
      message: message ?? prev.message,
      updatedAt: Date.now(),
    });
  }

  // ---------- notifikácie ----------
  async function notifyDevices(payload, filter = () => true) {
    const targets = state.devices.filter((d) => d.subscription && filter(d));
    let changed = false;
    await Promise.all(
      targets.map(async (d) => {
        try {
          const r = await push(d.subscription, payload, { vapid: config.vapid, subject, topic: payload.tag });
          if (r.gone) {
            d.subscription = null;
            changed = true;
          } else if (!r.ok) {
            console.warn(`[kukuk] push pre „${d.name}“ zlyhal: ${r.status} ${r.text}`);
          }
        } catch (err) {
          console.warn(`[kukuk] push pre „${d.name}“ zlyhal: ${err.message}`);
        }
      }),
    );
    if (changed) persist();
    return targets.length;
  }

  function notifyMac(title, body) {
    if (!macNotify) return;
    const esc = (s) => String(s).replace(/[\\"]/g, '\\$&').slice(0, 200);
    execFile('osascript', ['-e', `display notification "${esc(body)}" with title "${esc(title)}" sound name "Glass"`], () => {});
  }

  // ---------- rozhodnutia ----------
  function decide(r, decision, by, { always = false, message } = {}) {
    if (r.status !== 'pending') return false;
    r.status = decision;
    r.always = decision === 'allow' && always;
    r.message = message;
    r.decidedAt = Date.now();
    r.decidedBy = by;
    r.challenge = undefined;
    touchSession(r.sessionId, r.cwd, 'working');
    const result = hookResult(r);
    for (const res of r.waiters) sendJson(res, 200, result);
    r.waiters.clear();
    broadcast();
    return true;
  }

  function hookResult(r) {
    return {
      status: r.status,
      message: r.message,
      updatedPermissions: r.always ? r.suggestions : undefined,
    };
  }

  // Ak relácia pokračuje (nový prompt, koniec, alebo nástroj už prebehol), otázka bola
  // zodpovedaná priamo v termináli – zruš ju na telefóne. `match` obmedzí len na ten istý nástroj.
  function resolveStale(sessionId, reason, match) {
    let changed = false;
    for (const r of requests.values()) {
      if (r.status === 'pending' && (!sessionId || r.sessionId === sessionId) && (!match || match(r))) {
        decide(r, 'elsewhere', reason);
        changed = true;
      }
    }
    return changed;
  }

  function prune() {
    const now = Date.now();
    for (const r of requests.values()) {
      if (r.status === 'pending' && r.waiters.size === 0 && now - r.lastPoll > POLL_GRACE_MS) {
        decide(r, 'elsewhere', 'terminál');
      }
    }
    const old = [...requests.values()].filter((r) => r.status !== 'pending').sort((a, b) => b.createdAt - a.createdAt);
    for (const r of old.slice(MAX_HISTORY)) requests.delete(r.id);
    for (const [id, s] of sessions) if (now - s.updatedAt > 6 * 3600_000) sessions.delete(id);
  }
  const pruneTimer = setInterval(prune, 5_000);
  pruneTimer.unref();
  const keepAlive = setInterval(() => {
    for (const res of streams) res.write(': ping\n\n');
  }, 20_000);
  keepAlive.unref();

  // ---------- HTTP pomocníci ----------
  function sendJson(res, status, data) {
    if (res.writableEnded) return;
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
  }

  function readBody(req, limit = 256 * 1024) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) {
          reject(Object.assign(new Error('Príliš veľké telo požiadavky'), { status: 413 }));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(Object.assign(new Error('Neplatný JSON'), { status: 400 }));
        }
      });
      req.on('error', reject);
    });
  }

  function bearer(req, url) {
    const h = req.headers.authorization || '';
    if (h.startsWith('Bearer ')) return h.slice(7).trim();
    return url.searchParams.get('token') || '';
  }

  function authAgent(token) {
    return token && safeEqual(token, config.agentToken);
  }

  function authDevice(token) {
    if (!token) return null;
    const h = hashToken(token);
    return state.devices.find((d) => safeEqual(d.tokenHash, h)) || null;
  }

  function serveStatic(res, pathname) {
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 404, { error: 'Nenájdené' });
    fs.readFile(file, (err, data) => {
      if (err) {
        // SPA fallback
        if (!path.extname(rel)) return serveStatic(res, '/');
        return sendJson(res, 404, { error: 'Nenájdené' });
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': rel === 'sw.js' || rel.endsWith('.html') ? 'no-cache' : 'public, max-age=300',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      });
      res.end(data);
    });
  }

  // ---------- API ----------
  async function handleApi(req, res, url) {
    const { pathname } = url;
    const method = req.method;
    const token = bearer(req, url);

    if (method === 'GET' && pathname === '/api/health') return sendJson(res, 200, { ok: true, name: 'kukuk' });

    // --- párovanie zariadenia ---
    if (method === 'POST' && pathname === '/api/pair') {
      const body = await readBody(req);
      if (!pairing || Date.now() > pairing.expires) return sendJson(res, 410, { error: 'Kód vypršal. Na Macu spusti: node kukuk.js pair' });
      if (!safeEqual(String(body.code || '').replace(/\D/g, ''), pairing.code)) {
        pairing.attempts += 1;
        if (pairing.attempts >= 5) pairing = null;
        return sendJson(res, 403, { error: 'Nesprávny kód' });
      }
      pairing = null;
      const deviceToken = crypto.randomBytes(32).toString('base64url');
      const device = {
        id: newId(),
        name: String(body.name || 'Zariadenie').slice(0, 40),
        tokenHash: hashToken(deviceToken),
        createdAt: Date.now(),
        subscription: null,
        credential: null,
        prefs: { stop: true, idle: true },
      };
      state.devices.push(device);
      persist();
      console.log(`[kukuk] spárované zariadenie „${device.name}“`);
      return sendJson(res, 200, { token: deviceToken, deviceId: device.id });
    }

    // --- agent (hook na Macu, lišta) ---
    if (pathname.startsWith('/api/agent/')) {
      if (!authAgent(token)) return sendJson(res, 401, { error: 'Neplatný token agenta' });

      if (method === 'POST' && pathname === '/api/agent/pair-code') {
        const p = newPairingCode();
        return sendJson(res, 200, { code: p.code, expiresAt: p.expires });
      }

      if (method === 'GET' && pathname === '/api/agent/state') {
        return sendJson(res, 200, { ...snapshot(), devices: state.devices.map((d) => ({ name: d.name, push: !!d.subscription, passkey: !!d.credential })) });
      }

      if (method === 'POST' && pathname === '/api/agent/event') {
        const b = await readBody(req);
        const sid = b.session_id;
        const ev = b.hook_event_name;
        if (ev === 'UserPromptSubmit') {
          resolveStale(sid, 'terminál');
          touchSession(sid, b.cwd, 'working');
        } else if (ev === 'PostToolUse') {
          const tool = String(b.tool_name || '');
          const sum = summarize(tool, b.tool_input).slice(0, 500);
          resolveStale(sid, 'terminál', (r) => r.tool === tool && r.summary === sum);
          const s = sessions.get(sid);
          if (!s || s.status !== 'waiting') touchSession(sid, b.cwd, 'working');
        } else if (ev === 'Notification') {
          const type = b.notification_type || '';
          const permissionLike = type === 'permission_prompt' || /permission/i.test(b.message || '');
          if (!permissionLike) {
            touchSession(sid, b.cwd, 'idle', b.message);
            const title = `${projectName(b.cwd)}: Claude ťa potrebuje`;
            notifyMac(title, b.message || '');
            await notifyDevices({ title, body: b.message || 'Claude čaká na tvoju odpoveď.', tag: `idle-${sid}`, url: '/' }, (d) => d.prefs?.idle !== false);
          }
        } else if (ev === 'Stop') {
          resolveStale(sid, 'terminál');
          const last = String(b.last_assistant_message || '').replace(/\s+/g, ' ').trim();
          touchSession(sid, b.cwd, 'done', last.slice(0, 200));
          await notifyDevices(
            { title: `${projectName(b.cwd)}: hotovo ✓`, body: last.slice(0, 180) || 'Claude dokončil prácu.', tag: `done-${sid}`, url: '/' },
            (d) => d.prefs?.stop !== false,
          );
        } else if (ev === 'SessionEnd') {
          resolveStale(sid, 'koniec relácie');
          sessions.delete(sid);
        }
        broadcast();
        return sendJson(res, 200, { ok: true });
      }

      if (method === 'POST' && pathname === '/api/agent/requests') {
        const b = await readBody(req);
        const tool = String(b.tool_name || 'Nástroj');
        const r = {
          id: newId(),
          sessionId: b.session_id || null,
          cwd: b.cwd || '',
          project: projectName(b.cwd),
          tool,
          summary: summarize(tool, b.tool_input).slice(0, 500),
          detail: detail(tool, b.tool_input),
          suggestions: Array.isArray(b.permission_suggestions) ? b.permission_suggestions : [],
          status: 'pending',
          createdAt: Date.now(),
          lastPoll: Date.now(),
          challenge: b64u(crypto.randomBytes(32)),
          waiters: new Set(),
        };
        requests.set(r.id, r);
        touchSession(r.sessionId, r.cwd, 'waiting');
        broadcast();
        const title = `${r.project}: ${r.tool}`;
        notifyMac(`Kukuk · ${title}`, r.summary || 'Claude žiada o povolenie');
        const sent = await notifyDevices({ title, body: r.summary || 'Claude žiada o povolenie', tag: r.id, id: r.id, actions: true, url: `/?r=${r.id}` });
        return sendJson(res, 201, { id: r.id, devices: sent });
      }

      const wait = pathname.match(/^\/api\/agent\/requests\/([\w-]+)\/wait$/);
      if (method === 'GET' && wait) {
        const r = requests.get(wait[1]);
        if (!r) return sendJson(res, 404, { status: 'unknown' });
        r.lastPoll = Date.now();
        if (r.status !== 'pending') return sendJson(res, 200, hookResult(r));
        const timeout = Math.min(Math.max(Number(url.searchParams.get('timeout')) || 25, 1), 55) * 1000;
        r.waiters.add(res);
        const timer = setTimeout(() => {
          r.waiters.delete(res);
          r.lastPoll = Date.now();
          sendJson(res, 200, { status: 'pending' });
        }, timeout);
        res.on('close', () => {
          clearTimeout(timer);
          r.waiters.delete(res);
          r.lastPoll = Date.now();
        });
        return;
      }

      const cancel = pathname.match(/^\/api\/agent\/requests\/([\w-]+)\/cancel$/);
      if (method === 'POST' && cancel) {
        const r = requests.get(cancel[1]);
        if (r) decide(r, 'elsewhere', 'časový limit');
        return sendJson(res, 200, { ok: true });
      }

      const agentDecide = pathname.match(/^\/api\/agent\/requests\/([\w-]+)\/decide$/);
      if (method === 'POST' && agentDecide) {
        const r = requests.get(agentDecide[1]);
        if (!r) return sendJson(res, 404, { error: 'Požiadavka neexistuje' });
        const b = await readBody(req);
        if (!['allow', 'deny', 'terminal'].includes(b.decision)) return sendJson(res, 400, { error: 'Neplatné rozhodnutie' });
        const ok = decide(r, b.decision, b.by || 'Mac', { always: !!b.always, message: b.message });
        return sendJson(res, ok ? 200 : 409, ok ? { ok: true } : { error: 'Už rozhodnuté' });
      }

      return sendJson(res, 404, { error: 'Nenájdené' });
    }

    // --- spárované zariadenie (telefón, prehliadač) ---
    const device = authDevice(token);
    if (!device) return sendJson(res, 401, { error: 'Zariadenie nie je spárované' });

    if (method === 'GET' && pathname === '/api/me') {
      device.regChallenge = b64u(crypto.randomBytes(32));
      return sendJson(res, 200, {
        id: device.id,
        name: device.name,
        push: !!device.subscription,
        passkey: device.credential ? { id: device.credential.id, rpId: device.credential.rpId } : null,
        prefs: device.prefs || { stop: true, idle: true },
        vapidPublicKey: config.vapid.publicKey,
        regChallenge: device.regChallenge,
      });
    }

    if (method === 'GET' && pathname === '/api/state') return sendJson(res, 200, snapshot());

    if (method === 'GET' && pathname === '/api/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(`retry: 3000\nevent: state\ndata: ${JSON.stringify(snapshot())}\n\n`);
      streams.add(res);
      req.on('close', () => streams.delete(res));
      return;
    }

    if (method === 'POST' && pathname === '/api/push/subscribe') {
      const b = await readBody(req);
      const s = b.subscription;
      if (!s || typeof s.endpoint !== 'string' || !/^https:\/\//.test(s.endpoint) || !s.keys?.p256dh || !s.keys?.auth) {
        return sendJson(res, 400, { error: 'Neplatný odber notifikácií' });
      }
      device.subscription = { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } };
      persist();
      return sendJson(res, 200, { ok: true });
    }

    if (method === 'POST' && pathname === '/api/push/test') {
      if (!device.subscription) return sendJson(res, 400, { error: 'Notifikácie nie sú zapnuté' });
      const r = await push(device.subscription, { title: 'Kukuk 👀', body: 'Notifikácie fungujú.', tag: 'test', url: '/' }, { vapid: config.vapid, subject });
      if (r.gone) {
        device.subscription = null;
        persist();
      }
      return sendJson(res, r.ok ? 200 : 502, r.ok ? { ok: true } : { error: `Push služba vrátila ${r.status}` });
    }

    if (method === 'POST' && pathname === '/api/prefs') {
      const b = await readBody(req);
      device.prefs = { stop: b.stop !== false, idle: b.idle !== false };
      persist();
      return sendJson(res, 200, { ok: true, prefs: device.prefs });
    }

    if (method === 'POST' && pathname === '/api/passkey') {
      const b = await readBody(req);
      try {
        device.credential = verifyRegistration(b, device.regChallenge);
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      } finally {
        device.regChallenge = null;
      }
      persist();
      return sendJson(res, 200, { ok: true });
    }

    if (method === 'DELETE' && pathname === '/api/passkey') {
      return sendJson(res, 403, { error: 'Biometria sa z bezpečnostných dôvodov nedá vypnúť z telefónu. Odpáruj zariadenie a spáruj ho znova.' });
    }

    if (method === 'POST' && pathname === '/api/unpair') {
      state.devices = state.devices.filter((d) => d !== device);
      persist();
      return sendJson(res, 200, { ok: true });
    }

    const dev = pathname.match(/^\/api\/requests\/([\w-]+)\/decide$/);
    if (method === 'POST' && dev) {
      const r = requests.get(dev[1]);
      if (!r) return sendJson(res, 404, { error: 'Požiadavka už neexistuje' });
      if (r.status !== 'pending') return sendJson(res, 409, { error: 'Už rozhodnuté' });
      const b = await readBody(req);
      if (!['allow', 'deny', 'terminal'].includes(b.decision)) return sendJson(res, 400, { error: 'Neplatné rozhodnutie' });
      // Povolenie zo zariadenia s passkey musí byť potvrdené Face ID / Touch ID.
      if (b.decision === 'allow' && device.credential) {
        try {
          verifyAssertion(b.assertion || {}, device.credential, r.challenge);
        } catch (err) {
          return sendJson(res, 403, { error: `Overenie zlyhalo: ${err.message}` });
        }
        persist();
      }
      decide(r, b.decision, device.name, { always: !!b.always && r.suggestions.length > 0, message: b.decision === 'deny' ? `Zamietnuté cez Kukuk (${device.name}).` : undefined });
      return sendJson(res, 200, { ok: true });
    }

    return sendJson(res, 404, { error: 'Nenájdené' });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://kukuk.local');
    try {
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Nepovolená metóda' });
      return serveStatic(res, url.pathname);
    } catch (err) {
      console.error('[kukuk]', err);
      return sendJson(res, err.status || 500, { error: err.status ? err.message : 'Interná chyba' });
    }
  });

  server.on('close', () => {
    clearInterval(pruneTimer);
    clearInterval(keepAlive);
  });

  return { server, newPairingCode, requests, sessions, state, config };
}

function start() {
  const config = loadConfig();
  const port = Number(process.env.KUKUK_PORT || config.port || 8787);
  const host = process.env.KUKUK_HOST || '127.0.0.1';
  const kukuk = createServer({ config });
  kukuk.server.on('error', (err) => {
    console.error(err.code === 'EADDRINUSE' ? `Kukuk už beží (port ${port} je obsadený).` : `Chyba servera: ${err.message}`);
    process.exit(1);
  });
  kukuk.server.listen(port, host, () => {
    const p = kukuk.newPairingCode();
    console.log(`\n  👀 Kukuk beží na http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
    console.log(`  Spárované zariadenia: ${kukuk.state.devices.length}`);
    console.log(`  Párovací kód (10 min): ${p.code}   ·   nový kód: node kukuk.js pair\n`);
  });
  return kukuk;
}

module.exports = { createServer, start, summarize };

if (require.main === module) start();
