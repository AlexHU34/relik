/* Relik — мягкое восстановление после ошибок интерфейса.
   Ошибки после успешного запуска не должны молча исчезать в консоли:
   показываем спокойную плашку с «Перезагрузить» и ссылкой на проверку.
   Телеметрия (`backend/telemetry.js`) продолжает работать отдельно. */
import { $ } from './utils.js';
import { icon } from './icons.js';
import { t } from '../i18n/i18n.js';
import { APP } from '../config.js';

/* Ошибки, которые не означают поломку приложения */
const IGNORE = [
  /ResizeObserver loop/i,
  /AbortError/i,
  /The play\(\) request was interrupted/i,
  /The operation was aborted/i,
  /Load failed/i,
  /Failed to fetch/i,
  /NetworkError/i,
  /NotAllowedError/i,
  /Permission denied/i,
  /cancelled/i,
  /canceled/i,
];

const THROTTLE_MS = 6000;
let lastAt = 0;
let hideTimer = 0;
let shownCount = 0;

function hide() {
  clearTimeout(hideTimer);
  const bar = $('#recoverBar');
  if (bar) bar.hidden = true;
}

function show(message) {
  const bar = $('#recoverBar');
  if (!bar) return;
  const title = $('#rbTitle');
  const text = $('#rbText');
  if (title) title.textContent = t('recovery.title');
  if (text) text.textContent = t('recovery.text');
  bar.hidden = false;
  clearTimeout(hideTimer);
  hideTimer = setTimeout(hide, 15000);
  console.warn('Relik UI recovered from:', message);
}

function report(message) {
  /* До `bootDone()` фатальные ошибки показывает заглушка загрузки */
  if (!window.__relikLoaded) return;
  const msg = String(message || '').replace(/\s+/g, ' ').trim();
  if (!msg || IGNORE.some((r) => r.test(msg))) return;

  const now = Date.now();
  if (now - lastAt < THROTTLE_MS) return;
  lastAt = now;
  shownCount += 1;

  /* Короткий след для страницы проверки и поддержки — без текстов сообщений */
  try {
    localStorage.setItem('relik.lastError', JSON.stringify({
      message: msg.slice(0, 240),
      at: new Date(now).toISOString(),
      version: APP.version,
      count: shownCount,
    }));
  } catch (e) { /* приватный режим */ }

  show(msg);
}

export function initRecovery() {
  const bar = $('#recoverBar');
  if (!bar) return;

  const ic = $('#rbIc');
  if (ic) ic.innerHTML = icon('alert', 16);
  const close = $('#rbX');
  if (close) {
    close.innerHTML = icon('x', 15);
    close.addEventListener('click', hide);
  }
  $('#rbReload')?.addEventListener('click', () => location.reload());

  window.addEventListener('error', (e) => {
    /* ошибки ресурсов (img/script) разбирает заглушка загрузки */
    if (e?.target && e.target !== window) return;
    report(e?.message || e?.error?.message);
  });

  window.addEventListener('unhandledrejection', (e) => {
    const r = e?.reason;
    report(typeof r === 'string' ? r : r?.message);
  });
}

/* Для диагностики из консоли: что запомнили последним */
export function lastClientError() {
  try {
    return JSON.parse(localStorage.getItem('relik.lastError') || 'null');
  } catch (e) {
    return null;
  }
}
