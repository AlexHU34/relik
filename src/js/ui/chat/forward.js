/* Relik — пересылка сообщений (в т.ч. в несколько чатов).
   Чат-экран передаёт свои deliverMessage/renderMessages через bindForwardHooks,
   чтобы не было циклического импорта. */
import { S, chatById, chatTitle } from '../state.js';
import { esc, avatarHtml, $ } from '../utils.js';
import { t } from '../../i18n/i18n.js';
import { toast } from '../toast.js';
import { idb, newId } from '../../db/idb.js';
import { SUPABASE } from '../../config.js';
import { sendMessage, encodeMedia } from '../../backend/messages.js';
import { safeMediaSrc } from '../richText.js';
import { rememberMediaPreview } from '../../backend/storage.js';
import { notifyPush } from '../../backend/push.js';
import { renderSidebar } from '../sidebar.js';
import { refreshMessageStatus } from './receipts.js';

let hooks = { deliverMessage: async () => {}, renderMessages: () => {} };
export function bindForwardHooks(next = {}) { hooks = { ...hooks, ...next }; }

let forwardMsgs = [];
let forwardTargets = new Set();
export function openForward(m) {
  openForwardMany([m]);
}

export function openForwardMany(msgs) {
  forwardMsgs = (Array.isArray(msgs) ? msgs : [msgs]).filter(Boolean);
  if (!forwardMsgs.length) return;
  forwardTargets = new Set();
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
  paintForwardCount();
  $('#fwdOv').hidden = false;
}

export function paintForwardCount() {
  const n = forwardTargets.size;
  const go = $('#fwdGo');
  const cnt = $('#fwdCount');
  if (go) go.disabled = n === 0;
  if (cnt) cnt.textContent = n ? t('msg.forwardSelected').replace('{n}', String(n)) : t('msg.forwardPick');
}

export async function forwardToMany() {
  const msgs = forwardMsgs.slice();
  const ids = [...forwardTargets];
  if (!msgs.length || !ids.length) return;
  $('#fwdOv').hidden = true;
  forwardMsgs = [];
  forwardTargets = new Set();

  let sent = 0;
  let failed = 0;

  for (const chatId2 of ids) {
    const chat = chatById(chatId2);
    if (!chat) continue;
    let sentToChat = 0;
    for (const m of msgs) {
      const fwd = forwardPayload(m);
      if (!fwd) continue;
      if (fwd.media?.path && fwd.file?.src) rememberMediaPreview(fwd.media.path, fwd.file.src);
      for (const it of fwd.album || []) {
        if (it?.path && it.src) rememberMediaPreview(it.path, it.src);
      }
      const msg = {
        id: newId(), chatId: chatId2, sender: 'u_me', ts: Date.now(),
        type: fwd.type, text: fwd.text || '', reactions: [], status: 'sending', forwarded: true,
        wire: fwd.wire,
        ...(fwd.file ? { file: fwd.file } : {}),
        ...(fwd.voice ? { voice: fwd.voice } : {}),
        ...(fwd.media ? { media: fwd.media } : {}),
        ...(fwd.album ? { album: fwd.album } : {}),
      };
      await hooks.deliverMessage(chatId2, msg);

      if (!(SUPABASE.url && SUPABASE.anonKey)) {
        msg.status = 'sent';
        await idb.put('messages', msg);
        sent += 1;
        sentToChat += 1;
        continue;
      }

      try {
        await sendMessage(chatId2, fwd.wire, null, chat.kind, chat.publicKey, msg.id, chat.userId || null);
        msg.status = 'sent';
        await idb.put('messages', msg);
        refreshMessageStatus(msg);
        sent += 1;
        sentToChat += 1;
      } catch (err) {
        msg.status = 'error';
        msg.error = String(err?.message || '');
        await idb.put('messages', msg);
        refreshMessageStatus(msg);
        failed += 1;
      }
    }
    if (sentToChat) notifyPush(chat);
  }

  renderSidebar();
  if (!sent) toast(t('msg.forwardUnsupported'), { type: 'error' });
  else toast(t('msg.forwardedMany').replace('{n}', String(sent)), { type: 'success' });
  if (failed) toast(t('toast.error'), { type: 'error' });
}

/* Пересылка любого поддерживаемого типа: текст, фото, файл, голосовое */
function forwardPayload(m) {
  if (m.type === 'text') return { type: 'text', text: m.text || '', wire: m.text || '' };

  if (m.type === 'album') {
    const items = (m.album || []).filter((it) => it?.path || it?.src);
    if (!items.length) return null;
    const wireItems = items.map((it) => ({
      path: it.path, k: it.k, iv: it.iv, mime: it.mime, name: it.name, size: it.size,
      ...(it.thumb ? { thumb: it.thumb } : {}),
      ...(it.path ? {} : { src: it.src }),
    }));
    return {
      type: 'album', text: m.text || '',
      album: items.map((it) => ({ ...it })),
      wire: encodeMedia({ kind: 'album', items: wireItems }),
    };
  }

  if (['image', 'file', 'video', 'videoNote'].includes(m.type)) {
    const src = safeMediaSrc(m.file?.src, m.type === 'image' ? 'image' : 'file');
    if (!src && !m.media) return null;
    const file = {
      name: m.file?.name || 'file',
      size: m.file?.size || 0,
      mime: m.file?.mime || '',
      src,
      ...(m.file?.thumb ? { thumb: m.file.thumb } : {}),
    };
    const wireMedia = {
      kind: m.type, name: file.name, size: file.size, mime: file.mime,
      ...(m.media ? { path: m.media.path, k: m.media.k, iv: m.media.iv, ...(file.thumb ? { thumb: file.thumb } : {}) } : { src }),
    };
    return {
      type: m.type, text: m.text || '', file,
      name: file.name, size: file.size, mime: file.mime,
      ...(m.media ? { media: { ...m.media } } : {}),
      wire: encodeMedia(wireMedia),
    };
  }

  if (m.type === 'voice') {
    const src = safeMediaSrc(m.voice?.src, 'audio');
    if (!src && !m.media) return null;
    const voice = { dur: m.voice?.dur, bars: m.voice?.bars || [], src, rate: m.voice?.rate || 1 };
    return {
      type: 'voice', text: '', voice,
      name: 'voice', size: 0, mime: m.media?.mime || '',
      ...(m.media ? { media: { ...m.media } } : {}),
      wire: encodeMedia({
        kind: 'voice', name: 'voice', size: 0, mime: m.media?.mime || m.file?.mime || '',
        ...(m.media ? { path: m.media.path, k: m.media.k, iv: m.media.iv } : { src }),
        voice: { dur: voice.dur, bars: voice.bars, rate: voice.rate },
      }),
    };
  }
  return null;
}
/* Переключить чат-цель в окне пересылки. Возвращает новое состояние. */
export function toggleForwardTarget(chatId) {
  if (!chatId) return false;
  if (forwardTargets.has(chatId)) forwardTargets.delete(chatId);
  else forwardTargets.add(chatId);
  paintForwardCount();
  return forwardTargets.has(chatId);
}
