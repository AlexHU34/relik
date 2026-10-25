/* Relik — композер: ввод, ответ/редактирование, эмодзи, медиа, «микрофон» */
import { S, chatById } from './state.js';
import { $, fmtDur } from './utils.js';
import { icon } from './icons.js';
import { t } from '../i18n/i18n.js';
import { idb, newId } from '../db/idb.js';
import { SUPABASE } from '../config.js';
import { deliverMessage, markRead, renderMessages, refreshPollCard, refreshMessageReactions } from './chatView.js';
import { renderSidebar } from './sidebar.js';
import { toast } from './toast.js';
import { playSent } from './sounds.js';
import { sendTypingSignal } from '../backend/presence.js';
import { sendMessage, editMessage, encodePoll, encodeVote, encodeReaction, encodePollClose, encodeMedia } from '../backend/messages.js';
import { readFileAsDataURL } from '../backend/storage.js';
import { prefs } from './prefs.js';
import { currentDevice } from './device.js';
import { EMOJI_GROUPS, getRecentEmoji, pushRecentEmoji } from '../data/emoji.js';

let els = {};
let recTimer = null, recStart = 0;
let mediaRecorder = null, recChunks = [], recStream = null;
let recCanceled = false, recStartTimeout = null, recHeld = false, recGesture = false;
let recChatId = null;
let lastTypingSent = 0;
let draftTimer = null;
let emojiGroup = 'recent';

