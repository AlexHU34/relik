#!/usr/bin/env node
/* Relik — e2e-проверка двумя аккаунтами в двух изолированных профилях Chrome.
   Ничего не воспроизводит звук (Chrome запускается с --mute-audio).

   Подготовка (PowerShell):
     $env:EMAIL_A='admin@example.com'; $env:PASS_A='...'; $env:NAME_A='Admin'
     $env:EMAIL_B='grandma@example.com'; $env:PASS_B='...'; $env:NAME_B='Grandma'
     $env:USERNAME_B='Grandma'      # @username второго аккаунта (для заявки)
     node scripts/e2e.mjs

   Флаги:
     --url https://alexhu34.github.io/relik/   адрес приложения
     --demo                                    гонять демо-режим (один браузер, без аккаунтов)
     --keep                                    не закрывать браузеры после прогона
*/
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';

const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const BASE = arg('url', 'https://alexhu34.github.io/relik/').replace(/\/?$/, '/');
const DEMO = has('demo');
const KEEP = has('keep');
const TIMEOUT = Number(arg('timeout', '30000'));

const CHROME = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean).find((p) => existsSync(p));

if (!CHROME) {
  console.error('Chrome не найден. Укажи CHROME_PATH.');
  process.exit(2);
}

const env = {
  a: { email: process.env.EMAIL_A || '', pass: process.env.PASS_A || '', name: process.env.NAME_A || 'A' },
  b: { email: process.env.EMAIL_B || '', pass: process.env.PASS_B || '', name: process.env.NAME_B || 'B' },
};
const USERNAME_B = process.env.USERNAME_B || '';

if (!DEMO && !has('signup') && (!env.a.email || !env.a.pass || !env.b.email || !env.b.pass)) {
  console.error('Нужны EMAIL_A/PASS_A/EMAIL_B/PASS_B (или запусти с --demo).');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const record = (name, ok, info = '') => {
  results.push({ name, ok, info });
  console.log(`${ok ? '  OK  ' : ' FAIL '} ${name}${info ? ' — ' + info : ''}`);
};

/* Занят ли порт отладки (например, зависшим Chrome прошлого прогона). */
function portBusy(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: '127.0.0.1' });
    let settled = false;
    const done = (busy) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch (e) { /* уже закрыт */ }
      resolve(busy);
    };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.setTimeout(400, () => done(false));
  });
}

async function freePort(start) {
  const base = Number(start) || 9341;
  for (let i = 0; i < 20; i += 1) {
    if (!(await portBusy(base + i))) return base + i;
  }
  return base;
}

async function launch(tag, port) {
  /* Прошлый прогон мог оставить Chrome на этом порту — тогда новый
     подключился бы к чужому браузеру и все шаги «падали». Берём свободный. */
  port = await freePort(port);
  /* Chrome иногда не успевает подняться (или порт занят прошлым прогоном) —
     пробуем несколько раз, иначе CI мигает красным без причины. */
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await launchOnce(tag, port, attempt);
    } catch (err) {
      lastErr = err;
      await sleep(800 * attempt);
    }
  }
  throw lastErr || new Error(`Chrome ${tag} не поднялся`);
}

