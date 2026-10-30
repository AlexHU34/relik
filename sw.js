/* Relik — service worker: офлайн-оболочка PWA */
const VER = 'relik-v1.26.0';
const ASSETS = [
  './', './index.html', './legal.html', './welcome.html', './version.json', './manifest.json',
  './css/tokens.css', './css/base.css', './css/layout.css', './css/fonts.css',
  './assets/fonts/inter-cyrillic.woff2', './assets/fonts/inter-cyrillic-ext.woff2',
  './assets/fonts/inter-latin.woff2', './assets/fonts/inter-latin-ext.woff2',
  './css/components/chat.css', './css/components/composer.css', './css/components/modals.css', './css/components/call.css',
  './tools/status.html', './tools/preflight.html',
  './js/main.js', './js/config.js', './js/vendor/supabase.js', './js/vendor/qrcode.js',
  './js/i18n/i18n.js', './js/i18n/ru.js', './js/i18n/en.js',
  './js/db/idb.js', './js/data/mock.js', './js/data/emoji.js',
  './js/ui/state.js', './js/ui/utils.js', './js/ui/a11y.js', './js/ui/icons.js', './js/ui/toast.js',
  './js/ui/sidebar.js', './js/ui/chatView.js', './js/ui/composer.js', './js/ui/modals.js', './js/ui/router.js',
  './js/ui/themes.js', './js/ui/themeDefs.js', './js/ui/fonts.js', './js/ui/sounds.js', './js/ui/device.js', './js/ui/calls.js', './js/ui/notify.js',
  './js/ui/prefs.js', './js/ui/menu.js', './js/ui/dialog.js', './js/ui/richText.js', './js/ui/install.js', './js/ui/export.js', './js/ui/pin.js',
  './js/ui/palette.js', './js/ui/recovery.js', './js/ui/msgWindow.js', './js/db/mediaCache.js', './js/db/compaction.js',
  './js/backend/supabaseClient.js', './js/backend/auth.js', './js/backend/chats.js',  './js/backend/groups.js', './js/backend/groupKeys.js', './js/backend/messages.js', './js/backend/presence.js', './js/backend/storage.js', './js/backend/calls.js', './js/backend/prefsSync.js', './js/backend/devices.js', './js/backend/v2Messages.js', './js/backend/turn.js', './js/backend/contacts.js', './js/backend/blocks.js', './js/backend/telemetry.js', './js/backend/push.js',
  './js/crypto/keygen.js', './js/crypto/ecdh.js', './js/crypto/encryption.js', './js/crypto/backup.js', './js/crypto/fingerprint.js', './js/crypto/recovery.js', './js/crypto/v2/protocol.js',
  './js/vendor/bip39-wordlist.js',
  './js/backend/keyStore.js', './js/ui/keyRecovery.js', './js/backend/expiry.js', './js/backend/scheduled.js', './js/ui/iosHint.js',
  './assets/icons/icon-192.png', './assets/icons/icon-512.png',
];

/* Предзагрузка оболочки с ограничением параллельности: 86 файлов разом
   забивают канал на мобильном интернете и мешают первой отрисовке.
   5 потоков — компромисс: быстро и не отнимает полосу у приложения. */
async function preloadAssets(cache, urls, concurrency = 5) {
  const queue = urls.slice();
  const worker = async () => {
    while (queue.length) {
      const url = queue.shift();
      try {
        /* cache: no-cache — иначе GitHub Pages (max-age=600) может отдать
           в новый кэш старую версию файла. Один отсутствующий файл не
           должен ломать установку SW. */
        const res = await fetch(new Request(url, { cache: 'no-cache' }));
        if (res && res.ok) await cache.put(url, res);
      } catch (e) { /* пропускаем битый файл */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker));
}

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VER)
      .then((c) => preloadAssets(c, ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

/* ── Web Push ─────────────────────────────────────────────── */
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = {}; }
  const title = data.title || 'Relik';
  const body = data.body || 'Новое сообщение';
  const url = data.url || './';
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: './assets/icons/icon-192.png',
      badge: './assets/icons/icon-192.png',
      tag: data.tag || 'relik-msg',
      renotify: true,
      data: { url },
    }).catch(() => {})
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (c.url.includes('/relik/')) {
        try { await c.focus(); } catch (e) { /* ignore */ }
        try { c.postMessage({ type: 'relik:open-chat', url }); } catch (e) { /* ignore */ }
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VER).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* Стратегии:
   - навигация и version.json — network-first (свежий HTML после деплоя);
   - статика — stale-while-revalidate (мгновенно из кэша + тихое обновление).
   При смене VER старый кэш удаляется целиком, поэтому «залипших» файлов нет. */
const isHTML = (req, url) => req.mode === 'navigate' || /\/(index|legal|welcome)\.html$/.test(url.pathname) || url.pathname.endsWith('/');

/* Навигация не должна ждать мёртвую сеть дольше 5 секунд */
async function fetchWithTimeout(request, ms = 5000) {
  if (typeof AbortController === 'undefined') return fetch(request);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(new Request(request, { cache: 'no-store', signal: ctrl.signal }));
  } finally {
    clearTimeout(timer);
  }
}

async function networkFirst(event, url) {
  try {
    const res = await fetchWithTimeout(event.request);
    /* ответ-заглушка при офлайне не должен подменять страницу */
    if (!res || res.type === 'error' || res.status === 0) throw new Error('network');
    if (res.ok) {
      const copy = res.clone();
      caches.open(VER).then((c) => c.put(event.request, copy)).catch(() => {});
    }
    return res;
  } catch (err) {
    const hit = await caches.match(event.request, { ignoreSearch: true });
    if (hit) return hit;
    return (await caches.match('./index.html')) || Response.error();
  }
}

async function staleWhileRevalidate(event) {
  const cache = await caches.open(VER);
  const hit = await cache.match(event.request);
  const network = fetch(new Request(event.request, { cache: 'no-cache' }))
    .then((res) => {
      if (res && res.ok) cache.put(event.request, res.clone()).catch(() => {});
      return res;
    })
    .catch(() => null);
  /* ВАЖНО: ждём сеть, если кэша нет; иначе отдаём кэш без ожидания. */
  return hit || (await network) || Response.error();
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.endsWith('/version.json')) {
    e.respondWith(networkFirst(e, url));
    return;
  }
  if (isHTML(e.request, url)) {
    e.respondWith(networkFirst(e, url));
    return;
  }
  e.respondWith(staleWhileRevalidate(e));
});
