/* Relik — прочтения и галочки.
   Без новых таблиц: прочтение передаётся скрытым сообщением `__relik_read__:{upto}`.
   DOM-функции chatView приходят через bindReadHooks — так нет циклического импорта. */
import { S, user, chatById } from '../state.js';
import { esc } from '../utils.js';
import { icon } from '../icons.js';
import { t } from '../../i18n/i18n.js';
import { idb, newId } from '../../db/idb.js';
import { SUPABASE } from '../../config.js';
import { $ } from '../utils.js';
import { avatarHtml } from '../utils.js';
import { sendMessage, encodeRead } from '../../backend/messages.js';
import { scheduleTtlForChat } from './ttl.js';

let hooks = {
  getEls: () => ({}),
  ticksHtml: () => '',
  metaHtml: () => '',
  showTools: () => {},
  isToolsOpen: () => false,
  escapeId: (id) => String(id),
};

export function bindReadHooks(next = {}) {
  hooks = { ...hooks, ...next };
}

const readMarks = new Map(); // chatId -> { upto, at, timer }
const demoReads = new Set(); // сообщения, для которых демо уже «прочитало»

/* Последний upto по каждому участнику (скрытые read-события). */
export function readUptos(raw) {
  const map = new Map();
  for (const x of raw) {
    if (x.type !== 'read' || !x.read) continue;
    if (x.sender === 'u_me' || x.sender === S.me?.id) continue;
    const upto = Number(x.read.upto) || 0;
    if (upto > (map.get(x.sender) || 0)) map.set(x.sender, upto);
  }
  return map;
}

export function requiredReaders(chat) {
  if (!chat) return [];
  if (chat.kind === 'group') return [...new Set((chat.members || []).filter(Boolean))];
  return chat.userId ? [chat.userId] : [];
}

function refreshTicks(m) {
  if (S.active !== m.chatId) return;
  const el = hooks.getEls().msgs?.querySelector(`[data-mid="${hooks.escapeId(m.id)}"]`);
  if (!el) return;
  const meta = el.querySelector('.msg-meta');
  if (!meta) return;
  const html = hooks.ticksHtml(m, true);
  const old = meta.querySelector('.ticks');
  if (html) {
    if (old) old.outerHTML = html;
    else meta.insertAdjacentHTML('beforeend', html);
  } else if (old) {
    old.remove();
  }
}

/* Пересчитать галочки у своих сообщений по последним read-событиям */
export function applyReadState(chatId) {
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
  if (changed.length) scheduleTtlForChat(chatId);
}

/* Точечно обновить статус отправки (часики → галочки) без перерисовки ленты. */
export function refreshMessageStatus(m) {
  if (!m || S.active !== m.chatId) return;
  const el = hooks.getEls().msgs?.querySelector(`[data-mid="${hooks.escapeId(m.id)}"]`);
  if (!el) return;
  const meta = el.querySelector('.msg-meta');
  if (meta) meta.outerHTML = hooks.metaHtml(m, m.sender === 'u_me');
  if (hooks.isToolsOpen(m.id)) {
    el.querySelectorAll(':scope > .bubble > .tools').forEach((node) => node.remove());
    hooks.showTools(el);
  }
}

/* Кто прочитал конкретное сообщение */
export function readersFor(m) {
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

export function openReadInfo(m) {
  const list = readersFor(m);
  const wrap = $('#readList');
  if (!wrap) return;
  wrap.innerHTML = list.length
    ? list.map((u) => `<div class="member-row">
        ${avatarHtml(u, { sm: true, online: u.seen === 'online' })}
        <span class="info">
          <span class="n">${esc(u.name)}</span>
          <span class="s">${u.username ? '@' + esc(u.username) : t('msg.read')}</span>
        </span>
        <span class="read-mark">${icon('check2', 16)}</span>
      </div>`).join('')
    : `<div class="nc-hint">${t('msg.noReads')}</div>`;
  $('#readOv').hidden = false;
}

/* Сообщить другим, что мы дочитали до upto (не чаще раза в ~1,4 с) */
export function sendReadUpto(chatId) {
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

  sendMessage(chatId, encodeRead(upto), null, chat.kind, chat.publicKey, event.id, chat.userId || null)
    .then(() => { event.status = 'sent'; idb.put('messages', event).catch(() => {}); })
    .catch((err) => {
      console.warn('Read receipt error:', err);
      S.messages[chatId] = (S.messages[chatId] || []).filter((x) => x.id !== event.id);
      idb.del('messages', event.id).catch(() => {});
      readMarks.delete(chatId);
    });
}

/* В демо нет второго устройства — имитируем прочтение, чтобы было видно ✓✓ */
export function scheduleDemoRead(chatId, msg) {
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

/* Для тестов: сбросить внутреннее состояние (не используется в UI). */
export function __resetReadState() {
  readMarks.clear();
  demoReads.clear();
}