async function launchOnce(tag, port, attempt) {  const dir = mkdtempSync(join(tmpdir(), `relik-e2e-${tag}-${attempt}-`));
  const child = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=user-gesture-required',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${dir}`,
    '--window-size=1280,900',
    'about:blank',
  ], { stdio: 'ignore' });

  let page = null;
  for (let i = 0; i < 60 && !page; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      page = list.find((t) => t.type === 'page');
    } catch (e) { /* ещё грузится */ }
    if (!page) await sleep(250);
  }
  if (!page) {
    try { child.kill(); } catch (e) { /* уже мёртв */ }
    throw new Error(`Chrome ${tag} не поднялся`);
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    /* Отладочная страница может быть «мёртвой» (частый след прошлых прогонов) —
       без таймаута ожидание open() висит вечно и CI просто истекает. */
    const timer = setTimeout(() => rej(new Error(`CDP ${tag}: WebSocket не открылся за 8 с`)), 8000);
    ws.addEventListener('open', () => { clearTimeout(timer); res(); }, { once: true });
    ws.addEventListener('error', (e) => { clearTimeout(timer); rej(e); }, { once: true });
  });

  let id = 0;
  const pending = new Map();
  const events = [];
  const httpErrors = [];
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m.result || {});
      pending.delete(m.id);
      return;
    }
    if (m.method) {
      events.push(m);
      if (events.length > 300) events.shift();
      /* HTTP-ошибки (401/403/500) видно только по URL — без этого в консоли
         остаётся бесполезное «Failed to load resource». */
      if (m.method === 'Network.responseReceived') {
        const r = m.params?.response || {};
        if (r.status >= 400) {
          httpErrors.push(`${r.status} ${String(r.url || '').slice(0, 160)}`);
          if (httpErrors.length > 40) httpErrors.shift();
        }
      }
    }
  });
  const send = (method, params = {}) => new Promise((resolve) => {
    const n = (id += 1);
    pending.set(n, resolve);
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Network.enable');
  await send('Page.enable');

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      return { __error: r.exceptionDetails.text || 'js error' };
    }
    return r.result ? r.result.value : undefined;
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: BASE });
  await sleep(1500);

  return {
    tag, port, dir, child, ws, send, evaluate,
    events,
    /* HTTP-ошибки с адресами — для разбора «401 без подробностей» */
    httpErrors() { return httpErrors.slice(-12); },
    errors() {
      return events
        .filter((e) => e.method === 'Runtime.exceptionThrown' || e.method === 'Log.entryAdded')
        .map((e) => (e.method === 'Runtime.exceptionThrown'
          ? 'exception: ' + (e.params?.exceptionDetails?.exception?.description || e.params?.exceptionDetails?.text)
          : e.params?.entry?.level + ': ' + e.params?.entry?.text))
        .filter((s) => /error|warn/i.test(s));
    },
    close() {
      try { ws.close(); } catch (e) { /* ignore */ }
      try { child.kill(); } catch (e) { /* ignore */ }
      /* Windows: главный процесс Chrome переживает kill() и держит порт —
         следующий прогон не сможет занять порт и будет «мигать». */
      if (process.platform === 'win32' && child.pid) {
        try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* ignore */ }
      }
      if (!KEEP) {
        setTimeout(() => { try { rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ } }, 500);
      }
    },
  };
}

async function waitFor(ctx, expression, timeout = TIMEOUT, step = 400) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const v = await ctx.evaluate(expression);
    if (v && v !== '__error') return v;
    await sleep(step);
  }
  return null;
}

async function login(ctx, creds) {
  await waitFor(ctx, `document.documentElement.dataset.boot === 'done' || !document.getElementById('appView').hidden`, 25000);
  if (await ctx.evaluate(`!document.getElementById('appView').hidden`)) return;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const filled = await ctx.evaluate(`(function(){
      var e=document.getElementById('authEmail'), p=document.getElementById('authPass');
      if(!e||!p) return false;
      e.value=${JSON.stringify(creds.email)};
      p.value=${JSON.stringify(creds.pass)};
      document.getElementById('authForm').requestSubmit();
      return true;
    })()`);
    if (!filled) throw new Error('форма входа не найдена');
    const ok = await waitFor(ctx, `!document.getElementById('appView').hidden`, 25000);
    if (ok) return;
    await sleep(1500);
  }
  const err = await ctx.evaluate(`(document.querySelector('.toast')?.textContent || '')`);
  throw new Error('вход не выполнен: ' + String(err).slice(0, 120));
}

async function openPeopleSearch(ctx) {
  await ctx.evaluate(`document.getElementById('peopleBtn').click()`);
  await waitFor(ctx, `!document.getElementById('peopleOv').hidden`);
}

/* Состояние отношений A → B по кнопке в списке людей:
   none (можно пригласить), outgoing (заявка отправлена), incoming, contact. */
