/* Relik — сайдбар: список чатов, поиск, закрепление, мьют, контекстное меню */
import { S, emit, chatTitle } from './state.js';
import { $, esc, fmtTime, fmtDay, avatarHtml, preview } from './utils.js';
import { icon } from './icons.js';
import { t } from '../i18n/i18n.js';
import { idb } from '../db/idb.js';
import { loadChats as loadChatsFromBackend } from '../backend/chats.js';
import { loadLatestPreviews, previewTextFor } from '../backend/messages.js';
import { SUPABASE } from '../config.js';
import { getStatuses, refreshChatStatuses } from '../backend/presence.js';
import { isPinned, isMuted, togglePinned, toggleMuted, setReadAt, clearChatPrefs, getChatFolder, setChatFolder } from './prefs.js';
import { openMenu, bindLongPress } from './menu.js';
import { confirmAction } from './dialog.js';
import { hideUser, isBlocked, blockUser, unblockUser } from '../backend/blocks.js';

let lastSidebarSignature = '';
import { toast } from './toast.js';

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
  const pinned = isPinned(chat.id);
  const muted = isMuted(chat.id);
  const flags = `${pinned ? `<span class="ci-flag pin" title="${t('side.pinned')}">${icon('pin', 11)}</span>` : ''}
    ${muted ? `<span class="ci-flag mute" title="${t('side.muted')}">${icon('bellOff', 11)}</span>` : ''}`;
  const draft = String(S.drafts?.[chat.id] || '').replace(/\s+/g, ' ').trim();
  const previewHtml = draft
    ? `<span class="who">${t('side.draft')}:</span> ${esc(draft.length > 120 ? draft.slice(0, 120) + '…' : draft)}`
    : preview(chat);
  return `<div class="chat-item${active}${pinned ? ' pinned' : ''}" data-cid="${esc(chat.id)}" role="button" tabindex="0"
      aria-label="${esc(chatTitle(chat))}">
    ${avatarHtml(u, { online })}
    <span class="ci-main">
      <span class="ci-top">
        <span class="ci-name">${esc(chatTitle(chat))}${flags}</span>
        <span class="ci-time">${listTime(chat.last?.ts)}</span>
      </span>
      <span class="ci-bottom">
        <span class="ci-preview${draft ? ' draft' : ''}">${previewHtml}</span>
      </span>
    </span>
    <span class="ci-side">
      ${chat.unread ? `<span class="badge">${chat.unread > 99 ? '99+' : chat.unread}</span>` : ''}
      <button class="ci-more" type="button" data-chat-menu="${esc(chat.id)}"
        title="${t('side.actions')}" aria-label="${t('side.actions')}">${icon('more', 16)}</button>
    </span>
  </div>`;
}

