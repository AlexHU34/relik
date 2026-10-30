#!/usr/bin/env node
/* Relik — проверка «жив ли сервис» из терминала или из cron.
   Без зависимостей: fetch + WebSocket + net из Node 18+.

   Примеры:
     node scripts/relik-health.mjs
     node scripts/relik-health.mjs --json
     node scripts/relik-health.mjs --url https://alexhu34.github.io/relik/ --turn
     node scripts/relik-health.mjs --telegram

   Коды возврата: 0 — всё критичное работает, 1 — есть сбой, 2 — ошибка запуска.

   Что проверяется:
     site      — index.html отдаётся и содержит разметку Relik;
     config    — js/config.js читается, версия/URL/ключ на месте;
     version   — version.json совпадает с версией в config.js;
     auth      — Supabase Auth отвечает;
     rest      — база отвечает (это же и keep-alive);
     storage   — сервис файлов отвечает;
     realtime  — WebSocket-handshake (доставка сообщений);
     turn      — TCP-порт TURN из config.js (если --turn или всегда, когда задан).

   Алерты: TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID в окружении и флаг --telegram.
*/
import net from 'node:net';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const SITE = opt('--url', 'https://alexhu34.github.io/relik/').replace(/\/*$/, '/');
const TIMEOUT = Number(opt('--timeout', 12000));
const JSON_OUT = flag('--json');
const CHECK_TURN = flag('--turn') || !flag('--no-turn');
const TELEGRAM = flag('--telegram');

const results = [];
const t0 = Date.now();

function add(name, ok, ms, detail) {
  results.push({ name, ok, ms: ms == null ? null : Math.round(ms), detail: detail || '' });
}

async function timed(fn) {
  const start = Date.now();
  try {
    const value = await fn();
    return { ok: true, ms: Date.now() - start, value };
  } catch (err) {
    return { ok: false, ms: Date.now() - start, error: (err && err.message) || String(err) };
  }
}

async function get(url, headers = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT), cache: 'no-store' });
  const body = await res.text();
  return { res, body };
}

/* ── 1. Сайт и конфиг ─────────────────────────────────────── */
const site = await timed(async () => {
  const { res, body } = await get(SITE + 'index.html?health=' + Date.now());
  if (!res.ok) throw new Error('HTTP ' + res.status);
  if (!/Relik/.test(body)) throw new Error('нет разметки Relik');
  return body;
});
add('site', site.ok, site.ms, site.ok ? SITE : site.error);

const cfg = await timed(async () => {
  const { res, body } = await get(SITE + 'js/config.js?health=' + Date.now());
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const version = (body.match(/version:\s*'([^']+)'/) || [])[1] || '?';
  const url = (body.match(/url:\s*'(https:[^']+)'/) || [])[1] || '';
  const key = (body.match(/anonKey:\s*'([^']+)'/) || [])[1] || '';
  const turn = (body.match(/'turn:([^']+)'/g) || []).map((s) => s.slice(1, -1));
  return { version, url, key, turn };
});
add('config', cfg.ok, cfg.ms, cfg.ok ? `v${cfg.value.version}` : cfg.error);

const conf = cfg.ok ? cfg.value : { version: '?', url: '', key: '', turn: [] };

if (conf.url) {
  const ver = await timed(async () => {
    const { res, body } = await get(SITE + 'version.json?health=' + Date.now());
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const v = JSON.parse(body).version;
    if (!v) throw new Error('нет поля version');
    if (conf.version !== '?' && v !== conf.version) throw new Error(`в version.json ${v}, в config.js ${conf.version}`);
    return v;
  });
  add('version', ver.ok, ver.ms, ver.ok ? `v${ver.value}` : ver.error);

  const h = { apikey: conf.key, Authorization: 'Bearer ' + conf.key };

  const auth = await timed(async () => {
    const { res } = await get(conf.url + '/auth/v1/health', h);
    if (res.status >= 500) throw new Error('HTTP ' + res.status);
    return res.status;
  });
  add('auth', auth.ok, auth.ms, auth.ok ? `HTTP ${auth.value}` : auth.error);

  const rest = await timed(async () => {
    const { res } = await get(conf.url + '/rest/v1/profiles?select=id&limit=1', h);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.status;
  });
  add('rest', rest.ok, rest.ms, rest.ok ? `HTTP ${rest.value}` : rest.error);

  const storage = await timed(async () => {
    const { res } = await get(conf.url + '/storage/v1/bucket', h);
    if (res.status >= 500) throw new Error('HTTP ' + res.status);
    return res.status;
  });
  add('storage', storage.ok, storage.ms, storage.ok ? `HTTP ${storage.value}` : storage.error);

  if (typeof WebSocket === 'function') {
    const rt = await timed(() => new Promise((resolve, reject) => {
      const wsUrl = conf.url.replace(/^http/, 'ws') +
        `/realtime/v1/websocket?apikey=${encodeURIComponent(conf.key)}&vsn=1.0.0`;
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => { try { ws.close(); } catch (e) {} reject(new Error('timeout')); }, TIMEOUT);
      ws.onopen = () => { clearTimeout(timer); try { ws.close(); } catch (e) {} resolve('open'); };
      ws.onerror = () => { clearTimeout(timer); reject(new Error('ws error')); };
      ws.onclose = () => { /* закрыли сами */ };
    }));
    add('realtime', rt.ok, rt.ms, rt.ok ? 'канал открылся' : rt.error);
  } else {
    add('realtime', null, null, 'в этом Node нет WebSocket (нужен 22+)');
  }
} else {
  add('auth', false, null, 'Supabase не настроен в config.js');
}