/* ── инициализация ─────────────────────────────────────────── */
export function initComposer() {
  els = {
    ta: $('#ta'), crow: $('#crow'), send: $('#sendBtn'),
    reb: $('#reb'), rebIc: $('#rebIc'), rebLabel: $('#rebLabel'), rebText: $('#rebText'), rebX: $('#rebX'),
    attachBtn: $('#attachBtn'), attachMenu: $('#attachMenu'),
    emojiBtn: $('#emojiBtn'), emojiPop: $('#emojiPop'),
    recUi: $('#recUi'), recTime: $('#recTime'), recCancel: $('#recCancel'),
    attPhoto: $('#attPhoto'), attFile: $('#attFile'), attPoll: $('#attPoll'),
    pollOv: $('#pollOv'), pollQuestion: $('#pollQuestion'), pollOptions: $('#pollOptions'), pollMulti: $('#pollMulti'), pollAnon: $('#pollAnon'),
  };

  /* статичные иконки */
  els.attachBtn.innerHTML = icon('clip', 19);
  els.attachBtn.title = t('comp.attach');
  els.attachBtn.setAttribute('aria-label', t('comp.attach'));
  els.emojiBtn.innerHTML = icon('smile', 19);
  els.emojiBtn.title = t('comp.emoji');
  els.emojiBtn.setAttribute('aria-label', t('comp.emoji'));
  els.rebX.innerHTML = icon('x', 17);
  els.recCancel.innerHTML = icon('x', 16);
  $('#attPhotoIc').innerHTML = icon('image', 17);
  $('#attFileIc').innerHTML = icon('file', 17);
  $('#attPollIc').innerHTML = icon('poll', 17);
  setSendMode('mic');

  /* палитра эмодзи: категории + недавние */
  renderEmojiPicker();

  /* --- события --- */
  els.ta.addEventListener('input', () => {
    els.ta.style.height = 'auto';
    els.ta.style.height = Math.min(els.ta.scrollHeight, 140) + 'px';
    /* как только есть текст — показываем кнопку отправки (на всех устройствах) */
    syncSendMode();
    if (els.ta.value.trim() && Date.now() - lastTypingSent > 1500) {
      lastTypingSent = Date.now();
      sendTypingSignal();
    }
    scheduleDraft();
  });
  els.ta.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    /* На телефоне/планшете Enter — перенос строки; на компьютере зависит от настройки */
    if (currentDevice() === 'phone' || window.matchMedia?.('(hover: none)').matches) return;
    if (!prefs.enterToSend) return;
    e.preventDefault();
    sendCurrent();
  });
  els.send.addEventListener('click', (e) => {
    if (recGesture) { recGesture = false; return; }
    sendCurrent();
  });
  els.rebX.addEventListener('click', () => clearReplyEdit(true));

  els.attachBtn.addEventListener('click', (e) => { e.stopPropagation(); togglePopup('attach'); });
  els.emojiBtn.addEventListener('click', (e) => { e.stopPropagation(); togglePopup('emoji'); });
  els.emojiPop.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-emoji-group]');
    if (tab) {
      emojiGroup = tab.dataset.emojiGroup;
      renderEmojiPicker();
      return;
    }
    const b = e.target.closest('[data-emoji]');
    if (!b) return;
    const emoji = b.dataset.emoji;
    insertAtCursor(emoji);
    pushRecentEmoji(emoji);
    els.emojiPop.hidden = true;
  });
  els.attPhoto.addEventListener('click', () => { els.attachMenu.hidden = true; pickAndSend('image'); });
  els.attFile.addEventListener('click', () => { els.attachMenu.hidden = true; pickAndSend('file'); });
  els.attPoll.addEventListener('click', () => { els.attachMenu.hidden = true; openPollCreator(); });
  $('#pollAddOpt').addEventListener('click', () => addPollOption());
  $('#pollCreate').addEventListener('click', createPollFromForm);
  els.pollOptions.addEventListener('click', (e) => {
    const rm = e.target.closest('[data-rm-opt]');
    if (!rm) return;
    rm.closest('.poll-opt-edit')?.remove();
    syncPollRemoveButtons();
  });

  document.addEventListener('click', (e) => {
    if (!els.emojiPop.hidden && !e.target.closest('.emoji-wrap')) els.emojiPop.hidden = true;
    if (!els.attachMenu.hidden && !e.target.closest('.attach')) els.attachMenu.hidden = true;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!els.emojiPop.hidden) { els.emojiPop.hidden = true; e.stopPropagation(); }
    if (!els.attachMenu.hidden) { els.attachMenu.hidden = true; e.stopPropagation(); }
  });

  /* микрофон: нажать и держать → реальная запись */
  els.send.addEventListener('pointerdown', (e) => {
    if (!els.send.classList.contains('mic')) return;
    recGesture = true;
    recHeld = true;
    recStart = Date.now();
    recStartTimeout = setTimeout(() => { recStartTimeout = null; startRecording(); }, 250);
  });
  ['pointerup', 'pointercancel'].forEach((ev) =>
    document.addEventListener(ev, (e) => {
      recHeld = false;
      if (recStartTimeout) { clearTimeout(recStartTimeout); recStartTimeout = null; }
      if (mediaRecorder) stopRecording(!!e.target?.closest?.('#recCancel'));
    })
  );
  $('#recCancel').addEventListener('click', (e) => {
    e.stopPropagation();
    stopRecording(true);
  });

  /* вставка изображения из буфера (Ctrl+V) */
  els.ta.addEventListener('paste', (e) => {
    const items = [...(e.clipboardData?.items || [])];
    const img = items.find((it) => String(it.type).startsWith('image/'));
    if (!img) return;
    const file = img.getAsFile();
    if (!file) return;
    e.preventDefault();
    handlePickedFile(file);
  });

  /* перетаскивание файлов в чат */
  const pane = $('#chatPane');
  let dragDepth = 0;
  pane.addEventListener('dragenter', (e) => {
    if (!S.active) return;
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
    e.preventDefault();
    dragDepth++;
    pane.classList.add('drop-active');
  });
  pane.addEventListener('dragover', (e) => {
    if (!S.active) return;
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
    e.preventDefault();
  });
  pane.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) pane.classList.remove('drop-active');
  });
  pane.addEventListener('drop', (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    dragDepth = 0;
    pane.classList.remove('drop-active');
    [...e.dataTransfer.files].slice(0, 5).forEach((f) => handlePickedFile(f));
  });
}

/* ── эмодзи-пикер: категории + недавние ─────────────────── */
function renderEmojiPicker() {
  const recent = getRecentEmoji();
  if (emojiGroup === 'recent' && !recent.length) emojiGroup = EMOJI_GROUPS[0].id;
  const groups = [
    { id: 'recent', icon: '🕘', labelKey: 'emoji.recent', emojis: recent },
    ...EMOJI_GROUPS,
  ];
  const cur = groups.find((g) => g.id === emojiGroup) || groups[1] || groups[0];
  els.emojiPop.innerHTML = `
    <div class="emoji-tabs">${groups.map((g) => `
      <button type="button" class="emoji-tab${g.id === cur.id ? ' on' : ''}" data-emoji-group="${g.id}"
        title="${t(g.labelKey)}" aria-label="${t(g.labelKey)}">${g.icon}</button>`).join('')}
    </div>
    <div class="emoji-group-title">${t(cur.labelKey)}</div>
    <div class="emoji-grid">${cur.emojis.map((e) => `<button type="button" data-emoji="${e}">${e}</button>`).join('')}</div>`;
}

