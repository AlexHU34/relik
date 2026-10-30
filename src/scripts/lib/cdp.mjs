/* Мини-клиент Chrome DevTools Protocol без зависимостей.
   Используется скриптами scripts/visual.mjs (и может — e2e.mjs).
   Требует установленный Chrome/Edge: путь можно задать в CHROME_PATH. */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const CHROME = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean).find((p) => existsSync(p));

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch({ port = 9333, size = [1280, 900], keep = false } = {}) {
  if (!CHROME) throw new Error('Chrome не найден. Установите CHROME_PATH.');

  const dir = mkdtempSync(join(tmpdir(), 'relik-cdp-'));
  const child = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${dir}`,
    `--window-size=${size[0]},${size[1]}`,
    'about:blank',
  ], { stdio: 'ignore' });

  let page = null;
  for (let i = 0; i < 80 && !page; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      page = list.find((t) => t.type === 'page');
    } catch (e) { /* ещё поднимается */ }
    if (!page) await sleep(250);
  }
  if (!page) {
    try { child.kill(); } catch (e) { /* ignore */ }
    throw new Error('Chrome не поднялся на порту ' + port);
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });

  let id = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m.error ? { __error: m.error } : (m.result || {}));
      pending.delete(m.id);
      return;
    }
    if (m.method && listeners.has(m.method)) {
      for (const fn of listeners.get(m.method)) {
        try { fn(m.params); } catch (err) { /* обработчик не должен ломать клиент */ }
      }
    }
  });

  const send = (method, params = {}) => new Promise((resolve) => {
    const n = (id += 1);
    pending.set(n, resolve);
    ws.send(JSON.stringify({ id: n, method, params }));
  });

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return { __error: r.exceptionDetails.text || 'js error' };
    return r.result ? r.result.value : undefined;
  };

  const goto = async (url, settle = 1200) => {
    await send('Page.navigate', { url });
    await sleep(settle);
  };

  const screenshot = async () => {
    const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    return r && r.data ? Buffer.from(r.data, 'base64') : null;
  };

  const device = async (width, height, mobile = false) => {
    await send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 1, mobile,
    });
  };

  await send('Runtime.enable');
  await send('Page.enable');

  return {
    send, evaluate, goto, screenshot, device,
    /* подписка на события CDP: Runtime.exceptionThrown, Log.entryAdded, ... */
    on(method, fn) {
      if (!listeners.has(method)) listeners.set(method, []);
      listeners.get(method).push(fn);
    },
    close() {
      try { ws.close(); } catch (e) { /* ignore */ }
      try { child.kill(); } catch (e) { /* ignore */ }
      if (!keep) setTimeout(() => { try { rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ } }, 400);
    },
  };
}

export async function waitFor(ctx, expression, timeout = 20000, step = 350) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const v = await ctx.evaluate(expression);
    if (v && v !== '__error') return v;
    await sleep(step);
  }
  return null;
}
