/* Relik — представление чата: шапка, лента, пузыри, реакции, голос */
import { S, user, chatTitle, chatById } from './state.js';
import { $, esc, fmtTime, fmtDay, fmtDur, avatarHtml, snippet } from './utils.js';
import { icon } from './icons.js';
import { t } from '../i18n/i18n.js';
import { idb, newId } from '../db/idb.js';
import { EMOJI_QUICK, SUPABASE } from '../config.js';
import { openLightbox } from './modals.js';
import { toast } from './toast.js';
import { renderSidebar } from './sidebar.js';
import { refreshBar, resetComposer, loadEdit } from './composer.js';
import { playMessage, playSent } from './sounds.js';
import { initTyping, stopTyping } from '../backend/presence.js';
import { currentDevice } from './device.js';
import { startCall } from './calls.js';
import { loadMessages, subscribeToChat, updateReadReceipt, deleteMessage as deleteMessageBackend } from '../backend/messages.js';

let els = {};
const playing = new Map(); // msgId -> {timer, i, bars}
let searchQuery = '';
let forwardMsg = null;
let currentSubscription = null; // Realtime subscription

/* ── инициализация и делегирование ─────────────────────────── */
export function initChatView() {
  els.msgs = $('#msgs');
  els.msgs.addEventListener('click', onMsgClick);
  $('#backBtn').addEventListener('click', () => {
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
  $('#infoBtn').addEventListener('click', () => toast(t('toast.mockCall')));

  /* поиск по чату */
  $('#chatSearchBtn').innerHTML = icon('search', 18);
  $('#csIc').innerHTML = icon('search', 16);
  $('#chatSearchClose').innerHTML = icon('x', 17);
  $('#chatSearchBtn').addEventListener('click', () => toggleSearch(true));
  $('#chatSearchClose').addEventListener('click', () => toggleSearch(false));
  $('#chatSearchInput').addEventListener('input', (e) => {
    searchQuery = e.target.value.trim();
    renderMessages();
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
      location.hash = '#/app';
      S.active = null;
      $('#appView').classList.remove('pane-chat');
      showChat();
    }
  }, { passive: true });
}

function onMsgClick(e) {
  const actEl = e.target.closest('[data-act]');
  const pickEl = e.target.closest('[data-pick]');
  const rxBt = e.target.closest('[data-rx]');
  const imgEl = e.target.closest('.msg-img');
  const playEl = e.target.closest('.v-play');
  const speedEl = e.target.closest('[data-speed]');
  const quoteEl = e.target.closest('.reply-quote');
  const msgEl = e.target.closest('.msg');
  const m = msgEl && byId(msgEl.dataset.mid);

  if (pickEl && m) { toggleReaction(m, pickEl.dataset.pick); return; }
  if (rxBt && m) { toggleReaction(m, rxBt.dataset.rx); return; }
  if (imgEl && m?.file?.src) { openLightbox(m.file.src); return; }
  if (playEl && m) { playVoice(m, playEl); return; }
  if (speedEl && m) { cycleSpeed(m, speedEl); return; }
  if (quoteEl) { jumpTo(quoteEl.dataset.jump); return; }
  if (actEl && m) {
    const act = actEl.dataset.act;
    if (act === 'reply') { S.editing = null; S.reply = { id: m.id, name: user(m.sender).name, snippet: snippet(m) }; refreshBar(); closeReact(); }
    else if (act === 'react') { S.reactOpen = S.reactOpen === m.id ? null : m.id; renderMessages(); }
    else if (act === 'copy') { navigator.clipboard?.writeText(m.text || '').catch(() => {}); toast(t('msg.copied')); }
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
    else if (act === 'del') {
      if (SUPABASE.url && SUPABASE.anonKey) {
        deleteMessageBackend(m.id).catch((err) => console.error('Delete error:', err));
      }
      m.deleted = true; m.text = ''; idb.put('messages', m).then(() => { renderMessages(); renderSidebar(); }); closeReact();
    }
    return;
  }
  if (S.reactOpen) closeReact();
}

function byId(id) {
  return (S.messages[S.active] || []).find((m) => m.id === id);
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

/* ── открытие чата ─────────────────────────────────────────── */
export async function openChat(id) {
  const chat = chatById(id);
  if (!chat) return;

  // Отписываемся от предыдущего чата
  if (currentSubscription) {
    currentSubscription.unsubscribe();
    currentSubscription = null;
  }

  S.active = id;
  S.reply = null; S.editing = null; S.reactOpen = null;
  refreshBar(); resetComposer();
  $('#chatSearch').hidden = true;
  searchQuery = '';
  $('#chatSearchInput').value = '';

  if (chat.unread) { chat.unread = 0; await idb.put('chats', chat); }

  /* Мгновенно показываем кэш, сеть — фоном */
  S.messages[id] = await idb.messagesOf(id);
  showChat();
  renderSidebar();

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
        S.messages[id] = msgs;
        renderMessages();
        await updateReadReceipt(id).catch(() => {});
        const lastMsg = msgs[msgs.length - 1];
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
    initTyping(id, () => {
      showTyping(id);
      clearTimeout(window.__typingT);
      window.__typingT = setTimeout(() => hideTyping(id), 2600);
    });
    currentSubscription = subscribeToChat(id, {
      onMessage: async (msg) => {
        S.messages[id] = S.messages[id] || [];
        if (S.messages[id].some((x) => x.id === msg.id)) return;
        S.messages[id].push(msg);
        if (S.active === id) {
          renderMessages();
          scrollBottom();
        }
        const c = chatById(id);
        if (c) {
          c.last = { ts: msg.ts, from: msg.sender, type: msg.type, text: msg.text || '' };
          if (S.active !== id) c.unread = (c.unread || 0) + 1;
          await idb.put('chats', c);
          renderSidebar();
        }
      },
      onEdit: (msgId, updates) => {
        const m = (S.messages[id] || []).find((x) => x.id === msgId);
        if (m) {
          Object.assign(m, updates);
          if (S.active === id) renderMessages();
        }
      },
      onDelete: (msgId) => {
        S.messages[id] = (S.messages[id] || []).filter((x) => x.id !== msgId);
        if (S.active === id) renderMessages();
      },
    }, chat.kind, chat.publicKey);
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

/* ── шапка чата ────────────────────────────────────────────── */
function renderHeader() {
  const chat = chatById(S.active);
  const isDm = chat.kind === 'dm';
  const u = isDm
    ? (S.users.find((x) => x.id === chat.userId) || { name: chat.title || '…', hue: chat.hue ?? 0, seen: 'offline' })
    : null;
  $('#chatWhoAvatar').innerHTML = avatarHtml(u || { name: chat.title, hue: chat.hue ?? 5 }, { online: u?.seen === 'online' });
  $('#chatWhoName').textContent = chatTitle(chat);
  const st = $('#chatWhoStatus');
  st.classList.remove('online');
  if (isDm) {
    if (u.seen === 'online') { st.textContent = t('chat.online'); st.classList.add('online'); }
    else st.textContent = t('chat.' + u.seen);
  } else {
    st.textContent = t('chat.members').replace('{n}', String(chat.members.length + 1));
  }
}

/* ── лента ─────────────────────────────────────────────────── */
export function renderMessages() {
  const chat = chatById(S.active);
  if (!chat) return;
  const all = S.messages[S.active] || [];
  const arr = searchQuery
    ? all.filter((m) => String(m.text || '').toLowerCase().includes(searchQuery.toLowerCase()))
    : all;

  const countEl = $('#chatSearchCount');
  if (countEl) countEl.textContent = searchQuery ? String(arr.length) : '';

  if (!arr.length) {
    els.msgs.innerHTML = searchQuery
      ? `<div class="chat-welcome"><span class="w-ic">${icon('search', 24)}</span><b>${t('chat.searchEmpty')}</b></div>`
      : `<div class="chat-welcome">
      <span class="w-ic">${icon('lock', 26)}</span>
      <b>${t('chat.welcomeTitle')}</b>
      <span>${t('chat.welcomeSub')}</span>
    </div>`;
    return;
  }
  let html = '';
  let prev = null;
  for (const m of arr) {
    const newDay = !prev || new Date(m.ts).toDateString() !== new Date(prev.ts).toDateString();
    if (newDay) html += `<div class="day"><span>${fmtDay(m.ts)}</span></div>`;
    const cont = prev && prev.sender === m.sender && !newDay && (m.ts - prev.ts) < 4 * 60e3;
    html += msgHtml(m, !cont);
    prev = m;
  }
  if (S.typingChat === S.active && !searchQuery) html += typingHtml();
  const keep = els.msgs.scrollTop + els.msgs.clientHeight >= els.msgs.scrollHeight - 140;
  els.msgs.innerHTML = html;
  if (keep) scrollBottom(false);
  renderPin();
}

/* ── поиск ─────────────────────────────────────────────────── */
function toggleSearch(show) {
  const bar = $('#chatSearch');
  bar.hidden = !show;
  if (show) { setTimeout(() => $('#chatSearchInput').focus(), 40); }
  else {
    searchQuery = '';
    $('#chatSearchInput').value = '';
    renderMessages();
  }
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
    return `<button class="contact" data-fwd-cid="${c.id}">
      ${avatarHtml(u)}
      <span class="info"><span class="n">${esc(chatTitle(c))}</span></span>
    </button>`;
  }).join('') || `<div class="nc-hint">${t('newchat.empty')}</div>`;
  $('#fwdOv').hidden = false;
}

function forwardTo(chatId2) {
  const m = forwardMsg;
  const chat = chatById(chatId2);
  $('#fwdOv').hidden = true;
  forwardMsg = null;
  if (!m || !chat) return;
  const text = m.text || snippet(m);
  deliverMessage(chatId2, {
    id: newId(), chatId: chatId2, sender: 'u_me', ts: Date.now(),
    type: 'text', text, reactions: [], status: 'sent', forwarded: true,
  }).then(() => toast(t('chat.forwarded')));
}


function scrollBottom(smooth = true) {
  els.msgs.scrollTo({ top: els.msgs.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
}

/* ── разметка сообщения ────────────────────────────────────── */
function msgHtml(m, first) {
  const mine = m.sender === 'u_me';
  const u = mine ? S.me : user(m.sender);
  const cls = `msg${first ? ' first' : ' cont'}${mine ? ' mine' : ''}`;
  const av = mine ? '' : avatarHtml(u);
  const body = bubbleHtml(m, mine);
  const tools = m.deleted ? '' : toolsHtml(m, mine);
  const pick = S.reactOpen === m.id ? rxPickHtml() : '';
  return `<div class="${cls}" data-mid="${m.id}">${av}
    <div class="bubble">${body}${tools}${pick}</div>
  </div>`;
}

function bubbleHtml(m, mine) {
  if (m.deleted) return `<div class="msg-deleted">${t('msg.deleted')}</div>`;
  let out = '';
  if (m.replyTo) out += `<button class="reply-quote" data-jump="${m.replyTo.id}">
      <span class="rq-name">${esc(m.replyTo.name)}</span>
      <span class="rq-text">${esc(m.replyTo.snippet)}</span>
    </button>`;
  if (m.type === 'image') out += `<button class="msg-img"><img src="${m.file.src}" loading="lazy" alt=""></button>`;
  if (m.type === 'file') out += `<div class="file-row"><span class="file-ic">${icon('file', 20)}</span>
      <span class="file-info"><span class="file-name">${esc(m.file.name)}</span>
      <span class="file-size">${fmtSize(m.file.size)}</span></span></div>`;
  if (m.type === 'voice') out += `<div class="voice">
      <button class="v-play">${icon('play', 17)}</button>
      <span class="v-bars">${(m.voice.bars || []).map((h) => `<i style="height:${Math.round(h * 100)}%"></i>`).join('')}</span>
      <span class="v-dur">${fmtDur(m.voice.dur)}</span>
      <button class="v-speed" data-speed="${m.voice.rate || 1}" title="${t('msg.voiceSpeed')}">${m.voice.rate || 1}×</button>
    </div>`;
  if (m.text && (m.type === 'text' || m.type === 'image' || m.type === 'file')) out += `<div class="msg-text">${esc(m.text)}</div>`;
  if (m.reactions?.length) {
    out += `<div class="rx-row">${m.reactions.map((r) =>
      `<button class="rx${r.by.includes('u_me') ? ' mine' : ''}" data-rx="${r.e}">${r.e}${r.by.length > 1 ? `<b>${r.by.length}</b>` : ''}</button>`).join('')}</div>`;
  }
  out += metaHtml(m, mine);
  return out;
}

function metaHtml(m, mine) {
  const edited = m.edited ? `<span class="msg-edited">${t('msg.edited')}</span>` : '';
  const ticks = mine && !m.deleted
    ? (m.status === 'read'
        ? `<span class="ticks read">${icon('check2', 13)}</span>`
        : `<span class="ticks">${icon('check', 13)}</span>`)
    : '';
  return `<div class="msg-meta"><span>${fmtTime(m.ts)}</span>${edited}${ticks}</div>`;
}

function toolsHtml(m, mine) {
  const isText = m.type === 'text';
  const tools = [
    `<button data-act="reply" title="${t('msg.reply')}">${icon('reply', 15)}</button>`,
    `<button data-act="react" title="${t('msg.react')}">${icon('smile', 15)}</button>`,
    `<button data-act="forward" title="${t('msg.forward')}">${icon('forward', 15)}</button>`,
    `<button data-act="pin" title="${t('msg.pin')}">${icon('pin', 15)}</button>`,
    isText ? `<button data-act="copy" title="${t('msg.copy')}">${icon('copy', 15)}</button>` : '',
    mine && isText ? `<button data-act="edit" title="${t('msg.edit')}">${icon('pencil', 15)}</button>` : '',
    mine ? `<button data-act="del" title="${t('msg.remove')}">${icon('trash', 15)}</button>` : '',
  ].join('');
  return `<div class="tools">${tools}</div>`;
}

function rxPickHtml() {
  return `<div class="rx-pick">${EMOJI_QUICK.map((e) => `<button data-pick="${e}">${e}</button>`).join('')}</div>`;
}

const fmtSize = (b) => b >= 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.round(b / 1e3) + ' KB';

/* ── реакции ───────────────────────────────────────────────── */
function toggleReaction(m, emoji) {
  m.reactions = m.reactions || [];
  const r = m.reactions.find((x) => x.e === emoji);
  if (r?.by.includes('u_me')) {
    r.by = r.by.filter((x) => x !== 'u_me');
    if (!r.by.length) m.reactions = m.reactions.filter((x) => x.e !== emoji);
  } else if (r) r.by.push('u_me');
  else m.reactions.push({ e: emoji, by: ['u_me'] });
  S.reactOpen = null;
  idb.put('messages', m).then(renderMessages);
}

/* ── голосовые: реальное аудио или демо-анимация ───────────── */
const audioEls = new Map();

function playVoice(m, btn) {
  const voiceEl = btn.closest('.voice');
  const bars = voiceEl ? voiceEl.querySelectorAll('.v-bars i') : [];

  if (m.voice && m.voice.src) {
    let audio = audioEls.get(m.id);
    if (!audio) {
      audio = new Audio(m.voice.src);
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
  const el = els.msgs.querySelector(`[data-mid="${id}"]`);
  if (!el) return;
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1100);
}

/* ── typing ────────────────────────────────────────────────── */
function typingHtml() {
  return `<div class="msg first typing"><span class="avatar" data-h="1"><b>А</b></span><div class="bubble"><div class="dots"><i></i><i></i><i></i></div></div></div>`;
}

export function showTyping(chatId) {
  S.typingChat = chatId;
  if (S.active === chatId) renderMessages();
}
export function hideTyping(chatId) {
  if (S.typingChat !== chatId) return;
  S.typingChat = null;
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
  if (S.active === chatId) { renderMessages(); scrollBottom(); }
  renderSidebar();
  if (msg.sender !== 'u_me') playMessage();
}

/* «Доставлено → прочитано» имитация для своих сообщений */
export function markRead(chatId, msgId) {
  const m = (S.messages[chatId] || []).find((x) => x.id === msgId);
  if (!m || m.status === 'read') return;
  m.status = 'read';
  idb.put('messages', m).then(renderMessages);
}

/* Перечитать (при смене языка/обновлении) */
export function rerenderAll() {
  if (S.active) { renderHeader(); renderMessages(); }
  renderSidebar();
}
