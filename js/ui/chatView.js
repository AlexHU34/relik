/* Relik — представление чата: шапка, лента, пузыри, реакции, голос */
import { S, user, chatTitle, chatById, bus } from './state.js';
import { $, esc, fmtTime, fmtDay, fmtDur, fmtSize, avatarHtml, adminBadge, snippet } from './utils.js';
import { icon } from './icons.js';
import { t } from '../i18n/i18n.js';
import { idb, newId } from '../db/idb.js';
import { EMOJI_QUICK, SUPABASE } from '../config.js';
import { openLightbox, openGroupManager } from './modals.js';
import { openMenu } from './menu.js';
import { toast } from './toast.js';
import { renderSidebar } from './sidebar.js';
import { refreshBar, resetComposer, loadEdit, retryMessage, votePoll, sendReaction, closePoll } from './composer.js';
import { playMessage } from './sounds.js';
import { notifyMessage } from './notify.js';
import { initTyping, stopTyping } from '../backend/presence.js';
import { currentDevice } from './device.js';
import { startCall } from './calls.js';
import { getReadAt, setReadAt, isMuted, prefs } from './prefs.js';
import { formatText, isEmojiOnly, safeMediaSrc } from './richText.js';
import { loadMessages, fetchMessagesSince, subscribeToChat, updateReadReceipt, deleteMessage as deleteMessageBackend, sendMessage, encodeMedia, encodeRead } from '../backend/messages.js';

const PAGE_SIZE = 240;

let els = {};
const playing = new Map(); // msgId -> {timer, i, bars}
let searchQuery = '';
let searchHits = [];
let searchIndex = 0;
let unseenCount = 0;
let forwardMsg = null;
let currentSubscription = null; // Realtime subscription
let pollTimer = null;           // страховочный опрос активного чата
let activeSyncTick = null;
let toolsOpen = null;           // панель действий сообщения (тап на телефоне)
let autoScrolling = false;
const readMarks = new Map();    // chatId -> { upto, at } — последняя отправленная отметка
const demoReads = new Set();    // сообщения, для которых демо уже «прочитало»

/* ── инициализация и делегирование ─────────────────────────── */
export function initChatView() {
  els.msgs = $('#msgs');
  els.toBottom = $('#toBottom');
  els.toBottom.innerHTML = icon('arrowDown', 18);
  els.msgs.addEventListener('click', onMsgClick);
  els.msgs.addEventListener('scroll', updateToBottom, { passive: true });
  els.toBottom.addEventListener('click', () => scrollBottom(false));
  $('#backBtn').addEventListener('click', () => {
    stopActiveSync();
    stopTyping();
    location.hash = '#/app';
    S.active = null;
    $('#appView').classList.remove('pane-chat');
    showChat();
  });
  $('#videoCallBtn').addEventListener('click', () => {
    const chat = chatById(S.active);
    if (chat) startCall(chat, { video: true });
  });
  $('#shareBtn').addEventListener('click', shareChat);
  $('#callBtn').addEventListener('click', () => {
    const chat = chatById(S.active);
    if (chat) startCall(chat);
  });
  $('#infoBtn').addEventListener('click', openChatProfile);
  $('#chatWho').addEventListener('click', openChatProfile);
  $('#profileCall').addEventListener('click', () => {
    const chat = chatById(S.active);
    $('#profileOv').hidden = true;
    if (chat) startCall(chat);
  });
  $('#profileVideo').addEventListener('click', () => {
    const chat = chatById(S.active);
    $('#profileOv').hidden = true;
    if (chat) startCall(chat, { video: true });
  });

  /* поиск по чату: подсветка совпадений + переход между ними */
  $('#chatSearchBtn').innerHTML = icon('search', 18);
  $('#csIc').innerHTML = icon('search', 16);
  $('#chatSearchClose').innerHTML = icon('x', 17);
  $('#chatSearchPrev').innerHTML = icon('chevronUp', 17);
  $('#chatSearchNext').innerHTML = icon('chevronDown', 17);
  $('#chatSearchPrev').title = t('chat.searchPrev');
  $('#chatSearchNext').title = t('chat.searchNext');
  $('#chatSearchBtn').addEventListener('click', () => toggleSearch(true));
  $('#chatSearchClose').addEventListener('click', () => toggleSearch(false));
  $('#chatSearchPrev').addEventListener('click', () => jumpToHit(-1));
  $('#chatSearchNext').addEventListener('click', () => jumpToHit(1));
  $('#chatSearchInput').addEventListener('input', (e) => {
    searchQuery = e.target.value.trim();
    searchIndex = 0;
    renderMessages();
    if (searchQuery && searchHits.length) jumpTo(searchHits[0]);
  });
  $('#chatSearchInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      jumpToHit(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      toggleSearch(false);
    }
  });

  /* Ctrl/Cmd+F — поиск по открытому чату */
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || String(e.key).toLowerCase() !== 'f') return;
    if (!S.active) return;
    if (document.querySelector('.overlay:not([hidden]), .lightbox:not([hidden]), .call-overlay:not([hidden])')) return;
    e.preventDefault();
    toggleSearch(true);
  });

  /* закреплённое */
  $('#pinIc').innerHTML = icon('pin', 15);
  $('#pinClose').innerHTML = icon('x', 15);
  $('#pinBar').addEventListener('click', (e) => {
    if (e.target.closest('#pinClose')) return;
    const id = $('#pinBar').dataset.mid;
    if (id) jumpTo(id);
  });
  $('#pinClose').addEventListener('click', () => unpin());

  /* пересылка */
  $('#fwdList').addEventListener('click', (e) => {
    const item = e.target.closest('[data-fwd-cid]');
    if (item) forwardTo(item.dataset.fwdCid);
  });

  /* свайп вправо по чату = «назад» (как в Telegram) */
  const pane = $('#chatPane');
  let sx = 0, sy = 0;
  pane.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    sx = t.clientX; sy = t.clientY;
  }, { passive: true });
  pane.addEventListener('touchend', (e) => {
    if (!sx) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - sx;
    const dy = Math.abs(t.clientY - sy);
    sx = 0;
    if (dx > 80 && dy < 60 && $('#appView').classList.contains('pane-chat')) {
      stopActiveSync();
      location.hash = '#/app';
      S.active = null;
      $('#appView').classList.remove('pane-chat');
      showChat();
    }
  }, { passive: true });

  /* «Показать раньше» — подгружаем предыдущую страницу ленты */
  els.msgs.addEventListener('click', (e) => {
    if (!e.target.closest('[data-load-earlier]')) return;
    const id = S.active;
    if (!id) return;
    S.renderLimit = { ...(S.renderLimit || {}), [id]: (S.renderLimit?.[id] || PAGE_SIZE) + PAGE_SIZE };
    renderMessages({ prepend: true });
  });

  /* двойной клик по сообщению — ответ */
  els.msgs.addEventListener('dblclick', (e) => {
    if (e.target.closest('a,button,input,textarea,.msg-img')) return;
    const msgEl = e.target.closest('.msg');
    const m = msgEl && byId(msgEl.dataset.mid);
    if (!m || m.deleted || m.hidden) return;
    S.editing = null;
    S.reply = { id: m.id, name: m.sender === 'u_me' ? t('msg.you') : user(m.sender).name, snippet: snippet(m) };
    refreshBar();
    $('#ta')?.focus();
  });

  /* возврат из «вниз» — счётчик новых сообщений сбрасывается */
  els.toBottom.addEventListener('click', () => { unseenCount = 0; updateToBottom(); });

  /* сайдбар очистил историю / убрал чат — обновляем ленту без перезагрузки */
  bus.addEventListener('chat:cleared', (e) => {
    const id = e.detail?.id;
    if (!id) return;
    S.messages[id] = [];
    if (S.unreadFrom) S.unreadFrom[id] = 0;
    if (S.active === id) renderMessages();
  });
  bus.addEventListener('chat:removed', (e) => {
    if (S.active === e.detail?.id) {
      S.active = null;
      showChat();
    }
  });
  bus.addEventListener('chat:updated', (e) => {
    if (S.active === e.detail?.id) {
      renderHeader();
      renderMessages();
    }
  });

  /* вернулись в браузер/вкладку — сразу подтягиваем новые сообщения */
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && activeSyncTick) activeSyncTick();
    if (document.visibilityState === 'visible' && S.active) sendReadUpto(S.active);
  });

  /* тап мимо сообщения закрывает панель действий */
  document.addEventListener('click', (e) => {
    if (!toolsOpen) return;
    if (e.target.closest('.msg')) return;
    toolsOpen = null;
    renderMessages();
  });
}

