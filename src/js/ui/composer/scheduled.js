/* Relik — отложенные сообщения: диалог, список и обработка очереди.
   Элементы композера и deliverMessage приходят через bindScheduledHooks. */
import { S, chatById, chatTitle } from '../state.js';
import { esc } from '../utils.js';
import { idb, newId } from '../../db/idb.js';
import { t, lang } from '../../i18n/i18n.js';
import { SUPABASE } from '../../config.js';
import { toast } from '../toast.js';
import { playSent } from '../sounds.js';
import { sendMessage } from '../../backend/messages.js';
import { scheduleOnServer, cancelOnServer, sendNowOnServer, reconcileLocal, scheduledSupported } from '../../backend/scheduled.js';
import { refreshMessageStatus } from '../chat/receipts.js';

let hooks = { getEls: () => ({}), deliverMessage: async () => {}, clearReplyEdit: () => {} };
export function bindScheduledHooks(next = {}) { hooks = { ...hooks, ...next }; }

/* ── отложенные сообщения ─────────────────────────────────── */
export function localDateTimeValue(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function openScheduleDialog() {
  if (!chatById(S.active)) return;
  const text = hooks.getEls().ta.value.trim();
  if (!text) { toast(t('sched.needText')); return; }
  hooks.getEls().schedulePreview.textContent = text;
  const inHour = new Date(Date.now() + 60 * 60 * 1000);
  inHour.setSeconds(0, 0);
  hooks.getEls().scheduleAt.value = localDateTimeValue(inHour.getTime());
  hooks.getEls().scheduleOv.hidden = false;
  setTimeout(() => hooks.getEls().scheduleAt.focus(), 50);
}

export async function saveScheduledFromDialog() {
  const chat = chatById(S.active);
  const text = hooks.getEls().ta.value.trim();
  const dueAt = new Date(hooks.getEls().scheduleAt.value || '').getTime();
  if (!chat) return;
  if (!text) { toast(t('sched.needText')); return; }
  if (!Number.isFinite(dueAt) || dueAt < Date.now() + 1000) {
    toast(t('sched.badTime'), { type: 'error' });
    return;
  }
  const record = {
    id: newId(),
    chatId: chat.id,
    text,
    dueAt,
    replyId: S.reply?.id || null,
    replyBox: S.reply ? { ...S.reply } : null,
  };

  /* Пытаемся отправить через сервер: тогда сообщение уйдёт,
     даже если приложение закрыто. Без миграции — локальный режим. */
  if (scheduledSupported()) {
    try {
      await scheduleOnServer({
        ...record,
        chatKind: chat.kind,
        publicKey: chat.publicKey || null,
        peerUserId: chat.kind === 'dm' ? (chat.userId || null) : null,
      });
      record.server = true;
    } catch (err) {
      if (String(err?.message || '') === 'need_sql') toast(t('sched.needSql'), { type: 'error' });
      record.server = false;
    }
  }

  await idb.put('settings', { key: 'sched:' + record.id, value: record });
  hooks.getEls().scheduleOv.hidden = true;
  hooks.clearReplyEdit();
  toast(t('sched.saved'), { type: 'success' });
}

let schedBusy = false;
let lastReconcile = 0;

export async function sendScheduled(item) {
  const chat = chatById(item?.chatId);
  if (!chat || !item?.text) return;
  const msg = {
    id: item.id || newId(), chatId: chat.id, sender: 'u_me', ts: Date.now(),
    type: 'text', text: item.text, reactions: [],
    status: SUPABASE.url && SUPABASE.anonKey ? 'sending' : 'sent',
    ...(item.replyBox ? { replyTo: item.replyBox } : {}),
  };
  await hooks.deliverMessage(chat.id, msg);
  playSent();
  if (!(SUPABASE.url && SUPABASE.anonKey)) return;
  try {
    await sendMessage(chat.id, item.text, item.replyId || null, chat.kind, chat.publicKey, msg.id, chat.userId || null);
    msg.status = 'sent';
    await idb.put('messages', msg);
    refreshMessageStatus(msg);
  } catch (err) {
    console.error('Scheduled send error:', err);
    msg.status = 'error';
    msg.error = String(err?.message || '');
    await idb.put('messages', msg);
    refreshMessageStatus(msg);
  }
}

export async function processScheduled() {
  if (schedBusy || !S.me) return;
  schedBusy = true;
  try {
    if (Date.now() - lastReconcile > 5 * 60 * 1000) {
      lastReconcile = Date.now();
      reconcileLocal().catch(() => {});
    }
    const all = await idb.getAll('settings');
    const now = Date.now();
    const due = all
      .filter((rec) => String(rec.key).startsWith('sched:') && !rec.value?.server && Number(rec.value?.dueAt) <= now)
      .sort((a, b) => (a.value?.dueAt || 0) - (b.value?.dueAt || 0))
      .slice(0, 20);
    for (const rec of due) {
      await idb.del('settings', rec.key);
      await sendScheduled(rec.value);
    }
  } catch (err) {
    console.warn('Scheduled messages error:', err);
  } finally {
    schedBusy = false;
  }
}

/* ── список отложенных: посмотреть, отправить сейчас, отменить ── */
function fmtDue(ts) {
  const d = new Date(Number(ts) || 0);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return d.toLocaleString(lang === 'ru' ? 'ru-RU' : 'en-US', {
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    });
  } catch (e) {
    return d.toLocaleString();
  }
}

