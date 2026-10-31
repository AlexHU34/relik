/* Relik — композер: ввод, ответ/редактирование, эмодзи, медиа, «микрофон» */
import { S, chatById } from './state.js';
import { $, fmtDur, esc, preview } from './utils.js';
import { syncExpanded } from './a11y.js';
import { icon } from './icons.js';
import { t } from '../i18n/i18n.js';
import { idb, newId } from '../db/idb.js';
import { SUPABASE } from '../config.js';
import { deliverMessage, renderMessages, refreshMessageStatus } from './chatView.js';
import { renderSidebar } from './sidebar.js';
import { toast } from './toast.js';
import { playSent } from './sounds.js';
import { sendTypingSignal } from '../backend/presence.js';
import { sendMessage, editMessage } from '../backend/messages.js';
import { notifyPush } from '../backend/push.js';
import { dataUrlToBlob } from '../backend/storage.js';
import { prefs } from './prefs.js';
import { currentDevice } from './device.js';
import { EMOJI_GROUPS, getRecentEmoji, pushRecentEmoji } from '../data/emoji.js';
import { retryMessage, retryFailedMessages, retryOutbox, friendlySendError } from './composer/retry.js';
import {
  handlePickedFile, sendMediaPayload, withUploadNotice, payloadFromBlob, payloadFromDataUrl,
  pickAndSend, MAX_VOICE_CHARS, MAX_CIRCLE_MS, blobToDataUrl,
  sendImage, sendFile, sendVideo, bindMediaHooks,
} from './composer/media.js';

import {
  openScheduleDialog, saveScheduledFromDialog, processScheduled,
  openScheduledList, onScheduledListClick, bindScheduledHooks,
} from './composer/scheduled.js';

import {
  openPollCreator, addPollOption, syncPollRemoveButtons, createPollFromForm,
  sendReaction, closePoll, votePoll, bindPollHooks,
} from './composer/polls.js';

bindScheduledHooks({ getEls: () => els, deliverMessage, clearReplyEdit });
bindMediaHooks({ deliverMessage, clearReplyEdit });
bindPollHooks({ getEls: () => els, deliverMessage, clearReplyEdit });

export { processScheduled, retryMessage, retryFailedMessages, retryOutbox };
export { sendImage, sendFile, sendVideo };
export { sendReaction, closePoll, votePoll };

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
    attAlbum: $('#attAlbum'), attVideo: $('#attVideo'), attCircle: $('#attCircle'), attLater: $('#attLater'), attSched: $('#attSched'),
    scheduleOv: $('#scheduleOv'), scheduleAt: $('#scheduleAt'), schedulePreview: $('#schedulePreview'), scheduleGo: $('#scheduleGo'),
    schedListOv: $('#schedListOv'), schedList: $('#schedList'),
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
  $('#attAlbumIc').innerHTML = icon('album', 17);
  $('#attVideoIc').innerHTML = icon('video', 17);
  $('#attCircleIc').innerHTML = icon('circle', 17);
  $('#attLaterIc').innerHTML = icon('clock', 17);
  $('#attSchedIc').innerHTML = icon('clock', 17);
  setSendMode('mic');
  initCircleRecorder();

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
  els.attAlbum.addEventListener('click', () => { els.attachMenu.hidden = true; pickAndSend('album'); });
  els.attVideo.addEventListener('click', () => { els.attachMenu.hidden = true; pickAndSend('video'); });
  els.attCircle.addEventListener('click', () => { els.attachMenu.hidden = true; openCircleRecorder(); });
  els.attLater.addEventListener('click', () => { els.attachMenu.hidden = true; openScheduleDialog(); });
  els.attSched?.addEventListener('click', () => { els.attachMenu.hidden = true; openScheduledList(); });
  els.schedList?.addEventListener('click', onScheduledListClick);
  els.attFile.addEventListener('click', () => { els.attachMenu.hidden = true; pickAndSend('file'); });
  els.attPoll.addEventListener('click', () => { els.attachMenu.hidden = true; openPollCreator(); });
  $('#pollAddOpt').addEventListener('click', () => addPollOption());
  $('#pollCreate').addEventListener('click', createPollFromForm);
  els.scheduleGo.addEventListener('click', saveScheduledFromDialog);
  setInterval(processScheduled, 20000);
  window.addEventListener('online', processScheduled);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') processScheduled();
    else flushDraft();
  });
  window.addEventListener('pagehide', flushDraft);
  window.addEventListener('beforeunload', flushDraft);
  processScheduled();
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

