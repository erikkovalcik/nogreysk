'use strict';
// Service worker – push notifikácie (aj na zamknutej obrazovke).
// Na Androide má notifikácia tlačidlá Povoliť / Zamietnuť priamo v sebe.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// Malé úložisko v IndexedDB – appka sem uloží token, aby SW vedel rozhodnúť bez otvárania appky.
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

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  const options = {
    body: data.body || 'Claude ťa potrebuje',
    tag: data.tag || undefined,
    renotify: !!data.tag,
    icon: '/icon-192.png',
    badge: '/badge-96.png',
    data: { url: data.url || '/', id: data.id, title: data.title },
  };
  if (data.actions) {
    options.actions = [
      { action: 'allow', title: '✅ Povoliť' },
      { action: 'deny', title: '⛔ Zamietnuť' },
    ];
    options.requireInteraction = true;
    options.vibrate = [80, 60, 80];
  }
  event.waitUntil(self.registration.showNotification(data.title || 'Kukuk', options));
});

async function openApp(path) {
  const url = new URL(path || '/', self.location.origin).href;
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const win of windows) {
    if ('focus' in win) {
      win.postMessage({ type: 'open', url });
      return win.focus();
    }
  }
  return self.clients.openWindow(url);
}

async function decideFromNotification(id, action, title) {
  const auth = await kv('get', 'auth').catch(() => null);
  // Povolenie s odtlačkom prsta / passkey musí prebehnúť v appke.
  if (!auth?.token || (action === 'allow' && auth.passkey)) {
    return openApp(`/?r=${encodeURIComponent(id)}${action === 'allow' ? '&a=allow' : ''}`);
  }
  let ok = false;
  let message = '';
  try {
    const res = await fetch(`/api/requests/${encodeURIComponent(id)}/decide`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: action }),
    });
    ok = res.ok;
    message = ok ? title || '' : (await res.json().catch(() => ({}))).error || `Chyba ${res.status}`;
  } catch {
    message = 'Server Kukuk je nedostupný';
  }
  const tag = `ok-${id}`;
  await self.registration.showNotification(ok ? (action === 'allow' ? 'Povolené ✓' : 'Zamietnuté ⛔') : 'Nepodarilo sa', {
    body: message,
    tag,
    silent: true,
    icon: '/icon-192.png',
    badge: '/badge-96.png',
    data: { url: '/' },
  });
  if (ok) {
    await new Promise((r) => setTimeout(r, 4000));
    for (const n of await self.registration.getNotifications({ tag })) n.close();
  }
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { id, url, title } = event.notification.data || {};
  if (id && (event.action === 'allow' || event.action === 'deny')) {
    event.waitUntil(decideFromNotification(id, event.action, title));
  } else {
    event.waitUntil(openApp(url));
  }
});