function onMsgClick(e) {
  /* ссылки в тексте открываются браузером и не должны открывать панель действий */
  if (e.target.closest('a[href]')) return;
  const actEl = e.target.closest('[data-act]');
  const pickEl = e.target.closest('[data-pick]');
  const rxBt = e.target.closest('[data-rx]');
  const imgEl = e.target.closest('.msg-img');
  const playEl = e.target.closest('.v-play');
  const speedEl = e.target.closest('[data-speed]');
  const quoteEl = e.target.closest('.reply-quote');
  const msgEl = e.target.closest('.msg');
  const m = msgEl && byId(msgEl.dataset.mid);

  if (e.target.closest('.ticks.read') && m) { openReadInfo(m); return; }

  if (pickEl && m) { toggleReaction(m, pickEl.dataset.pick); return; }
  if (rxBt && m) { toggleReaction(m, rxBt.dataset.rx); return; }
  const pollEl = e.target.closest('[data-poll-opt]');
  if (pollEl && m?.type === 'poll') { votePollOption(m, Number(pollEl.dataset.pollOpt)); return; }
  const pollClose = e.target.closest('[data-poll-close]');
  if (pollClose && m?.type === 'poll') { closePoll(m); return; }
  if (imgEl && m?.file?.src) {
    const src = safeMediaSrc(m.file.src, 'image');
    if (src) openLightbox(src, m.file.name); else toast(t('media.broken'), { type: 'error' });
    return;
  }
  const fileEl = e.target.closest('.file-row');
  if (fileEl && m?.type === 'file' && m.file?.src) {
    const src = safeMediaSrc(m.file.src, 'file');
    if (!src) { toast(t('media.broken'), { type: 'error' }); return; }
    const a = document.createElement('a');
    a.href = src;
    a.download = m.file.name || 'file';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    return;
  }
  if (playEl && m) { playVoice(m, playEl); return; }
  if (speedEl && m) { cycleSpeed(m, speedEl); return; }
  if (quoteEl) { jumpTo(quoteEl.dataset.jump); return; }
  if (actEl && m) {
    const act = actEl.dataset.act;
    if (act === 'reply') { S.editing = null; S.reply = { id: m.id, name: user(m.sender).name, snippet: snippet(m) }; refreshBar(); closeReact(); }
    else if (act === 'react') { S.reactOpen = S.reactOpen === m.id ? null : m.id; renderMessages(); }
    else if (act === 'retry') { retryMessage(m); }
    else if (act === 'copy') {
      const text = m.text || '';
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text)
          .then(() => toast(t('msg.copied'), { type: 'success' }))
          .catch(() => toast(t('toast.error'), { type: 'error' }));
      } else {
        toast(t('toast.error'), { type: 'error' });
      }
    }
    else if (act === 'edit') { S.editing = m.id; S.reply = null; loadEdit(m); closeReact(); }
    else if (act === 'pin') {
      const chat = chatById(S.active);
      chat.pin = { id: m.id, text: snippet(m) };
      idb.put('settings', { key: 'pin:' + chat.id, value: chat.pin });
      idb.put('chats', chat);
      renderPin();
      toast(t('chat.pinnedToast'));
      closeReact();
    }
    else if (act === 'forward') { openForward(m); closeReact(); }
    else if (act === 'readby') { openReadInfo(m); closeReact(); }
    else if (act === 'del') {
      openMenu([
        {
          label: t('msg.deleteMe'),
          icon: 'trash',
          onClick: () => deleteMessageLocal(m),
        },
        {
          label: t('msg.deleteAll'),
          icon: 'trash',
          danger: true,
          onClick: () => deleteMessageEverywhere(m),
        },
      ], { anchor: actEl, align: 'right' });
      closeReact();
    }
    return;
  }
  if (S.reactOpen) closeReact();
  /* на телефоне действия по сообщению открываются тапом */
  if (m && !e.target.closest('[data-act],[data-pick],[data-rx],[data-poll-opt],.poll,.reply-quote,.msg-img,.voice')) {
    const touch = currentDevice() === 'phone' || window.matchMedia('(hover: none)').matches;
    if (touch) {
      toolsOpen = toolsOpen === m.id ? null : m.id;
      renderMessages();
    }
  }
}

function byId(id) {
  return (S.messages[S.active] || []).find((m) => m.id === id);
}

/* Удаление: у себя — скрываем только на этом устройстве; у всех — помечаем на сервере */
function afterMessageRemoved(m) {
  const chat = chatById(S.active);
  if (!chat) return;
  if (chat.pin?.id === m.id) {
    delete chat.pin;
    idb.del('settings', 'pin:' + chat.id);
    renderPin();
  }
  const last = (S.messages[S.active] || []).filter((x) => !x.hidden).pop();
  chat.last = last ? { ts: last.ts, from: last.sender, type: last.type, text: last.text || '' } : null;
  idb.put('chats', chat);
  renderSidebar();
}

function deleteMessageLocal(m) {
  m.hidden = true;
  m.localDeleted = true;
  idb.put('messages', m).then(() => {
    renderMessages();
    afterMessageRemoved(m);
  });
  toast(t('msg.deletedLocal'), { type: 'success' });
}

function deleteMessageEverywhere(m) {
  if (SUPABASE.url && SUPABASE.anonKey) {
    deleteMessageBackend(m.id).catch((err) => console.error('Delete error:', err));
  }
  m.deleted = true;
  m.text = '';
  idb.put('messages', m).then(() => {
    renderMessages();
    afterMessageRemoved(m);
  });
  toast(t('msg.deletedEverywhere'), { type: 'success' });
}

/* ── ссылка-приглашение в чат ──────────────────────────────── */
async function shareChat() {
  const chat = chatById(S.active);
  if (!chat) return;
  const link = `${location.origin}${location.pathname}#/join/${chat.id}`;
  try {
    await navigator.clipboard.writeText(link);
    toast(t('chat.linkCopied'));
  } catch (err) {
    toast(link);
  }
}

function closeReact() {
  if (S.reactOpen) { S.reactOpen = null; renderMessages(); }
}

/* ── «Живая» лента: Realtime + тихий опрос на случай сбоя сокета ── */
function mergeMessages(server, local) {
  const map = new Map(server.map((m) => [m.id, m]));
  for (const m of local) {
    const s = map.get(m.id);
    if (!s) map.set(m.id, m);
    else {
      if (m.status === 'read') s.status = 'read'; // локальная отметка прочтения не теряется
      if (m.localDeleted) { s.hidden = true; s.localDeleted = true; } // «удалено у себя»
    }
  }
  return [...map.values()].sort((a, b) => (a.ts || 0) - (b.ts || 0));
}

/* ── Прочтение: скрытые read-события, без новых таблиц и RLS ── */
function readUptos(raw) {
  const map = new Map();
  for (const x of raw) {
    if (x.type !== 'read' || !x.read) continue;
    if (x.sender === 'u_me' || x.sender === S.me?.id) continue;
    const upto = Number(x.read.upto) || 0;
    if (upto > (map.get(x.sender) || 0)) map.set(x.sender, upto);
  }
  return map;
}

