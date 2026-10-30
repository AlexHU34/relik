/* Relik — Supabase-клиент (локальный SDK, без CDN)
   SDK лежит в js/vendor/supabase.js и подключён в index.html как UMD.
   Без ключей приложение работает в демо-режиме на IndexedDB. */

import { SUPABASE } from '../config.js';

const lib = typeof window !== 'undefined' ? window.supabase : null;

export const sb = (lib && SUPABASE.url && SUPABASE.anonKey)
  ? lib.createClient(SUPABASE.url, SUPABASE.anonKey, {
      auth: { persistSession: true, storageKey: 'relik-auth' },
      realtime: { params: { eventsPerSecond: 10 } },
    })
  : null;