export async function openScheduledList() {
  if (!hooks.getEls().schedListOv || !hooks.getEls().schedList) return;
  let items = [];
  try {
    const all = await idb.getAll('settings');
    items = all
      .filter((rec) => String(rec.key || '').startsWith('sched:') && rec.value?.chatId && rec.value?.text)
      .map((rec) => rec.value)
      .sort((a, b) => (a.dueAt || 0) - (b.dueAt || 0));
  } catch (e) { /* ignore */ }
  hooks.getEls().schedList.innerHTML = items.length
    ? items.map((it) => {
      const chat = chatById(it.chatId);
      const name = chat ? chatTitle(chat) : t('sched.unknownChat');
      return `<div class="sched-item" data-sid="${esc(it.id)}">
        <div class="si-top">
          <span class="si-chat">${esc(name)}</span>
          <span>${esc(fmtDue(it.dueAt))}</span>
        </div>
        <div class="si-text">${esc(it.text)}</div>
        <div class="si-actions">
          <button type="button" class="btn btn-ghost" data-sched-cancel="${esc(it.id)}">${t('sched.cancelItem')}</button>
          <button type="button" class="btn" data-sched-now="${esc(it.id)}">${t('sched.sendNow')}</button>
        </div>
      </div>`;
    }).join('')
    : `<div class="sched-empty">${t('sched.empty')}</div>`;
  hooks.getEls().schedListOv.hidden = false;
}

export async function onScheduledListClick(e) {
  const cancel = e.target.closest('[data-sched-cancel]');
  const sendNow = e.target.closest('[data-sched-now]');
  if (!cancel && !sendNow) return;
  const btn = cancel || sendNow;
  const sid = btn.dataset.schedCancel || btn.dataset.schedNow;
  if (!sid) return;
  btn.disabled = true;
  try {
    const rec = await idb.get('settings', 'sched:' + sid);
    if (!rec?.value) return;
    if (rec.value.server) {
      if (cancel) await cancelOnServer(rec.value.id);
      else await sendNowOnServer(rec.value.id);
    }
    await idb.del('settings', 'sched:' + sid);
    if (cancel) {
      toast(t('sched.cancelled'), { type: 'success' });
    } else if (rec.value.server) {
      toast(t('sched.sentNow'), { type: 'success' });
    } else {
      await sendScheduled(rec.value);
      toast(t('sched.sentNow'), { type: 'success' });
    }
  } catch (err) {
    console.warn('Scheduled list action error:', err);
    toast(t('toast.error'), { type: 'error' });
  } finally {
    openScheduledList();
  }
}
