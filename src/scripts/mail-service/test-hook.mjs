#!/usr/bin/env node
/*
 * Локальная проверка mail-service без Supabase.
 *
 * Пример:
 *   SEND_EMAIL_HOOK_SECRET='v1,whsec_...' TO_EMAIL='you@yandex.ru' \
 *     node test-hook.mjs
 *
 * Переменные:
 *   MAIL_SERVICE_URL  — по умолчанию http://127.0.0.1:8100/hooks/send-email
 *   SEND_EMAIL_HOOK_SECRET — тот же секрет, что в env сервиса
 *   TO_EMAIL          — куда отправить тестовое письмо
 *   ACTION            — signup | recovery | magiclink | reauthentication | email_change
 *   NEW_EMAIL         — для ACTION=email_change
 *   WEBHOOK_ID        — повторить тот же id (проверка idempotency)
 */
import crypto from 'node:crypto';

const {
  MAIL_SERVICE_URL = 'http://127.0.0.1:8100/hooks/send-email',
  SEND_EMAIL_HOOK_SECRET = '',
  TO_EMAIL = '',
  ACTION = 'signup',
  NEW_EMAIL = '',
  WEBHOOK_ID = '',
  SUPABASE_URL = 'https://example.supabase.co',
} = process.env;

if (!SEND_EMAIL_HOOK_SECRET) {
  console.error('SEND_EMAIL_HOOK_SECRET is required');
  process.exit(1);
}
if (!TO_EMAIL) {
  console.error('TO_EMAIL is required');
  process.exit(1);
}

const secret = SEND_EMAIL_HOOK_SECRET.replace(/^v1,whsec_/i, '').replace(/^whsec_/i, '');
const key = Buffer.from(secret, 'base64');
if (key.length < 16) {
  console.error('SEND_EMAIL_HOOK_SECRET is not valid base64 / too short');
  process.exit(1);
}

const token = String(Math.floor(100000 + Math.random() * 900000));
const tokenNew = String(Math.floor(100000 + Math.random() * 900000));
const emailData = {
  token,
  token_hash: crypto.randomBytes(20).toString('hex'),
  redirect_to: 'https://alexhu34.github.io/relik/',
  email_action_type: ACTION,
  site_url: 'https://alexhu34.github.io/relik/',
  token_new: '',
  token_hash_new: '',
  old_email: '',
  old_phone: '',
  provider: '',
  factor_type: '',
};

const user = {
  id: crypto.randomUUID(),
  aud: 'authenticated',
  role: 'authenticated',
  email: TO_EMAIL,
  phone: '',
  app_metadata: { provider: 'email', providers: ['email'] },
  user_metadata: { email: TO_EMAIL, email_verified: false, sub: crypto.randomUUID() },
  identities: [],
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  is_anonymous: false,
};

if (ACTION === 'email_change' && NEW_EMAIL) {
  emailData.token_new = tokenNew;
  emailData.token_hash_new = crypto.randomBytes(20).toString('hex');
  user.new_email = NEW_EMAIL;
}

const payload = { user, email_data: emailData };
const body = JSON.stringify(payload);
const id = WEBHOOK_ID || 'msg_' + crypto.randomUUID();
const ts = String(Math.floor(Date.now() / 1000));
const signature = crypto
  .createHmac('sha256', key)
  .update(`${id}.${ts}.${body}`)
  .digest('base64');

const res = await fetch(MAIL_SERVICE_URL, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'webhook-id': id,
    'webhook-timestamp': ts,
    'webhook-signature': `v1,${signature}`,
  },
  body,
});

const text = await res.text();
console.log(`HTTP ${res.status}`);
console.log(text);
console.log(`\nКод в этом тесте: ${token.slice(0, 3)}-${token.slice(3)} (только для логов, не для продакшена)`);
console.log(`Supabase URL (для проверки ссылки): ${SUPABASE_URL}`);
if (!res.ok) process.exit(2);
