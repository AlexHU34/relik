/* Relik — управление чатами через Supabase (Фаза 5)
   Загрузка чатов, создание личных чатов, участники */

import { sb } from './supabaseClient.js';
import { idb } from '../db/idb.js';
import { S } from '../ui/state.js';

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

  // Проверяем, есть ли уже чат
  const { data: existing } = await sb
    .from('conversation_members')
    .select('conversation_id')
    .eq('user_id', user.id);

  if (existing) {
    for (const member of existing) {
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

/* ── Поиск пользователей по имени или @username (пустой запрос — все контакты) ── */
export async function searchUsers(query) {
  const q = String(query || '').trim().replace(/^@+/, '');
  const safe = q.replace(/[,()]/g, ' ').trim();
  const attempts = [
    { username: true, avatar: true, role: true },
    { username: true, avatar: true, role: false },
    { username: true, avatar: false, role: false },
    { username: false, avatar: false, role: false },
  ];

  let lastError = null;
  for (const cols of attempts) {
    const select = `id, display_name, avatar_hue, public_key, last_seen${cols.avatar ? ', avatar' : ''}${cols.username ? ', username' : ''}${cols.role ? ', role' : ''}`;
    let req = sb.from('profiles').select(select).order('display_name').limit(50);
    if (q) {
      req = cols.username
        ? req.or(`display_name.ilike.%${safe}%,username.ilike.%${safe}%`)
        : req.ilike('display_name', `%${safe}%`);
    }
    const { data, error } = await req;
    if (!error) return data || [];
    lastError = error;
    /* 42703 / schema cache — колонки нет: пробуем следующий набор */
    if (!/42703|column.*does not exist|schema cache/i.test(error.message || '')) break;
  }
  throw lastError || new Error('Profiles search failed');
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
