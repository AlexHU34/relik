/* Relik — компакция локальной истории сообщений.

   Проблема: IndexedDB хранит все сообщения всех чатов вечно. Медиа-кэш
   чистится по LRU (js/db/mediaCache.js), а сообщения росли без предела —
   на телефоне это упирается в квоту хранилища, и новые сообщения перестают
   сохраняться офлайн.

   Политика: в каждом чате оставляем последние KEEP сообщений, всё, что старше
   `olderThanDays`, может быть удалено. Незавершённые отправки и «ошибки»
   не трогаем никогда — иначе потеряется то, что ещё не ушло на сервер.
   Серверная история при этом остаётся: она догружается страницами. */

import { idb } from './idb.js';

export const KEEP_PER_CHAT = 400;
export const OLDER_THAN_DAYS = 180;

/* Чистая функция: какие id удалить. Без IndexedDB — поэтому тестируется. */
export function planCompaction(messages = [], opts = {}) {
  const keep = Math.max(0, Number(opts.keepPerChat ?? KEEP_PER_CHAT) || 0);
  const days = Number(opts.olderThanDays ?? OLDER_THAN_DAYS) || 0;
  const now = Number(opts.now) || Date.now();
  const cutoff = days > 0 ? now - days * 86400e3 : 0;

  const byChat = new Map();
  for (const m of messages || []) {
    if (!m || !m.id) continue;
    const key = m.chatId || '';
    if (!byChat.has(key)) byChat.set(key, []);
    byChat.get(key).push(m);
  }

  const remove = [];
  for (const list of byChat.values()) {
    list.sort((a, b) => (b.ts || 0) - (a.ts || 0));   // новые первыми
    for (let i = 0; i < list.length; i += 1) {
      const m = list[i];
      /* недосланное и ошибочное не удаляем: это данные, а не кэш */
      if (m.status === 'sending' || m.status === 'error') continue;
      const beyondKeep = i >= keep;
      const tooOld = cutoff > 0 && (Number(m.ts) || 0) > 0 && Number(m.ts) < cutoff;
      if (beyondKeep && tooOld) remove.push(m.id);
    }
  }
  return remove;
}

/* Сколько сообщений и чатов лежит локально. */
export async function messageStats() {
  let all = [];
  try { all = (await idb.getAll('messages')) || []; } catch (e) { all = []; }
  const chats = new Set(all.map((m) => m.chatId).filter(Boolean));
  return { total: all.length, chats: chats.size };
}

/* Удалить лишнее. Возвращает { removed, total }. */
export async function compactMessages(opts = {}) {
  let all = [];
  try { all = (await idb.getAll('messages')) || []; } catch (e) { all = []; }
  const remove = planCompaction(all, opts);
  let removed = 0;
  for (const id of remove) {
    try {
      await idb.del('messages', id);
      removed += 1;
    } catch (e) { /* одна запись не должна ломать весь проход */ }
  }
  return { removed, total: all.length };
}