function scheduleDraft() {
  if (S.editing) return;
  clearTimeout(draftTimer);
  draftTimer = setTimeout(async () => {
    const id = S.active;
    if (!id) return;
    const v = els.ta.value;
    try {
      if (v.trim()) await idb.put('settings', { key: 'draft:' + id, value: v });
      else await idb.del('settings', 'draft:' + id);
    } catch (e) { /* ignore */ }
  }, 500);
}

function togglePopup(which) {
  const el = which === 'attach' ? els.attachMenu : els.emojiPop;
  const other = which === 'attach' ? els.emojiPop : els.attachMenu;
  other.hidden = true;
  el.hidden = !el.hidden;
}

function insertAtCursor(txt) {
  const ta = els.ta;
  const s = ta.selectionStart ?? ta.value.length;
  const e = ta.selectionEnd ?? ta.value.length;
  ta.value = ta.value.slice(0, s) + txt + ta.value.slice(e);
  ta.selectionStart = ta.selectionEnd = s + txt.length;
  ta.focus();
  ta.dispatchEvent(new Event('input'));
}

/* ── плашка ответа / редактирования ────────────────────────── */
export function refreshBar() {
  const r = S.editing ? 'edit' : S.reply ? 'reply' : null;
  els.reb.classList.toggle('on', !!r);
  if (!r) { els.rebText.textContent = ''; return; }
  els.rebIc.innerHTML = r === 'edit' ? icon('pencil', 16) : icon('reply', 16);
  els.rebLabel.textContent = r === 'edit' ? t('comp.editLabel') : t('comp.replyLabel');
  els.rebText.textContent = r === 'edit'
    ? (S.messages[S.active] || []).find((m) => m.id === S.editing)?.text || ''
    : S.reply.snippet;
}

function clearReplyEdit(keepText = false) {
  S.reply = null; S.editing = null;
  refreshBar();
  if (!keepText) {
    els.ta.value = '';
    els.ta.style.height = 'auto';
    setSendMode('mic');
  } else {
    syncSendMode();
  }
}

export function resetComposer() {
  els.ta.value = ''; els.ta.style.height = 'auto';
  setSendMode('mic');
}

export function loadEdit(m) {
  els.ta.value = m.text || '';
  els.ta.dispatchEvent(new Event('input'));
  setSendMode('send');
  refreshBar();
  els.ta.focus();
}

function setSendMode(mode) {
  const mic = mode === 'mic';
  els.send.classList.toggle('mic', mic);
  els.send.innerHTML = icon(mic ? 'mic' : 'send', 18);
  els.send.title = t(mic ? 'comp.voice' : 'comp.send');
  els.send.setAttribute('aria-label', els.send.title);
}

/* Микрофон, пока поле пустое; кнопка отправки — как только появился текст */
function syncSendMode() {
  setSendMode(els.ta.value.trim() || S.editing ? 'send' : 'mic');
}

/* ── отправка ──────────────────────────────────────────────── */
export async function sendCurrent() {
  const chat = chatById(S.active);
  if (!chat) return;
  const text = els.ta.value.trim();
  if (!text) {
    toast(t(S.editing ? 'comp.emptyEdit' : 'comp.empty'));
    return;
  }
  if (S.editing) { await saveEdit(text); return; }

  /* запоминаем ответ до очистки поля */
  const replyId = S.reply?.id || null;
  const replyBox = S.reply ? { ...S.reply } : null;

  idb.del('settings', 'draft:' + chat.id).catch(() => {});

  /* Сообщение появляется в ленте сразу, не дожидаясь ответа сервера */
  const msg = {
    id: newId(), chatId: chat.id, sender: 'u_me', ts: Date.now(),
    type: 'text', text, reactions: [],
    status: SUPABASE.url && SUPABASE.anonKey ? 'sending' : 'sent',
    ...(replyBox ? { replyTo: replyBox } : {}),
  };

  clearReplyEdit();
  await deliverMessage(chat.id, msg);
  playSent();

  if (!(SUPABASE.url && SUPABASE.anonKey)) return;

  try {
    await sendMessage(chat.id, text, replyId, chat.kind, chat.publicKey, msg.id);
    msg.status = 'sent';
    await idb.put('messages', msg);
    if (S.active === chat.id) renderMessages();
    setTimeout(() => markRead(chat.id, msg.id), 1300);
  } catch (err) {
    console.error('Send message error:', err);
    msg.status = 'error';
    msg.error = String(err?.message || '');
    await idb.put('messages', msg);
    if (S.active === chat.id) renderMessages();
    toast(friendlySendError(err));
  }
}

