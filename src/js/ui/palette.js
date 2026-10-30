/* Relik — командная палитра (Ctrl/Cmd+K).
   Одна строка вместо десяти кликов: чаты, действия и поиск по уже
   загруженным сообщениям. Работает локально и одинаково в демо/реальном режиме. */
import { S, chatTitle } from './state.js';
import { $, $$, esc, avatarHtml, fmtTime, snippet } from './utils.js';
import { icon } from './icons.js';
import { t } from '../i18n/i18n.js';
import { THEMES, applyTheme, currentTheme } from './themes.js';
import { isPinned, isMuted, togglePinned, toggleMuted } from './prefs.js';
import { toast } from './toast.js';
import { openNewChat, openGroupCreator, openSettings, openGlobalSearch } from './modals.js';
import { renderSidebar } from './sidebar.js';
import { hideUser } from '../backend/blocks.js';
import { lockNow, hasPin } from './pin.js';
import { exportChats } from './export.js';

const MAX_CHATS = 7;
const MAX_CHAT_PREVIEW = 5;
const MAX_MESSAGES = 5;
const MAX_ACTIONS = 5;

let isOpen = false;
let index = 0;
let rows = [];
let lastFocus = null;
let currentQuery = '';

const low = (s) => String(s ?? '').toLowerCase();

/* ── данные для строк ─────────────────────────────────────── */
function chatUser(chat) {
  return chat.kind === 'dm'
    ? (S.users.find((x) => x.id === chat.userId) || { name: chat.title || '…', hue: chat.hue ?? 0, seen: '' })
    : { name: chat.title, hue: chat.hue ?? 5, seen: '' };
}

function sortedChats() {
  return S.chats
    .filter((c) => !(c.kind === 'dm' && c.userId && hideUser(c.userId)))
    .slice()
    .sort((a, b) => {
      const pa = isPinned(a.id) ? 1 : 0;
      const pb = isPinned(b.id) ? 1 : 0;
      if (pa !== pb) return pb - pa;
      return (b.last?.ts || 0) - (a.last?.ts || 0);
    });
}

function cycleTheme() {
  const ids = THEMES.map((x) => x.id);
  const next = ids[(ids.indexOf(currentTheme()) + 1) % ids.length];
  applyTheme(next);
  toast(THEMES.find((x) => x.id === next)?.name || next, { type: 'success', duration: 1500 });
}

function actionList(termRaw = '') {
  const chat = S.chats.find((c) => c.id === S.active);
  const term = String(termRaw || '').trim();
  const acts = [];

  if (chat) {
    acts.push({
      id: 'pin',
      icon: 'pin',
      label: t(isPinned(chat.id) ? 'palette.unpin' : 'palette.pin'),
      run: () => {
        const now = togglePinned(chat.id);
        renderSidebar();
        toast(t(now ? 'side.pinnedToast' : 'side.unpinnedToast'), { type: 'success' });
      },
    });
    acts.push({
      id: 'mute',
      icon: 'bellOff',
      label: t(isMuted(chat.id) ? 'palette.unmute' : 'palette.mute'),
      run: () => {
        const now = toggleMuted(chat.id);
        renderSidebar();
        toast(t(now ? 'side.mutedToast' : 'side.unmutedToast'), { type: 'success' });
      },
    });
  }

  acts.push(
    { id: 'newChat', icon: 'plus', label: t('palette.newChat'), run: () => openNewChat() },
    { id: 'newGroup', icon: 'users', label: t('palette.newGroup'), run: () => openGroupCreator() },
    { id: 'settings', icon: 'sliders', label: t('palette.settings'), run: () => openSettings() },
    {
      id: 'theme',
      icon: 'palette',
      label: t('palette.theme'),
      hint: THEMES.find((x) => x.id === currentTheme())?.name || '',
      run: () => cycleTheme(),
    },
    {
      id: 'storage',
      icon: 'hardDrive',
      label: t('palette.storage'),
      run: async () => {
        openSettings();
        setTimeout(() => $('#storageField')?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 120);
      },
    },
    {
      id: 'export',
      icon: 'dl',
      label: t('palette.export'),
      run: async () => {
        try {
          const n = await exportChats('json');
          toast(t('settings.exported').replace('{n}', String(n)), { type: 'success' });
        } catch (e) {
          toast(t('toast.error'), { type: 'error' });
        }
      },
    },
    {
      id: 'lock',
      icon: 'lock',
      label: t('palette.lock'),
      run: () => {
        if (!hasPin()) {
          openSettings();
          toast(t('palette.noPin'), { type: 'warn' });
          return;
        }
        lockNow();
      },
    },
    {
      id: 'diag',
      icon: 'shield',
      label: t('palette.diagnostics'),
      run: () => window.open('tools/diagnostics.html', '_blank', 'noopener'),
    },
    term.length >= 2
      ? {
        id: 'searchTerm',
        icon: 'search',
        label: t('palette.searchAllFor').replace('{q}', term),
        run: () => openGlobalSearch(term),
      }
      : { id: 'search', icon: 'search', label: t('palette.searchAll'), run: () => openGlobalSearch('') },
  );

  return acts;
}

