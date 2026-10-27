/* Relik push sender (pull-модель) + мониторинг.
   Сервис сам опрашивает public.push_queue через service_role и рассылает
   беззвучные уведомления участникам чата. Входящий HTTPS не нужен.

   Переменные окружения (/etc/relik-push.env):
     SUPABASE_URL, SUPABASE_SERVICE_KEY, VAPID_PUBLIC, VAPID_PRIVATE,
     VAPID_SUBJECT, PORT (для /healthz)

   Мониторинг (всё опционально, по умолчанию включён):
     MONITOR=0                — выключить проверки
     MONITOR_INTERVAL=60000   — период проверок, мс
     MONITOR_FRONT=https://alexhu34.github.io/relik/index.html
     MONITOR_VERSION_URL=https://alexhu34.github.io/relik/version.json
     SUPABASE_ANON_KEY=...    — если задан, проверки идут от anon (как у клиента)
     TELEGRAM_BOT_TOKEN=...   — алерты в Telegram
     TELEGRAM_CHAT_ID=...     — куда слать (личный chat_id или -100...)
     ALERT_AFTER=2            — сколько подряд неудач считать сбоем

   Что пишет:
     service_status  — последний срез (приложение читает в tools/status.html);
     service_samples — история раз в 5 минут для процента доступности.
   Если таблицы service_samples нет, сервис просто работает без истории. */
'use strict';

const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const webpush = require('web-push');

const {
  SUPABASE_URL = '',
  SUPABASE_SERVICE_KEY = '',
  VAPID_PUBLIC = '',
  VAPID_PRIVATE = '',
  VAPID_SUBJECT = 'mailto:admin@relik.local',
  PORT = '8099',
  INTERVAL = '3000',
  MONITOR = '1',
  MONITOR_INTERVAL = '60000',
  MONITOR_FRONT = 'https://alexhu34.github.io/relik/index.html',
  MONITOR_VERSION_URL = 'https://alexhu34.github.io/relik/version.json',
  SUPABASE_ANON_KEY = '',
  TELEGRAM_BOT_TOKEN = '',
  TELEGRAM_CHAT_ID = '',
  ALERT_AFTER = '2',
} = process.env;

const ready = Boolean(SUPABASE_URL && SUPABASE_SERVICE_KEY && VAPID_PUBLIC && VAPID_PRIVATE);
if (ready) webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

/* Ключ для проверок: лучше anon — тогда видно и поломку RLS. */
const PROBE_KEY = SUPABASE_ANON_KEY || SUPABASE_SERVICE_KEY;
const AGENT_VERSION = '1.2.0';

const stats = { started: Date.now(), processed: 0, sent: 0, errors: 0, lastAt: null, queueDepth: null };

async function sb(pathname, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}${pathname}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`supabase ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

async function processOne(job) {
  const members = await sb(`/rest/v1/conversation_members?select=user_id&conversation_id=eq.${job.chat_id}`);
  const targets = (members || [])
    .map((m) => m.user_id)
    .filter((id) => id && id !== job.from_user);
  if (!targets.length) return { sent: 0 };

  const list = targets.map((id) => `"${id}"`).join(',');
  const subs = await sb(`/rest/v1/push_subs?select=id,endpoint,p256dh,auth&user_id=in.(${encodeURIComponent(list)})`);
  if (!subs || !subs.length) return { sent: 0 };

  const payload = JSON.stringify({
    title: 'Relik',
    body: 'Новое сообщение',
    url: `./#/chat/${job.chat_id}`,
    tag: `chat-${job.chat_id}`,
  });

  let sent = 0;
  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload,
        { TTL: 600 },
      );
      sent += 1;
      await sb(`/rest/v1/push_subs?id=eq.${sub.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ last_ok: new Date().toISOString() }),
      }).catch(() => {});
    } catch (err) {
      const code = err && err.statusCode;
      if (code === 404 || code === 410) {
        await sb(`/rest/v1/push_subs?id=eq.${sub.id}`, { method: 'DELETE' }).catch(() => {});
      } else {
        stats.errors += 1;
      }
    }
  }
  return { sent };
}

async function tick() {
  if (!ready) return;
  try {
    const jobs = await sb('/rest/v1/push_queue?select=id,chat_id,from_user,tries&order=id.asc&limit=20');
    stats.queueDepth = (jobs || []).length;
    for (const job of jobs || []) {
      let ok = false;
      try {
        const res = await processOne(job);
        stats.sent += res.sent;
        ok = true;
      } catch (err) {
        stats.errors += 1;
        console.warn('job failed', job.id, err.message);
      }
      const tries = (job.tries || 0) + 1;
      if (ok || tries >= 3) {
        await sb(`/rest/v1/push_queue?id=eq.${job.id}`, { method: 'DELETE' }).catch(() => {});
        stats.processed += 1;
        stats.lastAt = new Date().toISOString();
      } else {
        await sb(`/rest/v1/push_queue?id=eq.${job.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ tries }),
        }).catch(() => {});
      }
    }
  } catch (err) {
    stats.errors += 1;
    console.warn('poll failed:', err.message);
  }
}