/* ── повторная отправка (клик по ошибке или возврат сети) ── */
export async function retryMessage(m) {
  if (!m || m.status !== 'error') return;
  const chat = chatById(m.chatId || S.active);
  if (!chat) return;

  const wire = m.wire || m.text;
  m.status = 'sending';
  await idb.put('messages', m);
  if (S.active === chat.id) renderMessages();

  try {
    await sendMessage(chat.id, wire, m.replyTo?.id || null, chat.kind, chat.publicKey, m.id);
    m.status = 'sent';
    delete m.error;
    await idb.put('messages', m);
    setTimeout(() => markRead(chat.id, m.id), 1300);
  } catch (err) {
    console.error('Retry message error:', err);
    m.status = 'error';
    m.error = String(err?.message || '');
    await idb.put('messages', m);
    toast(friendlySendError(err));
  }
  if (S.active === chat.id) renderMessages();
}

/* Все недоставленные сообщения — при восстановлении связи */
export function retryFailedMessages() {
  if (!(SUPABASE.url && SUPABASE.anonKey)) return;
  for (const list of Object.values(S.messages)) {
    for (const m of list) {
      if (m.sender === 'u_me' && m.status === 'error') retryMessage(m);
    }
  }
}

/* ── опросы ─────────────────────────────────────────────────── */
function pollOptionRow(value = '') {
  const row = document.createElement('div');
  row.className = 'poll-opt-edit';
  row.innerHTML = `<input class="input" maxlength="80" placeholder="${t('poll.optionPh')}">
    <button class="icon-btn" type="button" data-rm-opt></button>`;
  row.querySelector('input').value = value;
  row.querySelector('[data-rm-opt]').innerHTML = icon('x', 15);
  return row;
}

function syncPollRemoveButtons() {
  const rows = [...els.pollOptions.children];
  rows.forEach((row) => {
    const rm = row.querySelector('[data-rm-opt]');
    if (rm) rm.hidden = rows.length <= 2;
  });
}

function addPollOption(value = '') {
  if (els.pollOptions.children.length >= 6) { toast(t('poll.maxOptions')); return; }
  els.pollOptions.appendChild(pollOptionRow(value));
  syncPollRemoveButtons();
}

function openPollCreator() {
  if (!chatById(S.active)) return;
  els.pollQuestion.value = '';
  els.pollOptions.innerHTML = '';
  els.pollMulti.checked = false;
  els.pollAnon.checked = true;
  addPollOption();
  addPollOption();
  els.pollOv.hidden = false;
  setTimeout(() => els.pollQuestion.focus(), 60);
}

async function createPollFromForm() {
  const q = els.pollQuestion.value.trim();
  if (!q) { toast(t('poll.needQuestion')); return; }

  const o = [...els.pollOptions.querySelectorAll('input')]
    .map((i) => i.value.trim())
    .filter(Boolean);
  if (o.length < 2) { toast(t('poll.needOptions')); return; }

  els.pollOv.hidden = true;
  await sendPoll({ q, o: o.slice(0, 6), multi: !!els.pollMulti.checked, anon: !!els.pollAnon.checked });
}

async function sendPoll(poll) {
  const chat = chatById(S.active);
  if (!chat) return;

  const msg = {
    id: newId(), chatId: chat.id, sender: 'u_me', ts: Date.now(),
    type: 'poll', poll, text: poll.q, reactions: [],
    wire: encodePoll(poll),
    status: SUPABASE.url && SUPABASE.anonKey ? 'sending' : 'sent',
  };

  clearReplyEdit();
  await deliverMessage(chat.id, msg);
  playSent();

  if (!(SUPABASE.url && SUPABASE.anonKey)) return;

  try {
    await sendMessage(chat.id, encodePoll(poll), null, chat.kind, chat.publicKey, msg.id);
    msg.status = 'sent';
    await idb.put('messages', msg);
    if (S.active === chat.id) renderMessages();
  } catch (err) {
    console.error('Create poll error:', err);
    msg.status = 'error';
    await idb.put('messages', msg);
    if (S.active === chat.id) renderMessages();
    toast(friendlySendError(err) || t('poll.createError'));
  }
}

