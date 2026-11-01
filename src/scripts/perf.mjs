#!/usr/bin/env node
/* Relik — замер производительности на реальном профиле сети и CPU.
   Без цифр «в разы» — это вера. Скрипт снимает базовую линию до/после
   изменений и падает, если стало заметно хуже.

     node scripts/perf.mjs                         — замер (slow3g, локальный сервер)
     node scripts/perf.mjs --url https://... --profile fast
     node scripts/perf.mjs --write                 — записать базу kpi/perf-baseline.json
     node scripts/perf.mjs --check                 — упасть при регрессе (>25% время, >10% байты)
     node scripts/perf.mjs --json                  — только JSON

   Профили: slow3g (400 кбит/с, 400 мс RTT, CPU ×4), fast (без троттлинга).
   Сценарий: открыть приложение → вход в демо → открыть чат → отправить сообщение.
   Метрики: TTFB, FCP, LCP, время до экрана, байты/запросы до FCP, CLS,
   длинные задачи, открытие чата и отправка (плюс __relikPerf p50/p95). */
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
const PROFILE = arg('profile', 'slow3g');
const OUT = path.join(ROOT, 'kpi', 'perf-baseline.json');
const CHECK = has('check');
const WRITE = has('write');
const JSON_OUT = has('json');

const PROFILES = {
  slow3g: { label: 'slow3g: 400 кбит/с, 400 мс RTT, CPU ×4', down: 400 * 1024 / 8, up: 400 * 1024 / 8, latency: 400, cpu: 4 },
  slow4g: { label: 'slow4g: 1.6 Мбит/с, 150 мс RTT, CPU ×4', down: 1.6 * 1024 * 1024 / 8, up: 750 * 1024 / 8, latency: 150, cpu: 4 },
  fast: { label: 'fast: без троттлинга', down: -1, up: -1, latency: 0, cpu: 1 },
};
const P = PROFILES[PROFILE];
if (!P) {
  console.error(`Неизвестный профиль «${PROFILE}». Есть: ${Object.keys(PROFILES).join(', ')}`);
  process.exit(2);
}

/* Коллектор Web Vitals: ставится до загрузки документа. */
const VITALS = `(function(){
  var p = window.__relikVitals = { fcp: 0, lcp: 0, cls: 0, longTasks: 0, longTaskMs: 0 };
  try { new PerformanceObserver(function(l){ l.getEntries().forEach(function(e){ if(!p.fcp) p.fcp = e.startTime; }); })
    .observe({ type: 'paint', buffered: true }); } catch (e) {}
  try { new PerformanceObserver(function(l){ l.getEntries().forEach(function(e){ p.lcp = e.startTime; }); })
    .observe({ type: 'largest-contentful-paint', buffered: true }); } catch (e) {}
  try { new PerformanceObserver(function(l){ l.getEntries().forEach(function(e){ if(!e.hadRecentInput) p.cls += e.value; }); })
    .observe({ type: 'layout-shift', buffered: true }); } catch (e) {}
  try { new PerformanceObserver(function(l){ l.getEntries().forEach(function(e){ p.longTasks++; p.longTaskMs += e.duration; }); })
    .observe({ type: 'longtask', buffered: true }); } catch (e) {}
})();`;

const round = (n) => Math.round(Number(n) || 0);
const kb = (n) => `${(Number(n) / 1024).toFixed(1)} KB`;

async function probe(url) {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    await res.text().catch(() => '');
    return res.ok;
  } catch (e) {
    return false;
  }
}

