/* Relik — повторная отправка и очередь исходящих (outbox).
   Чистая политика ретраев живёт в js/core/outbox.js; здесь — Supabase и IndexedDB. */
import { S, chatById } from '../state.js';
import { idb } from '../../db/idb.js';
import { SUPABASE } from '../../config.js';
import { t } from '../../i18n/i18n.js';
import { toast } from '../toast.js';
import { renderSidebar } from '../sidebar.js';
import { notifyPush } from '../../backend/push.js';
import { sendMessage } from '../../backend/messages.js';
import { logEvent } from '../../backend/telemetry.js';
import { refreshMessageStatus } from '../chat/receipts.js';
import { pickDue, canRetry, backoffMs } from '../../core/outbox.js';

/* ── повторная отправка (клик по ошибке или возврат сети) ── */
export async function retryMessage(m, opts = {}) {
  if (!m || m.status !== 'error') return false;
  const chat = chatById(m.chatId || S.active);
  if (!chat) return false;

  const wire = m.wire || m.text;
  m.status = 'sending';
  m.attempts = (m.attempts || 0) + 1;
  delete m.nextTry;
  await idb.put('messages', m);
  refreshMessageStatus(m);

  let ok = false;
  try {
    await sendMessage(chat.id, wire, m.replyTo?.id || null, chat.kind, chat.publicKey, m.id, chat.userId || null);
    m.status = 'sent';
    delete m.error;
    await idb.put('messages', m);
    ok = true;
    notifyPush(chat);
  } catch (err) {
    const msg = String(err?.message || '');
    /* сообщение уже дошло раньше, но клиент не успел отметить — это успех */
    if (err?.code === '23505' || /duplicate key|already exists/i.test(msg)) {
      m.status = 'sent';
      delete m.error;
      await idb.put('messages', m);
      ok = true;
      /* дубликат значит «сообщение уже лежит на сервере» — считаем доставленным */
      logEvent('send_dup', { attempts: Number(m.attempts) || 1 });
    } else {
      console.error('Retry message error:', err);
      m.status = 'error';
      m.error = msg;
      /* единая политика ретраев из js/core/outbox.js: 5 с → 15 с → 45 с … потолок 5 мин */
      m.nextTry = Date.now() + backoffMs(m.attempts || 1, Math.random, { base: 5000, cap: 300000 });
      await idb.put('messages', m);
      if (!opts.silent) toast(friendlySendError(err));
      logEvent('send_failed', { attempts: m.attempts || 1, message: msg.slice(0, 120) });
    }
  }
  if (S.active === chat.id) refreshMessageStatus(m);
  renderSidebar();
  return ok;
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

/* Очередь исходящих: досылаем ошибки и «зависшие» отправки во всех чатах,
   даже если чат сейчас не открыт (после перезагрузки/обрыва сети). */
let outboxBusy = false;
let outboxAt = 0;

export async function retryOutbox() {
  if (!(SUPABASE.url && SUPABASE.anonKey)) return;
  if (navigator.onLine === false) return;
  if (outboxBusy || Date.now() - outboxAt < 15000) return;
  outboxBusy = true;
  outboxAt = Date.now();
  try {
    const now = Date.now();
    const all = await idb.getAll('messages');

    /* «Зависшие» отправки (вкладку закрыли в момент отправки) считаем ошибкой,
       иначе они навсегда останутся в статусе sending и не попадут в очередь. */
    for (const m of all) {
      if (m.sender === 'u_me' && m.status === 'sending' && now - (m.ts || 0) > 25000) {
        m.status = 'error';
        await idb.put('messages', m);
      }
    }

    /* Отбор и порядок — в проверенной чистой логике (js/core/outbox.js).
       Старше суток не трогаем: это уже не «сеть мигнула», а мусор. */
    const candidates = all
      .filter((m) => m.sender === 'u_me' && !m.hidden)
      .map((m) => ({ ...m, nextAt: m.nextTry || 0 }));
    const queue = pickDue(candidates, now, { limit: 20 });
    const expired = candidates.filter((m) => m.status === 'error' && !canRetry(m, now)).length;

    for (const m of queue) {
      if (!chatById(m.chatId)) continue;
      const list = S.messages[m.chatId] || (S.messages[m.chatId] = []);
      if (!list.some((x) => x.id === m.id)) list.push(m);
      const ok = await retryMessage(m, { silent: true });
      /* Счётчики надёжности: по ним видно, реально ли «ничего не теряется»,
         не читая переписку. Только метаданные, без текста. */
      logEvent(ok ? 'outbox_delivered' : 'outbox_failed', {
        attempts: Number(m.attempts) || 1,
        ageMin: Math.max(0, Math.round((Date.now() - (Number(m.ts) || Date.now())) / 60000)),
      });
    }
    if (expired) logEvent('outbox_expired', { count: expired });
    if (queue.length) renderSidebar();
  } catch (err) {
    console.warn('Outbox retry failed:', err);
  } finally {
    outboxBusy = false;
  }
}

/* Понятная причина, если отправка не удалась */
export function friendlySendError(err) {
  const msg = String(err?.message || '');
  if (/recipient_blocked/i.test(msg)) {
    return t('profile.blockedSend');
  }
  if (/rate_limited/i.test(msg)) {
    return t('comp.rateLimited');
  }
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
