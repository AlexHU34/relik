/* Relik — Supabase-клиент (локальный SDK, без CDN)
   SDK лежит в js/vendor/supabase.js и загружается лениво через sdk.js:
   на первом экране его нет в критическом пути, а клиент создаётся, когда
   бэкенд действительно понадобился (restoreSession, вход, первый запрос).
   Без ключей приложение работает в демо-режиме на IndexedDB. */

import { SUPABASE } from '../config.js';
import { ensureSdk, HAS_BACKEND } from './sdk.js';

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

function bind() {
  if (typeof window === 'undefined' || !HAS_BACKEND) return null;
  if (window[GLOBAL_KEY]) {
    sb = window[GLOBAL_KEY];
    return sb;
  }
  const client = makeClient();
  if (client) {
    window[GLOBAL_KEY] = client;
    sb = client;
  }
  return sb;
}

/* Живая привязка: модули читают sb в момент вызова и видят клиент,
   как только он появится. До этого здесь null — это нормальное состояние
   «SDK ещё не загружен», а не ошибка. */
export let sb = null;
bind();

/** Дождаться SDK (если нужно) и вернуть готовый клиент. В демо — null. */
export async function ensureClient() {
  if (sb) return sb;
  if (!HAS_BACKEND) return null;
  await ensureSdk();
  return bind();
}

export { ensureSdk, HAS_BACKEND };