function requiredReaders(chat) {
  if (!chat) return [];
  if (chat.kind === 'group') return [...new Set((chat.members || []).filter(Boolean))];
  return chat.userId ? [chat.userId] : [];
}

/* Пересчитать галочки у своих сообщений по последним read-событиям */
function applyReadState(chatId) {
  const chat = chatById(chatId);
  if (!chat) return;
  const raw = S.messages[chatId] || [];
  const reads = readUptos(raw);
  const req = requiredReaders(chat);
  if (!req.length) return;

  /* в группе достаточно одного прочитавшего (по ответу в опросе) */
  let upto = 0;
  for (const uid of req) upto = Math.max(upto, reads.get(uid) || 0);

  const changed = [];
  for (const m of raw) {
    if (m.sender !== 'u_me' || m.hidden || m.deleted) continue;
    if (m.status === 'sending' || m.status === 'error') continue;
    const desired = upto > 0 && m.ts <= upto ? 'read' : 'sent';
    if (m.status !== desired) {
      m.status = desired;
      changed.push(m);
      refreshTicks(m);
    }
  }
  if (changed.length) idb.bulkPut('messages', changed).catch(() => {});
}

function refreshTicks(m) {
  if (S.active !== m.chatId) return;
  const el = els.msgs?.querySelector(`[data-mid="${nonzeroEscape(m.id)}"]`);
  if (!el) return;
  const meta = el.querySelector('.msg-meta');
  if (!meta) return;
  const html = ticksHtml(m, true);
  const old = meta.querySelector('.ticks');
  if (html) {
    if (old) old.outerHTML = html;
    else meta.insertAdjacentHTML('beforeend', html);
  } else if (old) {
    old.remove();
  }
}

/* Кто прочитал конкретное сообщение (по скрытым read-событиям) */
function readersFor(m) {
  const raw = S.messages[S.active] || [];
  const map = new Map();
  for (const x of raw) {
    if (x.type !== 'read' || !x.read || x.sender === 'u_me') continue;
    const upto = Number(x.read.upto) || 0;
    if (upto < m.ts) continue;
    map.set(x.sender, Math.max(map.get(x.sender) || 0, upto));
  }
  return [...map.keys()].map((uid) => user(uid));
}

function openReadInfo(m) {
  const list = readersFor(m);
  const wrap = $('#readList');
  if (!wrap) return;
  wrap.innerHTML = list.length
    ? list.map((u) => `<div class="member-row">
        ${avatarHtml(u, { sm: true, online: u.seen === 'online' })}
        <span class="info">
          <span class="n">${esc(u.name)}${adminBadge(u)}</span>
          <span class="s">${u.username ? '@' + esc(u.username) : t('msg.read')}</span>
        </span>
        <span class="read-mark">${icon('check2', 16)}</span>
      </div>`).join('')
    : `<div class="nc-hint">${t('msg.noReads')}</div>`;
  $('#readOv').hidden = false;
}

/* Сообщить другим, что мы дочитали до upto (не чаще раза в ~1,5 с) */
function sendReadUpto(chatId) {
  if (!(SUPABASE.url && SUPABASE.anonKey)) return;
  const chat = chatById(chatId);
  if (!chat) return;
  const list = (S.messages[chatId] || []).filter((m) => !m.hidden && !m.deleted);
  const last = list[list.length - 1];
  const upto = last?.ts || 0;
  if (!upto) return;

  const prev = readMarks.get(chatId) || { upto: 0, at: 0, timer: 0 };
  if (upto <= prev.upto) return;

  const now = Date.now();
  const wait = 1400 - (now - prev.at);
  if (wait > 0) {
    clearTimeout(prev.timer);
    prev.timer = setTimeout(() => sendReadUpto(chatId), wait);
    readMarks.set(chatId, prev);
    return;
  }

  readMarks.set(chatId, { upto, at: now, timer: 0 });
  const event = {
    id: newId(), chatId, sender: 'u_me', ts: now,
    type: 'read', hidden: true, read: { upto }, text: '', reactions: [], status: 'sending',
  };
  S.messages[chatId] = S.messages[chatId] || [];
  S.messages[chatId].push(event);
  idb.put('messages', event).catch(() => {});

  sendMessage(chatId, encodeRead(upto), null, chat.kind, chat.publicKey, event.id)
    .then(() => { event.status = 'sent'; idb.put('messages', event).catch(() => {}); })
    .catch((err) => {
      console.warn('Read receipt error:', err);
      S.messages[chatId] = (S.messages[chatId] || []).filter((x) => x.id !== event.id);
      idb.del('messages', event.id).catch(() => {});
      readMarks.delete(chatId);
    });
}

/* В демо нет второго устройства — имитируем прочтение, чтобы было видно ✓✓ */
function scheduleDemoRead(chatId, msg) {
  if (SUPABASE.url && SUPABASE.anonKey) return;
  if (!msg || msg.sender !== 'u_me' || msg.hidden || msg.type === 'read') return;
  if (demoReads.has(msg.id)) return;
  demoReads.add(msg.id);
  const chat = chatById(chatId);
  if (!chat) return;
  const readers = chat.kind === 'group'
    ? [...new Set((chat.members || []).filter(Boolean))]
    : (chat.userId ? [chat.userId] : []);
  if (!readers.length) return;

  setTimeout(() => {
    if (!chatById(chatId)) return;
    if (!(S.messages[chatId] || []).some((x) => x.id === msg.id)) return;
    for (const uid of readers) {
      const ev = {
        id: newId(), chatId, sender: uid, ts: Date.now(),
        type: 'read', hidden: true, read: { upto: msg.ts }, text: '', reactions: [], status: 'sent',
      };
      S.messages[chatId] = S.messages[chatId] || [];
      S.messages[chatId].push(ev);
      idb.put('messages', ev).catch(() => {});
    }
    applyReadState(chatId);
  }, 2400 + Math.random() * 900);
}

function stopActiveSync() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  activeSyncTick = null;
}

function startActiveSync(id, chat) {
  stopActiveSync();
  let busy = false;

  const tick = async () => {
    if (busy || !S.me || S.active !== id) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    busy = true;
    try {
      const list = S.messages[id] || [];
      const lastTs = list.reduce((max, m) => Math.max(max, m.ts || 0), 0);
      /* берём с небольшим запасом: дубликаты отсекаем по id */
      const fresh = await fetchMessagesSince(id, lastTs ? lastTs - 5000 : 0, chat.kind, chat.publicKey);
      if (!fresh.length || S.active !== id) return;

      let added = 0;
      S.messages[id] = S.messages[id] || [];
      for (const m of fresh) {
        const i = S.messages[id].findIndex((x) => x.id === m.id);
        if (i >= 0) {
          const old = S.messages[id][i];
          S.messages[id][i] = {
            ...old,
            ...m,
            reactions: old.reactions?.length ? old.reactions : m.reactions,
          };
        } else {
          S.messages[id].push(m);
          added++;
        }
      }

      applyReadState(id);

      if (added) {
        /* сообщения пришли сами — перерисовываем без перезагрузки страницы */
        const st = els.msgs.scrollTop + els.msgs.clientHeight >= els.msgs.scrollHeight - 140;
        const incoming = fresh.some((m) => m.sender !== 'u_me' && !m.hidden);
        if (!st && incoming) unseenCount += fresh.filter((m) => m.sender !== 'u_me' && !m.hidden).length;
        renderMessages();
        if (st) {
          scrollBottom();
          sendReadUpto(id);
        } else {
          updateToBottom();
        }
        if (incoming) updateReadReceipt(id).catch(() => {});
      }

      const last = S.messages[id].filter((m) => !m.hidden).pop();
      if (last) {
        chat.last = { ts: last.ts, from: last.sender, type: last.type, text: last.text || '' };
        await idb.put('chats', chat);
        renderSidebar();
      }
    } catch (err) {
      /* офлайн или RLS — просто попробуем на следующем тике */
    } finally {
      busy = false;
    }
  };

  activeSyncTick = tick;
  pollTimer = setInterval(tick, 4000);
}

