/* Relik — сетевые помощники авторизации.
   Вынесено из backend/auth.js, чтобы модуль входа не разрастался:
   таймауты, повтор только для сетевых ошибок и человеческие тексты ошибок.
   Ничего не знает про конкретные запросы — только про транспорт. */

import { ensureClient } from './supabaseClient.js';

/* Сетевые вызовы Supabase не должны вешать вход навсегда:
   на медленной/заблокированной сети запрос может висеть без ответа. */
export function withTimeout(promise, ms = 15000, label = 'timeout') {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Повторяем только сетевые/5xx/429: пароль и «уже занято» повторять нельзя. */
export function isRetryable(err) {
  const msg = String(err?.message || err || '');
  const code = String(err?.code || err?.status || '');
  return /fetch|network|timeout|abort|load failed|failed to fetch|503|502|504|429/i.test(msg)
    || /^(429|5\d\d)$/.test(code);
}

export async function withRetry(fn, tries = 3, delays = [400, 1200]) {
  let last = null;
  for (let i = 0; i < tries; i += 1) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (!isRetryable(err) || i === tries - 1) break;
      await sleep(delays[Math.min(i, delays.length - 1)]);
    }
  }
  throw last;
}

/** Гарантирует загруженный SDK; без бэкенда/сети — понятная ошибка. */
export async function requireClient() {
  const c = await ensureClient();
  if (!c) throw new Error('Сеть недоступна: клиент Supabase не загрузился');
  return c;
}

/* Понятный текст вместо технического. UI может показать как есть. */
export function authErrorMessage(err) {
  const msg = String(err?.message || err || '');
  const code = String(err?.code || '');
  if (/invalid login credentials|invalid_credentials/i.test(msg)) return 'Неверный email или пароль';
  if (/email not confirmed|not confirmed/i.test(msg)) return 'Email не подтверждён — введите код из письма';
  if (/user already registered|already been registered|23505/i.test(msg)) return 'Этот email уже зарегистрирован. Войдите.';
  if (/password should be at least|weak.?password/i.test(msg)) return 'Пароль слишком короткий — минимум 6 символов';
  if (/rate limit|too many|429/i.test(msg) || code === '429') return 'Слишком много попыток. Подождите минуту.';
  if (/fetch|network|timeout|abort|load failed|offline/i.test(msg)) return 'Нет связи с сервером. Проверьте интернет и попробуйте снова.';
  if (/signup.*disabled|signups not allowed/i.test(msg)) return 'Регистрация временно закрыта';
  if (/username/i.test(msg) && /taken|unique|23505/i.test(msg + code)) return 'Этот @username уже занят';
  return msg || 'Не удалось выполнить вход';
}
