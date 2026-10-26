/*
 * Relik mail service — приём auth-хука Supabase и отправка кодов через Brevo.
 *
 * Зачем: Supabase Auth вызывает этот endpoint каждый раз, когда нужно
 * отправить письмо (подтверждение регистрации, сброс пароля, magic link,
 * смена почты, reauthentication). Мы формируем письмо сами и отправляем
 * через Brevo API. Домен не нужен: отправитель — подтверждённый адрес
 * (например, relik.support@yandex.ru).
 *
 * Безопасность:
 *   - проверяется подпись Standard Webhooks (webhook-id/timestamp/signature);
 *   - тело ограничено 20 КБ (лимит Supabase);
 *   - коды и токены не пишутся в логи;
 *   - rate limit по email и общий лимит в минуту;
 *   - idempotency по webhook-id, чтобы ретраи Supabase не слали дубли.
 *
 * Запуск: node index.js
 * Переменные окружения — см. README.md и env.example.
 */
'use strict';

const http = require('node:http');
const crypto = require('node:crypto');

const {
  HOST = '127.0.0.1',
  PORT = '8100',
  MAIL_PROVIDER = 'smtp',
  BREVO_API_KEY = '',
  BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email',
  SMTP_HOST = 'smtp.yandex.ru',
  SMTP_PORT = '465',
  SMTP_SECURE = 'true',
  SMTP_USER = '',
  SMTP_PASS = '',
  MAIL_FROM = 'Relik <relik.support@yandex.ru>',
  MAIL_REPLY_TO = '',
  SUPABASE_URL = '',
  SEND_EMAIL_HOOK_SECRET = '',
  DRY_RUN = '',
  MAX_BODY_BYTES = '20000',
  WEBHOOK_TOLERANCE_SEC = '300',
  RATE_PER_EMAIL = '5',
  RATE_WINDOW_MS = '900000',
  RATE_GLOBAL_PER_MIN = '30',
  BREVO_TIMEOUT_MS = '4000',
  CODE_TTL_MINUTES = '60',
  LOG_LEVEL = 'info',
} = process.env;

const VERSION = '1.0.0';
const STARTED = Date.now();
const dryRun = /^(1|true|yes)$/i.test(DRY_RUN);
const maxBody = Math.max(1024, Number(MAX_BODY_BYTES) || 20000);
const tolerance = Math.max(30, Number(WEBHOOK_TOLERANCE_SEC) || 300);
const ratePerEmail = Math.max(1, Number(RATE_PER_EMAIL) || 5);
const rateWindow = Math.max(60000, Number(RATE_WINDOW_MS) || 900000);
const globalPerMin = Math.max(1, Number(RATE_GLOBAL_PER_MIN) || 30);
const brevoTimeout = Math.max(1000, Number(BREVO_TIMEOUT_MS) || 4000);
const codeTtlMinutes = Math.max(1, Number(CODE_TTL_MINUTES) || 60);

const sender = parseSender(MAIL_FROM);
const replyTo = MAIL_REPLY_TO ? parseSender(MAIL_REPLY_TO).email : '';
const secrets = parseSecrets(SEND_EMAIL_HOOK_SECRET);
const provider = String(MAIL_PROVIDER || 'smtp').toLowerCase() === 'brevo' ? 'brevo' : 'smtp';
const providerReady = dryRun || (provider === 'brevo'
  ? Boolean(BREVO_API_KEY)
  : Boolean(SMTP_HOST && SMTP_USER && SMTP_PASS));
const ready = Boolean(sender.email && providerReady && secrets.length);

function missingConfig() {
  const missing = [];
  if (!sender.email) missing.push('MAIL_FROM');
  if (!secrets.length) missing.push('SEND_EMAIL_HOOK_SECRET');
  if (provider === 'brevo') {
    if (!BREVO_API_KEY) missing.push('BREVO_API_KEY');
  } else {
    if (!SMTP_HOST) missing.push('SMTP_HOST');
    if (!SMTP_USER) missing.push('SMTP_USER');
    if (!SMTP_PASS) missing.push('SMTP_PASS');
  }
  return missing;
}

const stats = {
  started: STARTED,
  received: 0,
  sent: 0,
  failed: 0,
  skipped: 0,
  lastAt: null,
  lastAction: '',
};