/* ── открытие чата ─────────────────────────────────────────── */
export async function openChat(id) {
  const chat = chatById(id);
  if (!chat) {
    S.active = null;
    $('#appView').classList.remove('pane-chat');
    if (location.hash.startsWith('#/chat/')) location.hash = '#/app';
    return;
  }

  // Отписываемся от предыдущего чата
  stopActiveSync();
  if (currentSubscription) {
    currentSubscription.unsubscribe();
    currentSubscription = null;
  }

  S.active = id;
  S.reply = null; S.editing = null; S.reactOpen = null;
  toolsOpen = null;
  unseenCount = 0;
  searchHits = [];
  searchIndex = 0;
  S.typingUser = null;
  refreshBar(); resetComposer();

  /* Откуда показывать «новые сообщения»: отметка прочтения до открытия */
  const prevReadAt = getReadAt(id);
  S.unreadFrom = S.unreadFrom || {};
  S.unreadFrom[id] = chat.unread ? prevReadAt : 0;

  $('#chatSearch').hidden = true;
  searchQuery = '';
  $('#chatSearchInput').value = '';

  if (chat.unread) { chat.unread = 0; await idb.put('chats', chat); }
  setReadAt(id);

  /* Мгновенно показываем кэш, сеть — фоном */
  S.messages[id] = await idb.messagesOf(id);
  applyReadState(id);
  showChat();
  scrollToStartPosition(id);
  renderSidebar();
  sendReadUpto(id);

  /* черновик и закреплённое */
  try {
    const draft = await idb.get('settings', 'draft:' + id);
    const pin = await idb.get('settings', 'pin:' + id);
    chat.pin = pin?.value || null;
    const ta = $('#ta');
    if (ta) {
      ta.value = draft?.value || '';
      ta.dispatchEvent(new Event('input'));
    }
  } catch (e) { /* ignore */ }
  renderPin();

  if (SUPABASE.url && SUPABASE.anonKey) {
    /* свежие сообщения из бэкенда (не блокируем UI) */
    loadMessages(id, chat.kind, chat.publicKey)
      .then(async (msgs) => {
        if (S.active !== id) return;
        /* сервер — источник правды, но локальные «отправляется/ошибка» не теряем */
        S.messages[id] = mergeMessages(msgs, S.messages[id] || []);
        applyReadState(id);
        renderMessages();
        await updateReadReceipt(id).catch(() => {});
        setReadAt(id);
        sendReadUpto(id);
        /* зависшие в «отправляется» после аварийного закрытия — пробуем дослать */
        if (navigator.onLine !== false) {
          S.messages[id]
            .filter((m) => m.sender === 'u_me' && m.status === 'sending' && Date.now() - (m.ts || 0) > 20000)
            .slice(0, 8)
            .forEach((m) => retryMessage(m));
        }
        const lastMsg = [...msgs].reverse().find((m) => !m.hidden);
        if (lastMsg) {
          chat.last = { ts: lastMsg.ts, from: lastMsg.sender, type: lastMsg.type, text: lastMsg.text || '' };
          idb.put('chats', chat);
          renderSidebar();
        }
      })
      .catch((err) => console.error('Load messages error:', err));
  }

  // Подписываемся на Realtime
  if (SUPABASE.url && SUPABASE.anonKey) {
    initTyping(id, (uid) => {
      S.typingUser = uid || null;
      showTyping(id);
      clearTimeout(window.__typingT);
      window.__typingT = setTimeout(() => hideTyping(id), 2600);
    });
    currentSubscription = subscribeToChat(id, {
      onMessage: async (msg) => {
        S.messages[id] = S.messages[id] || [];
        if (S.messages[id].some((x) => x.id === msg.id)) return;
        S.messages[id].push(msg);
        if (msg.sender !== 'u_me' && !msg.hidden && !isMuted(id)) playMessage();
        if (msg.hidden) {
          /* голос/реакция/закрытие/прочтение: обновляем только нужный блок */
          if (msg.type === 'read') applyReadState(id);
          else if (msg.type === 'vote' && msg.vote?.p) refreshPollCard(msg.vote.p);
          else if (msg.type === 'pollclose' && msg.close?.p) refreshPollCard(msg.close.p);
          else if (msg.type === 'rx' && msg.reaction?.m) refreshMessageReactions(msg.reaction.m);
          else if (S.active === id) renderMessages();
          return;
        }
        if (S.active === id) {
          const near = isNearBottom();
          if (!near && msg.sender !== 'u_me') unseenCount++;
          renderMessages();
          if (near) {
            scrollBottom();
            if (!document.hidden) sendReadUpto(id);
          } else {
            updateToBottom();
          }
        }
        const c = chatById(id);
        if (c) {
          c.last = { ts: msg.ts, from: msg.sender, type: msg.type, text: msg.text || '' };
          if (S.active !== id) c.unread = (c.unread || 0) + 1;
          await idb.put('chats', c);
          renderSidebar();
          if (document.hidden) notifyMessage(c, snippet(msg), () => { location.hash = `#/chat/${id}`; });
        }
      },
      onEdit: (msgId, updates) => {
        const m = (S.messages[id] || []).find((x) => x.id === msgId);
        if (m) {
          Object.assign(m, updates);
          if (S.active === id) renderMessages();
          const chat = chatById(id);
          const last = (S.messages[id] || []).filter((x) => !x.hidden).pop();
          if (chat && last && last.id === msgId) {
            chat.last = { ts: last.ts, from: last.sender, type: last.type, text: last.text || '' };
            idb.put('chats', chat);
            renderSidebar();
          }
        }
      },
      onDelete: (msgId) => {
        S.messages[id] = (S.messages[id] || []).filter((x) => x.id !== msgId);
        if (S.active === id) renderMessages();
        const chat = chatById(id);
        if (chat) {
          const last = (S.messages[id] || []).filter((x) => !x.hidden).pop();
          chat.last = last ? { ts: last.ts, from: last.sender, type: last.type, text: last.text || '' } : null;
          idb.put('chats', chat);
          renderSidebar();
        }
      },
    }, chat.kind, chat.publicKey);

    /* Realtime может отвалиться (сеть, VPN, RLS) — опрос добирает пропущенное */
    startActiveSync(id, chat);
  }

  if (currentDevice() === 'phone') $('#appView').classList.add('pane-chat');
  $('#ta')?.focus();
}

/* Показ пустого состояния или чата */
export function showChat() {
  const has = S.active && chatById(S.active);
  $('#chatEmpty').hidden = !!has;
  $('#chatActive').hidden = !has;
  if (has) { renderHeader(); renderMessages(); }
}

/* ── профиль собеседника / группы ── */
function openChatProfile() {
  const chat = chatById(S.active);
  if (!chat) return;

  const isDm = chat.kind === 'dm';
  const u = isDm
    ? (S.users.find((x) => x.id === chat.userId) || { name: chat.title || '…', hue: chat.hue ?? 0, seen: 'offline' })
    : { name: chat.title || '…', hue: chat.hue ?? 5 };

  $('#profileHero').innerHTML = avatarHtml(u, { lg: true });
  $('#profileName').innerHTML = esc(u.name) + adminBadge(isDm ? u : null);
  $('#profileUsername').textContent = isDm && u.username ? '@' + u.username : '';
  $('#profileStatus').textContent = isDm
    ? (u.seen === 'online' ? t('chat.online') : t('chat.' + u.seen))
    : t('chat.members').replace('{n}', String((chat.members?.length || 0) + 1));

  $('#profileCall').hidden = !isDm;
  $('#profileVideo').hidden = !isDm;
  const manage = $('#profileManage');
  if (manage) {
    manage.hidden = isDm;
    manage.onclick = () => {
      $('#profileOv').hidden = true;
      openGroupManager(chat);
    };
  }
  $('#profileOv').hidden = false;
}

