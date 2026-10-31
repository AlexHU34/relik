/* Relik — service worker: офлайн-оболочка PWA */
const VER = 'relik-v1.38.0';
const ASSETS = [
  './.nojekyll',
  './admin.html',
  './assets/apple-touch-icon-gc2qwoFq.png',
  './assets/auth-CFrAD3A-.js',
  './assets/base-BxOl2HU4.css',
  './assets/blocks-CEDxkmhZ.js',
  './assets/chatView-D5gkBJ5c.js',
  './assets/compaction-DWUaVnFN.js',
  './assets/config-BdSpPKjc.js',
  './assets/favicon-32-CXOIw-HK.png',
  './assets/favicon-48-DneR8WOl.png',
  './assets/fingerprint-DcziYqqC.js',
  './assets/icon-192-BeTextaT.png',
  './assets/icons/apple-touch-icon.png',
  './assets/icons/favicon-32.png',
  './assets/icons/favicon-48.png',
  './assets/icons/icon-1024.png',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/maskable-512.png',
  './assets/index-BUngaIog.css',
  './assets/index-z-FrRz0d.js',
  './assets/inter-cyrillic-DqGufNeO.woff2',
  './assets/inter-cyrillic-ext-BOeWTOD4.woff2',
  './assets/inter-latin-Dx4kXJAl.woff2',
  './assets/inter-latin-ext-DO1Apj_S.woff2',
  './assets/main-DfjtnF9D.js',
  './assets/manifest-DiYcaPFD.json',
  './assets/messages-CVkGUqFQ.js',
  './assets/state-0qaezjC3.js',
  './assets/tools_selftest-SHNsceai.js',
  './index.html',
  './js/vendor/qrcode.js',
  './js/vendor/supabase.js',
  './legal.html',
  './manifest.json',
  './tools/diagnostics.html',
  './tools/health.html',
  './tools/phone.html',
  './tools/preflight.html',
  './tools/selftest.html',
  './tools/status.html',
  './version.json',
  './welcome.html',
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