/* Реакция: тоже скрытое сообщение, чтобы синхронизировалась у всех */
export async function sendReaction(message, emoji, on) {
  const chat = chatById(message?.chatId || S.active);
  if (!chat || !message?.id) return;

  const event = {
    id: newId(), chatId: chat.id, sender: 'u_me', ts: Date.now(),
    type: 'rx', hidden: true,
    reaction: { m: message.id, e: emoji, on: !!on },
    text: '', reactions: [],
    status: SUPABASE.url && SUPABASE.anonKey ? 'sending' : 'sent',
  };

  S.messages[chat.id] = S.messages[chat.id] || [];
  S.messages[chat.id].push(event);
  await idb.put('messages', event);
  if (S.active === chat.id) refreshMessageReactions(message.id);

  if (!(SUPABASE.url && SUPABASE.anonKey)) return;

  try {
    await sendMessage(chat.id, encodeReaction(message.id, emoji, on), null, chat.kind, chat.publicKey, event.id);
    event.status = 'sent';
    await idb.put('messages', event);
  } catch (err) {
    console.error('Reaction error:', err);
    S.messages[chat.id] = (S.messages[chat.id] || []).filter((x) => x.id !== event.id);
    await idb.del('messages', event.id);
    if (S.active === chat.id) refreshMessageReactions(message.id);
    toast(t('msg.reactionError'));
  }
}

/* Завершение опроса: скрытое событие, доступно автору */
export async function closePoll(pollMsg) {
  const chat = chatById(pollMsg?.chatId || S.active);
  if (!chat || !pollMsg?.poll) return;

  const event = {
    id: newId(), chatId: chat.id, sender: 'u_me', ts: Date.now(),
    type: 'pollclose', hidden: true, close: { p: pollMsg.id },
    text: '', reactions: [],
    status: SUPABASE.url && SUPABASE.anonKey ? 'sending' : 'sent',
  };

  S.messages[chat.id] = S.messages[chat.id] || [];
  S.messages[chat.id].push(event);
  await idb.put('messages', event);
  if (S.active === chat.id) refreshPollCard(pollMsg.id);

  if (!(SUPABASE.url && SUPABASE.anonKey)) return;

  try {
    await sendMessage(chat.id, encodePollClose(pollMsg.id), null, chat.kind, chat.publicKey, event.id);
    event.status = 'sent';
    await idb.put('messages', event);
  } catch (err) {
    console.error('Close poll error:', err);
    S.messages[chat.id] = (S.messages[chat.id] || []).filter((x) => x.id !== event.id);
    await idb.del('messages', event.id);
    if (S.active === chat.id) refreshPollCard(pollMsg.id);
    toast(t('poll.closeError'));
  }
}

/* Голосование: клик по варианту. Меняем голос повторным кликом. */
export async function votePoll(pollMsg, options) {
  const chat = chatById(pollMsg?.chatId || S.active);
  if (!chat || !pollMsg?.poll) return;

  const picked = (Array.isArray(options) ? options : [options])
    .filter((i) => Number.isInteger(i) && i >= 0 && i < (pollMsg.poll.o || []).length);

  const vote = { p: pollMsg.id, v: picked };
  const msg = {
    id: newId(), chatId: chat.id, sender: 'u_me', ts: Date.now(),
    type: 'vote', hidden: true, vote, text: '', reactions: [],
    status: SUPABASE.url && SUPABASE.anonKey ? 'sending' : 'sent',
  };

  S.messages[chat.id] = S.messages[chat.id] || [];
  S.messages[chat.id].push(msg);
  await idb.put('messages', msg);
  if (S.active === chat.id) refreshPollCard(pollMsg.id);

  if (!(SUPABASE.url && SUPABASE.anonKey)) return;

  try {
    await sendMessage(chat.id, encodeVote(pollMsg.id, picked), null, chat.kind, chat.publicKey, msg.id);
    msg.status = 'sent';
    await idb.put('messages', msg);
  } catch (err) {
    console.error('Vote error:', err);
    S.messages[chat.id] = (S.messages[chat.id] || []).filter((x) => x.id !== msg.id);
    await idb.del('messages', msg.id);
    if (S.active === chat.id) refreshPollCard(pollMsg.id);
    toast(t('poll.voteError'));
  }
}