setInterval(tick, Number(INTERVAL));
tick();

/* ── Инструменты проверок ─────────────────────────────────── */

function portOpen(host, port, timeout = 1500) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (ok) => { try { sock.destroy(); } catch (e) {} resolve(ok); };
    sock.setTimeout(timeout);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

function backupAgeHours() {
  try {
    /* ВАЖНО: backup-db.sh пишет .dump, более старые версии — .dump.gz.
       Раньше здесь был только .dump.gz, поэтому статус всегда показывал
       «бэкапов не найдено». */
    const files = fs.readdirSync(BACKUP_DIR).filter((f) => /\.dump(\.gz)?$/.test(f));
    if (!files.length) return null;
    let newest = 0;
    for (const f of files) {
      const st = fs.statSync(path.join(BACKUP_DIR, f));
      newest = Math.max(newest, st.mtimeMs);
    }
    return Math.round(((Date.now() - newest) / 36e5) * 10) / 10;
  } catch (e) {
    return null;
  }
}

function diskFreeGb() {
  try {
    const st = fs.statfsSync('/');
    return Math.round((st.bavail * st.bsize) / 1e9 * 100) / 100;
  } catch (e) {
    return null;
  }
}

const BACKUP_DIR = '/var/backups/relik';

async function probeHttp(name, url, { headers = {}, bodyCheck = false, timeout = 12000 } = {}, validate) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      headers,
      cache: 'no-store',
      signal: AbortSignal.timeout(timeout),
    });
    const body = bodyCheck ? await res.text() : '';
    const ms = Date.now() - t0;
    const ok = res.ok && (!validate || validate(res, body));
    return { name, ok, ms, status: res.status, error: ok ? null : `HTTP ${res.status}`, body };
  } catch (err) {
    return { name, ok: false, ms: Date.now() - t0, status: 0, error: (err && err.message) || 'fetch failed' };
  }
}

/* Проверка Realtime: реальный WebSocket-handshake, а не просто HTTP.
   Именно здесь чаще всего «сообщения не приходят». */
function probeRealtime(timeout = 12000) {
  return new Promise((resolve) => {
    if (typeof WebSocket !== 'function') return resolve({ name: 'realtime', ok: null, ms: null, error: 'node без WebSocket' });
    const wsUrl = SUPABASE_URL.replace(/^http/, 'ws') + `/realtime/v1/websocket?apikey=${encodeURIComponent(PROBE_KEY)}&vsn=1.0.0`;
    const t0 = Date.now();
    let done = false;
    let ws;
    const finish = (ok, error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws && ws.close(); } catch (e) { /* ignore */ }
      resolve({ name: 'realtime', ok, ms: Date.now() - t0, error: error || null });
    };
    const timer = setTimeout(() => finish(false, 'timeout'), timeout);
    try {
      ws = new WebSocket(wsUrl);
      ws.onopen = () => finish(true);
      ws.onerror = () => finish(false, 'ws error');
      ws.onclose = () => finish(false, 'closed before open');
    } catch (err) {
      finish(false, (err && err.message) || 'ws throw');
    }
  });
}

async function probeFront() {
  const page = await probeHttp('front', MONITOR_FRONT, {
    bodyCheck: true,
    timeout: 15000,
  }, (res, body) => body.includes('Relik'));
  const ver = await probeHttp('version', MONITOR_VERSION_URL, { bodyCheck: true, timeout: 15000 });
  let version = null;
  try { version = JSON.parse(ver.body).version || null; } catch (e) { /* ignore */ }
  return { page, version, versionOk: ver.ok && !!version };
}

async function probeSupabase() {
  const h = { apikey: PROBE_KEY, Authorization: `Bearer ${PROBE_KEY}` };
  const [auth, rest, storage] = await Promise.all([
    probeHttp('auth', `${SUPABASE_URL}/auth/v1/health`, { headers: h }),
    probeHttp('rest', `${SUPABASE_URL}/rest/v1/profiles?select=id&limit=1`, { headers: h }),
    probeHttp('storage', `${SUPABASE_URL}/storage/v1/bucket`, { headers: h }),
  ]);
  const realtime = await probeRealtime();
  return { auth, rest, storage, realtime };
}

