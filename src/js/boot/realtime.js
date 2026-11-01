/* Relik — глобальная синхронизация: realtime-подписка, тихий опрос превью,
   переподключение с backoff и «догон» пропущенного после обрыва.

   Сокет рвётся в метро, при VPN, после сна ноутбука. Без переподключения
   сообщения «пропадают» до перезагрузки страницы, поэтому:
   - CHANNEL_ERROR/TIMED_OUT/CLOSED → переподписка с экспоненциальной паузой;
   - online / возврат на вкладку → немедленная попытка;
   - после успешной переподписки — тихий опрос превью и синк открытого чата. */

import { S, chatById } from '../ui/state.js';
import { idb } from '../db/idb.js';
import { previewTextFor, loadLatestPreviews } from '../backend/messages.js';
import { subscribeAllMessages } from '../backend/realtimeSub.js';
import { refreshRequests, startContactRealtime } from '../ui/reqBadge.js';
import { loadBlocks } from '../backend/blocks.js';
import { renderSidebar, loadChats as reloadChats } from '../ui/sidebar.js';
import { isMuted } from '../ui/prefs.js';
import { playMessage } from '../ui/sounds.js';
import { notifyMessage } from '../ui/notify.js';
import { syncActiveNow } from '../ui/activeSync.js';
import { backoffMs } from '../core/outbox.js';
import { logEvent } from '../backend/telemetry.js';
import { isRealBackend } from './auth.js';

let globalSub = null;
let sidebarTimer = null;
let sidebarBusy = false;
let rtTimer = null;
let rtAttempts = 0;
let rtUp = false;

export function startGlobalRealtime() {
  if (!S.me) return;

  /* заявки в контакты работают и в демо-режиме:
     счётчик на конверте + live-обновление */
  refreshRequests().catch(() => {});
  startContactRealtime();
  /* блокировки: скрыть чаты и запретить отправку */
  loadBlocks().then(() => renderSidebar()).catch(() => {});
  /* realtime может быть не включён для таблицы — тихо сверяем раз в 30 с */
  if (!window.__reqTimer) {
    window.__reqTimer = setInterval(() => {
      if (document.visibilityState === 'visible' && S.me) refreshRequests().catch(() => {});
    }, 30000);
  }

  if (!isRealBackend) return;
  wireRecovery();
  connect();
  /* Realtime может не дойти (сеть/RLS) — раз в 10 секунд тихо сверяем список */
  if (!sidebarTimer) sidebarTimer = setInterval(refreshChatListQuiet, 10000);
}

export function stopGlobalRealtime() {
  if (sidebarTimer) { clearInterval(sidebarTimer); sidebarTimer = null; }
  clearTimeout(rtTimer);
  rtTimer = null;
  rtAttempts = 0;
  rtUp = false;
  if (globalSub) {
    globalSub.unsubscribe();
    globalSub = null;
  }
}

function wireRecovery() {
  if (wireRecovery.done) return;
  wireRecovery.done = true;
  window.addEventListener('online', () => {
    rtAttempts = 0;
    if (!globalSub) connect();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !S.me) return;
    if (!globalSub) connect();
    else if (rtUp) refreshChatListQuiet();
  });
}

function connect() {
  if (!isRealBackend || !S.me || globalSub) return;
  globalSub = subscribeAllMessages(handleRow, (status) => {
    if (status === 'SUBSCRIBED') {
      const resumed = rtUp || rtAttempts > 0;
      rtAttempts = 0;
      rtUp = true;
      clearTimeout(rtTimer);
      rtTimer = null;
      if (resumed) catchUp();
      return;
    }
    if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
      rtUp = false;
      scheduleReconnect(status);
    }
  });
}

function scheduleReconnect(reason) {
  if (!S.me) return;
  try { globalSub?.unsubscribe(); } catch (e) { /* ignore */ }
  globalSub = null;
  if (rtTimer) return;
  /* Офлайн — ждём события online, не крутим таймеры впустую. */
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  rtAttempts += 1;
  const delay = backoffMs(rtAttempts, Math.random, { base: 1000, cap: 30000 });
  logEvent('rt_reconnect', { reason: String(reason || ''), attempt: rtAttempts, delay: Math.round(delay) });
  rtTimer = setTimeout(() => {
    rtTimer = null;
    connect();
  }, delay);
}

/* Догоняем пропущенное: превью чатов и открытый чат (через его же синк). */
async function catchUp() {
  logEvent('rt_catchup', { chats: S.chats?.length || 0 });
  try {
    await refreshChatListQuiet();
    if (S.active) syncActiveNow();
  } catch (e) { /* фон: не мешаем интерфейсу */ }
}

async function handleRow(row) {
  if (!row) return;
  const chat = chatById(row.conversation_id);
  if (!chat) {
    /* Новый чат создан другим человеком, пока мы были онлайн.
       Подтягиваем список, иначе сообщение некуда положить. */
    reloadChats().then(() => renderSidebar()).catch(() => {});
    return;
  }
  if (row.sender_id === S.me.id) return; // свои сообщения обрабатываются локально
  if (S.active === row.conversation_id) return; // открытый чат — своя подписка

  const text = await previewTextFor(row, chat);
  if (text == null) return; // голос в опросе не показываем
  chat.last = { ts: Date.now(), from: row.sender_id, type: 'text', text };
  chat.unread = (chat.unread || 0) + 1;
  await idb.put('chats', chat);
  renderSidebar();
  if (!isMuted(chat.id)) {
    playMessage();
    notifyMessage(chat, text, () => { location.hash = `#/chat/${chat.id}`; });
  }
}

/* Тихая синхронизация превью в списке чатов — без перезагрузки страницы */
export async function refreshChatListQuiet() {
  if (!isRealBackend || !S.me || sidebarBusy) return;
  if (document.visibilityState === 'hidden') return;
  sidebarBusy = true;
  try {
    const latest = await loadLatestPreviews();
    let changed = false;
    let incoming = false;
    let audible = false;

    /* Если появился чат, которого нет в локальном списке (его создал
       собеседник), сначала перечитываем список чатов. */
    const known = new Set(S.chats.map((c) => c.id));
    const hasUnknown = [...latest.keys()].some((id) => !known.has(id));
    if (hasUnknown) {
      await reloadChats();
      changed = true;
    }

    for (const chat of S.chats) {
      const rows = latest.get(chat.id) || [];
      for (const row of rows) {
        const ts = new Date(row.created_at).getTime();
        if ((chat.last?.ts || 0) >= ts) break;

        const text = await previewTextFor(row, chat);
        if (text == null) continue; // голос/реакция/опрос/прочтение
        const mine = row.sender_id === S.me.id;
        chat.last = { ts, from: mine ? 'u_me' : row.sender_id, type: 'text', text };
        if (!mine) {
          if (S.active !== chat.id) chat.unread = (chat.unread || 0) + 1;
          incoming = true;
          if (!isMuted(chat.id)) audible = true;
        }
        await idb.put('chats', chat);
        changed = true;
        break;
      }
    }

    if (changed) renderSidebar();
    if (incoming && audible) playMessage();
  } catch (err) {
    /* тихо: сеть/RLS восстановятся сами */
  } finally {
    sidebarBusy = false;
  }
}