/* Понятная причина, если отправка не удалась */
function friendlySendError(err) {
  const msg = String(err?.message || '');
  if (/not valid JSON|Unexpected token/i.test(msg)) {
    return t('comp.keyError');
  }
  if (/no key pair|key pair found/i.test(msg)) {
    return t('comp.noKeys');
  }
  if (/failed to fetch|network|load failed|timeout|abort|offline|fetch/i.test(msg)) {
    return t('comp.sendOffline');
  }
  return msg || t('toast.error');
}

async function saveEdit(text) {
  const m = (S.messages[S.active] || []).find((x) => x.id === S.editing);
  const chat = chatById(S.active);
  const wasEditing = S.editing;
  clearReplyEdit();
  if (!m || !wasEditing || !chat) return;

  if (SUPABASE.url && SUPABASE.anonKey) {
    try {
      await editMessage(m.id, text, chat.kind, chat.publicKey);
      m.text = text;
      m.edited = true;
      await idb.put('messages', m);
    } catch (err) {
      console.error('Edit message error:', err);
      toast(err.message || t('toast.error'));
    }
  } else {
    if (text) {
      m.text = text;
      m.edited = true;
      await idb.put('messages', m);
    }
  }

  if (S.active) renderMessages();
  const chat2 = chatById(S.active);
  if (chat2) {
    const last = (S.messages[S.active] || []).filter((x) => !x.hidden).pop();
    if (last && last.id === m.id) {
      chat2.last = { ts: last.ts, from: last.sender, type: last.type, text: last.text || '' };
      await idb.put('chats', chat2);
    }
  }
  renderSidebar();
}

/* Медиа передаём внутри зашифрованного сообщения (data URL).
   Так фото и файлы работают без Storage и остаются E2E. */
const MAX_MEDIA_CHARS = 900000;

function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = src;
  });
}

async function compressToDataUrl(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const variants = [[1400, .82], [1100, .76], [900, .7], [720, .64]];
    for (const [max, quality] of variants) {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      const src = canvas.toDataURL('image/jpeg', quality);
      if (src.length <= MAX_MEDIA_CHARS) return src;
    }
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function sendMediaPayload(payload, chatId = S.active) {
  const chat = chatById(chatId);
  if (!chat) return;

  const replyId = S.reply?.id || null;
  const replyBox = S.reply ? { ...S.reply } : null;
  /* голосовое: src хранится один раз, в voice — только метаданные */
  const wirePayload = payload.kind === 'voice'
    ? {
      kind: 'voice', name: payload.name, size: payload.size, src: payload.src,
      voice: { dur: payload.voice?.dur || 0, bars: payload.voice?.bars || [], rate: payload.voice?.rate || 1 },
    }
    : payload;
  const msg = {
    id: newId(), chatId: chat.id, sender: 'u_me', ts: Date.now(),
    type: payload.kind,
    file: { name: payload.name, size: payload.size, src: payload.src },
    text: '', reactions: [], wire: encodeMedia(wirePayload),
    status: SUPABASE.url && SUPABASE.anonKey ? 'sending' : 'sent',
    ...(replyBox ? { replyTo: replyBox } : {}),
    ...(payload.kind === 'voice' ? { voice: payload.voice } : {}),
  };

  clearReplyEdit();
  await deliverMessage(chat.id, msg);
  playSent();

  if (!(SUPABASE.url && SUPABASE.anonKey)) return;

  try {
    await sendMessage(chat.id, msg.wire, replyId, chat.kind, chat.publicKey, msg.id);
    msg.status = 'sent';
    await idb.put('messages', msg);
    if (S.active === chat.id) renderMessages();
    setTimeout(() => markRead(chat.id, msg.id), 1300);
  } catch (err) {
    console.error('Media send error:', err);
    msg.status = 'error';
    await idb.put('messages', msg);
    if (S.active === chat.id) renderMessages();
    toast(friendlySendError(err) || t('media.error'), { type: 'error' });
  }
}

/* Отправка выбранного/вставленного/перетащенного файла */
async function handlePickedFile(file, chatId = S.active) {
  if (!file || !chatById(chatId)) return;
  try {
    if (String(file.type).startsWith('image/')) {
      const src = await compressToDataUrl(file);
      if (!src) { toast(t('media.tooBig'), { type: 'error' }); return; }
      await sendMediaPayload({ kind: 'image', name: file.name || 'photo.jpg', size: file.size, src }, chatId);
      return;
    }
    if (file.size > 12 * 1024 * 1024) { toast(t('media.tooBig'), { type: 'error' }); return; }
    const src = await readFileAsDataURL(file);
    if (src.length > MAX_MEDIA_CHARS) { toast(t('media.tooBig'), { type: 'error' }); return; }
    await sendMediaPayload({ kind: 'file', name: file.name || 'file', size: file.size, src }, chatId);
  } catch (err) {
    console.error('File error:', err);
    toast(t('media.error'), { type: 'error' });
  }
}

function pickAndSend(kind) {
  const chatId = S.active;
  if (!chatById(chatId)) return;
  const input = document.createElement('input');
  input.type = 'file';
  if (kind === 'image') input.accept = 'image/*';
  input.onchange = (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (file) handlePickedFile(file, chatId);
  };
  input.click();
}

/* Оставлены для совместимости (могут вызываться из других модулей) */
export function sendImage() { pickAndSend('image'); }
export function sendFile() { pickAndSend('file'); }

/* ── голосовые: реальная запись через MediaRecorder ─────────── */
function pickMime() {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
  return ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
    .find((m) => MediaRecorder.isTypeSupported(m)) || '';
}

const blobToDataUrl = (blob) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(r.result);
  r.onerror = rej;
  r.readAsDataURL(blob);
});