/* ── шапка чата ────────────────────────────────────────────── */
function renderHeader() {
  const chat = chatById(S.active);
  const isDm = chat.kind === 'dm';
  const callBtn = $('#callBtn');
  const videoBtn = $('#videoCallBtn');
  if (callBtn) callBtn.hidden = !isDm;
  if (videoBtn) videoBtn.hidden = !isDm;
  const u = isDm
    ? (S.users.find((x) => x.id === chat.userId) || { name: chat.title || '…', hue: chat.hue ?? 0, seen: 'offline' })
    : null;
  $('#chatWhoAvatar').innerHTML = avatarHtml(u || { name: chat.title, hue: chat.hue ?? 5 }, { online: u?.seen === 'online' });
  $('#chatWhoName').innerHTML = esc(chatTitle(chat)) + adminBadge(isDm ? u : null);
  const st = $('#chatWhoStatus');
  st.classList.remove('online');
  if (isDm) {
    const uname = u.username ? '@' + u.username : '';
    if (u.seen === 'online') {
      st.textContent = uname ? `${uname} · ${t('chat.online')}` : t('chat.online');
      st.classList.add('online');
    } else {
      st.textContent = uname || t('chat.' + u.seen);
    }
  } else {
    st.textContent = t('chat.members').replace('{n}', String((chat.members?.length || 0) + 1));
  }
}

/* ── лента ─────────────────────────────────────────────────── */
export function renderMessages(opts = {}) {
  const chat = chatById(S.active);
  if (!chat) return;
  const raw = S.messages[S.active] || [];
  const all = raw.filter((m) => !m.hidden);
  const rxMap = tallyReactions(raw);

  const q = searchQuery.toLowerCase();
  searchHits = q
    ? all.filter((m) => String(m.poll?.q || m.text || '').toLowerCase().includes(q)).map((m) => m.id)
    : [];
  if (searchIndex >= searchHits.length) searchIndex = Math.max(0, searchHits.length - 1);

  const limit = S.renderLimit?.[S.active] || PAGE_SIZE;
  const visible = q || all.length <= limit ? all : all.slice(-limit);
  const hiddenCount = all.length - visible.length;

  const countEl = $('#chatSearchCount');
  if (countEl) {
    countEl.textContent = q
      ? (searchHits.length ? `${searchIndex + 1}/${searchHits.length}` : '0')
      : '';
  }

  if (!all.length) {
    els.msgs.innerHTML = `<div class="chat-welcome">
      <span class="w-ic">${icon('lock', 26)}</span>
      <b>${t('chat.welcomeTitle')}</b>
      <span>${t('chat.welcomeSub')}</span>
    </div>`;
    if (els.toBottom) els.toBottom.hidden = true;
    return;
  }

  if (q && !searchHits.length) {
    els.msgs.innerHTML = `<div class="chat-welcome"><span class="w-ic">${icon('search', 24)}</span><b>${t('chat.searchEmpty')}</b></div>`;
    if (els.toBottom) els.toBottom.hidden = true;
    return;
  }

  const beforeH = els.msgs.scrollHeight;
  const beforeT = els.msgs.scrollTop;
  const stick = isNearBottom();

  let html = '';
  if (hiddenCount > 0) {
    html += `<button type="button" class="load-earlier" data-load-earlier>
      ${icon('chevronUp', 15)} <span>${t('chat.loadEarlier')}</span><b>${hiddenCount}</b>
    </button>`;
  }

  const unreadFrom = S.unreadFrom?.[S.active] || 0;
  let dividerShown = !unreadFrom;
  let prev = null;
  for (const m of visible) {
    if (rxMap.has(m.id)) m.reactions = rxMap.get(m.id);
    const newDay = !prev || new Date(m.ts).toDateString() !== new Date(prev.ts).toDateString();
    if (newDay) html += `<div class="day"><span>${fmtDay(m.ts)}</span></div>`;
    if (!dividerShown && m.ts > unreadFrom) {
      html += `<div class="day new-divider"><span>${t('chat.newMessages')}</span></div>`;
      dividerShown = true;
    }
    const cont = prev && prev.sender === m.sender && !newDay && (m.ts - prev.ts) < 4 * 60e3;
    const hitIndex = searchHits.indexOf(m.id);
    html += msgHtml(m, !cont, hitIndex);
    prev = m;
  }
  if (S.typingChat === S.active && !q) html += typingHtml();

  els.msgs.innerHTML = html;

  if (opts.prepend) {
    els.msgs.scrollTop = beforeT + (els.msgs.scrollHeight - beforeH);
  } else if (stick || opts.forceBottom) {
    scrollBottom(false);
  }

  /* картинки увеличивают ленту после отрисовки — если были внизу, остаёмся внизу */
  if (stick || opts.forceBottom) {
    els.msgs.querySelectorAll('img').forEach((img) => {
      if (img.complete) return;
      img.addEventListener('load', () => {
        if (S.active && isNearBottom()) {
          const prev = els.msgs.style.scrollBehavior;
          els.msgs.style.scrollBehavior = 'auto';
          els.msgs.scrollTop = els.msgs.scrollHeight;
          els.msgs.style.scrollBehavior = prev;
        }
      }, { once: true });
    });
  }

  renderPin();
  updateToBottom();
}

/* ── поиск ─────────────────────────────────────────────────── */
function toggleSearch(show) {
  const bar = $('#chatSearch');
  bar.hidden = !show;
  if (show) {
    setTimeout(() => { $('#chatSearchInput').focus(); $('#chatSearchInput').select(); }, 40);
  } else {
    searchQuery = '';
    searchHits = [];
    searchIndex = 0;
    $('#chatSearchInput').value = '';
    renderMessages();
  }
}

function jumpToHit(delta) {
  if (!searchHits.length) return;
  searchIndex = (searchIndex + delta + searchHits.length) % searchHits.length;
  renderMessages();
  jumpTo(searchHits[searchIndex]);
}

/* Открываем чат на первом непрочитанном, иначе — внизу */
function scrollToStartPosition(id) {
  const apply = () => {
    if (S.active !== id) return;
    const divider = els.msgs.querySelector('.new-divider');
    const top = divider
      ? Math.max(0, divider.offsetTop - els.msgs.clientHeight * 0.3)
      : els.msgs.scrollHeight;
    const prev = els.msgs.style.scrollBehavior;
    els.msgs.style.scrollBehavior = 'auto';
    els.msgs.scrollTop = top;
    els.msgs.style.scrollBehavior = prev;
    updateToBottom();
  };
  requestAnimationFrame(() => {
    apply();
    requestAnimationFrame(apply);
  });

  /* фото догружаются после первого кадра — удерживаем низ, если мы уже внизу */
  els.msgs.querySelectorAll('img').forEach((img) => {
    if (img.complete) return;
    img.addEventListener('load', () => {
      if (S.active !== id) return;
      const gap = els.msgs.scrollHeight - els.msgs.scrollTop - els.msgs.clientHeight;
      if (!els.msgs.querySelector('.new-divider') && gap < 700) apply();
    }, { once: true });
  });
}

/* ── закреплённое сообщение ────────────────────────────────── */
function renderPin() {
  const chat = chatById(S.active);
  const bar = $('#pinBar');
  if (!bar) return;
  if (!chat || !chat.pin) { bar.hidden = true; return; }
  bar.hidden = false;
  bar.dataset.mid = chat.pin.id;
  $('#pinText').textContent = chat.pin.text || '';
}

function unpin() {
  const chat = chatById(S.active);
  if (!chat) return;
  delete chat.pin;
  idb.put('chats', chat);
  idb.del('settings', 'pin:' + chat.id);
  renderPin();
}

