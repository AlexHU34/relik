/* Relik — управление чатами через Supabase (Фаза 5)
   Загрузка чатов, создание личных чатов, участники */

import { sb } from './supabaseClient.js';
import { idb } from '../db/idb.js';
import { S } from '../ui/state.js';
import { SUPABASE } from '../config.js';

/* ── Колонка profiles.avatar появляется миграцией supabase/avatar.sql.
   Проверяем один раз: до миграции приложение тоже работает — аватар
   тогда хранится в метаданных пользователя Supabase Auth. ── */
let avatarCol = null;
export async function hasAvatarColumn() {
  if (avatarCol !== null) return avatarCol;
  if (!sb) { avatarCol = false; return false; }
  const { error } = await sb.from('profiles').select('avatar').limit(1);
  if (!error) { avatarCol = true; return true; }
  if (error.code === '42703' || /column.*does not exist|schema cache/i.test(error.message || '')) {
    avatarCol = false;
    return false;
  }
  /* сетевую ошибку не запоминаем — попробуем в следующий раз */
  return false;
}

let usernameCol = null;
export async function hasUsernameColumn() {
  if (usernameCol !== null) return usernameCol;
  if (!sb) { usernameCol = false; return false; }
  const { error } = await sb.from('profiles').select('username').limit(1);
  if (!error) { usernameCol = true; return true; }
  if (error.code === '42703' || /column.*does not exist|schema cache/i.test(error.message || '')) {
    usernameCol = false;
    return false;
  }
  return false;
}

let roleCol = null;
export async function hasRoleColumn() {
  if (roleCol !== null) return roleCol;
  if (!sb) { roleCol = false; return false; }
  const { error } = await sb.from('profiles').select('role').limit(1);
  if (!error) { roleCol = true; return true; }
  if (error.code === '42703' || /column.*does not exist|schema cache/i.test(error.message || '')) {
    roleCol = false;
    return false;
  }
  return false;
}

function profileCols(withAvatar, withUsername, withRole) {
  return `id, display_name, avatar_hue, public_key${withAvatar ? ', avatar' : ''}${withUsername ? ', username' : ''}${withRole ? ', role' : ''}`;
}

/* Контакты в S.users всегда свежие (имя, цвет, аватар) */
function upsertUser(p) {
  const i = S.users.findIndex((u) => u.id === p.id);
  const prev = i >= 0 ? S.users[i] : null;
  const fresh = {
    id: p.id,
    name: p.display_name,
    username: p.username || null,
    role: p.role || 'user',
    hue: p.avatar_hue ?? 0,
    avatar: p.avatar || null,
    seen: prev?.seen || 'offline',
  };
  if (i >= 0) S.users[i] = { ...prev, ...fresh };
  else S.users.push(fresh);
}

/* ── Загрузка всех чатов пользователя ── */
export async function loadChats() {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return [];

  const pcols = profileCols(await hasAvatarColumn(), await hasUsernameColumn(), await hasRoleColumn());

  const { data: members, error } = await sb
    .from('conversation_members')
    .select(`conversation_id, conversations(*, conversation_members(user_id, profiles(${pcols})))`)
    .eq('user_id', user.id);

  if (error) throw error;

  // Преобразуем в формат приложения
  const chats = members.map((m) => {
    const conv = m.conversations;
    const otherMembers = conv.conversation_members.filter((cm) => cm.user_id !== user.id);

    if (conv.kind === 'dm') {
      // Личный чат
      const otherProfile = otherMembers[0]?.profiles;
      if (otherProfile) upsertUser(otherProfile);
      return {
        id: conv.id,
        kind: 'dm',
        userId: otherProfile?.id,
        members: [otherProfile?.id],
        createdBy: conv.created_by || null,
        unread: 0,
        last: null,
        title: otherProfile?.display_name,
        hue: otherProfile?.avatar_hue,
        avatar: otherProfile?.avatar || null,
        username: otherProfile?.username || null,
        role: otherProfile?.role || 'user',
        publicKey: otherProfile?.public_key,
      };
    } else {
      // Групповой чат — добавляем профили участников в контакты
      for (const cm of conv.conversation_members) {
        const p = cm.profiles;
        if (p) upsertUser(p);
      }
      return {
        id: conv.id,
        kind: 'group',
        title: conv.title,
        hue: conv.hue || 0,
        createdBy: conv.created_by || null,
        members: conv.conversation_members
          .map((cm) => cm.user_id)
          .filter((id) => id !== user.id),
        unread: 0,
        last: null,
      };
    }
  });

  // Кэшируем в IndexedDB
  await idb.bulkPut('chats', chats);

  return chats;
}