function showRecUI() {
  els.crow.classList.add('recording');
  els.recUi.hidden = false;
  els.ta.hidden = true;
  els.recTime.textContent = '0:00';
}

function hideRecUI() {
  els.crow.classList.remove('recording');
  els.recUi.hidden = true;
  els.ta.hidden = false;
  if (recTimer) { clearInterval(recTimer); recTimer = null; }
}

async function startRecording() {
  if (mediaRecorder) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast(t('comp.micUnsupported'));
    return;
  }
  recChatId = S.active;
  try {
    recStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    /* палец уже отпустили, пока браузер спрашивал доступ */
    if (!recHeld) {
      recStream.getTracks().forEach((tr) => tr.stop());
      recStream = null;
      return;
    }
    const mime = pickMime();
    mediaRecorder = new MediaRecorder(recStream, mime ? { mimeType: mime } : undefined);
    recChunks = [];
    recCanceled = false;

    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size) recChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      const dur = (Date.now() - recStart) / 1000;
      const canceled = recCanceled;
      const mimeType = mediaRecorder?.mimeType || 'audio/webm';
      const blob = new Blob(recChunks, { type: mimeType });
      const chunks = recChunks;
      const targetChat = recChatId;
      cleanupRecording();
      if (canceled || dur < 0.8 || !chunks.length) return;
      const dataUrl = await blobToDataUrl(blob);
      sendVoiceData(dataUrl, dur, targetChat);
    };

    mediaRecorder.start();
    recStart = Date.now();
    showRecUI();
    recTimer = setInterval(() => {
      els.recTime.textContent = fmtDur((Date.now() - recStart) / 1000);
    }, 200);
  } catch (err) {
    console.error('Microphone error:', err);
    cleanupRecording();
    toast(t('comp.micDenied'));
  }
}

function stopRecording(cancel) {
  if (!mediaRecorder) return;
  recCanceled = !!cancel;
  if (mediaRecorder.state === 'recording') mediaRecorder.stop();
}

function cleanupRecording() {
  hideRecUI();
  if (recStream) recStream.getTracks().forEach((t) => t.stop());
  recStream = null;
  mediaRecorder = null;
  recChunks = [];
  recCanceled = false;
  recHeld = false;
  recChatId = null;
  if (recStartTimeout) { clearTimeout(recStartTimeout); recStartTimeout = null; }
}

async function sendVoiceData(src, dur, chatId = S.active) {
  if (src.length > MAX_MEDIA_CHARS) {
    toast(t('media.tooBig'), { type: 'error' });
    return;
  }
  const bars = Array.from({ length: 26 }, () => .25 + Math.random() * .7);
  await sendMediaPayload({
    kind: 'voice',
    name: 'voice.webm',
    size: src.length,
    src,
    voice: { dur: Math.max(1, Math.round(dur)), bars, rate: 1 },
  }, chatId);
}
