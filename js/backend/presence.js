/* Relik — presence и read receipts (Фаза 9)
   Онлайн-статусы, галочки прочтения, typing indicators */

import { sb } from './supabaseClient.js';
import { SUPABASE } from '../config.js';
import { idb } from '../db/idb.js';
import { S } from '../ui/state.js';

/* ── Обновление last_seen (присутствие) ── */
export async function updateLastSeen() {
  if (!sb) return;

  const { data: { user } } = await sb.auth.getUser();
  if (!user) return;

  const { error } = await sb
    .from('profiles')
    .update({ last_seen: new Date().toISOString() })
    .eq('id', user.id);

  if (error) console.error('Update last_seen error:', error);
}

/* ── Получение статуса пользователя ── */
export async function getUserStatus(userId) {
  if (!sb) return 'offline';

  const { data, error } = await sb
    .from('profiles')
    .select('last_seen')
    .eq('id', userId)
    .maybeSingle();

  if (error) return 'offline';

  const lastSeen = new Date(data.last_seen);
  const now = new Date();
  const diff = now - lastSeen;

  // онлайн если был активен в последние 2 минуты
  if (diff < 2 * 60 * 1000) return 'online';
  // недавно если был в последние 24 часа
  if (diff < 24 * 60 * 60 * 1000) return 'recent';
  return 'offline';
}

/* ── Получение статусов сразу для списка пользователей ── */
export async function getStatuses(userIds) {
  if (!sb) return {};
  const ids = [...new Set((userIds || []).filter((id) => id && !String(id).startsWith('u_')))];
  if (!ids.length) return {};

  const { data, error } = await sb
    .from('profiles')
    .select('id, last_seen')
    .in('id', ids);
  if (error) return {};

  const now = Date.now();
  const out = {};
  for (const p of data) {
    const diff = now - new Date(p.last_seen).getTime();
    out[p.id] = diff < 2 * 60 * 1000 ? 'online' : diff < 24 * 60 * 60 * 1000 ? 'recent' : 'offline';
  }
  return out;
}

/* ── Обновление read receipt ── */
export async function updateReadReceipt(chatId) {
  if (!sb) return;

  const { data: { user } } = await sb.auth.getUser();
  if (!user) return;

  const { error } = await sb
    .from('read_receipts')
    .upsert({
      conversation_id: chatId,
      user_id: user.id,
      last_read_at: new Date().toISOString(),
    });

  if (error) console.error('Update read receipt error:', error);
}

/* ── Получение read receipts чата ── */
export async function getReadReceipts(chatId) {
  if (!sb) return [];

  const { data, error } = await sb
    .from('read_receipts')
    .select('user_id, last_read_at')
    .eq('conversation_id', chatId);

  if (error) return [];

  return data;
}

/* ── Проверка прочитано ли сообщение ── */
export async function isMessageRead(messageId, chatId) {
  if (!sb) return false;

  const receipts = await getReadReceipts(chatId);
  // TODO: сравнить с временем отправки сообщения
  return receipts.length > 0;
}

/* ── Подписка на presence через Realtime ── */
export function subscribeToPresence(chatId, callbacks) {
  if (!sb) return { unsubscribe: () => {} };

  const channel = sb
    .channel(`presence:${chatId}`)
    .on('presence', { event: 'sync' }, () => {
      callbacks.onSync?.();
    })
    .on('presence', { event: 'join' }, ({ key, newPresences }) => {
      callbacks.onJoin?.(key, newPresences);
    })
    .on('presence', { event: 'leave' }, ({ key, leftPresences }) => {
      callbacks.onLeave?.(key, leftPresences);
    })
    .subscribe((status) => {
      console.log('Presence status:', status);
    });

  // Отслеживаем своё присутствие
  trackPresence(channel, chatId);

  return {
    unsubscribe: () => {
      sb.removeChannel(channel);
    },
  };
}

/* ── Отслеживание присутствия пользователя ── */
function trackPresence(channel, chatId) {
  const { data: { user } } = sb.auth.getUser();
  if (!user) return;

  channel.track({
    user_id: user.id,
    online_at: new Date().toISOString(),
  });
}

/* ── Typing indicators через Realtime broadcast ── */
let typingChannel = null;

export function initTyping(chatId, onTyping) {
  if (!sb) return;
  stopTyping();
  typingChannel = sb
    .channel(`typing:${chatId}`)
    .on('broadcast', { event: 'typing' }, (p) => {
      const uid = p.payload && p.payload.user_id;
      if (uid && uid !== S.me?.id) onTyping?.(uid);
    });
  typingChannel.subscribe();
}

export function sendTypingSignal() {
  if (!sb || !typingChannel) return;
  typingChannel.send({
    type: 'broadcast',
    event: 'typing',
    payload: { user_id: S.me?.id || null, at: Date.now() },
  }).catch(() => {});
}

export function stopTyping() {
  if (typingChannel && sb) {
    sb.removeChannel(typingChannel);
    typingChannel = null;
  }
}

/* ── Получение статусов всех участников чата ── */
export async function getChatMemberStatuses(chatId) {
  if (!sb) return {};

  const { data: members } = await sb
    .from('conversation_members')
    .select('user_id, profiles(last_seen)')
    .eq('conversation_id', chatId);

  if (!members) return {};

  const statuses = {};
  for (const member of members) {
    const lastSeen = member.profiles?.last_seen;
    if (lastSeen) {
      const diff = new Date() - new Date(lastSeen);
      statuses[member.user_id] = diff < 2 * 60 * 1000 ? 'online' : 'offline';
    } else {
      statuses[member.user_id] = 'offline';
    }
  }

  return statuses;
}

/* ── Периодическое обновление статусов в сайдбаре ── */
export async function refreshChatStatuses() {
  if (!SUPABASE.url || !SUPABASE.anonKey) return;

  const ids = (S.chats || [])
    .filter((c) => c.kind === 'dm' && c.userId && !String(c.userId).startsWith('u_'))
    .map((c) => c.userId);
  const statuses = await getStatuses(ids);

  for (const chat of S.chats || []) {
    if (chat.kind !== 'dm' || !chat.userId || String(chat.userId).startsWith('u_')) continue;
    const u = S.users?.find((x) => x.id === chat.userId);
    if (u && statuses[chat.userId]) u.seen = statuses[chat.userId];
  }
}