export function renderSidebar(force = false) {
  const list = $('#sideList');
  if (!list) return;
  const q = S.filter.toLowerCase().trim();
  const folder = S.folder || 'all';
  const rows = S.chats
    .filter((c) => {
      /* заблокированные (в любую сторону) не показываются в списке */
      if (c.kind === 'dm' && c.userId && hideUser(c.userId)) return false;
      if (folder === 'dm' && c.kind !== 'dm') return false;
      if (folder === 'group' && c.kind !== 'group') return false;
      if ((folder === 'work' || folder === 'archive') && getChatFolder(c.id) !== folder) return false;
      if (!q) return true;
      if (chatTitle(c).toLowerCase().includes(q)) return true;
      if (String(c.username || '').toLowerCase().includes(q)) return true;
      return String(c.last?.text || '').toLowerCase().includes(q);
    })
    .sort((a, b) => {
      const pa = isPinned(a.id) ? 1 : 0;
      const pb = isPinned(b.id) ? 1 : 0;
      if (pa !== pb) return pb - pa;
      return (b.last?.ts || 0) - (a.last?.ts || 0);
    });

  document.querySelectorAll('#folderRow [data-folder]').forEach((b) => {
    const on = b.dataset.folder === folder;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });

  /* Первая загрузка: показываем скелетоны вместо пустого списка */
  if (S.chatsLoading && !rows.length && !q) {
    if (list.dataset.skel !== '1') {
      list.dataset.skel = '1';
      list.innerHTML = Array.from({ length: 7 }).map(() => (
        '<div class="chat-skel" aria-hidden="true">'
        + '<span class="sk-av"></span>'
        + '<span class="sk-main"><span class="sk-line sk-l1"></span><span class="sk-line sk-l2"></span></span>'
        + '</div>'
      )).join('');
    }
    return;
  }
  if (list.dataset.skel === '1') { list.dataset.skel = ''; list.innerHTML = ''; }

  /* Перерисовываем список только если данные реально изменились:
     раньше каждые 10 секунд пересобирался весь innerHTML. */
  const signature = [
    folder, q,
    S.me?.name || '', S.me?.username || '', S.me?.mail || '', S.me?.avatar ? 1 : 0,
    rows.map((c) => [
      c.id, c.kind, chatTitle(c), c.last?.ts || 0, c.last?.text || '', c.last?.type || '',
      c.unread || 0, c.username || '', isPinned(c.id) ? 1 : 0, isMuted(c.id) ? 1 : 0,
      S.drafts?.[c.id] || '',
    ].join('~')).join('|'),
  ].join('#');

  if (!force && signature === lastSidebarSignature && list.childElementCount) {
    paintMeChip();
    return;
  }
  lastSidebarSignature = signature;

  if (!rows.length) {
    list.innerHTML = q
      ? `<div class="side-empty"><span class="se-ic">${icon('search', 18)}</span><b>${t('side.empty')}</b>
           <button class="btn btn-ghost" type="button" data-search-messages style="margin-top:8px" data-i18n="gs.open">Искать в сообщениях</button></div>`
      : `<div class="side-empty"><span class="se-ic">${icon('plus', 20)}</span><b>${t(folder === 'all' ? 'side.noChats' : 'folder.empty')}</b><span>${t(folder === 'all' ? 'side.noChatsHint' : 'folder.emptyHint')}</span></div>`;
  } else {
    list.innerHTML = rows.map(chatRow).join('');
  }

  /* профиль */
  paintMeChip();

  /* непрочитанные в заголовке вкладки и на иконке приложения */
  const total = S.me ? S.chats.reduce((n, c) => n + (c.unread || 0), 0) : 0;
  document.title = total ? `(${total > 99 ? '99+' : total}) Relik` : 'Relik';
  try {
    if (navigator.setAppBadge) {
      const p = total ? navigator.setAppBadge(total) : navigator.clearAppBadge?.();
      p?.catch?.(() => {});
    }
  } catch (e) { /* Badging API не поддерживается */ }
}

/* профиль внизу сайдбара — рисуем отдельно, чтобы не пересобирать список */
function paintMeChip() {
  const av = $('#meAvatar');
  if (av) av.innerHTML = avatarHtml(S.me || { name: '?', hue: 0 });
  if ($('#meName')) $('#meName').innerHTML = esc(S.me?.name || '');
  if ($('#meMail')) $('#meMail').textContent = S.me?.username ? '@' + S.me.username : (S.me?.mail || '');
}

/* ── контекстное меню чата ─────────────────────────────────── */
function openChatMenu(chat, pos) {
  if (!chat) return;
  const pinned = isPinned(chat.id);
  const muted = isMuted(chat.id);
  const isGroup = chat.kind === 'group';
  openMenu([
    {
      label: pinned ? t('side.unpin') : t('side.pin'),
      icon: 'pin',
      onClick: () => {
        const now = togglePinned(chat.id);
        renderSidebar();
        toast(t(now ? 'side.pinnedToast' : 'side.unpinnedToast'), { type: 'success' });
      },
    },
    {
      label: muted ? t('side.unmute') : t('side.mute'),
      icon: muted ? 'bell' : 'bellOff',
      onClick: () => {
        const now = toggleMuted(chat.id);
        renderSidebar();
        toast(t(now ? 'side.mutedToast' : 'side.unmutedToast'), { type: 'success' });
      },
    },
    {
      label: t('side.markRead'),
      icon: 'checkCircle',
      disabled: !chat.unread,
      onClick: () => markChatRead(chat),
    },
    {
      label: t('folder.move'),
      icon: 'folder',
      hint: getChatFolder(chat.id) ? t('folder.' + getChatFolder(chat.id)) : '',
      onClick: () => openFolderMenu(chat, pos),
    },
    { sep: true },
    {
      label: t('side.clear'),
      icon: 'database',
      onClick: () => clearChatHistory(chat),
    },
    {
      label: isGroup ? t('side.leave') : t('side.delete'),
      icon: isGroup ? 'logout' : 'trash',
      danger: true,
      onClick: () => leaveOrDelete(chat),
    },
  ], pos);
}

function openFolderMenu(chat, pos) {
  const current = getChatFolder(chat.id);
  const options = [
    { key: '', label: t('folder.none') },
    { key: 'work', label: t('folder.work') },
    { key: 'archive', label: t('folder.archive') },
  ];
  openMenu(options.map((opt) => ({
    label: opt.label,
    icon: current === opt.key ? 'check' : 'folder',
    onClick: () => {
      setChatFolder(chat.id, opt.key);
      renderSidebar();
      toast(t(opt.key ? 'folder.moved' : 'folder.removed'), { type: 'success' });
    },
  })), pos);
}