/* ── 2. TURN (TCP-порт) ───────────────────────────────────── */
if (CHECK_TURN && conf.turn.length) {
  const t = conf.turn[0];
  const m = t.match(/^turn:([^:?]+):(\d+)/);
  if (m) {
    const turn = await timed(() => new Promise((resolve, reject) => {
      const sock = net.connect({ host: m[1], port: Number(m[2]) });
      const done = (ok) => { try { sock.destroy(); } catch (e) {} ok ? resolve(true) : reject(new Error('порт закрыт')); };
      sock.setTimeout(Math.min(TIMEOUT, 5000));
      sock.once('connect', () => done(true));
      sock.once('timeout', () => done(false));
      sock.once('error', () => done(false));
    }));
    add('turn', turn.ok, turn.ms, turn.ok ? `${m[1]}:${m[2]}` : `TURN ${m[1]}:${m[2]} — ${turn.error}`);
  }
}

/* ── 3. Вывод ─────────────────────────────────────────────── */
const total = Date.now() - t0;
const critical = ['site', 'config', 'auth', 'rest'];
const failed = results.filter((r) => r.ok === false);
const criticalFailed = failed.filter((r) => critical.includes(r.name));

if (JSON_OUT) {
  console.log(JSON.stringify({
    time: new Date().toISOString(),
    site: SITE,
    version: conf.version,
    totalMs: total,
    ok: criticalFailed.length === 0,
    checks: results,
  }, null, 2));
} else {
  const pad = (s, n) => (s + ' '.repeat(n)).slice(0, n);
  console.log(`Relik health · ${SITE} · v${conf.version}`);
  for (const r of results) {
    const mark = r.ok === true ? 'ok  ' : r.ok === false ? 'FAIL' : '----';
    const ms = r.ms == null ? '' : `${r.ms} ms`;
    console.log(`  ${mark}  ${pad(r.name, 9)} ${pad(ms, 8)} ${r.detail}`);
  }
  const slow = results.filter((r) => r.ms != null && r.ms > 1500 && r.ok !== false);
  console.log(`\nИтог: ${results.length - failed.length}/${results.length} ок за ${total} ms` +
    (slow.length ? ` · медленно: ${slow.map((r) => r.name).join(', ')}` : '') +
    (criticalFailed.length ? ` · СБОЙ: ${criticalFailed.map((r) => r.name).join(', ')}` : ''));
}

if (TELEGRAM && failed.length) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (token && chat) {
    const lines = failed.map((r) => `• ${r.name}: ${r.detail}`).join('\n');
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chat,
        text: `🔴 Relik health (${SITE})\n${lines}`,
        disable_web_page_preview: true,
      }),
    }).catch(() => {});
  }
}

process.exit(criticalFailed.length ? 1 : 0);