/* Черновик привязан к чату, в котором его начали: id фиксируем в момент
   ввода, иначе при быстром переключении текст уезжал в следующий чат. */
function persistDraft(id, v) {
  if (!id) return;
  const text = String(v ?? '');
  const next = text.trim() ? text : '';
  const changed = (S.drafts[id] || '') !== next;
  S.drafts[id] = next;
  try {
    if (next) idb.put('settings', { key: 'draft:' + id, value: next });
    else idb.del('settings', 'draft:' + id);
  } catch (e) { /* ignore */ }
  if (changed) paintDraft(id, next);
}

/* Точечно обновляем превью строки в списке: полный renderSidebar()
   на каждом черновике сбрасывал бы прокрутку списка чатов. */
function paintDraft(id, text) {
  const chat = chatById(id);
  if (!chat) return;
  const safe = (window.CSS && CSS.escape) ? CSS.escape(String(id)) : String(id).replace(/"/g, '\\"');
  const row = document.querySelector(`#sideList .chat-item[data-cid="${safe}"] .ci-preview`);
  if (!row) return;
  row.classList.toggle('draft', !!text);
  row.innerHTML = text
    ? `<span class="who">${t('side.draft')}:</span> ${esc(text.length > 120 ? text.slice(0, 120) + '…' : text)}`
    : preview(chat);
}

function scheduleDraft() {
  if (S.editing) return;
  clearTimeout(draftTimer);
  const id = S.active;
  if (!id) return;
  const value = els.ta.value;
  draftTimer = setTimeout(() => persistDraft(id, value), 500);
}

/* Сохранить черновик немедленно (переключение чата, скрытие вкладки) */
export function flushDraft() {
  clearTimeout(draftTimer);
  if (S.editing) return;
  const id = S.active;
  if (!id) return;
  persistDraft(id, els.ta.value);
}

function togglePopup(which) {
  const el = which === 'attach' ? els.attachMenu : els.emojiPop;
  const other = which === 'attach' ? els.emojiPop : els.attachMenu;
  other.hidden = true;
  el.hidden = !el.hidden;
  syncExpanded();
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
  const wasEditing = !!S.editing;
  S.reply = null; S.editing = null;
  refreshBar();
  /* Отмена редактирования не должна оставлять в поле изменённый текст:
     возвращаем черновик, который был до входа в режим правки. */
  if (!keepText || wasEditing) {
    els.ta.value = wasEditing ? (S.drafts?.[S.active] || '') : '';
    els.ta.style.height = 'auto';
    if (els.ta.value) {
      els.ta.dispatchEvent(new Event('input'));
    } else {
      setSendMode('mic');
    }
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
  if (S.drafts[chat.id]) { S.drafts[chat.id] = ''; renderSidebar(); }

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
    await sendMessage(chat.id, text, replyId, chat.kind, chat.publicKey, msg.id, chat.userId || null);
    msg.status = 'sent';
    await idb.put('messages', msg);
    refreshMessageStatus(msg);
    notifyPush(chat);
  } catch (err) {
    console.error('Send message error:', err);
    msg.status = 'error';
    msg.error = String(err?.message || '');
    await idb.put('messages', msg);
    refreshMessageStatus(msg);
    toast(friendlySendError(err));
  }
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

/* ── голосовые: реальная запись через MediaRecorder ─────────── */
function pickMime() {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
  return ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
    .find((m) => MediaRecorder.isTypeSupported(m)) || '';
}

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
  if (src.length > MAX_VOICE_CHARS) {
    toast(t('media.tooBig'), { type: 'error' });
    return;
  }
  const bars = Array.from({ length: 26 }, () => .25 + Math.random() * .7);
  const payload = await payloadFromDataUrl(chatId, src, {
    kind: 'voice',
    name: 'voice.webm',
    mime: dataUrlToBlob(src).type || 'audio/webm',
    voice: { dur: Math.max(1, Math.round(dur)), bars, rate: 1 },
  });
  if (!payload) { toast(t('media.tooBig'), { type: 'error' }); return; }
  await sendMediaPayload(payload, chatId);
}

/* ── видеокружок: запись камерой ───────────────────────────── */
let circleStream = null;
let circleRec = null;
let circleChunks = [];
let circleStarted = 0;
let circleTimer = null;
let circleCanceled = false;

function circleEls() {
  return {
    ov: $('#circleOv'),
    video: $('#circlePreview'),
    start: $('#circleStart'),
    cancel: $('#circleCancel'),
    close: $('#circleClose'),
    timer: $('#circleTimer'),
  };
}

async function openCircleRecorder() {
  if (!chatById(S.active)) return;
  const e = circleEls();
  if (!e.ov) return;
  e.ov.hidden = false;
  e.timer.hidden = true;
  e.timer.textContent = '0:00';
  e.start.textContent = t('comp.circleStart');
  e.start.disabled = true;
  circleCanceled = false;

  if (!navigator.mediaDevices?.getUserMedia) {
    toast(t('call.cameraDenied'));
    closeCircleRecorder();
    return;
  }

  try {
    circleStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 640 }, aspectRatio: 1 },
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    if (e.video) {
      e.video.srcObject = circleStream;
      e.video.play().catch(() => {});
    }
    e.start.disabled = false;
  } catch (err) {
    console.warn('Circle camera:', err);
    toast(t('call.cameraDenied'));
    closeCircleRecorder();
  }
}

