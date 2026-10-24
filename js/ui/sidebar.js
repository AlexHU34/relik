/* Relik — сайдбар: список чатов, поиск, профиль */
import { S, emit, user, chatTitle } from './state.js';
import { $, esc, fmtTime, fmtDay, avatarHtml, adminBadge, preview } from './utils.js';
import { icon } from './icons.js';
import { t } from '../i18n/i18n.js';
import { idb } from '../db/idb.js';
import { loadChats as loadChatsFromBackend, searchUsers as searchUsersBackend } from '../backend/chats.js';
import { loadLatestPreviews, previewTextFor } from '../backend/messages.js';
import { SUPABASE } from '../config.js';
import { getStatuses, refreshChatStatuses } from '../backend/presence.js';

/* Дата для бейджа времени в списке: сегодня — время, вчера/старее — дата */
function listTime(ts) {
  if (!ts) return '';
  const n = new Date(), d = new Date(ts);
  return d.toDateString() === n.toDateString() ? fmtTime(ts) : fmtDay(ts);
}

function chatRow(chat) {
  const u = chat.kind === 'dm'
    ? (S.users.find((x) => x.id === chat.userId) || { name: chat.title || '…', hue: chat.hue ?? 0, seen: '' })
    : { name: chat.title, hue: chat.hue ?? 5, seen: '' };
  const online = chat.kind === 'dm' && u.seen === 'online';
  const active = chat.id === S.active ? ' active' : '';
  return `<button class="chat-item${active}" data-cid="${chat.id}">
    ${avatarHtml(u, { online })}
    <span class="ci-main">
      <span class="ci-top">
        <span class="ci-name">${esc(chatTitle(chat))}</span>
        <span class="ci-time">${listTime(chat.last?.ts)}</span>
      </span>
      <span class="ci-bottom">
        <span class="ci-preview">${preview(chat)}</span>
      </span>
    </span>
    <span class="ci-side">${chat.unread ? `<span class="badge">${chat.unread}</span>` : ''}</span>
  </button>`;
}

export function renderSidebar() {
  const list = $('#sideList');
  if (!list) return;
  const q = S.filter.toLowerCase().trim();
  const rows = S.chats
    .filter((c) => {
      if (!q) return true;
      if (chatTitle(c).toLowerCase().includes(q)) return true;
      if (String(c.username || '').toLowerCase().includes(q)) return true;
      return String(c.last?.text || '').toLowerCase().includes(q);
    })
    .sort((a, b) => (b.last?.ts || 0) - (a.last?.ts || 0));

  if (!rows.length) {
    list.innerHTML = q
      ? `<div class="side-empty"><span class="se-ic">${icon('search', 18)}</span><b>${t('side.empty')}</b></div>`
      : `<div class="side-empty"><span class="se-ic">${icon('plus', 20)}</span><b>${t('side.noChats')}</b><span>${t('side.noChatsHint')}</span></div>`;
  } else {
    list.innerHTML = rows.map(chatRow).join('');
  }

  /* профиль */
  const av = $('#meAvatar');
  if (av) av.innerHTML = avatarHtml(S.me || { name: '?', hue: 0 });
  $('#meName') && ($('#meName').innerHTML = esc(S.me?.name || '') + adminBadge(S.me));
  $('#meMail') && ($('#meMail').textContent = S.me?.username ? '@' + S.me.username : (S.me?.mail || ''));
}

/* Делегирование кликов навешивается один раз в initSidebar() */
export function initSidebar() {
  const list = $('#sideList');

  list.addEventListener('click', (e) => {
    const item = e.target.closest('.chat-item');
    if (!item) return;
    location.hash = `#/chat/${item.dataset.cid}`;
  });

  $('#searchInput').addEventListener('input', (e) => {
    S.filter = e.target.value;
    renderSidebar();
  });
  $('#searchInput').addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.target.value = '';
    S.filter = '';
    renderSidebar();
  });

  /* Ctrl/Cmd+K — быстрый поиск */
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || String(e.key).toLowerCase() !== 'k') return;
    e.preventDefault();
    if (location.hash !== '#/app') location.hash = '#/app';
    setTimeout(() => $('#searchInput')?.focus(), 60);
  });
}

/* Обновить время/порядок в списке (тик 30 сек) */
export async function touchSidebar() {
  // Обновляем статусы если есть Supabase
  if (SUPABASE.url && SUPABASE.anonKey) {
    try {
      await refreshChatStatuses();
    } catch (err) {
      console.error('Refresh statuses error:', err);
    }
  }
  renderSidebar();
}

/* ── Загрузка чатов из бэкенда (если есть Supabase) ── */
export async function loadChats() {
  if (SUPABASE.url && SUPABASE.anonKey) {
    try {
      const prev = new Map((S.chats || []).map((c) => [c.id, c]));
      const fresh = await loadChatsFromBackend();

      /* обновляем объекты на месте: открытый чат держит ссылку на свой объект */
      S.chats = fresh.map((c) => {
        const old = prev.get(c.id);
        if (!old) return c;
        const keep = {
          last: old.last || c.last,
          unread: old.unread ?? c.unread,
          pin: old.pin || c.pin,
          publicKey: c.publicKey || old.publicKey,
        };
        Object.assign(old, c, keep);
        return old;
      });

      /* сразу подтягиваем последние сообщения для превью в списке */
      try {
        const latest = await loadLatestPreviews();
        for (const chat of S.chats) {
          const row = latest.get(chat.id);
          if (!row) continue;
          const ts = new Date(row.created_at).getTime();
          if ((chat.last?.ts || 0) >= ts) continue;
          const text = await previewTextFor(row, chat);
          if (text == null) continue;
          const mine = row.sender_id === S.me?.id;
          chat.last = { ts, from: mine ? 'u_me' : row.sender_id, type: 'text', text };
        }
      } catch (err) {
        /* превью не критичны */
      }

      await idb.bulkPut('chats', S.chats);

      // Загружаем статусы участников одним запросом
      const ids = S.chats
        .filter((c) => c.kind === 'dm' && c.userId && !String(c.userId).startsWith('u_'))
        .map((c) => c.userId);
      const statuses = await getStatuses(ids);
      for (const chat of S.chats) {
        if (chat.kind !== 'dm' || !chat.userId) continue;
        const u = S.users?.find((x) => x.id === chat.userId);
        if (u && statuses[chat.userId]) u.seen = statuses[chat.userId];
      }
    } catch (err) {
      console.error('Load chats error:', err);
    }
  }
  renderSidebar();
}
