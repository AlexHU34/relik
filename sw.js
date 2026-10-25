/* Relik — service worker: офлайн-оболочка PWA */
const VER = 'relik-v1.11.0';
const ASSETS = [
  './', './index.html', './manifest.json',
  './css/tokens.css', './css/base.css', './css/layout.css',
  './css/components/chat.css', './css/components/composer.css', './css/components/modals.css', './css/components/call.css',
  './js/main.js', './js/config.js', './js/vendor/supabase.js',
  './js/i18n/i18n.js', './js/i18n/ru.js', './js/i18n/en.js',
  './js/db/idb.js', './js/data/mock.js', './js/data/emoji.js',
  './js/ui/state.js', './js/ui/utils.js', './js/ui/icons.js', './js/ui/toast.js',
  './js/ui/sidebar.js', './js/ui/chatView.js', './js/ui/composer.js', './js/ui/modals.js', './js/ui/router.js',
  './js/ui/themes.js', './js/ui/fonts.js', './js/ui/sounds.js', './js/ui/device.js', './js/ui/calls.js', './js/ui/notify.js',
  './js/ui/prefs.js', './js/ui/menu.js', './js/ui/dialog.js', './js/ui/richText.js', './js/ui/install.js',
  './js/backend/supabaseClient.js', './js/backend/auth.js', './js/backend/chats.js',  './js/backend/groups.js', './js/backend/messages.js', './js/backend/presence.js', './js/backend/storage.js', './js/backend/calls.js',
  './js/crypto/keygen.js', './js/crypto/ecdh.js', './js/crypto/encryption.js', './js/crypto/backup.js',
  './assets/icons/icon-192.png', './assets/icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VER).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VER).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  /* network-first + принудительная ревалидация HTTP-кеша:
     после деплоя свежий код подхватывается сразу, а не через 10 минут */
  const req = new Request(e.request, { cache: 'no-cache' });
  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(VER).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() =>
        caches.match(e.request).then((hit) =>
          hit || caches.match('./index.html'))
      )
  );
});
