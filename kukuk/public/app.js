'use strict';
// Kukuk – webová appka (PWA) pre telefón aj počítač.

const $ = (s) => document.querySelector(s);
const TOKEN_KEY = 'kukuk.token';
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isAndroid = /Android/.test(navigator.userAgent);
const BIO = isIOS ? 'Face ID' : isAndroid ? 'odtlačok prsta' : /Mac/.test(navigator.platform) ? 'Touch ID' : 'passkey';
const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const storage = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};

let token = storage.get(TOKEN_KEY);
let me = null;
let st = { pending: [], history: [], sessions: [], now: Date.now() };
let clockSkew = 0;
let es = null;
const params = new URLSearchParams(location.search);
let focusId = params.get('r');
let autoAllow = params.get('a') === 'allow';
const busy = new Set();

// ---------- pomocníci ----------

const b64u = {
  enc(buf) {
    let s = '';
    for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  dec(str) {
    const s = str.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  },
};

// IndexedDB – zdieľané so service workerom (tlačidlá v notifikácii na Androide).
function kv(op, key, value) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('kukuk', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction('kv', op === 'get' ? 'readonly' : 'readwrite');
      const store = tx.objectStore('kv');
      const req = op === 'get' ? store.get(key) : op === 'set' ? store.put(value, key) : store.delete(key);
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
    };
  });
}
const shareAuth = () => kv('set', 'auth', { token, passkey: !!me?.passkey }).catch(() => {});

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - clockSkew - ts) / 1000));
  if (s < 10) return 'práve teraz';
  if (s < 60) return `pred ${s} s`;
  if (s < 3600) return `pred ${Math.round(s / 60)} min`;
  return `pred ${Math.round(s / 3600)} h`;
}

