/* Relik — чистая логика очереди исходящих сообщений (outbox).
   Без DOM, без сети, без Supabase: только состояния и правила.
   Используется composer.js (отправка/ретраи) и тестами (chaos-симуляция). */

export const OUTBOX = Object.freeze({
  QUEUED: 'queued',
  SENDING: 'sending',
  SENT: 'sent',
  ERROR: 'error',
});

/* Порядок статусов: чем больше, тем «дальше» сообщение. Понижать нельзя. */
const RANK = { error: 0, queued: 0, sending: 1, sent: 2 };

export function statusRank(status) {
  return RANK[status] ?? 0;
}

export function maxStatus(a, b) {
  return statusRank(a) >= statusRank(b) ? a : b;
}

export function isPending(status) {
  return status === OUTBOX.QUEUED || status === OUTBOX.SENDING || status === OUTBOX.ERROR;
}

export function isRetryable(status) {
  return status === OUTBOX.QUEUED || status === OUTBOX.ERROR;
}

/* Экспоненциальная пауза с джиттером: 1с, 2с, 4с … до 60с.
   Джиттер обязателен: иначе 20 вкладок бьют в сервер одновременно. */
export function backoffMs(attempts, random = Math.random, { base = 1000, cap = 60000 } = {}) {
  const n = Math.max(0, Math.min(20, Number(attempts) || 0));
  const raw = Math.min(cap, base * 2 ** n);
  const jitter = 0.5 + random(); /* 0.5 … 1.5 */
  return Math.round(Math.min(cap, raw * jitter));
}

export const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/* Пора ли пробовать снова. Старше суток — не пытаемся: это уже не «сеть мигнула». */
export function canRetry(msg, now, { maxAgeMs = DEFAULT_MAX_AGE_MS } = {}) {
  if (!msg || !isRetryable(msg.status)) return false;
  if (msg.deleted || msg.localDeleted) return false;
  if (msg.nextAt && msg.nextAt > now) return false;
  if (msg.ts && now - msg.ts > maxAgeMs) return false;
  return true;
}

/* Что отправлять прямо сейчас: сначала старое, потом новое, не больше limit. */
export function pickDue(list, now, opts = {}) {
  const limit = opts.limit ?? 20;
  return (list || [])
    .filter((m) => canRetry(m, now, opts))
    .sort((a, b) => (a.ts || 0) - (b.ts || 0))
    .slice(0, limit);
}

/* Начало попытки. Возвращает новый объект — так проще тестировать и откатывать. */
export function beginAttempt(msg, now) {
  return {
    ...msg,
    status: OUTBOX.SENDING,
    attempts: (msg.attempts || 0) + 1,
    lastAttemptAt: now,
    nextAt: 0,
  };
}

export function completeAttempt(msg, now) {
  return { ...msg, status: OUTBOX.SENT, sentAt: now, nextAt: 0, error: null };
}

export function failAttempt(msg, now, error, opts = {}) {
  return {
    ...msg,
    status: OUTBOX.ERROR,
    attempts: msg.attempts || 1,
    failedAt: now,
    nextAt: now + backoffMs(msg.attempts || 1, opts.random, opts),
    error: String(error || 'send_failed').slice(0, 120),
  };
}

/* Подтверждение от сервера/получателя. Монотонно: «прочитано» не откатывается в «отправлено». */
export function applyAck(msg, ack, now) {
  const next = { ...msg };
  if (ack === 'read') {
    next.ack = 'read';
    next.readAt = next.readAt || now;
  } else if (ack === 'delivered') {
    if (msg.ack !== 'read') next.ack = 'delivered';
    next.deliveredAt = next.deliveredAt || now;
  } else if (ack === 'sent') {
    next.status = maxStatus(msg.status, OUTBOX.SENT);
  }
  return next;
}

/* Слияние локальной и серверной копий по id (id = client-generated UUID).
   Дубликаты физически не появляются: ключ один. */
export function mergeRemote(localList, remoteList, { meId = 'u_me' } = {}) {
  const map = new Map();
  for (const m of localList || []) map.set(m.id, m);
  let added = 0;
  let merged = 0;
  for (const r of remoteList || []) {
    const cur = map.get(r.id);
    if (!cur) {
      map.set(r.id, { ...r, sender: r.sender === meId ? 'u_me' : r.sender });
      added++;
      continue;
    }
    /* сервер знает статус лучше локального, но ack мог прийти только локально */
    const status = maxStatus(cur.status, r.status || OUTBOX.SENT);
    const ack = cur.ack === 'read' || r.ack === 'read' ? 'read' : cur.ack || r.ack || 'none';
    map.set(r.id, { ...r, ...cur, status, ack, text: cur.text ?? r.text });
    merged++;
  }
  return { messages: [...map.values()], added, merged };
}

export function summarize(list) {
  const out = { total: 0, queued: 0, sending: 0, sent: 0, error: 0, delivered: 0, read: 0 };
  for (const m of list || []) {
    out.total++;
    if (out[m.status] != null) out[m.status]++;
    if (m.ack === 'delivered') out.delivered++;
    if (m.ack === 'read') out.read++;
  }
  return out;
}
