/* Relik — история открытого чата: хвост из IndexedDB и страницы «показать
   раньше». Открытие читает только HISTORY_TAIL, дальше — по требованию.
   `S.historyMore[chatId]` — «в базе есть ещё старые» (для баннера). */
import { S, chatById } from '../state.js';
import { idb } from '../../db/idb.js';
import { loadOlderMessages } from '../../backend/messages.js';
import { HISTORY_TAIL, HISTORY_PAGE } from '../msgWindow.js';
import { mergeMessages, oldestTs } from '../msgWindow.js';

export function hasLocalHistory(chatId) {
  return !!S.historyMore?.[chatId];
}

export function setLocalHistory(chatId, more) {
  if (!S.historyMore) S.historyMore = {};
  S.historyMore[chatId] = !!more;
}

/* Открытие чата: последние HISTORY_TAIL сообщений. */
export async function loadChatTail(chatId) {
  const { messages, more } = await idb.messagesTail(chatId, HISTORY_TAIL);
  setLocalHistory(chatId, more);
  return messages;
}

/* Одна страница вглубь: локальная (офлайн) или серверная. null — конец. */
export async function loadOlderPage(chatId) {
  const chat = chatById(chatId);
  const before = oldestTs(S.messages[chatId] || []);
  if (!chat || !before) return null;

  if (hasLocalHistory(chatId)) {
    const page = await idb.messagesBefore(chatId, before, HISTORY_PAGE);
    setLocalHistory(chatId, page.more);
    return { messages: page.messages, hasMore: page.more };
  }
  if (!S.msgMore?.[chatId]) return null;
  const { messages, hasMore } = await loadOlderMessages(chatId, before, chat.kind, chat.publicKey);
  S.msgMore = { ...(S.msgMore || {}), [chatId]: hasMore };
  return { messages, hasMore };
}

/* Слить страницу в открытую ленту (локальные «отправляется/ошибка» целы). */
export function mergeOlder(chatId, messages) {
  if (!Array.isArray(messages) || !messages.length) return false;
  S.messages[chatId] = mergeMessages(messages, S.messages[chatId] || []);
  return true;
}

/* Поиск по всей локальной истории без загрузки её в ленту: возвращаем только
   совпадения (Ctrl+F в глубине длинного чата). */
export async function searchLocalHistory(chatId, query, limit = 60) {
  const q = String(query || '').toLowerCase();
  if (!q) return [];
  const all = await idb.messagesOf(chatId);
  const hits = [];
  for (const m of all) {
    if (m.hidden || m.localDeleted || !m.text) continue;
    if (!String(m.text).toLowerCase().includes(q)) continue;
    hits.push(m);
    if (hits.length > limit) hits.shift();
  }
  return hits;
}