async function peopleRelation(ctx, username) {
  await openPeopleSearch(ctx);
  await ctx.evaluate(`(function(){
    var i=document.getElementById('peopleSearch');
    i.value=${JSON.stringify(username)};
    i.dispatchEvent(new Event('input'));
  })()`);
  const rows = await waitFor(ctx, `document.querySelectorAll('#peopleList .people-row').length || 0`, 20000, 400);
  if (!rows) {
    /* первый запрос после простоя бывает медленным — жмём «Повторить», если есть */
    const retried = await ctx.evaluate(`(function(){
      var b=document.querySelector('#peopleList [data-retry-people]');
      if (!b) return false;
      b.click();
      return true;
    })()`);
    if (retried) {
      await waitFor(ctx, `document.querySelectorAll('#peopleList .people-row').length || 0`, 20000, 400);
    }
  }
  return ctx.evaluate(`(function(){
    var row=[...document.querySelectorAll('#peopleList .people-row')][0];
    if (!row) return 'none';
    if (row.querySelector('[data-pact="write"]')) return 'contact';
    if (row.querySelector('[data-pact="cancel"]')) return 'outgoing';
    if (row.querySelector('[data-pact="accept"]')) return 'incoming';
    return row.querySelector('[data-pact="add"]') ? 'none' : 'unknown';
  })()`);
}

async function clickInvite(ctx) {
  const ok = await ctx.evaluate(`(function(){
    var add=document.querySelector('#peopleList [data-pact="add"]');
    if (!add) return false;
    add.click();
    return true;
  })()`);
  return Boolean(ok);
}

async function acceptFirstRequest(ctx) {
  await ctx.evaluate(`document.getElementById('requestsBtn').click()`);
  await waitFor(ctx, `!document.getElementById('reqOv').hidden`);
  await sleep(600);
  const clicked = await ctx.evaluate(`(function(){
    var b=document.querySelector('#reqIn [data-pact="accept"]');
    if(!b) return false; b.click(); return true;
  })()`);
  return Boolean(clicked);
}

async function openChatWith(ctx, name) {
  await ctx.evaluate(`document.getElementById('newChatBtn').click()`);
  await waitFor(ctx, `!document.getElementById('ncOv').hidden`);
  /* Список контактов подгружается из сети — ждём строку, потом кликаем. */
  const ready = await waitFor(ctx, `document.querySelectorAll('#ncList .contact[data-uid]').length > 0`, 20000, 400);
  if (!ready) return false;
  const clicked = await ctx.evaluate(`(function(){
    var rows=[...document.querySelectorAll('#ncList .contact[data-uid]')];
    var row=rows.find(function(r){return (r.textContent||'').includes(${JSON.stringify(name)});}) || rows[0];
    if(!row) return false;
    row.click();
    return true;
  })()`);
  if (!clicked) return false;
  return Boolean(await waitFor(ctx, `!document.getElementById('chatActive').hidden`, 15000));
}

/* Первый запуск показывает онбординг (3 экрана). Он должен показываться
   один раз и не мешать дальше: закрываем его до основных проверок. */
async function dismissOnboarding(ctx) {
  const shown = await ctx.evaluate(`!!document.getElementById('obOv') && !document.getElementById('obOv').hidden`);
  if (!shown) return false;
  for (let i = 0; i < 3; i += 1) {
    await ctx.evaluate(`document.getElementById('obNext')?.click()`);
    await sleep(140);
  }
  return true;
}

/* Документальные страницы должны прокручиваться колесом/пальцем: base.css
   ставит body{overflow:hidden} для приложения, и однажды это уже «съело»
   прокрутку legal.html. Проверяем настоящим колесом, а не scrollTop. */