/* ── пересылка ─────────────────────────────────────────────── */
function openForward(m) {
  forwardMsg = m;
  const list = $('#fwdList');
  const chats = S.chats.filter((c) => c.id !== S.active);
  list.innerHTML = chats.map((c) => {
    const u = c.kind === 'dm'
      ? (S.users.find((x) => x.id === c.userId) || { name: c.title || '…', hue: c.hue ?? 0 })
      : { name: c.title, hue: c.hue ?? 5 };
    return `<button class="contact" data-fwd-cid="${esc(c.id)}">
      ${avatarHtml(u)}
      <span class="info"><span class="n">${esc(chatTitle(c))}</span></span>
    </button>`;
  }).join('') || `<div class="nc-hint">${t('newchat.empty')}</div>`;
  $('#fwdOv').hidden = false;
}

async function forwardTo(chatId2) {
  const m = forwardMsg;
  const chat = chatById(chatId2);
  $('#fwdOv').hidden = true;
  forwardMsg = null;
  if (!m || !chat) return;

  const fwd = forwardPayload(m);
  if (!fwd) { toast(t('msg.forwardUnsupported'), { type: 'error' }); return; }

  const msg = {
    id: newId(), chatId: chatId2, sender: 'u_me', ts: Date.now(),
    type: fwd.type, text: fwd.text || '', reactions: [], status: 'sending', forwarded: true,
    wire: fwd.wire,
    ...(fwd.file ? { file: fwd.file } : {}),
    ...(fwd.voice ? { voice: fwd.voice } : {}),
  };

  await deliverMessage(chatId2, msg);

  if (!(SUPABASE.url && SUPABASE.anonKey)) {
    msg.status = 'sent';
    await idb.put('messages', msg);
    toast(t('chat.forwarded'), { type: 'success' });
    return;
  }

  try {
    await sendMessage(chatId2, fwd.wire, null, chat.kind, chat.publicKey, msg.id);
    msg.status = 'sent';
    await idb.put('messages', msg);
    if (S.active === chatId2) renderMessages();
    toast(t('chat.forwarded'), { type: 'success' });
  } catch (err) {
    console.error('Forward error:', err);
    msg.status = 'error';
    msg.error = String(err?.message || '');
    await idb.put('messages', msg);
    if (S.active === chatId2) renderMessages();
    toast(err.message || t('toast.error'), { type: 'error' });
  }
}

/* Пересылка любого поддерживаемого типа: текст, фото, файл, голосовое */
function forwardPayload(m) {
  if (m.type === 'text') return { type: 'text', text: m.text || '', wire: m.text || '' };
  if (m.type === 'image' || m.type === 'file') {
    const src = safeMediaSrc(m.file?.src, m.type === 'image' ? 'image' : 'file');
    if (!src) return null;
    const file = { name: m.file?.name || 'file', size: m.file?.size || 0, src };
    return { type: m.type, text: m.text || '', file, wire: encodeMedia({ kind: m.type, ...file }) };
  }
  if (m.type === 'voice') {
    const src = safeMediaSrc(m.voice?.src, 'audio');
    if (!src) return null;
    const voice = { dur: m.voice.dur, bars: m.voice.bars || [], src, rate: m.voice.rate || 1 };
    return {
      type: 'voice', text: '', voice,
      wire: encodeMedia({
        kind: 'voice', name: 'voice', size: 0, src,
        voice: { dur: voice.dur, bars: voice.bars, rate: voice.rate },
      }),
    };
  }
  return null;
}


function scrollBottom(smooth = true) {
  if (prefs.motion === false) smooth = false;
  if (els.toBottom) els.toBottom.hidden = true;
  unseenCount = 0;
  autoScrolling = true;
  const top = els.msgs.scrollHeight;
  if (smooth) {
    els.msgs.scrollTo({ top, behavior: 'smooth' });
  } else {
    /* мгновенный прыжок: CSS scroll-behavior:smooth иначе анимирует и открытие чата */
    const prev = els.msgs.style.scrollBehavior;
    els.msgs.style.scrollBehavior = 'auto';
    els.msgs.scrollTop = top;
    els.msgs.style.scrollBehavior = prev;
  }
  clearTimeout(scrollBottom._t);
  scrollBottom._t = setTimeout(() => {
    /* страховка: если браузер не анимировал плавный скролл — прыгаем вниз */
    if (!isNearBottom()) els.msgs.scrollTop = els.msgs.scrollHeight;
    autoScrolling = false;
    updateToBottom();
  }, smooth ? 420 : 0);
}

function isNearBottom() {
  return els.msgs.scrollHeight - els.msgs.scrollTop - els.msgs.clientHeight < 160;
}

function updateToBottom() {
  if (!els.toBottom || autoScrolling) return;
  const near = isNearBottom();
  const show = !!(S.active && (!near || unseenCount > 0));
  els.toBottom.hidden = !show;
  if (!show) unseenCount = 0;
  els.toBottom.innerHTML = icon('arrowDown', 18) +
    (unseenCount ? `<span class="tb-count">${unseenCount > 9 ? '9+' : unseenCount}</span>` : '');
  if (near && S.active && document.visibilityState !== 'hidden') sendReadUpto(S.active);
}

/* ── разметка сообщения ────────────────────────────────────── */
function msgHtml(m, first, hitIndex = -1) {
  const mine = m.sender === 'u_me';
  const u = mine ? S.me : user(m.sender);
  const searchCls = hitIndex >= 0 ? ` search-hit${hitIndex === searchIndex ? ' search-current' : ''}` : '';
  const cls = `msg${first ? ' first' : ' cont'}${mine ? ' mine' : ''}${toolsOpen === m.id ? ' tools-open' : ''}${searchCls}`;
  const av = mine ? '' : avatarHtml(u);
  const body = bubbleHtml(m, mine);
  const tools = m.deleted ? '' : toolsHtml(m, mine);
  const pick = S.reactOpen === m.id ? rxPickHtml() : '';
  return `<div class="${cls}" data-mid="${esc(m.id)}" data-hit-index="${hitIndex}">${av}
    <div class="bubble">${body}${tools}${pick}</div>
  </div>`;
}

function bubbleHtml(m, mine) {
  if (m.deleted) return `<div class="msg-deleted">${t('msg.deleted')}</div>`;
  let out = '';
  if (m.forwarded) out += `<div class="fwd-label">${icon('forward', 12)} ${t('msg.forwarded')}</div>`;
  if (m.replyTo) out += `<button class="reply-quote" data-jump="${esc(m.replyTo.id)}">
      <span class="rq-name">${esc(m.replyTo.name)}</span>
      <span class="rq-text">${esc(m.replyTo.snippet)}</span>
    </button>`;
  if (m.type === 'poll') out += pollHtml(m);
  if (m.type === 'image') {
    const src = safeMediaSrc(m.file?.src, 'image');
    out += src
      ? `<button class="msg-img"><img src="${esc(src)}" loading="lazy" alt="${esc(m.file?.name || t('msg.photo'))}"></button>`
      : `<div class="msg-broken">${icon('image', 18)} ${t('media.broken')}</div>`;
  }
  if (m.type === 'file') {
    out += `<div class="file-row${m.file?.src ? '' : ' no-src'}"><span class="file-ic">${icon('file', 20)}</span>
      <span class="file-info"><span class="file-name">${esc(m.file?.name || t('msg.file'))}</span>
      <span class="file-size">${fmtSize(m.file?.size)}</span></span>
      ${m.file?.src ? `<span class="file-dl">${icon('dl', 17)}</span>` : ''}</div>`;
  }
  if (m.type === 'voice') {
    out += `<div class="voice">
      <button class="v-play">${icon('play', 17)}</button>
      <span class="v-bars">${(m.voice?.bars || []).map((h) => `<i style="height:${Math.round(h * 100)}%"></i>`).join('')}</span>
      <span class="v-dur">${fmtDur(m.voice?.dur || 0)}</span>
      <button class="v-speed" data-speed="${m.voice?.rate || 1}" title="${t('msg.voiceSpeed')}">${m.voice?.rate || 1}×</button>
    </div>`;
  }
  if (m.text && (m.type === 'text' || m.type === 'image' || m.type === 'file')) {
    const emoji = m.type === 'text' && isEmojiOnly(m.text);
    out += `<div class="msg-text${emoji ? ' emoji-only' : ''}">${formatText(m.text)}</div>`;
  }
  out += reactionsHtml(m);
  out += metaHtml(m, mine);
  return out;
}

