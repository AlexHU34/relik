/* Relik — метка «из кэша».
   Когда сеть пропала (или сервер не ответил), лента показывается из IndexedDB.
   Это надо говорить прямо: иначе человек думает, что чат «замер», и не понимает,
   почему новые сообщения не приходят. Метка живёт в строке статуса под именем
   чата (как «connecting…» в Telegram) и гаснет сама после удачной загрузки. */
import { t } from '../i18n/i18n.js';
import { SUPABASE } from '../config.js';

const isReal = () => Boolean(SUPABASE.url && SUPABASE.anonKey);

let cached = false;
let wired = false;
const listeners = new Set();

/* Показывать ли метку: реальный бэкенд и (нет сети или последняя загрузка упала).
   В демо-режиме всё локально по определению — метка бессмысленна. */
export function isCached() {
  return isReal() && (cached || navigator.onLine === false);
}

/* « · из кэша» дописывается к строке статуса шапки чата.
   Возвращает итоговый текст (из него собирается aria-label кнопки). */
export function decorateStatus(el) {
  if (!el) return '';
  const hint = isCached() ? t(navigator.onLine === false ? 'net.offlineHint' : 'net.cachedHint') : '';
  let text = el.textContent;
  if (hint) {
    text += ' · ' + t('net.cached');
    el.title = hint;
  } else {
    el.removeAttribute('title');
  }
  el.textContent = text;
  return text;
}

export function onNetChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify() {
  for (const fn of listeners) {
    try { fn(isCached()); } catch (e) { /* ignore */ }
  }
}

/* Загрузка из бэкенда не удалась — показываем то, что есть на диске. */
export function markCached() {
  if (cached) return;
  cached = true;
  notify();
}

/* Сервер ответил — метка больше не нужна. */
export function markLive() {
  if (!cached) return;
  cached = false;
  notify();
}

export function initNetBadge(onChange) {
  if (onChange) listeners.add(onChange);
  if (wired) return;
  wired = true;
  window.addEventListener('offline', () => { cached = true; notify(); });
  /* Сеть вернулась: метку снимаем не сразу, а после первой удачной загрузки —
     иначе она соврёт, пока история ещё лежит в кэше. */
  window.addEventListener('online', notify);
  document.addEventListener('relik:lang', notify);
}