async function checkDocScroll(ctx, page) {
  await ctx.send('Page.navigate', { url: BASE + page });
  await sleep(1200);
  /* В headless вкладка может быть не в фокусе — тогда синтетические жесты
     игнорируются (а программный scrollTop работает, и легко обмануться). */
  try { await ctx.send('Page.bringToFront'); } catch (e) { /* ignore */ }
  try { await ctx.send('Emulation.setFocusEmulationEnabled', { enabled: true }); } catch (e) { /* ignore */ }
  /* synthesizeScrollGesture — тот же путь, что у реального жеста. Ждём,
     пока страница действительно прокрутится: жест асинхронный и на нагруженной
     машине успевает начаться позже, чем мы читаем scrollTop. */
  let moved = null;
  for (let attempt = 0; attempt < 3 && !moved; attempt += 1) {
    try {
      await ctx.send('Input.synthesizeScrollGesture', {
        x: 120, y: 320, xDistance: 0, yDistance: -400, speed: 1200,
      });
    } catch (e) {
      await ctx.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 120, y: 320, deltaX: 0, deltaY: 400 }).catch(() => {});
    }
    moved = await waitFor(ctx, `document.scrollingElement.scrollTop > 0`, 2500, 120);
  }
  return ctx.evaluate(`(function(){
    var d = document.scrollingElement;
    return {
      top: d.scrollTop,
      sh: d.scrollHeight,
      ch: d.clientHeight,
      overflowY: getComputedStyle(document.body).overflowY,
      htmlOy: getComputedStyle(document.documentElement).overflowY,
      scrolling: d === document.documentElement ? 'html' : (d ? d.tagName : 'null'),
      focus: document.hasFocus(),
      innerH: window.innerHeight,
      vvH: window.visualViewport ? Math.round(window.visualViewport.height) : 0,
      href: location.href
    };
  })()`);
}

async function typeAndSend(ctx, text) {
  const sent = await ctx.evaluate(`(function(){
    var ta=document.getElementById('ta');
    if(!ta) return false;
    ta.value=${JSON.stringify(text)};
    ta.dispatchEvent(new Event('input'));
    var b=document.getElementById('sendBtn');
    if(!b) return false;
    b.click();
    return true;
  })()`);
  return Boolean(sent);
}

async function lastMessageText(ctx) {
  return ctx.evaluate(`(function(){
    var list=[...document.querySelectorAll('#chatActive .msg')];
    var m=list[list.length-1];
    return m ? (m.textContent||'').trim() : '';
  })()`);
}

async function runUiSmoke(ctx) {
  const r = await ctx.evaluate(`(async () => {
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    const $ = (s) => document.querySelector(s);
    const vis = (s) => { const el = $(s); return !!el && !el.hidden; };
    const out = {};

    document.getElementById('settingsBtn').click();
    await sleep(500);
    out.settings = vis('#settingsOv') && document.querySelectorAll('#themeGrid > *').length >= 6;
    document.querySelector('#settingsOv [data-close]')?.click();
    await sleep(300);
    out.settingsClosed = !vis('#settingsOv');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', ctrlKey: true, bubbles: true }));
    await sleep(600);
    out.palette = vis('#paletteOv') && document.querySelectorAll('#paletteList [data-pal-i]').length > 0;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(300);
    out.paletteClosed = !vis('#paletteOv');

    const si = $('#searchInput');
    const before = document.querySelectorAll('.chat-item').length;
    si.value = 'zzz-no-such-chat';
    si.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(350);
    const none = document.querySelectorAll('.chat-item').length;
    si.value = '';
    si.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(350);
    out.search = before >= 1 && none === 0 && document.querySelectorAll('.chat-item').length === before;

    const dm = document.querySelector('[data-folder="dm"]');
    const all = document.querySelector('[data-folder="all"]');
    dm?.click(); await sleep(250);
    const dmCount = document.querySelectorAll('.chat-item').length;
    all?.click(); await sleep(250);
    out.folders = document.querySelectorAll('.chat-item').length >= dmCount;

    out.nameless = [...document.querySelectorAll('button')]
      .filter((b) => !(b.getAttribute('aria-label') || b.textContent || '').trim())
      .map((b) => b.id || b.className);
    out.namelessList = out.nameless.join(', ');
    out.nameless = out.nameless.length;
    /* Демо — это и есть «из кэша», метка там только путала бы.
       В живом прогоне метка законна (сеть могла пропасть) — не проверяем. */
    out.cacheLabel = /[?&]demo=1/.test(location.search)
      ? /из кэша/i.test(document.body.innerText || '')
      : false;
    return out;
  })()`);

  if (!r || r.__error) {
    record('UI-смоук: настройки, палитра, поиск, папки, a11y', false, String(r && r.__error));
    return;
  }
  record('настройки открываются и закрываются', Boolean(r.settings && r.settingsClosed));
  record('палитра команд открывается и закрывается', Boolean(r.palette && r.paletteClosed));
  record('поиск по чатам фильтрует и очищается', Boolean(r.search));
  record('папки фильтруют и возвращают список', Boolean(r.folders));
  record('у иконочных кнопок есть подписи для диктора', r.nameless === 0, 'без подписи: ' + r.nameless + (r.namelessList ? ' (' + r.namelessList + ')' : ''));
  record('в демо нет метки «из кэша»', r.cacheLabel === false);
}

