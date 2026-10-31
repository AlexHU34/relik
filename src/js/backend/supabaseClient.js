/* Relik — Supabase-клиент (локальный SDK, без CDN)
   SDK лежит в js/vendor/supabase.js и подключён в <head> как UMD (defer),
   поэтому к моменту выполнения модулей window.supabase уже определён.
   Без ключей приложение работает в демо-режиме на IndexedDB. */

import { SUPABASE } from '../config.js';

/* Клиент храним на window: сборщик может положить этот модуль в несколько
   чанков, и без общего ключа получилось бы два клиента и две realtime-подписки. */
const GLOBAL_KEY = '__relikSb';

function makeClient() {
  const lib = typeof window !== 'undefined' ? window.supabase : null;
  if (!lib || !SUPABASE.url || !SUPABASE.anonKey) return null;
  return lib.createClient(SUPABASE.url, SUPABASE.anonKey, {
    auth: { persistSession: true, storageKey: 'relik-auth' },
    realtime: { params: { eventsPerSecond: 10 } },
  });
}

function initSb() {
  if (typeof window === 'undefined') return null;
  if (window[GLOBAL_KEY]) return window[GLOBAL_KEY];
  const client = makeClient();
  if (client) window[GLOBAL_KEY] = client;
  return client;
}

export let sb = initSb();

/* Страховка от регресса порядка скриптов: если SDK ещё не выполнился,
   пробуем создать клиент после загрузки страницы (живая привязка обновится). */
if (typeof window !== 'undefined' && !sb && SUPABASE.url && SUPABASE.anonKey) {
  const late = () => { if (!sb) sb = initSb(); };
  window.addEventListener('load', late);
  setTimeout(late, 100);
  setTimeout(late, 1500);
  console.error('[relik] Supabase SDK не выполнился до старта модулей — проверьте порядок <script> в index.html.');
}
