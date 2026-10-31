/* Relik — опросы: создание, голоса, реакции, закрытие.
   Элементы диалога и deliverMessage приходят через bindPollHooks. */
import { S, chatById } from '../state.js';
import { icon } from '../icons.js';
import { idb, newId } from '../../db/idb.js';
import { SUPABASE } from '../../config.js';
import { t } from '../../i18n/i18n.js';
import { toast } from '../toast.js';
import { playSent } from '../sounds.js';
import { sendMessage, encodePoll, encodeVote, encodeReaction, encodePollClose } from '../../backend/messages.js';
import { refreshMessageStatus } from '../chat/receipts.js';
import { refreshPollCard, refreshMessageReactions } from '../chat/render.js';
import { friendlySendError } from './retry.js';

let hooks = { getEls: () => ({}), deliverMessage: async () => {}, clearReplyEdit: () => {} };
export function bindPollHooks(next = {}) { hooks = { ...hooks, ...next }; }

/* ── опросы ─────────────────────────────────────────────────── */
export function pollOptionRow(value = '') {
  const row = document.createElement('div');
  row.className = 'poll-opt-edit';
  row.innerHTML = `<input class="input" maxlength="80" placeholder="${t('poll.optionPh')}">
    <button class="icon-btn" type="button" data-rm-opt></button>`;
  row.querySelector('input').value = value;
  row.querySelector('[data-rm-opt]').innerHTML = icon('x', 15);
  return row;
}

export function syncPollRemoveButtons() {
  const rows = [...hooks.getEls().pollOptions.children];
  rows.forEach((row) => {
    const rm = row.querySelector('[data-rm-opt]');
    if (rm) rm.hidden = rows.length <= 2;
  });
}

export function addPollOption(value = '') {
  if (hooks.getEls().pollOptions.children.length >= 6) { toast(t('poll.maxOptions')); return; }
  hooks.getEls().pollOptions.appendChild(pollOptionRow(value));
  syncPollRemoveButtons();
}

export function openPollCreator() {
  if (!chatById(S.active)) return;
  hooks.getEls().pollQuestion.value = '';
  hooks.getEls().pollOptions.innerHTML = '';
  hooks.getEls().pollMulti.checked = false;
  hooks.getEls().pollAnon.checked = true;
  addPollOption();
  addPollOption();
  hooks.getEls().pollOv.hidden = false;
  setTimeout(() => hooks.getEls().pollQuestion.focus(), 60);
}

export async function createPollFromForm() {
  const q = hooks.getEls().pollQuestion.value.trim();
  if (!q) { toast(t('poll.needQuestion')); return; }

  const o = [...hooks.getEls().pollOptions.querySelectorAll('input')]
    .map((i) => i.value.trim())
    .filter(Boolean);
  if (o.length < 2) { toast(t('poll.needOptions')); return; }

  hooks.getEls().pollOv.hidden = true;
  await sendPoll({ q, o: o.slice(0, 6), multi: !!hooks.getEls().pollMulti.checked, anon: !!hooks.getEls().pollAnon.checked });
}

export async function sendPoll(poll) {
  const chat = chatById(S.active);
  if (!chat) return;

  const msg = {
    id: newId(), chatId: chat.id, sender: 'u_me', ts: Date.now(),
    type: 'poll', poll, text: poll.q, reactions: [],
    wire: encodePoll(poll),
    status: SUPABASE.url && SUPABASE.anonKey ? 'sending' : 'sent',
  };

  hooks.clearReplyEdit();
  await hooks.deliverMessage(chat.id, msg);
  playSent();

  if (!(SUPABASE.url && SUPABASE.anonKey)) return;

  try {
    await sendMessage(chat.id, encodePoll(poll), null, chat.kind, chat.publicKey, msg.id, chat.userId || null);
    msg.status = 'sent';
    await idb.put('messages', msg);
    refreshMessageStatus(msg);
  } catch (err) {
    console.error('Create poll error:', err);
    msg.status = 'error';
    await idb.put('messages', msg);
    refreshMessageStatus(msg);
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
    await sendMessage(chat.id, encodeReaction(message.id, emoji, on), null, chat.kind, chat.publicKey, event.id, chat.userId || null);
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
    await sendMessage(chat.id, encodePollClose(pollMsg.id), null, chat.kind, chat.publicKey, event.id, chat.userId || null);
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
    await sendMessage(chat.id, encodeVote(pollMsg.id, picked), null, chat.kind, chat.publicKey, msg.id, chat.userId || null);
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