function reactionsHtml(m) {
  if (!m.reactions?.length) return '';
  return `<div class="rx-row">${m.reactions.map((r) =>
    `<button class="rx${r.by.includes('u_me') ? ' mine' : ''}" data-rx="${esc(r.e)}">${esc(r.e)}${r.by.length > 1 ? `<b>${r.by.length}</b>` : ''}</button>`).join('')}</div>`;
}

function pollHtml(m) {
  const opts = Array.isArray(m.poll?.o) ? m.poll.o : [];
  const { counts, voters, mine, closed, votersByOption } = tallyPoll(m);
  const rows = opts.map((label, i) => {
    const pct = voters ? Math.round((counts[i] / voters) * 100) : 0;
    const on = mine.includes(i);
    const names = m.poll?.anon
      ? ''
      : (votersByOption[i] || [])
        .map((uid) => user(uid).name)
        .slice(0, 3)
        .join(', ') + ((votersByOption[i] || []).length > 3 ? ' +' + ((votersByOption[i] || []).length - 3) : '');
    return `<button type="button" class="poll-opt${on ? ' on' : ''}${closed ? ' closed' : ''}" data-poll-opt="${i}"${closed ? ' disabled' : ''}>
      <span class="poll-fill" style="width:${pct}%"></span>
      <span class="poll-mark">${on ? icon('check', 12) : ''}</span>
      <span class="poll-text">
        <span class="poll-label">${esc(label)}</span>
        ${names ? `<span class="poll-who">${esc(names)}</span>` : ''}
      </span>
      <span class="poll-count">${counts[i]}</span>
    </button>`;
  }).join('');

  const hint = closed
    ? t('poll.closed')
    : (mine.length ? t('poll.yourVote') : (m.poll?.multi ? t('poll.hintMulti') : t('poll.hint')));
  const canClose = !closed && (m.sender === 'u_me' || S.me?.role === 'admin');

  return `<div class="poll${closed ? ' poll-ended' : ''}">
    <div class="poll-head">${icon('poll', 16)}<span>${esc(m.poll?.q || m.text || '')}</span></div>
    <div class="poll-opts">${rows}</div>
    <div class="poll-meta"><span>${t('poll.votes')}: ${voters}</span><span>${hint}</span></div>
    ${canClose ? `<button type="button" class="poll-close" data-poll-close="${esc(m.id)}">${t('poll.close')}</button>` : ''}
  </div>`;
}

/* Реакции: последнее событие пользователя по каждому эмодзи */
function tallyReactions(raw) {
  const latest = new Map();

  for (const x of raw) {
    if (x.type !== 'rx' || !x.reaction) continue;
    const r = x.reaction;
    const key = `${x.sender}|${r.m}|${r.e}`;
    const prev = latest.get(key);
    if (!prev || (x.ts || 0) >= (prev.ts || 0)) latest.set(key, x);
  }

  const touched = new Set();
  const byMessage = new Map();

  for (const x of latest.values()) {
    const id = x.reaction.m;
    touched.add(id);
    if (!x.reaction.on) continue;
    if (!byMessage.has(id)) byMessage.set(id, new Map());
    const emojiMap = byMessage.get(id);
    if (!emojiMap.has(x.reaction.e)) emojiMap.set(x.reaction.e, []);
    emojiMap.get(x.reaction.e).push(x.sender);
  }

  const out = new Map();
  for (const id of touched) {
    const emojiMap = byMessage.get(id);
    out.set(id, emojiMap
      ? [...emojiMap.entries()].map(([e, by]) => ({ e, by }))
      : []);
  }
  return out;
}

/* Обновляем только реакции сообщения */
export function refreshMessageReactions(messageId) {
  if (S.active == null) return;
  const m = byId(messageId);
  if (!m) return;

  const map = tallyReactions(S.messages[S.active] || []);
  if (map.has(m.id)) m.reactions = map.get(m.id);

  const id = nonzeroEscape(messageId);
  const bubble = els.msgs.querySelector(`[data-mid="${id}"] .bubble`);
  if (!bubble) return;

  const html = reactionsHtml(m);
  const row = bubble.querySelector('.rx-row');
  if (html) {
    if (row) row.outerHTML = html;
    else {
      const meta = bubble.querySelector('.msg-meta');
      if (meta) meta.insertAdjacentHTML('beforebegin', html);
      else bubble.insertAdjacentHTML('beforeend', html);
    }
  } else if (row) {
    row.remove();
  }
}

/* Обновляем только карточку опроса — без перерисовки всей ленты */
export function refreshPollCard(pollId) {
  if (S.active == null) return;
  const m = byId(pollId);
  if (!m || m.type !== 'poll') return;

  const id = nonzeroEscape(pollId);
  const el = els.msgs.querySelector(`[data-mid="${id}"] .poll`);
  if (!el) return;

  const box = document.createElement('div');
  box.innerHTML = pollHtml(m);
  const next = box.firstElementChild;
  if (next) el.replaceWith(next);
}

/* Последний голос каждого участника; для мультивыбора — весь набор */
function tallyPoll(pollMsg) {
  const all = S.messages[S.active] || [];
  const latest = new Map();
  let closed = false;

  for (const m of all) {
    if (m.type === 'pollclose' && m.close?.p === pollMsg.id) closed = true;
    if (m.type !== 'vote' || !m.vote || m.vote.p !== pollMsg.id) continue;
    const prev = latest.get(m.sender);
    if (!prev || (m.ts || 0) >= (prev.ts || 0)) latest.set(m.sender, m);
  }

  const total = Array.isArray(pollMsg.poll?.o) ? pollMsg.poll.o.length : 0;
  const counts = Array(total).fill(0);
  const votersByOption = Array.from({ length: total }, () => []);
  let voters = 0;
  let mine = [];

  for (const [uid, m] of latest) {
    const v = (m.vote.v || []).filter((i) => Number.isInteger(i) && i >= 0 && i < total);
    if (!v.length) continue;
    voters++;
    for (const i of v) {
      counts[i]++;
      votersByOption[i].push(uid);
    }
    if (uid === 'u_me' || uid === S.me?.id) mine = v;
  }

  return { counts, voters, mine, closed, votersByOption };
}

function votePollOption(m, index) {
  const { mine, closed } = tallyPoll(m);
  if (closed) return;
  let next;

  if (m.poll?.multi) {
    next = mine.includes(index)
      ? mine.filter((i) => i !== index)
      : [...mine, index].sort((a, b) => a - b);
  } else {
    if (mine.length === 1 && mine[0] === index) {
      toast(t('poll.alreadyVoted'));
      return;
    }
    next = [index];
  }

  votePoll(m, next);
}

function ticksHtml(m, mine) {
  if (!mine || m.deleted) return '';
  if (m.status === 'error') {
    return `<button class="ticks err" data-act="retry" title="${t('comp.sendOffline')}">${icon('alert', 13)}</button>`;
  }
  if (m.status === 'sending') {
    return `<span class="ticks sending" title="${t('comp.sending')}">${icon('clock', 13)}</span>`;
  }
  if (m.status === 'read') {
    return `<span class="ticks read" title="${t('msg.read')}">${icon('check2', 13)}</span>`;
  }
  return `<span class="ticks" title="${t('msg.delivered')}">${icon('check', 13)}</span>`;
}