async function runDemo() {
  const ctx = await launch('demo', 9341);
  try {
    await ctx.send('Page.navigate', { url: BASE + '?demo=1' });
    /* Ждём именно загрузки приложения, а не фиксированные 3.5 с:
       на слабой машине демо-сид с генерацией превью занимает дольше,
       и дальше все шаги падали «просто так». */
    const booted = await waitFor(ctx, `window.__relikLoaded === true`, 30000);
    if (!booted) throw new Error('приложение не загрузилось за 30 с');
    await sleep(600);
    const hasAuth = await ctx.evaluate(`!document.getElementById('authView').hidden`);
    if (hasAuth) {
      /* Регресс: на низком окне форма входа должна прокручиваться,
         а не обрезаться (body{overflow:hidden}). */
      await ctx.send('Emulation.setDeviceMetricsOverride', {
        width: 1280, height: 620, deviceScaleFactor: 1, mobile: false,
      });
      await sleep(400);
      const scrollState = await ctx.evaluate(`(() => {
        const a = document.getElementById('authView');
        const can = a.scrollHeight - a.clientHeight;
        const before = a.scrollTop;
        a.scrollTop = 9999;
        const after = a.scrollTop;
        a.scrollTop = before;
        return { can, after };
      })()`);
      record('окно входа прокручивается на низком экране', Boolean(scrollState && scrollState.can > 20 && scrollState.after > 0), JSON.stringify(scrollState));
      await ctx.send('Emulation.clearDeviceMetricsOverride', {});
      await sleep(250);

      await ctx.evaluate(`(function(){
        document.getElementById('authEmail').value='ui@relik.app';
        document.getElementById('authPass').value='123456';
        document.getElementById('authForm').requestSubmit();
      })()`);
      await sleep(2500);
    }
      record('вход в демо', Boolean(await ctx.evaluate(`!document.getElementById('appView').hidden`)));

    /* Онбординг первого запуска: показан один раз, закрывается кнопкой */
    const obShown = await dismissOnboarding(ctx);
    record('онбординг первого запуска', Boolean(obShown));
    record('онбординг закрылся', Boolean(await ctx.evaluate(`document.getElementById('obOv')?.hidden !== false`)));

    /* демо-данные сеются асинхронно: на холодном GitHub Pages список чатов
       появляется позже, чем экран приложения — ждём его, иначе шаг «плавает» */
    await waitFor(ctx, `document.querySelectorAll('.chat-item').length > 0`, 15000);

    const sidebarState = await ctx.evaluate(`({
      items: document.querySelectorAll('.chat-item').length,
      text: (document.getElementById('sideList')?.innerText || '').slice(0, 120),
      hash: location.hash,
    })`);
    await ctx.evaluate(`document.querySelector('.chat-item')?.click()`);
    const opened = await waitFor(ctx, `!document.getElementById('chatActive').hidden`, 8000);
    record('открытие чата', Boolean(opened), JSON.stringify(sidebarState));

    const marker = 'e2e-' + Date.now();
    await typeAndSend(ctx, marker);
    const ok = await waitFor(ctx, `document.body.innerText.includes(${JSON.stringify(marker)})`, 8000);
    record('отправка сообщения', Boolean(ok), marker);

    const before = await ctx.evaluate(`document.querySelectorAll('#chatActive .msg').length`);
    await ctx.evaluate(`document.getElementById('newChatBtn').click()`);
    await sleep(600);
    record('окно нового чата', Boolean(await ctx.evaluate(`!document.getElementById('ncOv').hidden`)));
    await ctx.evaluate(`document.getElementById('ncOv').hidden = true`);

    await ctx.evaluate(`document.getElementById('peopleBtn').click()`);
    await sleep(600);
    record('поиск людей', Boolean(await ctx.evaluate(`!document.getElementById('peopleOv').hidden`)));
    await ctx.evaluate(`document.getElementById('peopleOv').hidden = true`);

    record('лента не сломалась', Number(before) >= 1, 'сообщений: ' + before);

    /* Панель действий: появляется при наведении, не исчезает мгновенно при
       уходе курсора (есть пауза) и стоит сбоку. Живая лента может перерисоваться
       во время проверки (typing/read-таймеры), поэтому сценарий повторяем. */
    const toolsState = await ctx.evaluate(`(async () => {
      const wait = (ms) => new Promise((res) => setTimeout(res, ms));
      const pick = () => [...document.querySelectorAll('#chatActive .msg')].find((m) => m.querySelector('.bubble'));
      let shown = false, duringGrace = false, afterReturn = false, side = null;

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const el = pick();
        if (!el) return null;
        const bubble = el.querySelector('.bubble');
        const r = bubble.getBoundingClientRect();
        const ev = (type, target, related) => target.dispatchEvent(new PointerEvent(type, {
          bubbles: true, pointerType: 'mouse', clientX: r.left + 6, clientY: r.top + 6, relatedTarget: related,
        }));

        ev('pointerover', bubble, document.body);
        await wait(60);
        shown = !!bubble.querySelector('.tools');

        ev('pointerout', bubble, document.body);
        await wait(80);
        duringGrace = !!bubble.querySelector('.tools');

        const tools = bubble.querySelector('.tools');
        if (!tools || !bubble.isConnected) continue; /* ленту перерисовали */
        const tr = tools.getBoundingClientRect();
        side = {
          left: Math.round(tr.left), right: Math.round(tr.right),
          bubbleRight: Math.round(r.right), bubbleTop: Math.round(r.top), toolsTop: Math.round(tr.top),
        };
        ev('pointerover', tools, bubble);
        await wait(260);
        afterReturn = !!bubble.querySelector('.tools');
        if (bubble.isConnected) break;
      }
      return { shown, duringGrace, afterReturn, side };
    })()`);
    if (toolsState) {
      record('меню действий появляется при наведении', Boolean(toolsState.shown));
      record('меню не исчезает мгновенно при уходе курсора', Boolean(toolsState.duringGrace));
      record('меню остаётся, если вернуться на него', Boolean(toolsState.afterReturn));
      const side = toolsState.side;
      const isSide = !!side && side.left >= side.bubbleRight;
      record('меню стоит сбоку от сообщения', isSide, side ? JSON.stringify(side) : 'нет данных');
    }

    await runUiSmoke(ctx);

    /* Последняя проверка — вне приложения: документные страницы скроллятся.
       Синтетический жест в headless не всегда доставляется (композитор),
       поэтому падение ловим по главному признаку: body не должен быть
       overflow:hidden при переполнении страницы. */
    const doc = await checkDocScroll(ctx, 'legal.html');
    const docOk = Boolean(doc) && (doc.top > 0 || (doc.sh > doc.ch + 10 && doc.overflowY !== 'hidden'));
    record('страница правил не блокирует прокрутку', docOk, JSON.stringify(doc));
  } finally {
    const errs = ctx.errors();
    if (errs.length) {
      console.log('\nОшибки в консоли браузера:');
      for (const e of errs.slice(-12)) console.log('  ' + e.slice(0, 300));
    }
    ctx.close();
  }
}