/* ── Создание личного чата ── */
export async function createDmChat(targetUserId) {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  /* Атомарный RPC из supabase/dm_fix.sql: оба участника в одной транзакции.
     Если миграции ещё нет — работаем старым способом. */
  try {
    const { data, error } = await sb.rpc('create_dm', { target_user: targetUserId });
    if (!error && data) return data;
    if (error && !/could not find|does not exist|schema cache|function/i.test(error.message || '')) {
      throw error;
    }
  } catch (err) {
    if (!/could not find|does not exist|schema cache|function/i.test(err?.message || '')) throw err;
  }

  // Проверяем, есть ли уже чат
  const { data: existing } = await sb
    .from('conversation_members')
    .select('conversation_id, conversations(kind)')
    .eq('user_id', user.id);

  if (existing) {
    for (const member of existing) {
      /* Группа — не личный чат, даже если в ней есть этот человек */
      if (member.conversations?.kind !== 'dm') continue;
      const { data: other } = await sb
        .from('conversation_members')
        .select('user_id')
        .eq('conversation_id', member.conversation_id)
        .eq('user_id', targetUserId)
        .maybeSingle();

      if (other) {
        // Чат уже существует
        return member.conversation_id;
      }
    }
  }

  // Создаём новый чат (id генерируем на клиенте — без RETURNING, чтобы не зависеть от RLS на чтение)
  const convId = (crypto.randomUUID ? crypto.randomUUID() : 'c_' + Date.now().toString(36));
  const { error: convError } = await sb
    .from('conversations')
    .insert({ id: convId, kind: 'dm', created_by: user.id });

  if (convError) throw convError;

  // Добавляем участников
  const { error: membersError } = await sb
    .from('conversation_members')
    .insert([
      { conversation_id: convId, user_id: user.id },
      { conversation_id: convId, user_id: targetUserId },
    ]);

  if (membersError) throw membersError;

  return convId;
}

/* ── Получение профиля пользователя по ID ── */
export async function getProfile(userId) {
  const { data, error } = await sb
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

/* ── Поиск пользователей по имени или @username (пустой запрос — все) ──
   Быстрый путь: RPC search_people (supabase/search.sql) — один запрос,
   сервер сам сортирует «точное совпадение → префикс → вхождение».
   Второй путь: обычный select с закэшированным набором колонок.
   Кэш в памяти + в localStorage, чтобы не тратить запросы на схемные пробы. */
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

export async function searchUsers(query) {
  const q = String(query || '').trim().replace(/^@+/, '');
  if (!(SUPABASE.url && SUPABASE.anonKey) || !sb) return [];

  const key = q.toLowerCase();
  const hit = searchCache.get(key);
  if (hit && Date.now() - hit.at < SEARCH_TTL) return hit.rows;

  let rows = await searchByRpc(q);
  if (rows === null) rows = await searchByTable(q);
  rows = normalizePeople(rows);

  searchCache.set(key, { at: Date.now(), rows });
  return rows;
}


/* ── Починка старых личных чатов ───────────────────────────────
   Чат мог быть создан до dm_fix.sql с одним участником: тогда
   собеседник физически не видит сообщения. Функция из
   supabase/privacy.sql добавляет второго участника один раз. */
const repaired = new Set();
export async function ensureDmMember(chatId, peerId) {
  if (!chatId || !peerId) return false;
  if (!SUPABASE.url || !SUPABASE.anonKey) return false;
  const key = `${chatId}:${peerId}`;
  if (repaired.has(key)) return false;
  repaired.add(key);
  try {
    const { data, error } = await sb.rpc('ensure_dm_member', { conv: chatId, other_user: peerId });
    if (error) {
      /* миграция ещё не выполнена — тихо работаем как раньше */
      if (!/could not find|does not exist|schema cache|function/i.test(error.message || '')) {
        console.warn('ensure_dm_member:', error.message);
      }
      return false;
    }
    return !!data;
  } catch (err) {
    return false;
  }
}

/* ── Профили по списку id (для экрана «только контакты») ── */
export async function profilesByIds(ids) {
  if (!Array.isArray(ids) || !ids.length) return [];
  const cols = candidateCols()[0];
  const select = colsToSelect(cols);
  const { data, error } = await withTimeout(
    sb.from('profiles').select(select).in('id', ids).limit(200),
    6000,
    'profiles',
  );
  if (error) throw error;
  return data || [];
}

/* ── Получение участников чата ── */
export async function getChatMembers(chatId) {
  const { data, error } = await sb
    .from('conversation_members')
    .select('user_id, profiles(*)')
    .eq('conversation_id', chatId);

  if (error) throw error;
  return data;
}

/* ── Присоединение к чату по ссылке-приглашению ── */
export async function joinConversation(chatId) {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const { error } = await sb
    .from('conversation_members')
    .insert({ conversation_id: chatId, user_id: user.id });

  // 23505 = уже участник — это нормально
  if (error && error.code !== '23505' && !String(error.message || '').includes('duplicate')) {
    throw error;
  }
}

/* ── Админ: список профилей и выдача роли ── */
export async function listProfiles() {
  const withRole = await hasRoleColumn();
  const cols = `id, display_name, username, avatar_hue${withRole ? ', role' : ''}`;
  const { data, error } = await sb
    .from('profiles')
    .select(cols)
    .order('display_name')
    .limit(200);
  if (error) throw error;
  return data;
}

export async function setUserRole(userId, role) {
  const { error } = await sb
    .from('profiles')
    .update({ role })
    .eq('id', userId);
  if (error) throw error;
}