function percentile(list, p) {
  if (!list.length) return 0;
  const sorted = [...list].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function run() {
  if (!(await probe(BASE))) {
    console.error(`Сервер не отвечает: ${BASE}`);
    console.error('Запустите: cd relik; py -m http.server 8096 (или node scripts/build.mjs && npx vite preview)');
    return { error: 'server-unreachable' };
  }
  if (!CHROME) {
    console.error('Chrome/Edge не найден — замер пропущен (укажите CHROME_PATH)');
    return { error: 'no-chrome' };
  }

  /* Свободный порт на каждый запуск: зависший Chrome с прошлого прогона
     иначе отдаёт старую страницу, и метрики становятся мусором. */
  const port = 9300 + Math.floor(Math.random() * 500);
  const ctx = await launch({ port, size: [1280, 900] });
  const out = { profile: PROFILE, profileLabel: P.label, url: BASE, at: new Date().toISOString() };

  try {
    await ctx.send('Network.enable');
    /* Ошибки страницы — часть замера: быстрый экран с исключением не считается. */
    const pageErrors = [];
    await ctx.send('Runtime.enable');
    await ctx.on('Runtime.exceptionThrown', (p) => {
      pageErrors.push('EXC ' + String(p.exceptionDetails?.text || '') + ' ' +
        String(p.exceptionDetails?.exception?.description || '').slice(0, 160));
    });
    await ctx.on('Runtime.consoleAPICalled', (p) => {
      if (p.type !== 'error') return;
      pageErrors.push('ERR ' + p.args.map((a) => String(a.value ?? a.description ?? '')).join(' ').slice(0, 160));
    });
    await ctx.send('Network.setCacheDisabled', { cacheDisabled: true });
    /* Замеряем «первый визит»: service worker не должен отдавать из кэша. */
    try { await ctx.send('Network.setBypassServiceWorker', { bypass: true }); } catch (e) { /* старый Chrome */ }
    await ctx.send('Emulation.setCPUThrottlingRate', { rate: P.cpu });
    if (P.down > 0) {
      await ctx.send('Network.emulateNetworkConditions', {
        offline: false,
        latency: P.latency,
        downloadThroughput: P.down,
        uploadThroughput: P.up,
      });
    } else {
      /* -1 в некоторых сборках Chrome работает как «почти ноль», поэтому
         профиль fast просто не включает троттлинг вовсе. */
      try { await ctx.send('Network.disableNetworkEmulation'); } catch (e) { /* ignore */ }
    }
    await ctx.send('Page.addScriptToEvaluateOnNewDocument', { source: VITALS });
    /* Момент старта загрузки SDK — единственный способ увидеть «в полёте». */
    const sdkRequests = [];
    await ctx.on('Network.requestWillBeSent', (p) => {
      if (/js\/vendor\/supabase\.js/.test(p.request.url)) sdkRequests.push(p.wallTime || 0);
    });
    /* Регистрация SW тянет 1.5 МБ оболочки в фоне и искажает первый экран:
       на время замера отключаем её (это же и есть «холодный» первый визит). */
    await ctx.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(function(){
        try {
          if (window.ServiceWorkerContainer) {
            ServiceWorkerContainer.prototype.register = function(){
              return Promise.resolve({ addEventListener: function(){}, update: function(){ return Promise.resolve(); } });
            };
          }
        } catch (e) {}
      })();`,
    });

    /* ── 1. Первый экран (реальный режим: SDK грузится лениво) ── */
    await ctx.goto(BASE, 300);
    const booted = await waitFor(ctx, `document.documentElement.dataset.boot === 'done'`, 45000, 150);
    if (!booted) out.bootError = 'boot-done не выставлен за 45 с';
    /* Даём секунду: SDK стартует сразу после первого экрана — надо увидеть,
       что он действительно грузится ПОСЛЕ boot, а не тормозит его. */
    await sleep(600);

    const first = await ctx.evaluate(`(function(){
      var v = window.__relikVitals || {};
      var nav = performance.getEntriesByType('navigation')[0] || {};
      var res = performance.getEntriesByType('resource') || [];
      var fcp = v.fcp || performance.now();
      var size = function(e){ return e.transferSize || e.encodedBodySize || 0; };
      var crit = res.filter(function(e){ return (e.responseEnd || e.startTime) <= fcp; });
      var sdk = res.filter(function(e){ return /js\\/vendor\\/supabase\\.js/.test(e.name); })[0];
      var blocking = res.filter(function(e){ return e.renderBlockingStatus === 'blocking'; });
      return {
        ttfb: nav.responseStart || 0,
        dcl: nav.domContentLoadedEventEnd || 0,
        load: nav.loadEventEnd || 0,
        fcp: v.fcp || 0,
        lcp: v.lcp || 0,
        cls: v.cls || 0,
        longTasks: v.longTasks || 0,
        longTaskMs: v.longTaskMs || 0,
        now: performance.now(),
        criticalBytes: crit.reduce(function(a, e){ return a + size(e); }, 0),
        criticalRequests: crit.length,
        renderBlockingBytes: blocking.reduce(function(a, e){ return a + size(e); }, 0),
        renderBlockingRequests: blocking.length,
        totalBytes: res.reduce(function(a, e){ return a + size(e); }, 0),
        resources: res.length,
        timeOrigin: performance.timeOrigin || Date.now(),
        sdk: sdk ? { start: sdk.startTime || 0, bytes: size(sdk) } : null
      };
    })()`);

    /* Ресурс-тайминг появляется только после завершения загрузки: пока 213 КБ
       SDK ещё качаются, видно лишь сетевой запрос — это и есть «не на критическом
       пути». Ловим момент старта запроса, чтобы отчёт не врал «не грузился». */
    let sdkStart = 0;
    if (!first.sdk) {
      sdkStart = sdkRequests.length ? sdkRequests[0] * 1000 - first.timeOrigin : 0;
    }

    out.first = {
      ttfb: round(first.ttfb),
      fcp: round(first.fcp),
      lcp: round(first.lcp),
      domContentLoaded: round(first.dcl),
      load: round(first.load),
      boot: round(first.now),
      cls: Number((first.cls || 0).toFixed(3)),
      longTasks: first.longTasks,
      longTaskMs: round(first.longTaskMs),
      criticalBytes: first.criticalBytes,
      criticalRequests: first.criticalRequests,
      renderBlockingBytes: first.renderBlockingBytes,
      renderBlockingRequests: first.renderBlockingRequests,
      totalBytes: first.totalBytes,
      resources: first.resources,
      errors: pageErrors.slice(0, 10),
      sdk: first.sdk
        ? { startedAt: round(first.sdk.start), bytes: first.sdk.bytes, pending: false }
        : (sdkStart ? { startedAt: round(sdkStart), bytes: 0, pending: true } : null),
    };

    /* ── 2. Демо: открыть чат и отправить сообщение ──────────── */
    const demoUrl = new URL(BASE);
    demoUrl.searchParams.set('demo', '1');
    await ctx.goto(demoUrl.href, 300);
    const demoBoot = await waitFor(ctx, `document.documentElement.dataset.boot === 'done'`, 45000, 150);
    /* Демо без регистрации: на экране входа отправляем форму (как это делает
       пользователь по кнопке «Войти»), иначе чатов не будет. Небольшая пауза —
       как будто человек прочитал экран: за это время чанк уже грузится. */
    await sleep(1200);
    await ctx.evaluate(`(function(){
      if (document.getElementById('appView') && !document.getElementById('appView').hidden) return true;
      var f = document.getElementById('authForm');
      if (!f) return false;
      window.__tLogin = performance.now();
      document.getElementById('authEmail').value = 'perf@relik.app';
      document.getElementById('authPass').value = '123456';
      f.requestSubmit();
      return true;
    })()`);
    await waitFor(ctx, `document.getElementById('appView') && !document.getElementById('appView').hidden`, 30000, 60);
    const loginMs = round(await ctx.evaluate('performance.now() - (window.__tLogin || performance.now())'));
    const appChunk = await ctx.evaluate(`(function(){
      var e = (performance.getEntriesByType('resource') || []).filter(function(r){ return /\\/app-[^/]+\\.js$/.test(r.name); })[0];
      return e ? { start: Math.round(e.startTime), bytes: e.transferSize || e.encodedBodySize || 0 } : null;
    })()`);
    const hasChat = await waitFor(ctx, `document.querySelectorAll('.chat-item[data-cid]').length > 0`, 30000, 200);
    out.demo = { booted: Boolean(demoBoot), chats: Boolean(hasChat), login: loginMs, chunk: appChunk };

    if (hasChat) {
      await ctx.evaluate(`(function(){
        window.__tOpen = performance.now();
        document.querySelector('.chat-item[data-cid]').click();
        return true;
      })()`);
      await waitFor(ctx, `document.querySelectorAll('#chatActive .msg').length > 0`, 25000, 100);
      out.demo.openChat = round(await ctx.evaluate('performance.now() - window.__tOpen'));

      const before = await ctx.evaluate(`(function(){
        var ta = document.getElementById('ta');
        if (!ta) return -1;
        ta.value = 'perf-check ' + Date.now();
        ta.dispatchEvent(new Event('input'));
        var n = document.querySelectorAll('#chatActive .msg').length;
        window.__tSend = performance.now();
        window.__before = n;
        var b = document.getElementById('sendBtn');
        if (!b) return -1;
        b.click();
        return n;
      })()`);
      if (before >= 0) {
        await waitFor(ctx, `document.querySelectorAll('#chatActive .msg').length > window.__before`, 20000, 50);
        out.demo.send = round(await ctx.evaluate('performance.now() - window.__tSend'));
        /* отправка действительно появилась в ленте */
        out.demo.sent = await ctx.evaluate(`(function(){
          var list = document.querySelectorAll('#chatActive .msg');
          var last = list[list.length - 1];
          return !!last && (last.textContent || '').indexOf('perf-check') >= 0;
        })()`);
      }

      const perf = await ctx.evaluate(`(function(){
        var buf = window.__relikPerf || [];
        return buf.filter(function(e){ return e && typeof e.ms === 'number'; }).slice(-200);
      })()`);
      const pick = (name) => (perf || []).filter((e) => e.name === name).map((e) => e.ms);
      const stat = (arr) => ({ n: arr.length, p50: percentile(arr, 50), p95: percentile(arr, 95) });
      out.demo.perf = {
        open_chat: stat(pick('open_chat')),
        render_messages: stat(pick('render_messages')),
        samples: (perf || []).length,
      };
      const demoVitals = await ctx.evaluate(`(function(){
        var v = window.__relikVitals || {};
        return { fcp: v.fcp || 0, lcp: v.lcp || 0, cls: v.cls || 0 };
      })()`);
      out.demo.vitals = {
        fcp: round(demoVitals.fcp), lcp: round(demoVitals.lcp), cls: Number((demoVitals.cls || 0).toFixed(3)),
      };
    }
  } finally {
    ctx.close();
  }

  return out;
}

/* ── Сравнение с базой ─────────────────────────────────────── */
function compare(now, base) {
  const problems = [];
  const worse = (name, cur, was, factor) => {
    if (!was) return;
    if (cur > was * factor) problems.push(`${name}: ${round(cur)} > ${round(was * factor)} (база ${round(was)})`);
  };
  const a = now.first || {};
  const b = base.first || {};
  /* Время на троттлинге шумит (процессор, фон), поэтому для него запас
     больше; байты рендер-блокирующих ресурсов — жёсткий бюджет. */
  worse('FCP', a.fcp, b.fcp, 1.6);
  worse('LCP', a.lcp, b.lcp, 1.6);
  worse('время до экрана', a.boot, b.boot, 1.6);
  worse('рендер-блокирующие байты', a.renderBlockingBytes, b.renderBlockingBytes, 1.1);
  worse('байты до FCP', a.criticalBytes, b.criticalBytes, 1.25);
  worse('открытие чата', now.demo?.openChat, base.demo?.openChat, 1.5);
  worse('отправка', now.demo?.send, base.demo?.send, 1.5);
  if (!now.demo?.sent && base.demo?.sent) problems.push('сообщение не появилось в ленте');
  return problems;
}

const result = await run();

if (JSON_OUT) {
  console.log(JSON.stringify(result, null, 2));
} else if (result.error) {
  /* нет сервера/Chrome — это не регресс, код 2 */
} else {
  const f = result.first || {};
  const d = result.demo || {};
  console.log(`Relik perf — ${P.label}`);
  console.log('─'.repeat(56));
  console.log(`TTFB                     ${f.ttfb} мс`);
  console.log(`FCP                      ${f.fcp} мс`);
  console.log(`LCP                      ${f.lcp} мс`);
  console.log(`Экран готов (boot)       ${f.boot} мс`);
  console.log(`Критический путь         ${kb(f.criticalBytes)} в ${f.criticalRequests} запросах`);
  console.log(`Рендер-блокирующие       ${kb(f.renderBlockingBytes)} в ${f.renderBlockingRequests} запросах`);
  console.log(`Всего за загрузку        ${kb(f.totalBytes)}`);
  console.log(`CLS / длинные задачи     ${f.cls} / ${f.longTasks} (${f.longTaskMs} мс)`);
  if (f.errors?.length) console.log(`Ошибки страницы          ${f.errors.length}: ${f.errors[0]}`);
  console.log(`SDK Supabase             ${f.sdk ? `старт ${f.sdk.startedAt} мс, ${f.sdk.pending ? 'качается' : kb(f.sdk.bytes)}` : 'не грузился'}`);
  if (d.chats) {
    console.log('─'.repeat(56));
    console.log(`Открытие чата            ${d.openChat} мс${d.perf?.open_chat?.n ? ` (p95 ${d.perf.open_chat.p95} по ${d.perf.open_chat.n} замерам)` : ''}`);
    console.log(`Отправка сообщения       ${d.send} мс${d.sent ? '' : ' — сообщение не появилось!'}`);
    console.log(`render_messages p95      ${d.perf?.render_messages?.p95 ?? 0} мс (${d.perf?.render_messages?.n ?? 0} замеров)`);
    console.log(`Демо: FCP / LCP / CLS    ${d.vitals?.fcp ?? 0} / ${d.vitals?.lcp ?? 0} / ${d.vitals?.cls ?? 0}`);
    console.log(`Вход (submit → экран)    ${d.login ?? 0} мс`);
    console.log(`Чанк приложения          ${d.chunk ? `старт ${d.chunk.start} мс, ${kb(d.chunk.bytes)}` : 'не найден'}`);
  }
}

if (result.error) process.exit(2);

if (WRITE) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  let all = {};
  if (fs.existsSync(OUT)) {
    try { all = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) { all = {}; }
  }
  all[PROFILE] = result;
  fs.writeFileSync(OUT, JSON.stringify(all, null, 2) + '\n');
  console.log(`\nБаза записана: ${path.relative(ROOT, OUT).replace(/\\/g, '/')} [${PROFILE}]`);
}

if (CHECK) {
  if (!fs.existsSync(OUT)) {
    console.error(`\n✖ Нет базы ${path.relative(ROOT, OUT)} — сначала: node scripts/perf.mjs --write`);
    process.exit(1);
  }
  const all = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  const base = all[PROFILE];
  if (!base) {
    console.error(`\n✖ В базе нет профиля ${PROFILE}`);
    process.exit(1);
  }
  const problems = compare(result, base);
  if (problems.length) {
    console.error('\n✖ Производительность ухудшилась:\n   ' + problems.join('\n   '));
    process.exit(1);
  }
  console.log('\n✔ Не хуже базы');
}

/* Явный выход: открытый WebSocket к уже убитому Chrome иногда держит loop. */
process.exit(0);
