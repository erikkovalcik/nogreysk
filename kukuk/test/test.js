'use strict';
// Spusti: node --test test/

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

process.env.KUKUK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kukuk-test-'));

const { encrypt, generateVapidKeys, b64u } = require('../lib/webpush');
const { verifyRegistration, verifyAssertion, sha256 } = require('../lib/webauthn');
const { createServer } = require('../server');

const KUKUK_JS = path.join(__dirname, '..', 'kukuk.js');
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();

// Dešifrovanie na strane prehliadača (RFC 8291) – nezávislá implementácia pre test.
function decrypt(body, uaEcdh, authSecret) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  const shared = uaEcdh.computeSecret(asPublic);
  const ikm = crypto.hkdfSync('sha256', shared, authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), uaEcdh.getPublicKey(), asPublic]), 32);
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  assert.equal(plain[plain.length - 1], 2);
  return plain.subarray(0, -1).toString('utf8');
}

test('web push: šifrovanie aes128gcm sa dá dešifrovať', () => {
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  const auth = crypto.randomBytes(16);
  const body = encrypt('{"title":"Ahoj ľščťž"}', ua.getPublicKey('base64url'), auth.toString('base64url'));
  assert.equal(decrypt(body, ua, auth), '{"title":"Ahoj ľščťž"}');
  assert.equal(body.readUInt32BE(16), 4096);
});

// ----- simulovaný autentifikátor (ako Face ID) -----
function fakeAuthenticator(origin) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const id = b64u(crypto.randomBytes(16));
  const rpId = new URL(origin).hostname;
  return {
    id,
    register(challenge) {
      return {
        id,
        publicKey: b64u(publicKey.export({ format: 'der', type: 'spki' })),
        clientDataJSON: b64u(JSON.stringify({ type: 'webauthn.create', challenge, origin })),
      };
    },
    assert(challenge, { flags = 0x05, counter = 0, tamper = false } = {}) {
      const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin }));
      const authData = Buffer.concat([sha256(rpId), Buffer.from([flags]), Buffer.alloc(4)]);
      authData.writeUInt32BE(counter, 33);
      let signature = crypto.sign('sha256', Buffer.concat([authData, sha256(clientDataJSON)]), privateKey);
      if (tamper) signature = crypto.sign('sha256', Buffer.from('iné'), privateKey);
      return { id, authenticatorData: b64u(authData), clientDataJSON: b64u(clientDataJSON), signature: b64u(signature) };
    },
  };
}

test('webauthn: registrácia a overenie podpisu', () => {
  const auth = fakeAuthenticator('https://mac.tailnet.ts.net');
  const cred = verifyRegistration(auth.register('abc'), 'abc');
  assert.equal(cred.rpId, 'mac.tailnet.ts.net');
  assert.ok(verifyAssertion(auth.assert('xyz'), cred, 'xyz'));
  assert.throws(() => verifyAssertion(auth.assert('xyz'), cred, 'iná'), /výzva/);
  assert.throws(() => verifyAssertion(auth.assert('xyz', { flags: 0x01 }), cred, 'xyz'), /biometriou/);
  assert.throws(() => verifyAssertion(auth.assert('xyz', { tamper: true }), cred, 'xyz'), /podpis/);
  assert.throws(() => verifyRegistration(fakeAuthenticator('http://evil.example').register('a'), 'a'), /HTTPS/);
});

