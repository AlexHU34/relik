/* Relik push sender (pull-модель).
   Сервис сам опрашивает public.push_queue через service_role и рассылает
   беззвучные уведомления участникам чата. Входящий HTTPS не нужен.

   Переменные окружения (/etc/relik-push.env):
     SUPABASE_URL, SUPABASE_SERVICE_KEY, VAPID_PUBLIC, VAPID_PRIVATE,
     VAPID_SUBJECT, PORT (для /healthz) */
'use strict';

const http = require('node:http');
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
  return res.status === 204 ? null : res.json();
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
