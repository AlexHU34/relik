/* Relik — управление сообщениями через Supabase (Фаза 6)
   Отправка, загрузка, Realtime-подписка с E2E шифрованием */

import { sb } from './supabaseClient.js';
import { idb, newId } from '../db/idb.js';
import { SUPABASE } from '../config.js';
import { S } from '../ui/state.js';
import {
  getKeyPair,
  getTheirPublicKey,
  encryptForChat,
  decryptFromChat,
  encryptForGroup,
  decryptFromGroup,
} from '../crypto/encryption.js';

/* Опросы и голоса передаются обычными сообщениями с префиксом —
   так они остаются E2E-зашифрованными и не требуют новых таблиц. */
const POLL_PREFIX = '__relik_poll__:';
const VOTE_PREFIX = '__relik_vote__:';

export function encodePoll(poll) {
  return POLL_PREFIX + JSON.stringify(poll);
}

export function encodeVote(pollId, options) {
  return VOTE_PREFIX + JSON.stringify({ p: pollId, v: options });
}

export function decodeSpecial(text) {
  if (typeof text !== 'string') return null;
  if (text.startsWith(POLL_PREFIX)) {
    try {
      const poll = JSON.parse(text.slice(POLL_PREFIX.length));
      return { kind: 'poll', poll, text: poll.q || '' };
    } catch (err) { return null; }
  }
  if (text.startsWith(VOTE_PREFIX)) {
    try {
      return { kind: 'vote', vote: JSON.parse(text.slice(VOTE_PREFIX.length)), text: '' };
    } catch (err) { return null; }
  }
  return null;
}

/* Помечаем сообщение как опрос или скрытый голос */
function applySpecial(m) {
  const s = decodeSpecial(m.text);
  if (!s) return m;
  if (s.kind === 'poll') {
    m.type = 'poll';
    m.poll = s.poll;
    m.text = s.text;
  } else {
    m.type = 'vote';
    m.hidden = true;
    m.vote = s.vote;
    m.text = '';
  }
  return m;
}

/* Превью для списка чатов */
function previewOfText(text) {
  const s = decodeSpecial(text);
  if (s?.kind === 'poll') return '📊 ' + s.text;
  if (s?.kind === 'vote') return null;
  return text;
}

/* ── Ключи для расшифровки (кешируем на время вызова) ── */
async function chatKeys(theirPublicKeyJwk) {
  if (!SUPABASE.url || !SUPABASE.anonKey) return { keyPair: null, theirPubKey: null };
  const keyPair = await getKeyPair();
  let theirPubKey = null;
  if (theirPublicKeyJwk && keyPair) {
    try {
      theirPubKey = await getTheirPublicKey(theirPublicKeyJwk);
    } catch (err) {
      console.warn('Peer public key error:', err);
    }
  }
  return { keyPair, theirPubKey };
}

/* ── Строка из Supabase → сообщение приложения (с дешифровкой) ── */
async function rowToMessage(m, keyPair, theirPubKey, chatKind) {
  let text = m.ciphertext;

  if (keyPair && theirPubKey && m.iv && chatKind === 'dm') {
    try {
      text = await decryptFromChat(m.iv, m.ciphertext, keyPair.privateKey, theirPubKey);
    } catch (err) {
      console.error('Decrypt error:', err);
      text = '[Шифрование не удалось]';
    }
  }

  return applySpecial({
    id: m.id,
    chatId: m.conversation_id,
    sender: m.sender_id === S.me?.id ? 'u_me' : m.sender_id,
    ts: new Date(m.created_at).getTime(),
    type: 'text',
    text,
    reactions: [],
    status: 'read',
    replyTo: m.reply_to ? { id: m.reply_to } : null,
    edited: m.edited,
    deleted: m.deleted,
  });
}

/* ── Загрузка сообщений чата с дешифрованием ── */
export async function loadMessages(chatId, chatKind = 'dm', theirPublicKeyJwk = null) {
  const { data, error } = await sb
    .from('messages')
    .select('*')
    .eq('conversation_id', chatId)
    .order('created_at', { ascending: true });

  if (error) throw error;

  const { keyPair, theirPubKey } = await chatKeys(theirPublicKeyJwk);
  const messages = await Promise.all(data.map((m) => rowToMessage(m, keyPair, theirPubKey, chatKind)));

  // Кэшируем в IndexedDB (уже дешифрованные)
  await idb.bulkPut('messages', messages);

  return messages;
}