function circleMime() {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
  return ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']
    .find((m) => MediaRecorder.isTypeSupported(m)) || '';
}

function startCircleRecording() {
  if (!circleStream || circleRec) return;
  try {
    const mime = circleMime();
    circleRec = new MediaRecorder(circleStream, mime ? { mimeType: mime } : undefined);
    circleChunks = [];
    circleStarted = Date.now();
    circleCanceled = false;

    circleRec.ondataavailable = (ev) => {
      if (ev.data?.size) circleChunks.push(ev.data);
    };

    circleRec.onstop = async () => {
      const dur = (Date.now() - circleStarted) / 1000;
      const canceled = circleCanceled;
      const blob = new Blob(circleChunks, { type: circleRec?.mimeType || 'video/webm' });
      circleRec = null;
      closeCircleRecorder();
      if (canceled || dur < 1 || !blob.size) return;
      const chatId = S.active;
      const payload = await withUploadNotice(blob.size, () => payloadFromBlob(chatId, blob, {
        kind: 'videoNote', name: 'circle.webm', mime: blob.type || 'video/webm',
      }));
      if (!payload) {
        toast(t('media.storageNeeded'), { type: 'error' });
        return;
      }
      await sendMediaPayload({ ...payload, duration: dur }, chatId);
    };

    circleRec.start(250);
    const e = circleEls();
    e.start.textContent = t('comp.circleStop');
    e.timer.hidden = false;
    circleTimer = setInterval(() => {
      const sec = (Date.now() - circleStarted) / 1000;
      e.timer.textContent = fmtDur(sec);
      if (sec * 1000 >= MAX_CIRCLE_MS) stopCircleRecording(false);
    }, 200);
  } catch (err) {
    console.warn('Circle record:', err);
    toast(t('media.error'));
    closeCircleRecorder();
  }
}

function stopCircleRecording(cancel = false) {
  circleCanceled = !!cancel;
  if (circleRec && circleRec.state === 'recording') circleRec.stop();
  else closeCircleRecorder();
}

function closeCircleRecorder() {
  clearInterval(circleTimer);
  circleTimer = null;
  if (circleRec && circleRec.state === 'recording') {
    circleCanceled = true;
    try { circleRec.stop(); } catch (e) { /* ignore */ }
  }
  circleRec = null;
  if (circleStream) {
    circleStream.getTracks().forEach((tr) => tr.stop());
    circleStream = null;
  }
  const e = circleEls();
  if (e.video) e.video.srcObject = null;
  if (e.ov) e.ov.hidden = true;
  if (e.start) { e.start.textContent = t('comp.circleStart'); e.start.disabled = false; }
  if (e.timer) e.timer.hidden = true;
}

export function initCircleRecorder() {
  const e = circleEls();
  if (!e.ov || e.ov.dataset.bound) return;
  e.ov.dataset.bound = '1';
  if (e.close) e.close.innerHTML = icon('x', 18);
  e.start?.addEventListener('click', () => {
    if (circleRec && circleRec.state === 'recording') stopCircleRecording(false);
    else startCircleRecording();
  });
  e.cancel?.addEventListener('click', () => {
    if (circleRec && circleRec.state === 'recording') stopCircleRecording(true);
    else closeCircleRecorder();
  });
  e.close?.addEventListener('click', () => {
    if (circleRec && circleRec.state === 'recording') stopCircleRecording(true);
    else closeCircleRecorder();
  });
}