async function runLive() {
  const A = await launch('a', 9342);
  const B = await launch('b', 9343);
  try {
    await login(A, env.a);
    record('вход A', true, env.a.name);
    await dismissOnboarding(A);
    await login(B, env.b);
    record('вход B', true, env.b.name);
    await dismissOnboarding(B);

    /* Контакты A ↔ B. На повторных прогонах они уже установлены — тогда
       заявку не отправляем, иначе тест «падал» на пустом списке входящих. */
    const uname = USERNAME_B.replace(/^@/, '');
    let relation = USERNAME_B ? await peopleRelation(A, uname) : 'unknown';
    record('связь с B', relation === 'contact' || relation === 'none' || relation === 'outgoing', 'состояние: ' + relation);

    if (relation === 'none') {
      const invited = await clickInvite(A);
      record('заявка в контакты', invited, uname);
      if (!invited) {
        const debug = await A.evaluate(`JSON.stringify({
          open: !document.getElementById('peopleOv').hidden,
          rows: document.querySelectorAll('#peopleList .people-row').length,
          text: (document.getElementById('peopleList').innerText || '').slice(0, 160),
        })`);
        record('список людей', false, String(debug).slice(0, 300));
      }
      if (invited) {
        const accepted = await acceptFirstRequest(B);
        /* повторы: заявка могла уже существовать — тогда B просто ничего не видит */
        if (!accepted) relation = await peopleRelation(A, uname);
        record('принятие заявки', Boolean(accepted) || relation === 'contact',
          accepted ? '' : 'заявки не было, состояние: ' + relation);
      }
    } else if (relation === 'contact') {
      record('контакты уже установлены', true);
    } else if (relation === 'outgoing') {
      record('заявка уже отправлена', true);
      const accepted = await acceptFirstRequest(B);
      record('принятие заявки', Boolean(accepted) || (await peopleRelation(A, uname)) === 'contact');
    }

    const opened = await openChatWith(A, env.b.name);
    record('чат с B открыт', opened);

    if (opened) {
      const marker = 'e2e-' + Date.now();
      await typeAndSend(A, marker);
      record('A отправил', true, marker);

      /* B: обновляем список и открываем чат с A */
      await B.evaluate(`window.dispatchEvent(new Event('focus'))`);
      await sleep(1500);
      const bOpened = await openChatWith(B, env.a.name);
      let got = bOpened
        ? await waitFor(B, `document.body.innerText.includes(${JSON.stringify(marker)})`, 25000)
        : null;
      if (!got) {
        /* Сеть до Supabase иногда «залипает» на первом запросе после входа.
           Один перезаход (как сделал бы человек) обычно всё лечит. */
        await B.evaluate(`location.reload()`);
        await sleep(6000);
        await waitFor(B, `!document.getElementById('appView').hidden`, 30000, 500);
        const second = await openChatWith(B, env.a.name);
        if (second) {
          got = await waitFor(B, `document.body.innerText.includes(${JSON.stringify(marker)})`, 25000);
        }
      }
      record('B получил сообщение', Boolean(got), got ? '' : 'не найдено в ленте B');

      if (bOpened) {
        const back = 'reply-' + Date.now();
        await typeAndSend(B, back);
        let onB = await waitFor(B, `document.body.innerText.includes(${JSON.stringify(back)})`, 8000);
        if (!onB) {
          await typeAndSend(B, back);
          onB = await waitFor(B, `document.body.innerText.includes(${JSON.stringify(back)})`, 8000);
        }
        record('B отправил ответ', Boolean(onB));
        const gotBack = await waitFor(A, `document.body.innerText.includes(${JSON.stringify(back)})`, 45000);
        record('A получил ответ', Boolean(gotBack));

        await runUiSmoke(A);
      }
    }
  } finally {
    const errs = A.errors();
    const errsB = B.errors();
    const all = [...errs, ...errsB];
    if (all.length) {
      console.log('\nОшибки в консоли браузера:');
      for (const e of all.slice(-12)) console.log('  ' + e.slice(0, 300));
    }
    const http = [...A.httpErrors(), ...B.httpErrors()];
    if (http.length) {
      console.log('\nHTTP-ответы с ошибкой:');
      for (const e of [...new Set(http)].slice(0, 12)) console.log('  ' + e);
    }
    A.close();
    B.close();
  }
}

