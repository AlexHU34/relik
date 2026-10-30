#!/usr/bin/env node
/* Relik — проверка TURN из реального браузера (без звука).
   Запускает headless Chrome с --mute-audio, открывает tools/preflight.html
   и смотрит, появился ли relay-кандидат.

   Запуск:
     node scripts/ice-check.mjs
     node scripts/ice-check.mjs --url https://alexhu34.github.io/relik/
   Выход: 0 — TURN работает, 1 — нет, 2 — не удалось запустить браузер.
*/
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};

const BASE = arg('url', 'https://alexhu34.github.io/relik/').replace(/\/?$/, '/');
const PAGE = `${BASE}tools/preflight.html`;
const PORT = Number(arg('port', '9333'));
const TIMEOUT = Number(arg('timeout', '45000'));

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

const chrome = CANDIDATES.find((p) => existsSync(p));
if (!chrome) {
  console.error('Не найден Chrome. Укажи путь: CHROME_PATH=... node scripts/ice-check.mjs');
  process.exit(2);
}

const profile = mkdtempSync(join(tmpdir(), 'relik-ice-'));
const child = spawn(chrome, [
  '--headless=new',
  '--disable-gpu',
  '--mute-audio',            // без звука
  '--no-first-run',
  '--no-default-browser-check',
  '--autoplay-policy=user-gesture-required',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findTarget() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page;
    } catch (e) { /* ещё не поднялся */ }
    await sleep(250);
  }
  throw new Error('Chrome не отвечает на порту ' + PORT);
}

function cdp(ws) {
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg.result || {});
      pending.delete(msg.id);
    }
  });
  return (method, params = {}) => new Promise((resolve) => {
    const n = (id += 1);
    pending.set(n, resolve);
    ws.send(JSON.stringify({ id: n, method, params }));
  });
}

async function cleanup(code) {
  try { child.kill(); } catch (e) { /* ignore */ }
  await sleep(300);
  try { rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  process.exit(code);
}

try {
  const page = await findTarget();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  const send = cdp(ws);
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: PAGE });

  const started = Date.now();
  let report = null;
  while (Date.now() - started < TIMEOUT) {
    await sleep(700);
    const out = await send('Runtime.evaluate', {
      expression: `(function(){var r=document.getElementById('report');return r?r.textContent:'';})()`,
      returnByValue: true,
    });
    const text = out?.result?.value || '';
    if (text.trim().startsWith('{')) {
      try { report = JSON.parse(text); break; } catch (e) { /* ждём */ }
    }
  }

  if (!report) {
    console.log('ПРОВАЛ: страница не вернула отчёт за ' + Math.round(TIMEOUT / 1000) + ' с');
    await cleanup(1);
  }

  const ice = report.ice || {};
  const ok = Boolean(ice.relay);
  console.log('Relik ICE-проверка · ' + new Date(report.at || Date.now()).toLocaleString('ru-RU'));
  console.log('  страница : ' + report.page);
  console.log('  версия   : ' + (report.version || '?'));
  if (ok) {
    console.log('  TURN     : OK, relay выдан за ' + ice.time + ' мс (' + ice.relay + ')');
  } else {
    console.log('  TURN     : ПРОВАЛ' + (ice.error ? ' — ' + ice.error : ' — relay-кандидат не появился'));
  }
  console.log('  кандидаты: host=' + (ice.host || 0) + ' srflx=' + (ice.srflx || 0));
  console.log('  проблем  : ' + ((report.status && report.status.bad) || 0) + ', предупреждений: ' + ((report.status && report.status.warn) || 0));
  await cleanup(ok ? 0 : 1);
} catch (err) {
  console.error('Ошибка запуска: ' + (err?.message || err));
  await cleanup(2);
}
