/* Relik push sender.
   Принимает POST /notify от клиента-отправителя, проверяет JWT через Supabase,
   находит подписки участников чата и отправляет беззвучные уведомления.

   Переменные окружения (/etc/relik-push.env):
     SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_KEY
     VAPID_PUBLIC, VAPID_PRIVATE, VAPID_SUBJECT (mailto:...)
     PORT (по умолчанию 8099)
*/
'use strict';

const http = require('node:http');
const webpush = require('web-push');

const {
  SUPABASE_URL = '',
  SUPABASE_ANON_KEY = '',
  SUPABASE_SERVICE_KEY = '',
  VAPID_PUBLIC = '',
  VAPID_PRIVATE = '',
  VAPID_SUBJECT = 'mailto:admin@example.com',
  PORT = '8099',
} = process.env;

const ready = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY && SUPABASE_SERVICE_KEY && VAPID_PUBLIC && VAPID_PRIVATE);
if (ready) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
}

const hits = new Map(); // user_id -> [timestamps]

function limited(uid) {
  const now = Date.now();
  const list = (hits.get(uid) || []).filter((t) => now - t < 60_000);
  list.push(now);
  hits.set(uid, list);
  return list.length > 20;
}

function json(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(data);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 10_000) throw new Error('too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

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

async function whoami(token) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error('unauthorized');
  const user = await res.json();
  if (!user || !user.id) throw new Error('unauthorized');
  return user.id;
}

async function notify(req, res) {
  const auth = String(req.headers.authorization || '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return json(res, 401, { error: 'no token' });

  let uid;
  try {
    uid = await whoami(token);
  } catch (e) {
    return json(res, 401, { error: 'unauthorized' });
  }

  if (limited(uid)) return json(res, 429, { error: 'rate limited' });

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (e) {
    return json(res, 400, { error: 'bad json' });
  }

  const chatId = String(body.chatId || '');
  if (!chatId) return json(res, 400, { error: 'no chatId' });

  /* участник ли отправитель */
  const mine = await sb(`/rest/v1/conversation_members?select=user_id&conversation_id=eq.${chatId}&user_id=eq.${uid}`);
  if (!mine || !mine.length) return json(res, 403, { error: 'not a member' });

  const members = await sb(`/rest/v1/conversation_members?select=user_id&conversation_id=eq.${chatId}`);
  const targets = (members || []).map((m) => m.user_id).filter((id) => id && id !== uid);
  if (!targets.length) return json(res, 200, { sent: 0 });

  const list = targets.map((id) => `"${id}"`).join(',');
  const subs = await sb(`/rest/v1/push_subs?select=id,endpoint,p256dh,auth&user_id=in.(${encodeURIComponent(list)})`);
  if (!subs || !subs.length) return json(res, 200, { sent: 0, subscribers: 0 });

  const payload = JSON.stringify({
    title: 'Relik',
    body: 'Новое сообщение',
    url: `./#/chat/${chatId}`,
    tag: `chat-${chatId}`,
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
    } catch (err) {
      const code = err && err.statusCode;
      if (code === 404 || code === 410) {
        await sb(`/rest/v1/push_subs?id=eq.${sub.id}`, { method: 'DELETE' }).catch(() => {});
      }
    }
  }
  return json(res, 200, { sent, subscribers: subs.length });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') {
    return json(res, 200, {
      ok: true,
      ready,
      uptime: Math.round(process.uptime()),
      version: 1,
    });
  }
  if (req.method === 'POST' && req.url === '/notify') {
    if (!ready) return json(res, 503, { error: 'push not configured' });
    try {
      return await notify(req, res);
    } catch (err) {
      console.error('notify error:', err.message);
      return json(res, 500, { error: 'internal' });
    }
  }
  json(res, 404, { error: 'not found' });
});

server.listen(Number(PORT), '127.0.0.1', () => {
  console.log(`relik-push on 127.0.0.1:${PORT}, ready=${ready}`);
});