/* ── журнал ──────────────────────────────────────────────────── */
const log = (level, msg, extra = {}) => {
  const order = { debug: 10, info: 20, warn: 30, error: 40 };
  if ((order[level] || 20) < (order[LOG_LEVEL] || 20)) return;
  const row = { t: new Date().toISOString(), level, msg, ...extra };
  console.log(JSON.stringify(row));
};

/* ── разбор конфигурации ────────────────────────────────────── */
function parseSender(value) {
  const raw = String(value || '').trim().replace(/^["']|["']$/g, '');
  const m = /^(.*?)\s*<([^>]+)>\s*$/.exec(raw);
  if (m) return { name: m[1].trim().replace(/^["']|["']$/g, '') || 'Relik', email: m[2].trim().toLowerCase() };
  return { name: 'Relik', email: raw.toLowerCase() };
}

function parseSecrets(value) {
  return String(value || '')
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/^v1,whsec_/i, '').replace(/^whsec_/i, ''))
    .map((s) => {
      try {
        const buf = Buffer.from(s, 'base64');
        return buf.length >= 16 ? buf : null;
      } catch (e) {
        return null;
      }
    })
    .filter(Boolean);
}

function maskEmail(email) {
  const s = String(email || '');
  const at = s.lastIndexOf('@');
  if (at < 1) return '***';
  return s[0] + '***' + s.slice(at);
}

function hashEmail(email) {
  return crypto.createHash('sha256').update(String(email || '').toLowerCase()).digest('hex').slice(0, 16);
}

function isValidEmail(email) {
  const s = String(email || '').trim();
  return s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

/* ── подпись Standard Webhooks ──────────────────────────────── */
function verifySignature(rawBody, headers) {
  if (!secrets.length) return false;

  const id = headers['webhook-id'];
  const tsRaw = headers['webhook-timestamp'];
  const sigHeader = headers['webhook-signature'];
  if (!id || !tsRaw || !sigHeader) return false;

  let ts = Number(tsRaw);
  if (!Number.isFinite(ts)) return false;
  if (ts > 1e12) ts = Math.floor(ts / 1000); // на всякий случай: миллисекунды
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > tolerance) return false;

  const signed = Buffer.concat([
    Buffer.from(`${id}.${tsRaw}.`, 'utf8'),
    rawBody,
  ]);

  const parts = String(sigHeader).split(/\s+/);
  for (const key of secrets) {
    const expected = crypto.createHmac('sha256', key).update(signed).digest();
    for (const part of parts) {
      const comma = part.indexOf(',');
      if (comma < 0) continue;
      const version = part.slice(0, comma);
      if (version !== 'v1') continue;
      const b64 = part.slice(comma + 1).replace(/-/g, '+').replace(/_/g, '/');
      let got;
      try {
        got = Buffer.from(b64, 'base64');
      } catch (e) {
        continue;
      }
      if (got.length === expected.length && crypto.timingSafeEqual(got, expected)) return true;
    }
  }
  return false;
}

/* ── лимиты и idempotency ───────────────────────────────────── */
const emailBuckets = new Map(); // hash -> { count, reset }
const attemptedHooks = new Map(); // webhook-id -> timestamp
const sentHooks = new Map(); // webhook-id -> timestamp
const sentJobs = new Map(); // `${webhook-id}:${to}` -> timestamp
let globalBucket = { count: 0, reset: Date.now() + 60000 };

function hitEmail(email) {
  const key = hashEmail(email);
  const now = Date.now();
  const b = emailBuckets.get(key);
  if (!b || b.reset <= now) {
    emailBuckets.set(key, { count: 1, reset: now + rateWindow });
    return true;
  }
  if (b.count >= ratePerEmail) return false;
  b.count += 1;
  return true;
}

function hitGlobal() {
  const now = Date.now();
  if (globalBucket.reset <= now) globalBucket = { count: 0, reset: now + 60000 };
  if (globalBucket.count >= globalPerMin) return false;
  globalBucket.count += 1;
  return true;
}

function prune() {
  const now = Date.now();
  for (const [k, v] of emailBuckets) if (v.reset <= now) emailBuckets.delete(k);
  for (const [k, v] of attemptedHooks) if (now - v > 30 * 60e3) attemptedHooks.delete(k);
  for (const [k, v] of sentHooks) if (now - v > 30 * 60e3) sentHooks.delete(k);
  for (const [k, v] of sentJobs) if (now - v > 30 * 60e3) sentJobs.delete(k);
}
const pruneTimer = setInterval(prune, 10 * 60e3);
pruneTimer.unref?.();

/* ── текст письма ───────────────────────────────────────────── */
const SUBJECTS = {
  signup: 'Подтвердите почту в Relik',
  recovery: 'Сброс пароля в Relik',
  magiclink: 'Код входа в Relik',
  invite: 'Приглашение в Relik',
  email_change: 'Подтвердите новую почту в Relik',
  email_change_current: 'Подтвердите смену почты в Relik',
  email_change_new: 'Подтвердите новую почту в Relik',
  reauthentication: 'Код подтверждения Relik',
  password_changed_notification: 'Пароль Relik изменён',
  email_changed_notification: 'Почта Relik изменена',
  phone_changed_notification: 'Телефон Relik изменён',
  identity_linked_notification: 'Новый способ входа в Relik',
  identity_unlinked_notification: 'Способ входа в Relik отключён',
  mfa_factor_enrolled_notification: 'Двухфакторная защита Relik включена',
  mfa_factor_unenrolled_notification: 'Двухфакторная защита Relik отключена',
};

const INTROS = {
  signup: 'Введите этот код в Relik, чтобы подтвердить почту и завершить регистрацию.',
  recovery: 'Введите этот код в Relik, чтобы задать новый пароль.',
  magiclink: 'Введите этот код в Relik, чтобы войти без пароля.',
  invite: 'Введите этот код в Relik, чтобы принять приглашение и создать аккаунт.',
  email_change: 'Подтвердите смену почты в Relik.',
  email_change_current: 'Подтвердите смену почты: этот код относится к текущему адресу.',
  email_change_new: 'Подтвердите новую почту: этот код относится к новому адресу.',
  reauthentication: 'Введите этот код, чтобы подтвердить действие в Relik.',
  password_changed_notification: 'Пароль от вашего аккаунта Relik был изменён.',
  email_changed_notification: 'Адрес почты в вашем аккаунте Relik был изменён.',
  phone_changed_notification: 'Номер телефона в вашем аккаунте Relik был изменён.',
  identity_linked_notification: 'К аккаунту Relik привязан новый способ входа.',
  identity_unlinked_notification: 'От аккаунта Relik отвязан способ входа.',
  mfa_factor_enrolled_notification: 'Для аккаунта Relik включена двухфакторная защита.',
  mfa_factor_unenrolled_notification: 'Для аккаунта Relik отключена двухфакторная защита.',
};

const NOTIFICATIONS = new Set([
  'password_changed_notification',
  'email_changed_notification',
  'phone_changed_notification',
  'identity_linked_notification',
  'identity_unlinked_notification',
  'mfa_factor_enrolled_notification',
  'mfa_factor_unenrolled_notification',
]);

function formatCode(token) {
  const digits = String(token || '').replace(/\D/g, '');
  if (digits.length === 6) return `${digits.slice(0, 3)}-${digits.slice(3)}`;
  if (digits.length === 8) return `${digits.slice(0, 4)}-${digits.slice(4)}`;
  return String(token || '');
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function verifyUrl(emailData, tokenHash) {
  if (!SUPABASE_URL || !tokenHash) return '';
  try {
    const base = String(SUPABASE_URL).replace(/\/+$/, '');
    const url = new URL(`${base}/auth/v1/verify`);
    url.searchParams.set('token', tokenHash);
    url.searchParams.set('type', emailData.email_action_type || 'signup');
    const redirect = emailData.redirect_to || emailData.site_url || '';
    if (redirect) url.searchParams.set('redirect_to', redirect);
    return url.toString();
  } catch (e) {
    return '';
  }
}

function renderEmail(job) {
  const action = job.action;
  const isNotification = NOTIFICATIONS.has(action);
  const subject = SUBJECTS[action] || 'Код Relik';
  const intro = INTROS[action] || 'Ваш код для входа в Relik.';
  const code = isNotification ? '' : formatCode(job.token);
  const link = job.link || '';
  const support = replyTo || sender.email;

  const textLines = [`Relik — ${subject}`, '', intro, ''];
  if (code) textLines.push(`Код: ${code}`, '');
  if (link) textLines.push(`Ссылка: ${link}`, '');
  if (code) textLines.push(`Код действует ${codeTtlMinutes} минут. Никому его не сообщайте.`, '');
  textLines.push('Если вы не запрашивали это действие, просто проигнорируйте письмо.');
  if (support) textLines.push('', `Поддержка: ${support}`);
  const text = textLines.join('\n');

  const html = `<!doctype html>
<html lang="ru">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f6fb;color:#1b2230;-webkit-font-smoothing:antialiased">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f6fb;padding:28px 12px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:520px;background:#ffffff;border:1px solid #e2e6ef;border-radius:20px;padding:26px 26px 20px;font-family:Inter,Segoe UI,Arial,sans-serif">
        <tr><td>
          <div style="font-size:20px;font-weight:800;color:#5b6cf9;letter-spacing:-.02em">Relik</div>
          <h1 style="margin:18px 0 10px;font-size:22px;line-height:1.25;color:#111827;font-weight:700">${escapeHtml(subject)}</h1>
          <p style="margin:0 0 18px;font-size:15px;line-height:1.55;color:#4b5563">${escapeHtml(intro)}</p>
          ${code ? `<div style="margin:0 0 18px;padding:16px 18px;background:#f6f7fb;border:1px solid #e2e6ef;border-radius:14px;text-align:center;font-size:34px;letter-spacing:6px;font-weight:800;color:#111827">${escapeHtml(code)}</div>` : ''}
          ${link ? `<p style="margin:0 0 18px"><a href="${escapeHtml(link)}" style="display:inline-block;padding:11px 18px;border-radius:12px;background:#5b6cf9;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px">Открыть Relik</a></p>` : ''}
          ${code ? `<p style="margin:0 0 18px;font-size:13px;line-height:1.5;color:#6b7280">Код действует ${codeTtlMinutes} минут. Никому его не сообщайте.</p>` : ''}
          <p style="margin:0 0 8px;font-size:13px;line-height:1.5;color:#6b7280">Если вы не запрашивали это действие, просто проигнорируйте письмо.</p>
          ${support ? `<p style="margin:0;font-size:12px;line-height:1.5;color:#6b7280">Поддержка: ${escapeHtml(support)}</p>` : ''}
          <hr style="border:0;border-top:1px solid #e2e6ef;margin:20px 0 12px">
          <p style="margin:0;font-size:11px;line-height:1.4;color:#9aa3b2">Relik · письмо отправлено автоматически, отвечать на него не нужно.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return { subject, text: textLines.join('\n'), html };
}

/* ── отправка через Brevo ───────────────────────────────────── */
async function sendViaBrevo({ to, subject, text, html }) {
  if (dryRun) {
    log('info', 'dry-run send', { to: maskEmail(to), subject });
    return { id: 'dry_' + crypto.randomBytes(6).toString('hex') };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), brevoTimeout);
  try {
    const res = await fetch(BREVO_API_URL, {
      method: 'POST',
      headers: {
        'api-key': BREVO_API_KEY,
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        sender: { name: sender.name, email: sender.email },
        to: [{ email: to }],
        subject,
        htmlContent: html,
        textContent: text,
        ...(replyTo ? { replyTo: { email: replyTo } } : {}),
        headers: { 'X-Relik-Service': 'mail' },
      }),
      signal: ctrl.signal,
    });
    const raw = await res.text();
    if (!res.ok) {
      const err = new Error(`brevo ${res.status}: ${raw.slice(0, 240)}`);
      err.status = res.status === 429 || res.status >= 500 ? 503 : 500;
      err.retryAfter = res.status === 429 ? '60' : '';
      throw err;
    }
    let data = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch (e) { /* ignore */ }
    return { id: data.messageId || '' };
  } catch (err) {
    if (!err.status) {
      err.status = 503;
      err.retryAfter = '10';
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/* ── отправка через SMTP (Яндекс/Mail.ru) ──────────────────── */
let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  let nodemailer;
  try {
    nodemailer = require('nodemailer');
  } catch (e) {
    const err = new Error('nodemailer is not installed: run npm install --omit=dev');
    err.status = 500;
    throw err;
  }
  const port = Number(SMTP_PORT) || 465;
  const secure = /^(1|true|yes)$/i.test(String(SMTP_SECURE))
    || (!String(SMTP_SECURE).trim() && port === 465);
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port,
    secure,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    pool: true,
    maxConnections: 1,
    maxMessages: 50,
    connectionTimeout: brevoTimeout,
    greetingTimeout: Math.min(3000, brevoTimeout),
    socketTimeout: Math.max(5000, brevoTimeout),
    tls: { minVersion: 'TLSv1.2' },
  });
  return transporter;
}

async function sendViaSmtp({ to, subject, text, html }) {
  if (dryRun) {
    log('info', 'dry-run send', { to: maskEmail(to), subject, provider: 'smtp' });
    return { id: 'dry_' + crypto.randomBytes(6).toString('hex') };
  }
  const t = getTransporter();
  try {
    const info = await t.sendMail({
      from: `${sender.name} <${sender.email}>`,
      to,
      subject,
      text,
      html,
      ...(replyTo ? { replyTo } : {}),
    });
    return { id: info.messageId || '' };
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    err.status = /timeout|ETIMEDOUT|ECONNECTION|ECONNRESET|ESOCKET|ENOTFOUND|EAI_AGAIN|EDNS/i.test(msg) ? 503 : 500;
    err.retryAfter = err.status === 503 ? '10' : '';
    throw err;
  }
}

async function sendMail(job) {
  return provider === 'brevo' ? sendViaBrevo(job) : sendViaSmtp(job);
}

/* ── сборка писем из payload Supabase ───────────────────────── */
function buildJobs(payload) {
  const user = payload && payload.user ? payload.user : {};
  const emailData = payload && payload.email_data ? payload.email_data : {};
  const action = String(emailData.email_action_type || 'signup');
  const email = String(user.email || '').trim();
  const newEmail = String(user.new_email || '').trim();
  const token = String(emailData.token || '');
  const tokenNew = String(emailData.token_new || '');
  const tokenHash = String(emailData.token_hash || '');
  const tokenHashNew = String(emailData.token_hash_new || '');

  if (!isValidEmail(email) && !isValidEmail(newEmail)) {
    const err = new Error('payload has no valid email');
    err.status = 400;
    throw err;
  }

  // Смена почты: Supabase может сгенерировать два кода (Secure Email Change).
  if (action === 'email_change') {
    if (tokenNew && isValidEmail(newEmail)) {
      // Внимание: поля token_hash/token_hash_new исторически «перевёрнуты».
      return [
        {
          to: email,
          action: 'email_change_current',
          token,
          link: verifyUrl(emailData, tokenHashNew),
        },
        {
          to: newEmail,
          action: 'email_change_new',
          token: tokenNew,
          link: verifyUrl(emailData, tokenHash),
        },
      ].filter((j) => isValidEmail(j.to));
    }
    return [{
      to: isValidEmail(newEmail) ? newEmail : email,
      action: 'email_change',
      token,
      link: verifyUrl(emailData, tokenHash || tokenHashNew),
    }];
  }

  return [{
    to: isValidEmail(email) ? email : newEmail,
    action,
    token: NOTIFICATIONS.has(action) ? '' : token,
    link: NOTIFICATIONS.has(action) ? '' : verifyUrl(emailData, tokenHash),
  }];
}

/* ── HTTP ───────────────────────────────────────────────────── */
function json(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBody) {
        const err = new Error('payload too large');
        err.status = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handleHook(req, res) {
  const started = Date.now();
  let raw;
  try {
    raw = await readBody(req);
  } catch (err) {
    json(res, err.status || 400, { error: 'bad request' });
    return;
  }

  const headers = req.headers;
  if (!verifySignature(raw, headers)) {
    stats.failed += 1;
    log('warn', 'bad signature', { ip: req.socket.remoteAddress || '' });
    json(res, 401, { error: 'invalid signature' });
    return;
  }

  let payload;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch (e) {
    json(res, 400, { error: 'invalid json' });
    return;
  }

  const hookId = String(headers['webhook-id'] || '');
  const now = Date.now();
  if (hookId && sentHooks.has(hookId)) {
    stats.skipped += 1;
    json(res, 200, { ok: true, duplicate: true });
    return;
  }

  let jobs;
  try {
    jobs = buildJobs(payload);
  } catch (err) {
    stats.failed += 1;
    log('warn', 'bad payload', { error: err.message });
    json(res, 400, { error: 'invalid payload' });
    return;
  }

  const firstTo = jobs[0]?.to || '';
  if (!firstTo) {
    stats.failed += 1;
    json(res, 400, { error: 'no recipient' });
    return;
  }

  // Повторную попытку того же webhook-id не режем по лимиту.
  if (!(hookId && attemptedHooks.has(hookId))) {
    if (!hitGlobal() || !hitEmail(firstTo)) {
      stats.failed += 1;
      log('warn', 'rate limited', { to: maskEmail(firstTo), action: jobs[0].action });
      json(res, 429, { error: 'rate limited' }, { 'retry-after': '60' });
      return;
    }
    if (hookId) attemptedHooks.set(hookId, now);
  }

  stats.received += 1;
  stats.lastAt = new Date().toISOString();
  stats.lastAction = jobs[0].action;

  try {
    for (const job of jobs) {
      const jobKey = hookId ? `${hookId}:${job.to}` : '';
      if (jobKey && sentJobs.has(jobKey)) continue;
      const rendered = renderEmail(job);
      const sent = await sendMail({ to: job.to, ...rendered });
      if (jobKey) sentJobs.set(jobKey, Date.now());
      stats.sent += 1;
      log('info', 'sent', {
        to: maskEmail(job.to),
        action: job.action,
        id: sent.id || '',
        ms: Date.now() - started,
      });
    }
    if (hookId) sentHooks.set(hookId, Date.now());
    json(res, 200, { ok: true });
  } catch (err) {
    stats.failed += 1;
    log('error', 'send failed', {
      to: maskEmail(firstTo),
      action: jobs[0].action,
      status: err.status || 500,
      error: String(err.message || err).slice(0, 300),
    });
    // 429/503 Supabase повторит до 3 раз; остальное — ошибка конфигурации.
    const status = err.status === 503 ? 503 : 500;
    json(res, status, { error: 'send failed' }, status === 503 ? { 'retry-after': err.retryAfter || '60' } : {});
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'cache-control': 'no-store' });
    res.end();
    return;
  }

  if (path === '/healthz') {
    json(res, 200, {
      ok: true,
      ready,
      missing: ready ? [] : missingConfig(),
      version: VERSION,
      provider: dryRun ? 'dry-run' : provider,
      uptime: Math.round((Date.now() - STARTED) / 1000),
      received: stats.received,
      sent: stats.sent,
      failed: stats.failed,
      skipped: stats.skipped,
      lastAt: stats.lastAt,
      lastAction: stats.lastAction,
    });
    return;
  }

  if (path === '/readyz') {
    json(res, ready ? 200 : 503, { ready });
    return;
  }

  if ((path === '/hooks/send-email' || path === '/send-email') && req.method === 'POST') {
    handleHook(req, res).catch((err) => {
      stats.failed += 1;
      log('error', 'unhandled', { error: String(err && err.message ? err.message : err).slice(0, 300) });
      if (!res.headersSent) json(res, 500, { error: 'internal error' });
    });
    return;
  }

  json(res, 404, { error: 'not found' });
});

if (require.main === module) {
  server.listen(Number(PORT) || 8100, HOST, () => {
    log('info', 'listening', {
      host: HOST,
      port: Number(PORT) || 8100,
      ready,
      provider: dryRun ? 'dry-run' : provider,
      from: maskEmail(sender.email),
      replyTo: replyTo ? maskEmail(replyTo) : '',
    });
    if (!ready) {
      log('warn', 'service is not ready: check provider credentials / MAIL_FROM / SEND_EMAIL_HOOK_SECRET', {});
    }
    if (provider === 'smtp' && SMTP_USER && sender.email.toLowerCase() !== SMTP_USER.toLowerCase()) {
      log('warn', 'MAIL_FROM and SMTP_USER differ; Yandex may reject the sender', {
        from: maskEmail(sender.email),
        smtpUser: maskEmail(SMTP_USER),
      });
    }
  });

  const stop = (sig) => {
    log('info', 'stopping', { signal: sig });
    try { transporter?.close(); } catch (e) { /* ignore */ }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

module.exports = {
  server,
  buildJobs,
  formatCode,
  renderEmail,
  verifySignature,
  parseSecrets,
  parseSender,
};