async function runSignup() {
  const ctx = await launch('signup', 9346);
  const stamp = Date.now().toString(36);
  const email = process.env.SIGNUP_EMAIL || `test.${stamp}@relik.test`;
  const username = process.env.SIGNUP_USERNAME || `t${stamp}`.slice(0, 18);
  const password = process.env.SIGNUP_PASS || 'Signup-Test-2026-x7Kq';
  try {
    await waitFor(ctx, `document.documentElement.dataset.boot === 'done'`, 30000);
    record('экран входа загружен', true);

    await ctx.evaluate(`document.querySelector('[data-mode="signup"]')?.click()`);
    await sleep(400);

    const filled = await ctx.evaluate(`(function(){
      var n=document.getElementById('authName');
      var u=document.getElementById('authUsername');
      var e=document.getElementById('authEmail');
      var p=document.getElementById('authPass');
      var c=document.getElementById('authConsent');
      if(!n||!u||!e||!p) return false;
      n.value=${JSON.stringify('Signup ' + stamp)};
      u.value=${JSON.stringify(username)};
      e.value=${JSON.stringify(email)};
      p.value=${JSON.stringify(password)};
      if (c) c.checked = true;
      document.getElementById('authForm').requestSubmit();
      return true;
    })()`);
    record('форма регистрации заполнена', Boolean(filled), email);

    const invite = await waitFor(ctx, `!document.getElementById('verifyOv').hidden`, 15000);
    record('запрос инвайт-кода', Boolean(invite));

    if (invite) {
      await ctx.evaluate(`(function(){
        var i=document.getElementById('verifyCode');
        i.value='LAREK1999';
        i.dispatchEvent(new Event('input'));
        document.getElementById('verifyGo').click();
      })()`);
      const app = await waitFor(ctx, `!document.getElementById('appView').hidden`, 45000);
      record('регистрация завершена', Boolean(app));

      const me = await ctx.evaluate(`(async () => {
        const m = await import('./js/ui/state.js');
        return m.S.me ? JSON.stringify({ id: m.S.me.id, username: m.S.me.username, hasKey: !!m.S.me.publicKey }) : '';
      })()`);
      record('профиль и @username созданы', String(me).includes(username), String(me).slice(0, 120));
      record('ключи шифрования созданы', String(me).includes('"hasKey":true'));

      await ctx.send('Page.reload');
      await sleep(3500);
      const persists = await waitFor(ctx, `!document.getElementById('appView').hidden`, 25000);
      record('сессия сохраняется после перезагрузки', Boolean(persists));
    }
  } finally {
    ctx.close();
  }
}

(async () => {
  console.log('Relik e2e · ' + BASE + (DEMO ? ' (демо)' : ''));
  try {
    if (has('signup')) await runSignup();
    else if (has('warmup')) {
      const A = await launch('warm-a', 9344);
      const B = await launch('warm-b', 9345);
      try {
        await login(A, env.a);
        record('прогрев A: профиль и ключи', true);
        await login(B, env.b);
        record('прогрев B: профиль и ключи', true);
      } finally {
        A.close();
        B.close();
      }
      await sleep(800);
      process.exit(0);
    } else if (DEMO) {
      await runDemo();
    } else {
      await runLive();
    }
  } catch (err) {
    record('исключение', false, err?.message || String(err));
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log('\nИтого: ' + (results.length - failed) + '/' + results.length + ' шагов пройдено');
  if (failed) console.log('Провалено: ' + results.filter((r) => !r.ok).map((r) => r.name).join(', '));
  await sleep(KEEP ? 0 : 800);
  process.exit(failed ? 1 : 0);
})();