function messageHits(term) {
  const hits = [];
  for (const [chatId, list] of Object.entries(S.messages || {})) {
    const chat = S.chats.find((c) => c.id === chatId);
    if (!chat) continue;
    for (const m of list || []) {
      if (m.hidden || m.localDeleted || !m.text) continue;
      if (!low(m.text).includes(term)) continue;
      hits.push({ kind: 'message', chat, msg: m });
    }
  }
  return hits.sort((a, b) => (b.msg.ts || 0) - (a.msg.ts || 0)).slice(0, MAX_MESSAGES);
}

/* ── сборка строк ─────────────────────────────────────────── */
function buildRows() {
  const raw = $('#paletteInput')?.value || '';
  currentQuery = raw;
  const cmdMode = raw.trimStart().startsWith('>');
  const termRaw = (cmdMode ? raw.trimStart().slice(1) : raw).trim();
  const term = low(termRaw);
  const out = [];

  if (!cmdMode) {
    const chats = sortedChats();
    const matched = term
      ? chats.filter((c) => low(chatTitle(c)).includes(term)
        || low(c.username).includes(term)
        || low(snippet(c.last)).includes(term))
      : chats;
    const limited = matched.slice(0, term ? MAX_CHATS : MAX_CHAT_PREVIEW);
    if (limited.length) {
      out.push({ section: t(term ? 'palette.chatsFound' : 'palette.recent') });
      for (const chat of limited) out.push({ kind: 'chat', chat });
    }
  }

  const actions = actionList(termRaw).filter((a) => !term || low(a.label).includes(term) || low(a.hint).includes(term));
  if (actions.length) {
    out.push({ section: t('palette.actions') });
    const limit = cmdMode ? actions.length : (term ? MAX_ACTIONS + 2 : MAX_ACTIONS);
    for (const a of actions.slice(0, limit)) out.push({ kind: 'action', ...a });
  }

  if (!cmdMode && term.length >= 2) {
    const hits = messageHits(term);
    if (hits.length) {
      out.push({ section: t('palette.messages') });
      for (const h of hits) out.push(h);
    }
  }

  rows = out;
  const first = rows.findIndex((r) => !r.section);
  index = first < 0 ? 0 : first;
}

/* ── отрисовка ────────────────────────────────────────────── */
function rowHtml(r, i) {
  const on = i === index ? ' on' : '';
  const sel = i === index ? 'true' : 'false';

  if (r.kind === 'chat') {
    const chat = r.chat;
    const u = chatUser(chat);
    const unread = chat.unread ? `<span class="pal-badge">${chat.unread > 99 ? '99+' : chat.unread}</span>` : '';
    return `<button class="pal-row${on}" type="button" role="option" aria-selected="${sel}" data-pal-i="${i}">
      ${avatarHtml(u, { sm: true, online: chat.kind === 'dm' && u.seen === 'online' })}
      <span class="pal-main">
        <span class="pal-name">${esc(chatTitle(chat))}</span>
        <span class="pal-sub">${esc(snippet(chat.last) || t('chat.previewEmpty'))}</span>
      </span>
      <span class="pal-side">${unread}<span class="pal-time">${chat.last?.ts ? fmtTime(chat.last.ts) : ''}</span></span>
    </button>`;
  }

  if (r.kind === 'message') {
    const body = String(r.msg.text || '').replace(/\s+/g, ' ').trim();
    const at = low(body).indexOf(low(currentQuery.replace(/^>/, '').trim()));
    const from = Math.max(0, at - 26);
    const cut = body.length > from + 72 ? body.slice(from, from + 72) + '…' : body.slice(from);
    return `<button class="pal-row${on}" type="button" role="option" aria-selected="${sel}" data-pal-i="${i}">
      <span class="pal-ic">${icon('message', 16)}</span>
      <span class="pal-main">
        <span class="pal-name">${esc(chatTitle(r.chat))}</span>
        <span class="pal-sub">${(from ? '…' : '') + esc(cut)}</span>
      </span>
      <span class="pal-time">${fmtTime(r.msg.ts)}</span>
    </button>`;
  }

  return `<button class="pal-row${on}" type="button" role="option" aria-selected="${sel}" data-pal-i="${i}">
    <span class="pal-ic">${icon(r.icon || 'zap', 16)}</span>
    <span class="pal-main">
      <span class="pal-name">${esc(r.label || '')}</span>
      ${r.hint ? `<span class="pal-sub">${esc(r.hint)}</span>` : ''}
    </span>
    <span class="pal-kbd">${icon('chevronRight', 14)}</span>
  </button>`;
}

