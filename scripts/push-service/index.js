/* Relik push sender (pull-модель).
   Сервис сам опрашивает public.push_queue через service_role и рассылает
   беззвучные уведомления участникам чата. Входящий HTTPS не нужен.

   Переменные окружения (/etc/relik-push.env):
     SUPABASE_URL, SUPABASE_SERVICE_KEY, VAPID_PUBLIC, VAPID_PRIVATE,
     VAPID_SUBJECT, PORT (для /healthz) */
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
} = process.env;

const ready = Boolean(SUPABASE_URL && SUPABASE_SERVICE_KEY && VAPID_PUBLIC && VAPID_PRIVATE);
if (ready) webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

const stats = { started: Date.now(), processed: 0, sent: 0, errors: 0, lastAt: null };

async function sb(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
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

/* ── Состояние сервера в Supabase ───────────────────────────
   Раз в минуту пишем агрегаты в service_status: приложение читает их
   и показывает, жив ли VPS, TURN и когда был последний бэкап. */
const STATUS_INTERVAL = 60_000;
const BACKUP_DIR = '/var/backups/relik';

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
    const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.dump.gz'));
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

async function writeStatus() {
  if (!ready) return;
  let supabaseOk = false;
  let supabaseMs = null;
  try {
    const t0 = Date.now();
    await sb('/rest/v1/profiles?select=id&limit=1');
    supabaseMs = Date.now() - t0;
    supabaseOk = true;
  } catch (e) {
    supabaseOk = false;
  }

  let queueDepth = null;
  try {
    const rows = await sb('/rest/v1/push_queue?select=id');
    queueDepth = Array.isArray(rows) ? rows.length : null;
  } catch (e) { /* ignore */ }

  const body = {
    id: 1,
    checked_at: new Date().toISOString(),
    supabase_ok: supabaseOk,
    supabase_ms: supabaseMs,
    turn_ok: await portOpen('127.0.0.1', 3478),
    disk_free_gb: diskFreeGb(),
    backup_age_h: backupAgeHours(),
    queue_depth: queueDepth,
    push_ready: stats.errors === 0 || stats.sent > 0,
    agent_version: '1.1.0',
    note: stats.errors ? `errors: ${stats.errors}` : null,
  };

  try {
    await sb('/rest/v1/service_status?on_conflict=id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.warn('status write failed:', e.message);
  }
}

setInterval(writeStatus, STATUS_INTERVAL);
writeStatus();

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
maintenance();

http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      ready,
      uptime: Math.round((Date.now() - stats.started) / 1000),
      processed: stats.processed,
      sent: stats.sent,
      errors: stats.errors,
      lastAt: stats.lastAt,
    }));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end('{"error":"not found"}');
}).listen(Number(PORT), '127.0.0.1', () => {
  console.log(`relik-push pull-mode on 127.0.0.1:${PORT}, ready=${ready}`);
});
