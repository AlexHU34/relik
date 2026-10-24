/* Relik — управление чатами через Supabase (Фаза 5)
   Загрузка чатов, создание личных чатов, участники */

import { sb } from './supabaseClient.js';
import { idb } from '../db/idb.js';
import { S } from '../ui/state.js';

/* ── Загрузка всех чатов пользователя ── */
export async function loadChats() {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return [];

  const { data: members, error } = await sb
    .from('conversation_members')
    .select('conversation_id, conversations(*, conversation_members(user_id, profiles(id, display_name, avatar_hue, public_key)))')
    .eq('user_id', user.id);

  if (error) throw error;

  // Преобразуем в формат приложения
  const chats = members.map((m) => {
    const conv = m.conversations;
    const otherMembers = conv.conversation_members.filter((cm) => cm.user_id !== user.id);

    if (conv.kind === 'dm') {
      // Личный чат
      const otherProfile = otherMembers[0]?.profiles;
      if (otherProfile && !S.users.some((u) => u.id === otherProfile.id)) {
        S.users.push({
          id: otherProfile.id,
          name: otherProfile.display_name,
          hue: otherProfile.avatar_hue ?? 0,
          seen: 'offline',
        });
      }
      return {
        id: conv.id,
        kind: 'dm',
        userId: otherProfile?.id,
        members: [otherProfile?.id],
        unread: 0,
        last: null,
        title: otherProfile?.display_name,
        hue: otherProfile?.avatar_hue,
        publicKey: otherProfile?.public_key,
      };
    } else {
      // Групповой чат — добавляем профили участников в контакты
      for (const cm of conv.conversation_members) {
        const p = cm.profiles;
        if (p && !S.users.some((u) => u.id === p.id)) {
          S.users.push({
            id: p.id,
            name: p.display_name,
            hue: p.avatar_hue ?? 0,
            seen: 'offline',
          });
        }
      }
      return {
        id: conv.id,
        kind: 'group',
        title: conv.title,
        hue: conv.hue || 0,
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
        .single();

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
    .single();

  if (error) throw error;
  return data;
}

/* ── Поиск пользователей по имени (пустой запрос — все контакты) ── */
export async function searchUsers(query) {
  const q = String(query || '').trim();
  let req = sb
    .from('profiles')
    .select('id, display_name, avatar_hue, public_key, last_seen')
    .order('display_name')
    .limit(30);
  if (q) req = req.ilike('display_name', `%${q}%`);

  const { data, error } = await req;
  if (error) throw error;
  return data;
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
