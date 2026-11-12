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
     turn      — STUN binding по UDP (запасной путь — TCP). Важно: просто
                 TCP-подключение к порту 3478 ничего не доказывает — хост
                 может принимать SYN, когда coturn уже мёртв (так VPS
                 «выглядел живым» 11 дней после инцидента Beget).

   Алерты: TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID в окружении и флаг --telegram.
*/
import net from 'node:net';
import dgram from 'node:dgram';
import crypto from 'node:crypto';

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

/* ── 2. TURN: настоящий STUN binding, а не «порт открылся» ─────
   TCP-connect к 3478 проходил даже когда coturn был мёртв: сеть провайдера
   отвечала SYN, и мониторинг 11 дней показывал «turn ok». */

function stunRequest() {
  const buf = Buffer.alloc(20);
  buf.writeUInt16BE(0x0001, 0);      // Binding Request
  buf.writeUInt16BE(0, 2);           // длина атрибутов
  buf.writeUInt32BE(0x2112a442, 4);  // magic cookie
  crypto.randomFillSync(buf, 8, 12); // transaction id
  return buf;
}

const isStunSuccess = (b) => Buffer.isBuffer(b) && b.length >= 20 && (b.readUInt16BE(0) & 0x3fff) === 0x0101;

function stunUdp(host, port, timeout) {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      try { s.close(); } catch (e) { /* ignore */ }
      resolve(val);
    };
    const t = setTimeout(() => finish(null), timeout);
    s.once('message', (msg) => finish(isStunSuccess(msg) ? msg : null));
    s.once('error', () => finish(null));
    try { s.send(stunRequest(), port, host, (err) => { if (err) finish(null); }); } catch (e) { finish(null); }
  });
}

function stunTcp(host, port, timeout) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      try { sock.destroy(); } catch (e) { /* ignore */ }
      resolve(val);
    };
    const t = setTimeout(() => finish(null), timeout);
    sock.once('connect', () => sock.write(stunRequest()));
    sock.once('data', (d) => finish(isStunSuccess(d) ? d : null));
    sock.once('error', () => finish(null));
    sock.once('close', () => finish(null));
  });
}

async function turnAlive(host, port, timeout) {
  const viaUdp = await stunUdp(host, port, timeout);
  if (viaUdp) return 'UDP';
  const viaTcp = await stunTcp(host, port, timeout);
  if (viaTcp) return 'TCP';
  throw new Error('нет ответа на STUN binding (UDP и TCP) — coturn не работает');
}

if (CHECK_TURN && conf.turn.length) {
  const t = conf.turn[0];
  const m = t.match(/^turn:([^:?]+):(\d+)/);
  if (m) {
    const turn = await timed(() => turnAlive(m[1], Number(m[2]), Math.min(TIMEOUT, 5000)));
    add('turn', turn.ok, turn.ms, turn.ok ? `${m[1]}:${m[2]} · STUN ${turn.value}` : `TURN ${m[1]}:${m[2]} — ${turn.error}`);
  }
}

/* ── 3. Вывод ─────────────────────────────────────────────── */
const total = Date.now() - t0;
/* TURN теперь критичен: без него звонки не проходят за строгим NAT, и его
   падение — единственный сигнал, что VPS (coturn, push, зеркало, бэкапы) мёртв. */
const critical = ['site', 'config', 'auth', 'rest', 'turn'];
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
