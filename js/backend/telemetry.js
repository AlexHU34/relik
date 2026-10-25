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
}
