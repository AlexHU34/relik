/* Relik — мелкие индикаторы экрана чата: закреп, «печатает», скринридер.
   renderMessages приходит из chatView через bindIndicatorHooks. */
import { S, user, chatById } from '../state.js';
import { $, esc, avatarHtml, snippet } from '../utils.js';
import { idb } from '../../db/idb.js';

let hooks = { renderMessages: () => {} };
export function bindIndicatorHooks(next = {}) { hooks = { ...hooks, ...next }; }

/* ── закреплённое сообщение ────────────────────────────────── */
export function renderPin() {
  const chat = chatById(S.active);
  const bar = $('#pinBar');
  if (!bar) return;
  if (!chat || !chat.pin) { bar.hidden = true; return; }
  bar.hidden = false;
  bar.dataset.mid = chat.pin.id;
  $('#pinText').textContent = chat.pin.text || '';
}

export function unpin() {
  const chat = chatById(S.active);
  if (!chat) return;
  delete chat.pin;
  idb.put('chats', chat);
  idb.del('settings', 'pin:' + chat.id);
  renderPin();
}

/* ── typing ────────────────────────────────────────────────── */
export function typingHtml() {
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
  if (S.active === chatId) hooks.renderMessages();
}
export function hideTyping(chatId) {
  if (S.typingChat !== chatId) return;
  S.typingChat = null;
  S.typingUser = null;
  if (S.active === chatId) hooks.renderMessages();
}

/* ── доступность: объявляем новое сообщение скринридеру ───── */
export function announceIncoming(msg) {
  if (!msg || msg.hidden || msg.sender === 'u_me') return;
  if (document.visibilityState === 'hidden') return;
  const el = document.getElementById('srLive');
  if (!el) return;
  const who = user(msg.sender)?.name || '';
  el.textContent = who ? `${who}: ${snippet(msg)}` : snippet(msg);
  clearTimeout(announceIncoming._t);
  announceIncoming._t = setTimeout(() => { el.textContent = ''; }, 2500);
}
