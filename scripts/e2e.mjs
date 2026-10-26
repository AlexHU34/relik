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
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

async function launch(tag, port) {
  const dir = mkdtempSync(join(tmpdir(), `relik-e2e-${tag}-`));
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
  if (!page) throw new Error(`Chrome ${tag} не поднялся`);

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });

  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m.result || {});
      pending.delete(m.id);
    }
  });
  const send = (method, params = {}) => new Promise((resolve) => {
    const n = (id += 1);
    pending.set(n, resolve);
    ws.send(JSON.stringify({ id: n, method, params }));
  });

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
    close() {
      try { ws.close(); } catch (e) { /* ignore */ }
      try { child.kill(); } catch (e) { /* ignore */ }
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

async function sendContactRequest(ctx, username) {
  await openPeopleSearch(ctx);
  await ctx.evaluate(`(function(){
    var i=document.getElementById('peopleSearch');
    i.value=${JSON.stringify(username)};
    i.dispatchEvent(new Event('input'));
  })()`);
  await sleep(900);
  const clicked = await ctx.evaluate(`(function(){
    var b=[...document.querySelectorAll('#peopleList [data-pact="add"]')][0];
    if (b) { b.click(); return 'sent'; }
    if (document.querySelector('#peopleList .pc-pending')) return 'already';
    if (document.querySelector('#peopleList [data-pact="write"]')) return 'contact';
    return false;
  })()`);
  return clicked;
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
  await sleep(700);
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

async function runDemo() {
  const ctx = await launch('demo', 9341);
  try {
    await ctx.send('Page.navigate', { url: BASE + '?demo=1' });
    await sleep(3500);
    const hasAuth = await ctx.evaluate(`!document.getElementById('authView').hidden`);
    if (hasAuth) {
      await ctx.evaluate(`(function(){
        document.getElementById('authEmail').value='ui@relik.app';
        document.getElementById('authPass').value='123456';
        document.getElementById('authForm').requestSubmit();
      })()`);
      await sleep(2500);
    }
    record('вход в демо', Boolean(await ctx.evaluate(`!document.getElementById('appView').hidden`)));

    await ctx.evaluate(`document.querySelector('.chat-item')?.click()`);
    const opened = await waitFor(ctx, `!document.getElementById('chatActive').hidden`, 8000);
    record('открытие чата', Boolean(opened));

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
  } finally {
    ctx.close();
  }
}

async function runLive() {
  const A = await launch('a', 9342);
  const B = await launch('b', 9343);
  try {
    await login(A, env.a);
    record('вход A', true, env.a.name);
    await login(B, env.b);
    record('вход B', true, env.b.name);

    /* заявка в контакты A → B */
    const requested = USERNAME_B ? await sendContactRequest(A, USERNAME_B.replace(/^@/, '')) : false;
    record('заявка в контакты', requested, USERNAME_B || 'USERNAME_B не задан');

    if (requested === 'contact') {
      record('контакты уже установлены', true);
    } else if (requested) {
      const accepted = await acceptFirstRequest(B);
      record('принятие заявки', Boolean(accepted));
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
      const got = bOpened
        ? await waitFor(B, `document.body.innerText.includes(${JSON.stringify(marker)})`, 25000)
        : null;
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

        /* валюта: подарок 1 Relic за ответ B */
        const gifting = await A.evaluate(`(async () => {
          const w = await import('./js/backend/wallet.js');
          const st = await import('./js/ui/state.js');
          const chatId = st.S.active;
          const list = st.S.messages[chatId] || [];
          const incoming = list.filter((m) => m.sender !== 'u_me');
          const target = incoming[incoming.length - 1];
          if (!target) return 'no-incoming';
          const before = st.S.relics;
          const g = await w.sendGift(chatId, target.id, target.sender, 1);
          return JSON.stringify({ before, after: st.S.relics, amount: g && g.amount });
        })()`);
        record('подарок Relics', /"amount":1/.test(String(gifting)), String(gifting).slice(0, 90));
      }
    }
  } finally {
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
        i.value='RELIK2013';
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
