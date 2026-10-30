/* Relik — ICE/TURN конфигурация для звонков.

   Проблема: статический логин/пароль TURN, зашитый в клиент, может забрать
   любой желающий и гонять через наш сервер свой трафик (счёт за канал).

   Решение: короткоживущие креды по схеме coturn «use-auth-secret»:
   username = "<expiry>:<login>", credential = base64(HMAC-SHA1(secret, username)).
   Секрет живёт только в базе (таблица turn_config, RLS без политик), клиент
   получает готовую пару через RPC turn_creds() на 1 час.

   Если миграция supabase/turn.sql ещё не применена — тихо откатываемся на
   статические креды из config.js, звонки продолжают работать. */

import { sb } from './supabaseClient.js';
import { SUPABASE, RELAY } from '../config.js';

const TTL_SAFETY_MS = 60_000;   // обновляем креды заранее
const FETCH_TIMEOUT_MS = 2500;  // не задерживаем начало звонка

let cache = null;   // { username, credential, uris, expiresAt }
let warned = false;

function stunEntries() {
  const list = [];
  for (const u of RELAY.stunUrls || []) list.push({ urls: u });
  list.push({ urls: 'stun:stun.l.google.com:19302' });
  list.push({ urls: 'stun:global.stun.twilio.com:3478' });
  return list;
}

function staticTurn() {
  if (!Array.isArray(RELAY.urls) || !RELAY.urls.length) return [];
  if (!RELAY.username || !RELAY.credential) return [];
  return [{ urls: RELAY.urls, username: RELAY.username, credential: RELAY.credential }];
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), ms)),
  ]);
}

/* Сходить за кредами в RPC. Кэшируем до истечения. */
export async function fetchTurnCreds({ force = false } = {}) {
  if (!force && cache && cache.expiresAt - TTL_SAFETY_MS > Date.now()) return cache;
  if (!SUPABASE.url || !SUPABASE.anonKey) return null;

  try {
    const res = await withTimeout(sb.rpc('turn_creds'), FETCH_TIMEOUT_MS);
    if (!res || res.timeout) return null;
    const { data, error } = res;
    if (error) {
      if (!warned) {
        warned = true;
        console.warn('turn_creds недоступен, используются статические TURN-креды:', error.message);
      }
      return null;
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row || !row.username || !row.credential) return null;
    const ttl = Math.max(300, Number(row.ttl) || 3600);
    cache = {
      username: String(row.username),
      credential: String(row.credential),
      uris: Array.isArray(row.uris) && row.uris.length ? row.uris : RELAY.urls,
      expiresAt: Date.now() + ttl * 1000,
    };
    return cache;
  } catch (err) {
    if (!warned) {
      warned = true;
      console.warn('turn_creds не получены, используются статические TURN-креды:', err?.message || err);
    }
    return null;
  }
}

/* Готовый iceServers для RTCPeerConnection. */
export async function getIceServers() {
  const creds = await fetchTurnCreds();
  if (creds) {
    return [...stunEntries(), { urls: creds.uris, username: creds.username, credential: creds.credential }];
  }
  return [...stunEntries(), ...staticTurn()];
}

/* Синхронный запас: если звонок начался раньше, чем пришли креды. */
export function currentIceServers() {
  if (cache && cache.expiresAt > Date.now()) {
    return [...stunEntries(), { urls: cache.uris, username: cache.username, credential: cache.credential }];
  }
  return [...stunEntries(), ...staticTurn()];
}

/* Для индикатора в настройках/диагностике. */
export function turnState() {
  if (cache && cache.expiresAt > Date.now()) return { mode: 'ephemeral', expiresAt: cache.expiresAt };
  if (!RELAY.username || !RELAY.credential) return { mode: 'stun-only', expiresAt: 0 };
  return { mode: 'static', expiresAt: 0 };
}