function metaHtml(m, mine) {
  const edited = m.edited ? `<span class="msg-edited">${t('msg.edited')}</span>` : '';
  return `<div class="msg-meta"><span>${fmtTime(m.ts)}</span>${edited}${ticksHtml(m, mine)}</div>`;
}

function toolsHtml(m, mine) {
  const isText = m.type === 'text';
  const canForward = ['text', 'image', 'file', 'voice'].includes(m.type);
  const canDelete = mine || S.me?.role === 'admin';
  const tools = [
    `<button data-act="reply" title="${t('msg.reply')}">${icon('reply', 15)}</button>`,
    `<button data-act="react" title="${t('msg.react')}">${icon('smile', 15)}</button>`,
    canForward ? `<button data-act="forward" title="${t('msg.forward')}">${icon('forward', 15)}</button>` : '',
    `<button data-act="pin" title="${t('msg.pin')}">${icon('pin', 15)}</button>`,
    isText ? `<button data-act="copy" title="${t('msg.copy')}">${icon('copy', 15)}</button>` : '',
    mine && m.status === 'read' ? `<button data-act="readby" title="${t('msg.readBy')}">${icon('users', 15)}</button>` : '',
    mine && isText ? `<button data-act="edit" title="${t('msg.edit')}">${icon('pencil', 15)}</button>` : '',
    canDelete ? `<button data-act="del" title="${t('msg.remove')}">${icon('trash', 15)}</button>` : '',
  ].join('');
  return `<div class="tools">${tools}</div>`;
}

function rxPickHtml() {
  return `<div class="rx-pick">${EMOJI_QUICK.map((e) => `<button data-pick="${e}">${e}</button>`).join('')}</div>`;
}

/* ── реакции ───────────────────────────────────────────────── */
function toggleReaction(m, emoji) {
  const mine = (m.reactions || []).some((r) => r.e === emoji && r.by.includes('u_me'));
  S.reactOpen = null;
  sendReaction(m, emoji, !mine);
}

/* ── голосовые: реальное аудио или демо-анимация ───────────── */
const audioEls = new Map();

function playVoice(m, btn) {
  const voiceEl = btn.closest('.voice');
  const bars = voiceEl ? voiceEl.querySelectorAll('.v-bars i') : [];

  const src = safeMediaSrc(m.voice?.src, 'audio');
  if (src) {
    let audio = audioEls.get(m.id);
    if (!audio) {
      audio = new Audio(src);
      audio.playbackRate = m.voice.rate || 1;
      audioEls.set(m.id, audio);
      audio.addEventListener('ended', () => {
        btn.innerHTML = icon('play', 17);
        bars.forEach((b) => b.classList.remove('on'));
      });
      audio.addEventListener('timeupdate', () => {
        const p = audio.duration ? audio.currentTime / audio.duration : 0;
        const upto = Math.round(p * bars.length);
        bars.forEach((b, i) => b.classList.toggle('on', i < upto));
      });
    }
    if (audio.paused) {
      audioEls.forEach((a, id) => { if (id !== m.id) a.pause(); });
      audio.play().catch(() => {});
      btn.innerHTML = icon('pause', 17);
    } else {
      audio.pause();
      btn.innerHTML = icon('play', 17);
    }
    return;
  }

  /* демо-анимация для старых сообщений без src */
  const st = playing.get(m.id);
  if (st) {
    clearInterval(st.timer);
    playing.delete(m.id);
    btn.innerHTML = icon('play', 17);
    bars.forEach((i) => i.classList.remove('on'));
    return;
  }
  const total = bars.length;
  const step = Math.max(60, ((m.voice?.dur || 3) * 1000) / total);
  const state = { i: 0, timer: 0, bars };
  state.timer = setInterval(() => {
    bars.forEach((b) => b.classList.remove('on'));
    for (let k = 0; k <= state.i && k < total; k++) bars[k].classList.add('on');
    state.i++;
    if (state.i >= total) {
      clearInterval(state.timer);
      playing.delete(m.id);
      btn.innerHTML = icon('play', 17);
      bars.forEach((b) => b.classList.remove('on'));
    }
  }, step);
  playing.set(m.id, state);
  btn.innerHTML = icon('pause', 17);
}

/* ── скорость голосового ─────────────────────────────────── */
function cycleSpeed(m, btn) {
  const rates = [1, 1.5, 2];
  const cur = m.voice.rate || 1;
  const next = rates[(rates.indexOf(cur) + 1) % rates.length];
  m.voice.rate = next;
  btn.textContent = next + '×';
  btn.dataset.speed = String(next);
  const audio = audioEls.get(m.id);
  if (audio) audio.playbackRate = next;
}

/* ── переход к цитате ──────────────────────────────────────── */
function jumpTo(id) {
  let el = els.msgs.querySelector(`[data-mid="${nonzeroEscape(id)}"]`);
  if (!el) {
    /* сообщение за пределами первой страницы — догружаем ленту до него */
    const all = (S.messages[S.active] || []).filter((m) => !m.hidden);
    const idx = all.findIndex((m) => m.id === id);
    if (idx < 0) return;
    const need = all.length - idx + 20;
    const cur = S.renderLimit?.[S.active] || PAGE_SIZE;
    if (need > cur) {
      S.renderLimit = { ...(S.renderLimit || {}), [S.active]: need };
      renderMessages({ prepend: true });
      el = els.msgs.querySelector(`[data-mid="${nonzeroEscape(id)}"]`);
    }
  }
  if (!el) return;
  el.scrollIntoView({ block: 'center', behavior: prefs.motion === false ? 'auto' : 'smooth' });
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1100);
}

function nonzeroEscape(id) {
  return (window.CSS && CSS.escape) ? CSS.escape(String(id)) : String(id).replace(/"/g, '\\"');
}

/* ── typing ────────────────────────────────────────────────── */
function typingHtml() {
  const chat = chatById(S.active);
  const uid = S.typingUser || (chat?.kind === 'group'
    ? (chat.members || []).find((x) => x !== S.me?.id) || chat.members?.[0]
    : chat?.userId);
  const u = uid ? user(uid) : { name: '…', hue: 5 };
  const who = chat?.kind === 'group' && uid ? `<span class="typing-who">${esc(u.name)}</span>` : '';
  return `<div class="msg first typing">${avatarHtml(u)}<div class="bubble">${who}<div class="dots"><i></i><i></i><i></i></div></div></div>`;
}

export function showTyping(chatId) {
  S.typingChat = chatId;
  if (S.active === chatId) renderMessages();
}
export function hideTyping(chatId) {
  if (S.typingChat !== chatId) return;
  S.typingChat = null;
  S.typingUser = null;
  if (S.active === chatId) renderMessages();
}

/* ── доставка сообщения (совместно с composer и демо-сценарием) ─ */
export async function deliverMessage(chatId, msg) {
  const chat = chatById(chatId);
  if (!chat) return;
  S.messages[chatId] = S.messages[chatId] || [];
  S.messages[chatId].push(msg);
  await idb.put('messages', msg);
  chat.last = { ts: msg.ts, from: msg.sender, type: msg.type, text: msg.text || '' };
  if (S.active !== chatId) chat.unread = (chat.unread || 0) + 1;
  await idb.put('chats', chat);
  if (msg.sender === 'u_me' && !msg.hidden) scheduleDemoRead(chatId, msg);
  if (S.active === chatId) {
    const near = isNearBottom();
    if (!near && msg.sender !== 'u_me') unseenCount++;
    renderMessages();
    if (near) scrollBottom();
    else updateToBottom();
    if (near) setReadAt(chatId);
  }
  renderSidebar();
  if (msg.sender !== 'u_me' && !isMuted(chatId)) playMessage();
}

/* Перечитать (при смене языка/обновлении) */
export function rerenderAll() {
  if (S.active) { renderHeader(); renderMessages(); }
  renderSidebar();
}