function renderRows() {
  const list = $('#paletteList');
  if (!list) return;

  if (!rows.length) {
    list.innerHTML = `<div class="pal-empty">
      <b>${esc(t('palette.empty'))}</b>
      <span>${esc(t('palette.emptyHint'))}</span>
    </div>`;
    return;
  }

  let html = '';
  rows.forEach((r, i) => {
    if (r.section) { html += `<div class="pal-sec">${esc(r.section)}</div>`; return; }
    html += rowHtml(r, i);
  });
  list.innerHTML = html;
  const active = list.querySelector('.pal-row.on');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

function paintSelection() {
  $$('#paletteList .pal-row').forEach((el) => {
    const on = Number(el.dataset.palI) === index;
    el.classList.toggle('on', on);
    el.setAttribute('aria-selected', on ? 'true' : 'false');
    if (on) el.scrollIntoView({ block: 'nearest' });
  });
}

function moveSelection(dir) {
  if (!rows.length) return;
  let i = index;
  for (let k = 0; k < rows.length; k++) {
    i = (i + dir + rows.length) % rows.length;
    if (!rows[i].section) {
      index = i;
      paintSelection();
      return;
    }
  }
}

/* ── выполнение ───────────────────────────────────────────── */
function focusMessage(msgId) {
  try {
    const safe = String(msgId).replace(/["\\]/g, '');
    const el = document.querySelector(`.msg[data-mid="${safe}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1500);
  } catch (e) { /* ignore */ }
}

function openMessage(chatId, msgId) {
  closePalette();
  const target = `#/chat/${chatId}`;
  if (location.hash === target) {
    focusMessage(msgId);
    setTimeout(() => focusMessage(msgId), 350);
    return;
  }
  location.hash = target;
  setTimeout(() => focusMessage(msgId), 700);
}

async function runRow(r) {
  if (!r || r.section) return;
  if (r.kind === 'chat') {
    const id = r.chat.id;
    closePalette();
    location.hash = `#/chat/${id}`;
    return;
  }
  if (r.kind === 'message') {
    openMessage(r.chat.id, r.msg.id);
    return;
  }
  closePalette();
  try {
    await r.run?.();
  } catch (e) {
    console.error('Palette action failed:', e);
    toast(t('toast.error'), { type: 'error' });
  }
}

/* ── открытие / закрытие ──────────────────────────────────── */
export function openPalette(initial = '') {
  const ov = $('#paletteOv');
  if (!ov || !S.me) return;
  if (isOpen) {
    const inp = $('#paletteInput');
    if (inp && initial) { inp.value = initial; buildRows(); renderRows(); }
    inp?.focus();
    return;
  }
  lastFocus = document.activeElement;
  isOpen = true;
  const inp = $('#paletteInput');
  if (inp) inp.value = initial === '>' ? '>' : initial;
  ov.hidden = false;
  document.documentElement.classList.add('palette-open');
  buildRows();
  renderRows();
  if (inp) {
    try { inp.focus(); } catch (e) { /* ignore */ }
  }
  requestAnimationFrame(() => {
    if (!inp) return;
    try {
      inp.focus();
      inp.setSelectionRange(inp.value.length, inp.value.length);
    } catch (e) { /* ignore */ }
  });
}

export function closePalette({ restore = true } = {}) {
  const ov = $('#paletteOv');
  if (!ov || !isOpen) return;
  isOpen = false;
  ov.hidden = true;
  document.documentElement.classList.remove('palette-open');
  const list = $('#paletteList');
  if (list) list.innerHTML = '';
  if (restore && lastFocus && lastFocus.isConnected) {
    try { lastFocus.focus(); } catch (e) { /* ignore */ }
  }
  lastFocus = null;
}

export function paletteOpen() {
  return isOpen;
}

/* ── соседний чат (Alt+↑ / Alt+↓) ─────────────────────────── */
function navigateChat(dir) {
  const chats = sortedChats();
  if (!chats.length) return;
  let at = chats.findIndex((c) => c.id === S.active);
  if (at < 0) at = dir > 0 ? -1 : 0;
  const next = chats[(at + dir + chats.length) % chats.length];
  if (next) location.hash = `#/chat/${next.id}`;
}

function onKey(e) {
  const cmd = e.ctrlKey || e.metaKey;

  /* Ctrl/Cmd+K — открыть/закрыть палитру (e.code не зависит от раскладки) */
  if (cmd && !e.shiftKey && (e.code === 'KeyK' || low(e.key) === 'k')) {
    if (!S.me) return;
    e.preventDefault();
    if (isOpen) closePalette(); else openPalette();
    return;
  }

  if (isOpen) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closePalette();
      return;
    }
    if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
      e.preventDefault();
      e.stopPropagation();
      moveSelection(1);
      return;
    }
    if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
      e.preventDefault();
      e.stopPropagation();
      moveSelection(-1);
      return;
    }
    if (e.key === 'Enter') {
      const r = rows[index];
      if (r && !r.section) {
        e.preventDefault();
        e.stopPropagation();
        runRow(r);
      }
      return;
    }
    return;
  }

  /* Alt+↑/↓ — переключение чатов (не мешаем вводу текста) */
  if (S.me && e.altKey && !cmd && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    const tag = low(e.target?.tagName);
    if (tag === 'textarea' || tag === 'input' || e.target?.isContentEditable) return;
    if ($('.overlay:not([hidden]), .call-overlay:not([hidden]), .lightbox:not([hidden])')) return;
    e.preventDefault();
    navigateChat(e.key === 'ArrowDown' ? 1 : -1);
  }
}

export function initPalette() {
  const ov = $('#paletteOv');
  if (!ov) return;

  const lead = $('#paletteIc');
  if (lead) lead.innerHTML = icon('search', 18);

  /* Ctrl K на клавиатуре, ⌘K — на Mac */
  const kbd = $('#paletteBtn');
  if (kbd) {
    const mac = /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || '');
    kbd.textContent = mac ? '⌘K' : 'Ctrl K';
    kbd.title = mac ? '⌘K' : 'Ctrl K';
  }
  const searchOpen = $('#searchOpenPalette');
  if (searchOpen) {
    searchOpen.title = t('palette.title');
    searchOpen.setAttribute('aria-label', t('palette.title'));
  }
  const dialog = $('.palette');
  if (dialog) dialog.setAttribute('aria-label', t('palette.title'));
  document.addEventListener('click', (e) => {
    if (!e.target.closest('[data-open-palette]')) return;
    e.preventDefault();
    openPalette();
  });

  const hint = $('#paletteHint');
  if (hint) hint.innerHTML = `${icon('keyboard', 13)}<span>${esc(t('palette.footer'))}</span>`;

  $('#paletteInput')?.addEventListener('input', () => {
    buildRows();
    renderRows();
  });

  $('#paletteList')?.addEventListener('mousemove', (e) => {
    const row = e.target.closest('[data-pal-i]');
    if (!row) return;
    const i = Number(row.dataset.palI);
    if (i !== index && rows[i] && !rows[i].section) {
      index = i;
      paintSelection();
    }
  });

  $('#paletteList')?.addEventListener('click', (e) => {
    const row = e.target.closest('[data-pal-i]');
    if (!row) return;
    const r = rows[Number(row.dataset.palI)];
    if (r) runRow(r);
  });

  ov.addEventListener('click', (e) => { if (e.target === ov) closePalette(); });
  document.addEventListener('keydown', onKey, true);

  document.addEventListener('relik:lang', () => {
    const so = $('#searchOpenPalette');
    if (so) {
      so.title = t('palette.title');
      so.setAttribute('aria-label', t('palette.title'));
    }
    const dialog = $('.palette');
    if (dialog) dialog.setAttribute('aria-label', t('palette.title'));
    if (!isOpen) return;
    const h = $('#paletteHint');
    if (h) h.innerHTML = `${icon('keyboard', 13)}<span>${esc(t('palette.footer'))}</span>`;
    buildRows();
    renderRows();
  });
}
