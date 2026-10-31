/* Relik — поиск людей по имени или @username (пустой запрос — все).
   Быстрый путь: RPC search_people (supabase/search.sql) — один запрос,
   сервер сам сортирует «точное совпадение → префикс → вхождение».
   Второй путь: обычный select с закэшированным набором колонок.
   Кэш в памяти + в localStorage, чтобы не тратить запросы на схемные пробы.
   Вынесено из chats.js, чтобы модуль не рос и поиск можно было покрыть тестами. */

import { sb } from './supabaseClient.js';
import { SUPABASE } from '../config.js';

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}: timeout ${Math.round(ms / 1000)}s`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

const COLS_KEY = 'relik.profiles.cols.v1';
const RPC_KEY = 'relik.search.rpc.v1';
const SEARCH_TTL = 15000;
const searchCache = new Map();

function readJson(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; }
}
function writeJson(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* приватный режим */ }
}

function colsToSelect(cols) {
  return `id, display_name, avatar_hue, public_key, last_seen${cols.avatar ? ', avatar' : ''}${cols.username ? ', username' : ''}${cols.role ? ', role' : ''}`;
}

function candidateCols() {
  const saved = readJson(COLS_KEY);
  if (saved && typeof saved === 'object') return [saved];
  return [
    { username: true, avatar: true, role: true },
    { username: true, avatar: true, role: false },
    { username: true, avatar: false, role: false },
    { username: false, avatar: false, role: false },
  ];
}

/* RPC search_people: один быстрый запрос вместо перебора колонок */
async function searchByRpc(q) {
  if (readJson(RPC_KEY) === false) return null;
  try {
    const { data, error } = await withTimeout(
      sb.rpc('search_people', { q: q || '' }),
      6000,
      'search',
    );
    if (error) {
      if (/could not find|does not exist|schema cache|function/i.test(error.message || '')) {
        writeJson(RPC_KEY, false);
        return null;
      }
      throw error;
    }
    writeJson(RPC_KEY, true);
    return data || [];
  } catch (err) {
    const msg = String(err?.message || '');
    /* миграции нет — больше не пробуем в этой сессии */
    if (/could not find|does not exist|schema cache|function/i.test(msg)) {
      writeJson(RPC_KEY, false);
      return null;
    }
    /* таймаут не отключает RPC: просто сейчас отвечаем через таблицу */
    if (/timeout/i.test(msg)) return null;
    throw err;
  }
}

async function searchByTable(q) {
  const safe = q.replace(/[,()]/g, ' ').trim();
  let lastError = null;
  for (const cols of candidateCols()) {
    let req = sb.from('profiles').select(colsToSelect(cols)).order('display_name').limit(50);
    if (q) {
      req = cols.username
        ? req.or(`display_name.ilike.%${safe}%,username.ilike.%${safe}%`)
        : req.ilike('display_name', `%${safe}%`);
    }
    const { data, error } = await withTimeout(req, 6000, 'profiles');
    if (!error) {
      writeJson(COLS_KEY, cols);
      return data || [];
    }
    lastError = error;
    if (!/42703|column.*does not exist|schema cache/i.test(error.message || '')) break;
    /* набор колонок не подошёл — сбрасываем кэш и пробуем следующий */
    writeJson(COLS_KEY, null);
  }
  throw lastError || new Error('Не удалось получить список пользователей');
}

/* общий список результатов → единый вид для UI */
function normalizePeople(rows) {
  return (rows || []).map((p) => ({
    ...p,
    display_name: p.display_name || '',
    avatar_hue: p.avatar_hue ?? 0,
  }));
}

/* Профили по списку id (для экрана «только контакты») */
export async function profilesByIds(ids) {
  if (!Array.isArray(ids) || !ids.length) return [];
  const cols = candidateCols()[0];
  const { data, error } = await withTimeout(
    sb.from('profiles').select(colsToSelect(cols)).in('id', ids).limit(200),
    6000,
    'profiles',
  );
  if (error) throw error;
  return data || [];
}

export async function searchUsers(query) {
  const q = String(query || '').trim().replace(/^@+/, '');
  if (!(SUPABASE.url && SUPABASE.anonKey) || !sb) return [];

  const key = q.toLowerCase();
  const hit = searchCache.get(key);
  if (hit && Date.now() - hit.at < SEARCH_TTL) return hit.rows;

  /* Сеть до Supabase иногда «залипает» на первом запросе после входа.
     Один быстрый повтор превращает пустой экран в нормальный список. */
  let rows = null;
  let lastErr = null;
  for (let attempt = 0; attempt < 2 && rows === null; attempt += 1) {
    if (attempt) await new Promise((r) => setTimeout(r, 400));
    try {
      rows = await searchByRpc(q);
      if (rows === null) rows = await searchByTable(q);
    } catch (err) {
      lastErr = err;
      rows = null;
    }
  }
  if (rows === null) throw lastErr || new Error('поиск людей недоступен');
  rows = normalizePeople(rows);

  searchCache.set(key, { at: Date.now(), rows });
  return rows;
}
