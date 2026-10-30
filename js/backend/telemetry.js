/* Relik — телеметрия ошибок и событий.
   Пишет только то, что нужно для отладки: тип события, версия, короткий контекст.
   Тексты сообщений и ключи сюда не попадают никогда. */

import { sb } from './supabaseClient.js';
import { SUPABASE, APP } from '../config.js';
import { S } from '../ui/state.js';

const MAX_PER_SESSION = 60;
const BATCH_MS = 4000;

let queue = [];
let sent = 0;
let timer = null;
let ready = null;

const real = () => !!(SUPABASE.url && SUPABASE.anonKey && sb);

function sanitize(data) {
  try {
    const s = JSON.stringify(data ?? {});
    return s.length > 1200 ? { truncated: s.slice(0, 1200) } : JSON.parse(s);
  } catch (e) {
    return { note: 'unserializable' };
  }
}

async function tableReady() {
  if (!real()) return false;
  if (ready !== null) return ready;
  try {
    const { error } = await sb.from('client_events').select('id').limit(1);
    ready = !error || !/42P01|does not exist|schema cache|relation/i.test(error.message || '');
  } catch (e) {
    ready = false;
  }
  return ready;
}

async function flush() {
  clearTimeout(timer);
  timer = null;
  if (!queue.length) return;
  if (sent >= MAX_PER_SESSION) { queue = []; return; }
  if (!(await tableReady())) { queue = []; return; }

  const batch = queue.splice(0, 20);
  sent += batch.length;
  const rows = batch.map((e) => ({
    user_id: S.me?.id || null,
    kind: String(e.kind || 'unknown').slice(0, 60),
    data: sanitize(e.data),
    app_version: APP.version,
  }));
  try {
    const { error } = await sb.from('client_events').insert(rows);
    if (error) {
      /* таблицы нет — больше не пытаемся */
      if (/42P01|does not exist|schema cache|relation/i.test(error.message || '')) ready = false;
    }
  } catch (e) { /* сеть — просто теряем батч */ }
  if (queue.length) schedule();
}

function schedule() {
  if (timer) return;
  timer = setTimeout(flush, BATCH_MS);
}

export function logEvent(kind, data = {}) {
  try {
    if (!real()) return;
    if (sent >= MAX_PER_SESSION && !queue.length) return;
    queue.push({ kind, data });
    if (queue.length >= 20) flush();
    else schedule();
  } catch (e) { /* телеметрия не должна ломать приложение */ }
}

export function initTelemetry() {
  if (!real()) return;
  window.addEventListener('error', (e) => {
    logEvent('js_error', {
      message: String(e.message || '').slice(0, 200),
      source: String(e.filename || '').split('/').pop(),
      line: e.lineno,
      col: e.colno,
    });
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    logEvent('promise_rejection', {
      message: String(r?.message || r || '').slice(0, 200),
      code: r?.code,
    });
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
  window.addEventListener('online', () => logEvent('network_online'));
  window.addEventListener('offline', () => logEvent('network_offline'));
  observeVitals();
}

/* Замер конкретной операции (открытие чата, отправка) — в миллисекундах. */
export function markTiming(name, ms, extra = {}) {
  if (!Number.isFinite(ms)) return;
  logEvent('perf_' + String(name).slice(0, 30), { ms: Math.round(ms), ...extra });
}

/* Web-vitals без зависимостей: LCP, CLS, INP-приближение, TTFB.
   Отправляем один раз — при уходе со страницы или через 15 с. */
function observeVitals() {
  const nav = performance.getEntriesByType?.('navigation')?.[0];
  if (nav) {
    logEvent('perf_nav', {
      ttfb: Math.round(nav.responseStart || 0),
      dcl: Math.round(nav.domContentLoadedEventEnd || 0),
      load: Math.round(nav.loadEventEnd || 0),
      transfer: nav.transferSize || 0,
    });
  }

  let lcp = 0;
  let cls = 0;
  let inp = 0;

  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) lcp = Math.max(lcp, e.startTime);
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch (e) { /* Safari < 14.5 */ }

  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (!e.hadRecentInput) cls += e.value;
    }).observe({ type: 'layout-shift', buffered: true });
  } catch (e) { /* нет LayoutShift */ }

  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) inp = Math.max(inp, e.duration);
    }).observe({ type: 'event', durationThreshold: 40, buffered: true });
  } catch (e) { /* нет Event Timing */ }

  let reported = false;
  const report = () => {
    if (reported) return;
    reported = true;
    logEvent('perf_vitals', {
      lcp: Math.round(lcp),
      cls: Number(cls.toFixed(3)),
      inp: Math.round(inp),
      heap: performance.memory?.usedJSHeapSize || 0,
      v: APP.version,
    });
  };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') report();
  });
  setTimeout(report, 15000);
}
