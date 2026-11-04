#!/usr/bin/env node
/* Relik — нагрузочный замер ленты: 2000 сообщений в одном чате.
   Отвечает на вопрос «прокрутка ×5–10?» цифрами, а не верой.

     node scripts/perf-chat.mjs                    — 2000 сообщений, локальный dist
     node scripts/perf-chat.mjs --msgs 5000
     node scripts/perf-chat.mjs --write            — база kpi/chat-perf.json
     node scripts/perf-chat.mjs --check            — падение при регрессе
     node scripts/perf-chat.mjs --json

   Сценарий: демо-вход → чат с N сообщениями → замер открытия, render_messages,
   числа узлов в DOM (окно должно быть ограничено), FPS прокрутки (3 с), память.
   Демо-сид читает ?stress=N из js/data/mock.js — на реальную БД не влияет. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep, waitFor, CHROME } from './lib/cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const BASE = arg('url', 'http://localhost:8096/');
const MSGS = Math.max(100, Math.min(10000, Number(arg('msgs', '2000')) || 2000));
const OUT = path.join(ROOT, 'kpi', 'chat-perf.json');
const CHECK = has('check');
const WRITE = has('write');
const JSON_OUT = has('json');
const round = (n) => Math.round(Number(n) || 0);

async function probe(url) {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    await res.text().catch(() => '');
    return res.ok;
  } catch (e) {
    return false;
  }
}

const SCROLL = `(async function(){
  const holder = document.getElementById('msgs');
  const dur = 3000;
  const frames = [];
  let dir = -1;
  const start = performance.now();
  let last = start;
  holder.scrollTop = Math.max(0, holder.scrollHeight - holder.clientHeight - 1000);
  await new Promise((resolve) => {
    const step = (t) => {
      frames.push(t - last);
      last = t;
      const before = holder.scrollTop;
      const max = holder.scrollHeight - holder.clientHeight;
      /* Не доходим до верхней кромки: там приложение само догружает историю,
         и мы мерили бы запись в IndexedDB вместо прокрутки. */
      const top = Math.max(0, max - 1000);
      holder.scrollTop = Math.max(top, Math.min(max, before + dir * 18));
      if (holder.scrollTop <= top) dir = 1;
      if (holder.scrollTop >= max - 1) dir = -1;
      if (t - start < dur) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
  const ms = performance.now() - start;
  const sorted = frames.slice().sort((a, b) => a - b);
  const p = (q) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0;
  return {
    fps: Math.round((frames.length / ms) * 1000),
    frames: frames.length,
    p50: Math.round(p(0.5)),
    p95: Math.round(p(0.95)),
    max: Math.round(sorted[sorted.length - 1] || 0),
    long: frames.filter((d) => d > 50).length,
    ms: Math.round(ms)
  };
})()`;

async function run() {
  if (!(await probe(BASE))) {
    console.error(`Сервер не отвечает: ${BASE}`);
    return { error: 'server-unreachable' };
  }
  if (!CHROME) {
    console.error('Chrome/Edge не найден — замер пропущен (укажите CHROME_PATH)');
    return { error: 'no-chrome' };
  }

  const port = 9300 + Math.floor(Math.random() * 500);
  const ctx = await launch({ port, size: [1280, 900] });
  const out = { msgs: MSGS, url: BASE, at: new Date().toISOString() };
  const errors = [];

  try {
    await ctx.send('Runtime.enable');
    await ctx.on('Runtime.exceptionThrown', (p) => {
      errors.push(String(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || '').slice(0, 160));
    });

    const url = new URL(BASE);
    url.searchParams.set('demo', '1');
    url.searchParams.set('stress', String(MSGS));
    await ctx.goto(url.href, 300);

    await waitFor(ctx, `document.documentElement.dataset.boot === 'done'`, 45000, 150);
    await ctx.evaluate(`(function(){
      if (document.getElementById('appView') && !document.getElementById('appView').hidden) return true;
      var f = document.getElementById('authForm');
      if (!f) return false;
      document.getElementById('authEmail').value = 'perf@relik.app';
      document.getElementById('authPass').value = '123456';
      f.requestSubmit();
      return true;
    })()`);
    const hasChat = await waitFor(ctx, `document.querySelectorAll('.chat-item[data-cid]').length > 0`, 45000, 200);
    out.chats = Boolean(hasChat);
    if (!hasChat) return out;

    /* Ждём, пока демо-сид допишет все сообщения: иначе замер прокрутки ловит
       фоновую запись IndexedDB, а не работу ленты. */
    await waitFor(ctx, `(async function(){
      const have = await new Promise((res) => {
        const r = indexedDB.open('relik-db-demo');
        r.onsuccess = () => {
          const db = r.result;
          const q = db.transaction('messages').objectStore('messages').index('byChat').count(IDBKeyRange.only('c_alina'));
          q.onsuccess = () => res(q.result);
          q.onerror = () => res(0);
        };
        r.onerror = () => res(0);
      });
      return have >= ${MSGS};
    })()`, 120000, 250);

    /* Открытие чата с длинной историей */
    await ctx.evaluate(`(function(){
      window.__tOpen = performance.now();
      document.querySelector('.chat-item[data-cid]').click();
      return true;
    })()`);
    await waitFor(ctx, `document.querySelectorAll('#chatActive .msg').length > 0`, 30000, 100);
    out.openChat = round(await ctx.evaluate('performance.now() - window.__tOpen'));

    /* Окно ограничено: ждём, пока сид дорисуется, и смотрим DOM */
    await sleep(1200);
    const dom = await ctx.evaluate(`(function(){
      const holder = document.getElementById('msgs');
      const banner = holder.querySelector('.load-earlier');
      const buf = (window.__relikPerf || []).filter((e) => e && e.name === 'render_messages');
      const last = buf[buf.length - 1] || null;
      const ms = buf.map((e) => e.ms).sort((a, b) => a - b);
      return {
        domMsgs: holder.querySelectorAll('.msg').length,
        domChildren: holder.children.length,
        domNodes: holder.querySelectorAll('*').length,
        banner: banner ? (banner.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60) : null,
        renders: buf.length,
        renderP95: ms.length ? ms[Math.min(ms.length - 1, Math.floor(ms.length * 0.95))] : 0,
        renderedN: last ? (last.n || 0) : 0,
        heap: performance.memory ? performance.memory.usedJSHeapSize : 0
      };
    })()`);
    out.dom = dom;

    out.scroll = await ctx.evaluate(SCROLL);

    /* «Показать раньше»: с хвостовой загрузкой история должна приходить
       из IndexedDB и увеличивать окно, а не оставлять пустой экран. */
    out.earlier = await ctx.evaluate(`(async function(){
      const n = () => document.querySelectorAll('#msgs .msg').length;
      const before = n();
      const btn = document.querySelector('#msgs [data-load-earlier]');
      if (!btn) return { before, after: before, ok: false };
      btn.click();
      for (let i = 0; i < 40 && n() <= before; i++) await new Promise((r) => setTimeout(r, 100));
      const after = n();
      return { before, after, ok: after > before };
    })()`);
    out.errors = errors.slice(0, 5);
  } finally {
    ctx.close();
  }
  return out;
}

const result = await run();

if (JSON_OUT) {
  console.log(JSON.stringify(result, null, 2));
} else if (result.error) {
  /* нет сервера/Chrome — код 2 */
} else {
  const d = result.dom || {};
  const s = result.scroll || {};
  console.log(`Relik chat perf — ${result.msgs} сообщений в чате`);
  console.log('─'.repeat(56));
  console.log(`Открытие чата            ${result.openChat} мс`);
  console.log(`render_messages p95      ${d.renderP95} мс (${d.renders} замеров, в кадре ${d.renderedN})`);
  console.log(`В DOM сейчас             ${d.domMsgs} .msg, ${d.domNodes} узлов, ${d.domChildren} детей`);
  console.log(`Скрыто за баннером       ${d.banner || '—'}`);
  console.log(`Прокрутка (3 с)          ${s.fps} fps, кадры p95 ${s.p95} мс, max ${s.max} мс, >50 мс: ${s.long}`);
  const e = result.earlier || {};
  console.log(`Показать раньше          ${e.before} → ${e.after} .msg${e.ok ? '' : ' (нет кнопки/не выросло)'}`);
  console.log(`Память JS                ${(Number(d.heap) / 1048576).toFixed(1)} MB`);
  if (result.errors?.length) console.log(`Ошибки страницы          ${result.errors[0]}`);
}

if (result.error) process.exit(2);

const KEY = String(MSGS);
if (WRITE) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  let all = {};
  if (fs.existsSync(OUT)) {
    try { all = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) { all = {}; }
  }
  all[KEY] = result;
  fs.writeFileSync(OUT, JSON.stringify(all, null, 2) + '\n');
  console.log(`\nБаза записана: ${path.relative(ROOT, OUT).replace(/\\/g, '/')} [${KEY}]`);
}

if (CHECK) {
  if (!fs.existsSync(OUT)) {
    console.error(`\n✖ Нет базы ${path.relative(ROOT, OUT)} — сначала: node scripts/perf-chat.mjs --write`);
    process.exit(1);
  }
  const all = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  const base = all[KEY];
  if (!base) {
    console.error(`\n✖ В базе нет профиля ${KEY}`);
    process.exit(1);
  }
  const bad = [];
  /* Окно DOM — жёсткий контракт виртуализации: не должно расти вообще. */
  if ((result.dom?.domMsgs || 0) > Math.max(160, (base.dom?.domMsgs || 0) + 20)) {
    bad.push(`в DOM ${result.dom.domMsgs} сообщений (база ${base.dom?.domMsgs}) — окно не ограничено`);
  }
  if ((result.dom?.renderP95 || 0) > Math.max(120, (base.dom?.renderP95 || 0) * 1.5)) {
    bad.push(`render p95 ${result.dom.renderP95} мс > ${Math.round(Math.max(120, (base.dom?.renderP95 || 0) * 1.5))} мс`);
  }
  if ((result.scroll?.fps || 0) < Math.min(30, (base.scroll?.fps || 60) * 0.6)) {
    bad.push(`прокрутка ${result.scroll?.fps} fps < ${Math.round(Math.min(30, (base.scroll?.fps || 60) * 0.6))} fps`);
  }
  if (result.earlier && !result.earlier.ok) {
    bad.push(`«показать раньше» не догрузило историю (${result.earlier.before} → ${result.earlier.after})`);
  }
  if (bad.length) {
    console.error('\n✖ Лента деградировала:\n   ' + bad.join('\n   '));
    process.exit(1);
  }
  console.log('\n✔ Не хуже базы');
}

process.exit(0);