/* ── Новые сообщения после отметки времени (страховка для Realtime) ── */
export async function fetchMessagesSince(chatId, afterTs, chatKind = 'dm', theirPublicKeyJwk = null) {
  const after = new Date(Math.max(0, afterTs || 0)).toISOString();

  const { data, error } = await sb
    .from('messages')
    .select('*')
    .eq('conversation_id', chatId)
    .gt('created_at', after)
    .order('created_at', { ascending: true });

  if (error) throw error;
  if (!data.length) return [];

  const { keyPair, theirPubKey } = await chatKeys(theirPublicKeyJwk);
  const messages = await Promise.all(data.map((m) => rowToMessage(m, keyPair, theirPubKey, chatKind)));
  await idb.bulkPut('messages', messages);
  return messages;
}

/* ── Последние сообщения по всем чатам: превью в списке без Realtime ── */
export async function loadLatestPreviews() {
  const { data, error } = await sb
    .from('messages')
    .select('conversation_id, sender_id, ciphertext, iv, created_at')
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) throw error;

  const byChat = new Map();
  for (const row of data) {
    if (!byChat.has(row.conversation_id)) byChat.set(row.conversation_id, row);
  }
  return byChat;
}

/* ── Отправка сообщения с шифрованием ── */
export async function sendMessage(chatId, text, replyToId = null, chatKind = 'dm', theirPublicKeyJwk = null, messageId = null) {
  /* id уже есть у оптимистичного сообщения в ленте — используем его же */
  const msgId = messageId || newId();

  /* не гоняем лишний сетевой запрос getUser: id уже есть в состоянии */
  let senderId = S.me?.id || null;
  if (!senderId) {
    const { data: { user } } = await sb.auth.getUser();
    if (!user) throw new Error('Not authenticated');
    senderId = user.id;
  }

  let ciphertext, iv;

  if (SUPABASE.url && SUPABASE.anonKey) {
    // Шифруем сообщение
    const keyPair = await getKeyPair();
    if (!keyPair) throw new Error('No key pair found');

    if (chatKind === 'dm' && theirPublicKeyJwk) {
      const theirPubKey = await getTheirPublicKey(theirPublicKeyJwk);
      const encrypted = await encryptForChat(text, keyPair.privateKey, theirPubKey);
      ciphertext = encrypted.ciphertext;
      iv = encrypted.iv;
    } else if (chatKind === 'group') {
      // TODO: в Фазе 8 будет шифрование ключом группы
      ciphertext = text; // временно открытым текстом
      iv = '';
    } else {
      ciphertext = text;
      iv = '';
    }
  } else {
    // Демо-режим: открытым текстом
    ciphertext = text;
    iv = '';
  }

  const { error } = await sb
    .from('messages')
    .insert({
      id: msgId,
      conversation_id: chatId,
      sender_id: senderId,
      ciphertext,
      iv,
      reply_to: replyToId,
    });

  if (error) throw error;

  return applySpecial({
    id: msgId,
    chatId,
    sender: 'u_me',
    ts: Date.now(),
    type: 'text',
    text, // возвращаем оригинальный текст для UI
    reactions: [],
    status: 'sent',
    replyTo: replyToId ? { id: replyToId } : null,
    edited: false,
    deleted: false,
  });
}

/* ── Редактирование сообщения ── */
export async function editMessage(messageId, newText, chatKind = 'dm', theirPublicKeyJwk = null) {
  let ciphertext = newText;
  let iv = '';

  /* в личных чатах правка тоже должна оставаться зашифрованной */
  if (SUPABASE.url && SUPABASE.anonKey && chatKind === 'dm' && theirPublicKeyJwk) {
    const keyPair = await getKeyPair();
    if (keyPair) {
      const theirPubKey = await getTheirPublicKey(theirPublicKeyJwk);
      const encrypted = await encryptForChat(newText, keyPair.privateKey, theirPubKey);
      ciphertext = encrypted.ciphertext;
      iv = encrypted.iv;
    }
  }

  const { error } = await sb
    .from('messages')
    .update({ ciphertext, iv, edited: true })
    .eq('id', messageId);

  if (error) throw error;

  return { ciphertext, iv };
}

/* ── Удаление сообщения ── */
export async function deleteMessage(messageId) {
  const { error } = await sb
    .from('messages')
    .update({ deleted: true })
    .eq('id', messageId);

  if (error) throw error;
}

/* ── Добавление реакции ── */
export async function addReaction(messageId, emoji) {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const { error } = await sb
    .from('reactions')
    .insert({
      message_id: messageId,
      user_id: user.id,
      emoji,
    });

  if (error) throw error;
}

/* ── Удаление реакции ── */
export async function removeReaction(messageId, emoji) {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const { error } = await sb
    .from('reactions')
    .delete()
    .match({
      message_id: messageId,
      user_id: user.id,
      emoji,
    });

  if (error) throw error;
}