function markChatRead(chat) {
  chat.unread = 0;
  setReadAt(chat.id);
  idb.put('chats', chat);
  renderSidebar();
  toast(t('side.markedRead'), { type: 'success' });
}

async function clearChatHistory(chat) {
  const ok = await confirmAction({
    title: t('side.clearTitle'),
    text: t('side.clearText'),
    ok: t('side.clearOk'),
    danger: true,
  });
  if (!ok) return;
  try {
    await idb.delMessagesOf(chat.id);
  } catch (e) { /* ignore */ }
  S.messages[chat.id] = [];
  chat.last = null;
  chat.unread = 0;
  delete chat.pin;
  await idb.put('chats', chat);
  await idb.del('settings', 'pin:' + chat.id);
  await idb.del('settings', 'draft:' + chat.id);
  if (S.drafts) S.drafts[chat.id] = '';
  setReadAt(chat.id);
  emit('chat:cleared', { id: chat.id });
  renderSidebar();
  toast(t('side.cleared'), { type: 'success' });
}

async function leaveOrDelete(chat) {
  const isGroup = chat.kind === 'group';
  const ok = await confirmAction({
    title: t(isGroup ? 'side.leaveTitle' : 'side.deleteTitle'),
    text: t(isGroup ? 'side.leaveText' : 'side.deleteText'),
    ok: t(isGroup ? 'side.leaveOk' : 'side.deleteOk'),
    danger: true,
    iconName: isGroup ? 'logout' : 'trash',
  });
  if (!ok) return;

  if (isGroup && SUPABASE.url && SUPABASE.anonKey) {
    try {
      const { leaveGroup } = await import('../backend/groups.js');
      await leaveGroup(chat.id);
    } catch (err) {
      console.warn('Leave group error:', err);
      toast(t('side.leaveError'), { type: 'error' });
      return;
    }
  }

  S.chats = S.chats.filter((c) => c.id !== chat.id);
  delete S.messages[chat.id];
  clearChatPrefs(chat.id);
  await idb.del('chats', chat.id);
  if (S.active === chat.id) {
    S.active = null;
    $('#appView').classList.remove('pane-chat');
    location.hash = '#/app';
    emit('chat:removed', { id: chat.id });
  }
  renderSidebar();
  toast(t(isGroup ? 'side.left' : 'side.deleted'), { type: 'success' });
}

/* Делегирование кликов навешивается один раз в initSidebar() */
export function initSidebar() {
  const list = $('#sideList');

  const openFromRow = (row) => {
    if (!row) return;
    location.hash = `#/chat/${row.dataset.cid}`;
  };

  list.addEventListener('click', (e) => {
    const menuBtn = e.target.closest('[data-chat-menu]');
    if (menuBtn) {
      e.stopPropagation();
      const chat = S.chats.find((c) => c.id === menuBtn.dataset.chatMenu);
      openChatMenu(chat, { anchor: menuBtn, align: 'right' });
      return;
    }
    const item = e.target.closest('.chat-item');
    if (!item) return;
    openFromRow(item);
  });

  list.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const item = e.target.closest('.chat-item');
    if (!item || e.target.closest('button')) return;
    e.preventDefault();
    openFromRow(item);
  });

  list.addEventListener('contextmenu', (e) => {
    const item = e.target.closest('.chat-item');
    if (!item) return;
    e.preventDefault();
    const chat = S.chats.find((c) => c.id === item.dataset.cid);
    openChatMenu(chat, { x: e.clientX, y: e.clientY });
  });

  bindLongPress(list, (e) => {
    const item = e.target.closest('.chat-item');
    if (!item) return;
    const chat = S.chats.find((c) => c.id === item.dataset.cid);
    openChatMenu(chat, { x: e.clientX, y: e.clientY });
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

  $('#folderRow')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-folder]');
    if (!btn) return;
    S.folder = btn.dataset.folder || 'all';
    renderSidebar();
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
          const rows = latest.get(chat.id) || [];
          for (const row of rows) {
            const ts = new Date(row.created_at).getTime();
            if ((chat.last?.ts || 0) >= ts) break;
            const text = await previewTextFor(row, chat);
            if (text == null) continue;
            const mine = row.sender_id === S.me?.id;
            chat.last = { ts, from: mine ? 'u_me' : row.sender_id, type: 'text', text };
            break;
          }
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