let toastTimer;
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `show${err ? ' err' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ''), 3200);
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token) {
    logout();
    throw new Error('Zariadenie už nie je spárované');
  }
  if (!res.ok) throw new Error(data.error || `Chyba ${res.status}`);
  return data;
}

function logout() {
  token = null;
  storage.set(TOKEN_KEY, null);
  kv('del', 'auth').catch(() => {});
  if (es) es.close();
  showPair();
}

// ---------- párovanie ----------
function showPair() {
  $('#view-main').hidden = true;
  $('#view-pair').hidden = false;
  $('#ios-hint').hidden = !(isIOS && !standalone);
  $('#pair-name').value ||= isAndroid ? 'Android' : isIOS ? (/iPad/.test(navigator.userAgent) ? 'iPad' : 'iPhone') : /Mac/.test(navigator.platform) ? 'Mac' : 'Prehliadač';
  setConn(null);
}

$('#pair-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.submitter || $('#pair-form button');
  btn.disabled = true;
  try {
    const res = await fetch('/api/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: $('#pair-code').value, name: $('#pair-name').value }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Párovanie zlyhalo');
    token = data.token;
    storage.set(TOKEN_KEY, token);
    toast('Spárované 🎉');
    await boot();
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

// ---------- hlavný pohľad ----------
async function boot() {
  if (!token) return showPair();
  try {
    me = await api('GET', '/api/me');
  } catch (err) {
    if (!token) return;
    setConn(false);
    toast(err.message, true);
    setTimeout(boot, 4000);
    return;
  }
  $('#view-pair').hidden = true;
  $('#view-main').hidden = false;
  shareAuth();
  await syncPushSubscription();
  renderSetup();
  renderSettings();
  connect();
}

function setConn(ok) {
  const c = $('#conn');
  c.className = `conn${ok === true ? ' ok' : ok === false ? ' bad' : ''}`;
  $('#conn-text').textContent = ok === true ? 'pripojené' : ok === false ? 'odpojené' : '';
}

function connect() {
  if (es) es.close();
  es = new EventSource(`/api/stream?token=${encodeURIComponent(token)}`);
  es.addEventListener('state', (ev) => {
    st = JSON.parse(ev.data);
    clockSkew = Date.now() - st.now;
    setConn(true);
    render();
  });
  es.onerror = async () => {
    setConn(false);
    if (es.readyState === EventSource.CLOSED) {
      try {
        await api('GET', '/api/me');
        setTimeout(connect, 3000);
      } catch {}
    }
  };
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && token && me) {
    if (!es || es.readyState === EventSource.CLOSED) connect();
    api('GET', '/api/state').then((s) => { st = s; clockSkew = Date.now() - s.now; render(); }).catch(() => {});
  }
});

navigator.serviceWorker?.addEventListener('message', (e) => {
  if (e.data?.type === 'open') {
    const p = new URL(e.data.url).searchParams;
    focusId = p.get('r');
    autoAllow = p.get('a') === 'allow';
    render();
  }
});

// ---------- vykreslenie ----------
function render() {
  const pending = st.pending || [];
  document.body.classList.toggle('alert', pending.length > 0);
  document.title = pending.length ? `(${pending.length}) Kukuk` : 'Kukuk';
  $('#pending-count').textContent = pending.length || '';
  navigator.setAppBadge?.(pending.length).catch?.(() => {});
  if (!pending.length) navigator.clearAppBadge?.().catch?.(() => {});

  // nerenderuj zoznam, kým prebieha Face ID (prišlo by o tlačidlá)
  if (!busy.size) {
    $('#pending').innerHTML = pending.length
      ? pending.map(renderRequest).join('')
      : `<div class="card empty"><span class="big">🫥</span>Nič nečaká. Claude pracuje sám.</div>`;
  }

  const label = { working: 'pracuje', waiting: 'čaká na povolenie', idle: 'čaká na teba', done: 'hotovo' };
  $('#sessions').innerHTML = st.sessions?.length
    ? `<div class="card">${st.sessions
        .map(
          (s) => `<div class="row"><div class="grow"><div class="title">${esc(s.project)}</div>
            <div class="sub">${esc(s.message || s.cwd || '')}</div></div>
            <span class="pill ${esc(s.status)}">${label[s.status] || esc(s.status)}</span></div>`,
        )
        .join('')}</div>`
    : `<div class="card empty small">Zatiaľ žiadne relácie. Spusti <code>claude</code> na Macu.</div>`;

  const res = { allow: 'povolené', deny: 'zamietnuté', terminal: 'v termináli', elsewhere: 'vybavené inde' };
  $('#history').innerHTML = st.history?.length
    ? st.history
        .map(
          (r) => `<div class="row"><div class="grow"><div class="title">${esc(r.project)} · ${esc(r.tool)}</div>
            <div class="sub mono">${esc(r.summary)}</div>
            <div class="sub">${ago(r.decidedAt || r.createdAt)}${r.decidedBy ? ` · ${esc(r.decidedBy)}` : ''}</div></div>
            <span class="pill ${esc(r.status)}">${res[r.status] || esc(r.status)}</span></div>`,
        )
        .join('')
    : '<p class="muted small">Prázdne.</p>';

  if (focusId) {
    const el = document.getElementById(`req-${focusId}`);
    if (el) {
      el.classList.add('focus');
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      focusId = null;
      history.replaceState(null, '', '/');
      // ťuk na „Povoliť“ v notifikácii → rovno vyvolaj overenie odtlačkom
      if (autoAllow) {
        autoAllow = false;
        el.querySelector('[data-act="allow"]')?.click();
      }
    }
  }
}

function renderRequest(r) {
  const faceId = me?.passkey ? ` · ${BIO}` : '';
  return `<article class="card req" id="req-${esc(r.id)}">
    <div class="req-head">
      <div class="tool">${esc(r.tool)} <span class="proj">· ${esc(r.project)}</span></div>
      <div class="age" data-ts="${r.createdAt}">${ago(r.createdAt)}</div>
    </div>
    <div class="summary">${esc(r.summary || '(bez popisu)')}</div>
    ${r.detail && r.detail !== r.summary ? `<details><summary>Detail</summary><pre>${esc(r.detail)}</pre></details>` : ''}
    <div class="actions">
      <button class="btn deny" data-act="deny" data-id="${esc(r.id)}">Zamietnuť</button>
      <button class="btn allow" data-act="allow" data-id="${esc(r.id)}">Povoliť${faceId}</button>
      ${r.canAlways ? `<button class="btn wide" data-act="always" data-id="${esc(r.id)}">Povoliť vždy (pre tento projekt)</button>` : ''}
      <button class="btn ghost wide" data-act="terminal" data-id="${esc(r.id)}">Rozhodnem v termináli</button>
    </div>
  </article>`;
}

setInterval(() => {
  for (const el of document.querySelectorAll('[data-ts]')) el.textContent = ago(Number(el.dataset.ts));
}, 10_000);

// ---------- rozhodovanie ----------
$('#pending').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const r = (st.pending || []).find((x) => x.id === btn.dataset.id);
  if (!r) return;
  const act = btn.dataset.act;
  const decision = act === 'always' ? 'allow' : act;
  const buttons = btn.closest('.actions').querySelectorAll('button');
  buttons.forEach((b) => (b.disabled = true));
  busy.add(r.id);
  try {
    let assertion;
    if (decision === 'allow' && me.passkey) {
      // credentials.get musí ísť hneď v obsluhe kliknutia (Safari), preto challenge prišla vopred.
      const cred = await navigator.credentials.get({
        publicKey: {
          challenge: b64u.dec(r.challenge),
          rpId: me.passkey.rpId,
          allowCredentials: [{ type: 'public-key', id: b64u.dec(me.passkey.id) }],
          userVerification: 'required',
          timeout: 60_000,
        },
      });
      assertion = {
        id: cred.id,
        authenticatorData: b64u.enc(cred.response.authenticatorData),
        clientDataJSON: b64u.enc(cred.response.clientDataJSON),
        signature: b64u.enc(cred.response.signature),
      };
    }
    await api('POST', `/api/requests/${r.id}/decide`, { decision, always: act === 'always', assertion });
    toast(decision === 'allow' ? 'Povolené ✓' : decision === 'deny' ? 'Zamietnuté' : 'Rozhodneš v termináli');
  } catch (err) {
    toast(err.name === 'NotAllowedError' ? `Overenie zrušené – ťukni znova na Povoliť` : err.message, true);
  } finally {
    busy.delete(r.id);
    buttons.forEach((b) => (b.disabled = false));
    render();
  }
});

// ---------- notifikácie ----------
async function syncPushSubscription() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js');
    const sub = await reg.pushManager?.getSubscription();
    if (sub && Notification.permission === 'granted') {
      await api('POST', '/api/push/subscribe', { subscription: sub.toJSON() });
      me.push = true;
    }
  } catch {}
}

async function enablePush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    throw new Error(isIOS && !standalone ? 'Najprv si Kukuk pridaj na plochu (Zdieľať → Pridať na plochu).' : 'Tento prehliadač nepodporuje push notifikácie.');
  }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Notifikácie nie sú povolené v nastaveniach.');
  const reg = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  const key = b64u.dec(me.vapidPublicKey);
  let sub = await reg.pushManager.getSubscription();
  if (sub && b64u.enc(sub.options?.applicationServerKey || new ArrayBuffer(0)) !== me.vapidPublicKey) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ||= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await api('POST', '/api/push/subscribe', { subscription: sub.toJSON() });
  me.push = true;
}

// ---------- Face ID / Touch ID ----------
async function setupPasskey() {
  if (!window.PublicKeyCredential) throw new Error('Tento prehliadač nepodporuje passkeys.');
  const cred = await navigator.credentials.create({
    publicKey: {
      challenge: b64u.dec(me.regChallenge),
      rp: { name: 'Kukuk' },
      user: { id: new TextEncoder().encode(me.id), name: `kukuk-${me.name}`, displayName: `Kukuk · ${me.name}` },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
      attestation: 'none',
      timeout: 60_000,
    },
  });
  const publicKey = cred.response.getPublicKey?.();
  if (!publicKey) throw new Error('Prehliadač je príliš starý (chýba getPublicKey).');
  await api('POST', '/api/passkey', {
    id: cred.id,
    publicKey: b64u.enc(publicKey),
    clientDataJSON: b64u.enc(cred.response.clientDataJSON),
  });
}

function renderSetup() {
  const steps = [];
  if (isIOS && !standalone) {
    steps.push(`<div class="setup-step"><div class="grow"><strong>Pridaj Kukuk na plochu</strong>
      <div class="sub">Zdieľať → Pridať na plochu. Notifikácie na iPhone fungujú len tak.</div></div></div>`);
  }
  if (!me.push) {
    steps.push(`<div class="setup-step"><div class="grow"><strong>Notifikácie</strong>
      <div class="sub">Upozornenie aj na zamknutej obrazovke, keď ťa Claude potrebuje.</div></div>
      <button class="btn primary small" id="btn-push">Zapnúť</button></div>`);
  }
  if (!me.passkey && window.PublicKeyCredential) {
    steps.push(`<div class="setup-step"><div class="grow"><strong>Potvrdzovať cez ${BIO}</strong>
      <div class="sub">Každé povolenie potvrdíš biometriou – nikto iný s tvojím telefónom nič neschváli.${isAndroid ? ' Bez toho sa dá povoliť jedným ťuknutím priamo v notifikácii.' : ''}</div></div>
      <button class="btn primary small" id="btn-passkey">Nastaviť</button></div>`);
  }
  if (me.passkey && me.passkey.rpId !== location.hostname) {
    steps.push(`<div class="setup-step"><div class="grow"><strong>Iná adresa</strong>
      <div class="sub">${BIO} bolo nastavené pre ${esc(me.passkey.rpId)}. Otvor Kukuk cez túto adresu, inak povolenie neprejde.</div></div></div>`);
  }
  $('#setup').innerHTML = steps.length ? `<div class="card">${steps.join('')}</div>` : '';
  $('#btn-push')?.addEventListener('click', (e) => runStep(e.currentTarget, enablePush, 'Notifikácie zapnuté 🔔'));
  $('#btn-passkey')?.addEventListener('click', (e) => runStep(e.currentTarget, setupPasskey, `${BIO[0].toUpperCase() + BIO.slice(1)} nastavené 🔐`));
}

async function runStep(btn, fn, ok) {
  btn.disabled = true;
  try {
    await fn();
    toast(ok);
  } catch (err) {
    toast(err.name === 'NotAllowedError' ? 'Zrušené' : err.message, true);
  }
  try {
    me = await api('GET', '/api/me');
    shareAuth();
  } catch {}
  btn.disabled = false;
  renderSetup();
  renderSettings();
}

function renderSettings() {
  const p = me.prefs || {};
  $('#settings').innerHTML = `
    <p class="muted small">Zariadenie: <b>${esc(me.name)}</b> · notifikácie ${me.push ? 'zapnuté' : 'vypnuté'} · ${me.passkey ? `${BIO} zapnuté` : 'bez biometrie'}</p>
    <label class="switch">Upozorniť, keď Claude dokončí prácu <input type="checkbox" id="pref-stop" ${p.stop !== false ? 'checked' : ''}></label>
    <label class="switch">Upozorniť, keď Claude čaká na odpoveď <input type="checkbox" id="pref-idle" ${p.idle !== false ? 'checked' : ''}></label>
    <div class="buttons">
      ${me.push ? '<button class="btn small" id="btn-test">Skúšobná notifikácia</button>' : ''}
      <button class="btn small deny" id="btn-unpair">Odpárovať zariadenie</button>
    </div>`;
  const savePrefs = () =>
    api('POST', '/api/prefs', { stop: $('#pref-stop').checked, idle: $('#pref-idle').checked })
      .then((r) => { me.prefs = r.prefs; toast('Uložené'); })
      .catch((e) => toast(e.message, true));
  $('#pref-stop').addEventListener('change', savePrefs);
  $('#pref-idle').addEventListener('change', savePrefs);
  $('#btn-test')?.addEventListener('click', () => api('POST', '/api/push/test').then(() => toast('Odoslané – pozri notifikácie')).catch((e) => toast(e.message, true)));
  $('#btn-unpair').addEventListener('click', async () => {
    if (!confirm('Naozaj odpárovať toto zariadenie?')) return;
    await api('POST', '/api/unpair').catch(() => {});
    logout();
  });
}

boot();