/* ── Состояние, алерты, история ───────────────────────────── */

const CHECKS = ['front', 'auth', 'rest', 'storage', 'realtime', 'turn'];
const state = new Map(); // check -> { ok, since, streak, lastAlertAt }
const lastProbe = new Map();
const ring = []; // { t, ok, checks }
const RING_MAX = 288; // сутки при опросе раз в 5 минут

function noteState(name, ok) {
  const now = Date.now();
  const prev = state.get(name) || { ok: null, since: now, streak: 0, lastAlertAt: 0 };
  const threshold = Math.max(1, Number(ALERT_AFTER) || 2);
  prev.streak = ok
    ? (prev.streak > 0 ? prev.streak + 1 : 1)
    : (prev.streak < 0 ? prev.streak - 1 : -1);

  if (ok && prev.streak >= threshold && prev.ok !== true) {
    const downMs = prev.ok === false ? now - prev.since : 0;
    prev.ok = true;
    prev.since = now;
    state.set(name, prev);
    alert(name, true, downMs).catch(() => {});
    return;
  }
  if (!ok && prev.streak <= -threshold && prev.ok !== false) {
    prev.ok = false;
    prev.since = now;
    state.set(name, prev);
    alert(name, false, 0).catch(() => {});
    return;
  }
  state.set(name, prev);
}

async function alert(name, up, downMs) {
  const label = {
    front: 'сайт (GitHub Pages)',
    auth: 'вход (Supabase Auth)',
    rest: 'база данных (Supabase REST)',
    storage: 'файлы (Storage)',
    realtime: 'realtime-доставка',
    turn: 'TURN (звонки)',
  }[name] || name;
  const prev = state.get(name);
  if (prev && Date.now() - (prev.lastAlertAt || 0) < 60_000) return;
  if (prev) prev.lastAlertAt = Date.now();
  const text = up
    ? `🟢 Relik: ${label} снова работает${downMs > 60000 ? ` (сбой ${Math.round(downMs / 60000)} мин)` : ''}`
    : `🔴 Relik: ${label} не отвечает`;
  console.warn(text);
  await sendTelegram(text);
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    console.warn('telegram alert failed:', err.message);
  }
}

function uptimePercent(list) {
  if (!list.length) return null;
  const ok = list.filter((x) => x.ok).length;
  return Math.round((ok / list.length) * 1000) / 10;
}

async function runMonitor() {
  const started = Date.now();
  const [frontRes, sbRes, turnOk] = await Promise.all([
    probeFront(),
    probeSupabase(),
    portOpen('127.0.0.1', 3478),
  ]);

  const results = {
    front: frontRes.page,
    auth: sbRes.auth,
    rest: sbRes.rest,
    storage: sbRes.storage,
    realtime: sbRes.realtime,
    turn: { name: 'turn', ok: turnOk, ms: null, error: turnOk ? null : 'port 3478 closed' },
  };

  for (const name of CHECKS) {
    const r = results[name];
    lastProbe.set(name, r);
    noteState(name, r.ok === true);
  }

  const coreOk = results.front.ok && results.auth.ok && results.rest.ok;
  ring.push({ t: started, ok: coreOk });
  if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);

  return { results, coreOk, version: frontRes.version, versionOk: frontRes.versionOk };
}

/* ── Запись среза в Supabase ──────────────────────────────── */

let lastStatus = null;
let lastStatusAt = 0;
let lastSampleAt = 0;
let lastPruneAt = 0;
let warnedHistory = false;

function statusBody(snapshot) {
  const r = snapshot.results;
  return {
    id: 1,
    checked_at: new Date().toISOString(),
    /* базовые поля — их читает tools/status.html с прошлых версий */
    supabase_ok: r.rest.ok,
    supabase_ms: r.rest.ms,
    turn_ok: r.turn.ok === true,
    disk_free_gb: diskFreeGb(),
    backup_age_h: backupAgeHours(),
    queue_depth: stats.queueDepth,
    push_ready: stats.errors === 0 || stats.sent > 0,
    agent_version: AGENT_VERSION,
    note: stats.errors ? `errors: ${stats.errors}` : null,
    /* расширенные (нужны service_status.sql / service_uptime.sql) */
    front_ok: r.front.ok,
    front_ms: r.front.ms,
    front_version: snapshot.version,
    auth_ok: r.auth.ok,
    auth_ms: r.auth.ms,
    storage_ok: r.storage.ok,
    storage_ms: r.storage.ms,
    realtime_ok: r.realtime.ok,
    realtime_ms: r.realtime.ms,
    uptime_24h: uptimePercent(ring),
    checks: Object.fromEntries(CHECKS.map((n) => [n, {
      ok: r[n].ok,
      ms: r[n].ms,
      error: r[n].error || undefined,
    }])),
  };
}

