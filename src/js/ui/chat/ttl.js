/* Relik — исчезающие сообщения (TTL).
   Таймеры живут только пока открыто приложение; серверная часть — `message_expiry`.
   UI-функции chatView передаются через bindTtlHooks, чтобы не было циклического импорта. */
import { S, chatById } from '../state.js';
import { idb, newId } from '../../db/idb.js';
import { SUPABASE } from '../../config.js';
import { toast } from '../toast.js';
import { t } from '../../i18n/i18n.js';
import { getChatTtl, getChatTtlSince, setChatTtl } from '../prefs.js';
import { registerExpiry, clearExpiry } from '../../backend/expiry.js';
import { deleteMessage as deleteMessageBackend, sendMessage, encodeTtl } from '../../backend/messages.js';
import { renderSidebar } from '../sidebar.js';

let hooks = {
  renderMessages: () => {},
  renderPin: () => {},
};

export function bindTtlHooks(next = {}) {
  hooks = { ...hooks, ...next };
}

const ttlTimers = new Map(); // messageId -> timeout
const ttlChat = new Map();   // messageId -> chatId

export function clearTtlTimer(messageId) {
  const timer = ttlTimers.get(messageId);
  if (timer) clearTimeout(timer);
  ttlTimers.delete(messageId);
  ttlChat.delete(messageId);
}

export function clearTtlForChat(chatId) {
  for (const [id, cid] of [...ttlChat]) {
    if (cid === chatId) clearTtlTimer(id);
  }
}

export function clearTtlTimers() {
  for (const timer of ttlTimers.values()) clearTimeout(timer);
  ttlTimers.clear();
}

export function ttlWindow(m) {
  if (!m || m.hidden || m.deleted || m.expired) return 0;
  const seconds = getChatTtl(m.chatId);
  if (!seconds) return 0;
  const since = getChatTtlSince(m.chatId);
  if ((m.ts || 0) < since) return 0;
  return seconds * 1000;
}

export function scheduleTtlForChat(chatId) {
  const list = S.messages[chatId] || [];
  const now = Date.now();
  const alive = new Set(list.map((m) => m.id));
  for (const [id, timer] of [...ttlTimers]) {
    if (!alive.has(id)) { clearTimeout(timer); ttlTimers.delete(id); }
  }

  for (const m of list) {
    const ttl = ttlWindow(m);
    if (!ttl) { clearTtlTimer(m.id); continue; }

    let started = Number(m.ttlStartedAt) || 0;
    if (!started) {
      /* Отправитель ждёт прочтения; получатель — открытия чата. */
      if (m.sender === 'u_me') {
        if (m.status !== 'read') continue;
      } else if (S.active !== chatId) {
        continue;
      }
      started = now;
      m.ttlStartedAt = now;
      idb.put('messages', m).catch(() => {});
    }

    const left = started + ttl - now;
    registerExpiry(m.id, chatId, started + ttl);
    if (left <= 0) { expireTtlMessage(chatId, m); continue; }
    clearTtlTimer(m.id);
    ttlTimers.set(m.id, setTimeout(() => expireTtlMessage(chatId, m), Math.min(left, 2147483647)));
    ttlChat.set(m.id, chatId);
  }
}

function expireTtlMessage(chatId, m) {
  clearTtlTimer(m.id);
  if (!m || m.hidden || m.expired) return;
  m.expired = true;
  m.hidden = true;
  m.localDeleted = true;
  if (m.sender === 'u_me' && SUPABASE.url && SUPABASE.anonKey) {
    deleteMessageBackend(m.id).catch(() => {});
  }
  idb.put('messages', m).catch(() => {});

  const chat = chatById(chatId);
  if (chat) {
    if (chat.pin?.id === m.id) {
      delete chat.pin;
      idb.del('settings', 'pin:' + chat.id).catch(() => {});
      hooks.renderPin();
    }
    const last = (S.messages[chatId] || []).filter((x) => !x.hidden && !x.expired).pop();
    chat.last = last ? { ts: last.ts, from: last.sender, type: last.type, text: last.text || '' } : null;
    idb.put('chats', chat).catch(() => {});
  }
  if (S.active === chatId) hooks.renderMessages();
  renderSidebar();
}

export function paintTtl(chat) {
  if (!chat) return;
  const current = getChatTtl(chat.id);
  document.querySelectorAll('#ttlSeg [data-ttl]').forEach((b) => {
    b.classList.toggle('on', Number(b.dataset.ttl) === current);
  });
}

export function applyTtlFromHistory(chatId) {
  const events = (S.messages[chatId] || []).filter((m) => m.type === 'ttl' && m.ttl);
  if (!events.length) return;
  const last = events.reduce((a, b) => ((b.ts || 0) > (a.ts || 0) ? b : a), events[0]);
  const sec = Number(last.ttl.sec) || 0;
  if ((last.ts || 0) > getChatTtlSince(chatId)) {
    setChatTtl(chatId, sec, last.ts || Date.now());
  }
}

export async function changeChatTtl(chat, seconds) {
  if (!chat) return;
  const sec = Number(seconds) || 0;
  setChatTtl(chat.id, sec);
  paintTtl(chat);
  scheduleTtlForChat(chat.id);
  if (!sec) clearExpiry(chat.id).catch(() => {});

  if (SUPABASE.url && SUPABASE.anonKey) {
    const event = {
      id: newId(), chatId: chat.id, sender: 'u_me', ts: Date.now(),
      type: 'ttl', hidden: true, ttl: { sec }, text: '', reactions: [], status: 'sending',
    };
    S.messages[chat.id] = S.messages[chat.id] || [];
    S.messages[chat.id].push(event);
    idb.put('messages', event).catch(() => {});
    sendMessage(chat.id, encodeTtl(sec), null, chat.kind, chat.publicKey, event.id, chat.userId || null)
      .then(() => { event.status = 'sent'; idb.put('messages', event).catch(() => {}); })
      .catch((err) => {
        console.warn('TTL signal error:', err);
        S.messages[chat.id] = (S.messages[chat.id] || []).filter((x) => x.id !== event.id);
        idb.del('messages', event.id).catch(() => {});
      });
  }
  toast(t('ttl.saved'), { type: 'success' });
}