// ----- integrácia: server + hook + zariadenie -----
async function startServer() {
  const pushes = [];
  const kukuk = createServer({
    config: { agentToken: 'agent-secret', port: 0, vapid: generateVapidKeys() },
    state: { devices: [] },
    persist: () => {},
    macNotify: false,
    sendPush: async (sub, payload) => {
      pushes.push(payload);
      return { ok: true, status: 201 };
    },
  });
  await new Promise((ok) => kukuk.server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${kukuk.server.address().port}`;
  const call = async (method, p, body, token) => {
    const res = await fetch(base + p, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };
  return { kukuk, base, call, pushes };
}

function runHook(base, input, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [KUKUK_JS, 'hook'], {
      env: { ...process.env, KUKUK_URL: base, KUKUK_TOKEN: 'agent-secret', ...env },
    });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.on('close', (code) => resolve({ code, out }));
    child.stdin.end(JSON.stringify(input));
  });
}

const waitFor = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((ok) => setTimeout(ok, 30));
  }
  throw new Error('timeout');
};

const permissionInput = (extra = {}) => ({
  hook_event_name: 'PermissionRequest',
  session_id: 's1',
  cwd: '/Users/erik/projekty/nogreysk',
  tool_name: 'Bash',
  tool_input: { command: 'npm test', description: 'Spusti testy' },
  permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }], behavior: 'allow', destination: 'localSettings' }],
  ...extra,
});

test('celý tok: párovanie → hook → Face ID povolenie z telefónu', async () => {
  const { kukuk, base, call, pushes } = await startServer();
  try {
    // párovanie
    const { code } = kukuk.newPairingCode();
    assert.equal((await call('POST', '/api/pair', { code: '000000' === code ? '111111' : '000000', name: 'x' })).status, 403);
    const paired = await call('POST', '/api/pair', { code, name: 'iPhone' });
    assert.equal(paired.status, 200);
    const token = paired.data.token;
    assert.equal((await call('POST', '/api/pair', { code, name: 'druhý' })).status, 410, 'kód je jednorazový');

    // push odber + passkey
    await call('POST', '/api/push/subscribe', { subscription: { endpoint: 'https://web.push.apple.com/x', keys: { p256dh: 'a', auth: 'b' } } }, token);
    const me = (await call('GET', '/api/me', null, token)).data;
    const phone = fakeAuthenticator('https://mac.tailnet.ts.net');
    assert.equal((await call('POST', '/api/passkey', phone.register(me.regChallenge), token)).status, 200);

    // Claude Code spustí hook
    const hookRun = runHook(base, permissionInput());
    const pending = await waitFor(async () => (await call('GET', '/api/state', null, token)).data.pending[0]);
    assert.equal(pending.summary, 'npm test');
    assert.equal(pending.project, 'nogreysk');
    assert.ok(pending.canAlways);
    assert.equal(pushes.at(-1).title, 'nogreysk: Bash');

    // bez Face ID neprejde
    assert.equal((await call('POST', `/api/requests/${pending.id}/decide`, { decision: 'allow' }, token)).status, 403);
    // s Face ID prejde, vrátane „vždy povoliť“
    const ok = await call('POST', `/api/requests/${pending.id}/decide`, { decision: 'allow', always: true, assertion: phone.assert(pending.challenge) }, token);
    assert.equal(ok.status, 200);

    const { out, code: exit } = await hookRun;
    assert.equal(exit, 0);
    const decision = JSON.parse(out).hookSpecificOutput.decision;
    assert.equal(decision.behavior, 'allow');
    assert.equal(decision.updatedPermissions[0].rules[0].ruleContent, 'npm test');
    assert.equal(JSON.parse(out).hookSpecificOutput.hookEventName, 'PermissionRequest');
  } finally {
    kukuk.server.close();
    kukuk.server.closeAllConnections();
  }
});

test('zamietnutie, terminál, PostToolUse a nedostupný server', async () => {
  const { kukuk, base, call } = await startServer();
  try {
    const { code } = kukuk.newPairingCode();
    const token = (await call('POST', '/api/pair', { code, name: 'Mac' })).data.token;

    // zamietnutie
    let run = runHook(base, permissionInput());
    let r = await waitFor(async () => (await call('GET', '/api/state', null, token)).data.pending[0]);
    await call('POST', `/api/requests/${r.id}/decide`, { decision: 'deny' }, token);
    let res = await run;
    const d = JSON.parse(res.out).hookSpecificOutput.decision;
    assert.equal(d.behavior, 'deny');
    assert.match(d.message, /Mac/);

    // „rozhodnem v termináli“ → hook skončí bez výstupu
    run = runHook(base, permissionInput());
    r = await waitFor(async () => (await call('GET', '/api/state', null, token)).data.pending[0]);
    await call('POST', `/api/agent/requests/${r.id}/decide`, { decision: 'terminal' }, 'agent-secret');
    res = await run;
    assert.equal(res.out, '');

    // používateľ to povolil priamo v termináli → PostToolUse to zruší na telefóne
    run = runHook(base, permissionInput({ session_id: 's2' }));
    r = await waitFor(async () => (await call('GET', '/api/state', null, token)).data.pending[0]);
    await runHook(base, { hook_event_name: 'PostToolUse', session_id: 's2', cwd: '/x/nogreysk', tool_name: 'Bash', tool_input: { command: 'npm test' } });
    res = await run;
    assert.equal(res.out, '');
    const st = (await call('GET', '/api/state', null, token)).data;
    assert.equal(st.pending.length, 0);
    assert.equal(st.history[0].status, 'elsewhere');

    // agent bez tokenu
    assert.equal((await call('GET', '/api/agent/state', null, 'zly')).status, 401);
    assert.equal((await call('GET', '/api/state', null, 'zly')).status, 401);
  } finally {
    kukuk.server.close();
    kukuk.server.closeAllConnections();
  }
  // server nebeží → hook ticho skončí a Claude Code ukáže bežný dialóg
  const res = await runHook('http://127.0.0.1:9', permissionInput());
  assert.equal(res.code, 0);
  assert.equal(res.out, '');
});

test('menubar výstup a inštalácia hookov', async () => {
  const { kukuk, base } = await startServer();
  try {
    const out = await new Promise((resolve) => {
      const c = spawn(process.execPath, [KUKUK_JS, 'menubar'], { env: { ...process.env, KUKUK_URL: base, KUKUK_TOKEN: 'agent-secret' } });
      let o = '';
      c.stdout.on('data', (x) => (o += x));
      c.on('close', () => resolve(o));
    });
    assert.match(out.split('\n')[0], /^kukuk/);
    assert.match(out, /Otvoriť Kukuk/);
  } finally {
    kukuk.server.close();
    kukuk.server.closeAllConnections();
  }

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kukuk-home-'));
  const settings = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settings));
  fs.writeFileSync(settings, JSON.stringify({ model: 'x', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo moje' }] }] } }));
  const run = (cmd) =>
    new Promise((resolve) => spawn(process.execPath, [KUKUK_JS, cmd], { env: { ...process.env, HOME: home } }).on('close', resolve));
  await run('install');
  await run('install'); // idempotentné
  let s = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.equal(s.model, 'x');
  assert.equal(s.hooks.Stop.length, 2);
  assert.equal(s.hooks.PermissionRequest.length, 1);
  assert.equal(s.hooks.PermissionRequest[0].hooks[0].timeout, 600);
  await run('uninstall');
  s = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.deepEqual(s.hooks, { Stop: [{ hooks: [{ type: 'command', command: 'echo moje' }] }] });
});