const CORE_FIELDS = ['id', 'checked_at', 'supabase_ok', 'supabase_ms', 'turn_ok', 'disk_free_gb',
  'backup_age_h', 'queue_depth', 'push_ready', 'agent_version', 'note'];

async function writeStatus(snapshot) {
  const body = statusBody(snapshot);
  try {
    await sb('/rest/v1/service_status?on_conflict=id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(body),
    });
    lastStatus = body;
    lastStatusAt = Date.now();
    return true;
  } catch (err) {
    /* Старая схема (без расширенных колонок) не должна ломать статус:
       отступаем к базовому набору полей. */
    try {
      const core = {};
      for (const k of CORE_FIELDS) core[k] = body[k];
      await sb('/rest/v1/service_status?on_conflict=id', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(core),
      });
      lastStatus = core;
      lastStatusAt = Date.now();
      if (!writeStatus._warned) {
        writeStatus._warned = true;
        console.warn('расширенные поля статуса не приняты — выполните supabase/service_uptime.sql');
      }
      return true;
    } catch (err2) {
      console.warn('status write failed:', err.message, '/', err2.message);
      return false;
    }
  }
}

async function writeSample(snapshot) {
  if (Date.now() - lastSampleAt < 5 * 60_000) return;
  lastSampleAt = Date.now();
  try {
    const down = CHECKS.filter((n) => snapshot.results[n].ok === false);
    await sb('/rest/v1/service_samples', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        ok: snapshot.coreOk,
        rest_ms: snapshot.results.rest.ms,
        front_ms: snapshot.results.front.ms,
        down,
        ver: snapshot.version,
      }),
    });
    if (!warnedHistory) {
      warnedHistory = true;
      console.log('история доступности пишется в service_samples');
    }
  } catch (err) {
    if (!warnedHistory) {
      warnedHistory = true;
      console.warn('история недоступна (нет service_samples?) — выполните supabase/service_uptime.sql');
    }
  }
  /* Чистка истории: раз в сутки, 30 дней */
  if (Date.now() - lastPruneAt > 24 * 3600_000) {
    lastPruneAt = Date.now();
    const cutoff = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();
    await sb(`/rest/v1/service_samples?ts=lt.${cutoff}`, { method: 'DELETE' }).catch(() => {});
  }
}

/* ── Цикл мониторинга ─────────────────────────────────────── */

async function monitorTick() {
  if (!ready || MONITOR === '0') return;
  try {
    const snapshot = await runMonitor();
    await writeStatus(snapshot);
    await writeSample(snapshot);
  } catch (err) {
    console.warn('monitor failed:', err.message);
  }
}

if (MONITOR !== '0') {
  const every = Math.max(30_000, Number(MONITOR_INTERVAL) || 60_000);
  setInterval(monitorTick, every);
  monitorTick();
}

/* ── Ночное обслуживание: чистка по расписанию ─────────────── */
let lastMaintenance = 0;
async function maintenance() {
  if (!ready) return;
  if (Date.now() - lastMaintenance < 6 * 3600_000) return;
  const hour = new Date().getHours();
  if (hour !== 4) return;
  lastMaintenance = Date.now();
  try {
    await sb('/rest/v1/rpc/relik_maintenance', { method: 'POST', body: '{}' });
    console.log('maintenance ok');
  } catch (e) {
    console.warn('maintenance failed:', e.message);
  }
}
setInterval(maintenance, 30 * 60_000);

/* ── /healthz ─────────────────────────────────────────────── */

http.createServer((req, res) => {
  if (req.url === '/healthz') {
    const checks = {};
    for (const name of CHECKS) {
      const r = lastProbe.get(name);
      checks[name] = r ? { ok: r.ok, ms: r.ms, error: r.error || null } : null;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      ready,
      uptime: Math.round((Date.now() - stats.started) / 1000),
      processed: stats.processed,
      sent: stats.sent,
      errors: stats.errors,
      lastAt: stats.lastAt,
      lastStatusAt: lastStatusAt ? new Date(lastStatusAt).toISOString() : null,
      uptime24h: uptimePercent(ring),
      checks,
    }));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end('{"error":"not found"}');
}).listen(Number(PORT), '127.0.0.1', () => {
  console.log(`relik-push pull-mode on 127.0.0.1:${PORT}, ready=${ready}`);
});