/* ── Realtime-подписка на сообщения чата с дешифрованием ── */
export function subscribeToChat(chatId, callbacks, chatKind = 'dm', theirPublicKeyJwk = null) {
  if (!sb) return { unsubscribe: () => {} };

  const channel = sb
    .channel(`chat:${chatId}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'messages',
        filter: `conversation_id=eq.${chatId}`,
      },
      async (payload) => {
        if (payload.eventType === 'INSERT') {
          const m = payload.new;
          let text = m.ciphertext;

          // Дешифруем если есть ключи
          if (SUPABASE.url && SUPABASE.anonKey && m.iv && chatKind === 'dm') {
            try {
              const keyPair = await getKeyPair();
              const theirPubKey = theirPublicKeyJwk ? await getTheirPublicKey(theirPublicKeyJwk) : null;
              if (keyPair && theirPubKey) {
                text = await decryptFromChat(m.iv, m.ciphertext, keyPair.privateKey, theirPubKey);
              }
            } catch (err) {
              console.error('Decrypt error:', err);
              text = '[Шифрование не удалось]';
            }
          }

          const message = applySpecial({
            id: m.id,
            chatId: m.conversation_id,
            sender: m.sender_id === S.me?.id ? 'u_me' : m.sender_id,
            ts: new Date(m.created_at).getTime(),
            type: 'text',
            text,
            reactions: [],
            status: 'sent',
            replyTo: m.reply_to ? { id: m.reply_to } : null,
            edited: m.edited,
            deleted: m.deleted,
          });
          await idb.put('messages', message);
          callbacks.onMessage?.(message);
        } else if (payload.eventType === 'UPDATE') {
          const m = payload.new;
          let text = m.ciphertext;

          // Дешифруем редактирование
          if (SUPABASE.url && SUPABASE.anonKey && m.iv && chatKind === 'dm') {
            try {
              const keyPair = await getKeyPair();
              const theirPubKey = theirPublicKeyJwk ? await getTheirPublicKey(theirPublicKeyJwk) : null;
              if (keyPair && theirPubKey) {
                text = await decryptFromChat(m.iv, m.ciphertext, keyPair.privateKey, theirPubKey);
              }
            } catch (err) {
              console.error('Decrypt error:', err);
            }
          }

          if (callbacks.onEdit) {
            callbacks.onEdit(m.id, {
              text,
              edited: m.edited,
              deleted: m.deleted,
            });
          }
        } else if (payload.eventType === 'DELETE') {
          if (callbacks.onDelete) {
            callbacks.onDelete(payload.old.id);
          }
        }
      }
    )
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'reactions',
      },
      async (payload) => {
        if (callbacks.onReaction) {
          callbacks.onReaction(payload);
        }
      }
    )
    .subscribe((status) => {
      console.log('Realtime status:', status);
    });

  return {
    unsubscribe: () => {
      sb.removeChannel(channel);
    },
  };
}

/* ── Realtime-подписка на все сообщения пользователя (RLS фильтрует) ── */
export function subscribeAllMessages(onInsert) {
  if (!sb) return { unsubscribe: () => {} };

  const channel = sb
    .channel('all-messages')
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'messages' },
      (payload) => { onInsert?.(payload.new); }
    )
    .subscribe();

  return { unsubscribe: () => { sb.removeChannel(channel); } };
}

/* Текст для превью входящего сообщения (с расшифровкой, если возможно) */
export async function previewTextFor(row, chat) {
  if (!row.iv) return previewOfText(row.ciphertext || '…');
  try {
    if (chat && chat.publicKey) {
      const keyPair = await getKeyPair();
      if (keyPair) {
        const theirPubKey = await getTheirPublicKey(chat.publicKey);
        const text = await decryptFromChat(row.iv, row.ciphertext, keyPair.privateKey, theirPubKey);
        return previewOfText(text);
      }
    }
  } catch (err) {
    /* не смогли расшифровать — покажем заглушку */
  }
  return '…';
}

/* ── Realtime-подписка на presence (онлайн-статус) ── */
export function subscribeToPresence(callbacks) {
  if (!sb) return { unsubscribe: () => {} };

  const channel = sb
    .channel('presence')
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

  return {
    unsubscribe: () => {
      sb.removeChannel(channel);
    },
  };
}

/* ── Обновление read receipt ── */
export async function updateReadReceipt(chatId) {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return;

  const { error } = await sb
    .from('read_receipts')
    .upsert({
      conversation_id: chatId,
      user_id: user.id,
      last_read_at: new Date().toISOString(),
    });

  if (error) console.error('Read receipt error:', error);
}
