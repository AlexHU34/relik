/* Supabase-клиент: один клиент на вкладку и ленивая загрузка SDK.
   Регресс этого места уже ломал прод: SDK грузился после модулей, клиент
   создавался с null, и все запросы данных молча падали. Теперь SDK грузится
   через ensureSdk(), а модули читают sb в момент вызова (живая привязка). */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { installShim } from './_shim.mjs';

installShim();

function fakeWindow(withSdk) {
  const handlers = new Map();
  const win = {
    addEventListener(type, fn) {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type).push(fn);
    },
    fire(type) {
      for (const fn of handlers.get(type) || []) fn();
    },
  };
  if (withSdk) win.supabase = { createClient: () => win.__client };
  win.__client = { tag: 'client', from() {}, auth: {}, channel() { return {}; } };
  return win;
}

test('клиент создаётся, когда SDK уже загружен, и переиспользуется', async () => {
  globalThis.window = fakeWindow(true);
  const first = await import('../../js/backend/supabaseClient.js?case=sdk-ready');
  assert.equal(first.sb, globalThis.window.__client);
  assert.equal(globalThis.window.__relikSb, globalThis.window.__client);

  /* вторая «копия» модуля из другого чанка должна взять тот же клиент */
  const second = await import('../../js/backend/supabaseClient.js?case=second-chunk');
  assert.equal(second.sb, first.sb, 'два клиента вместо одного = двойные realtime-подписки');
});

test('SDK грузится лениво и привязка обновляется после ensureClient()', async () => {
  const win = fakeWindow(false);
  globalThis.window = win;

  const appended = [];
  globalThis.document = {
    baseURI: 'https://example.test/relik/',
    querySelector: () => null, /* SRI-meta в тестах нет — это нормально */
    head: { appendChild: (el) => appended.push(el) },
    createElement: () => ({
      addEventListener() {},
      removeEventListener() {},
    }),
  };

  const sdk = await import('../../js/backend/sdk.js');
  sdk.resetSdk();

  try {
    const mod = await import('../../js/backend/supabaseClient.js?case=lazy');
    assert.equal(mod.sb, null, 'до ensureClient клиента нет — и это не ошибка');
    assert.equal(mod.HAS_BACKEND, true, 'режим определяется по ключам, а не по факту загрузки');

    const waiting = mod.ensureClient();
    assert.equal(appended.length, 1, 'SDK подключается тегом script');
    assert.match(appended[0].src, /js\/vendor\/supabase\.js$/);
    assert.equal(mod.sb, null, 'пока скрипт не выполнился, клиента нет');

    /* имитируем выполнение UMD: он выставляет window.supabase */
    win.supabase = { createClient: () => win.__client };
    appended[0].onload();

    const client = await waiting;
    assert.equal(client, win.__client, 'ensureClient возвращает готовый клиент');
    assert.equal(mod.sb, win.__client, 'живая привязка обновилась');
  } finally {
    delete globalThis.document;
  }
});

test('ошибка загрузки SDK не вешает вход: возвращается null, следующая попытка повторяет', async () => {
  globalThis.window = fakeWindow(false);
  const bad = [];
  globalThis.document = {
    baseURI: 'https://example.test/relik/',
    querySelector: () => null,
    head: { appendChild: (el) => bad.push(el) },
    createElement: () => ({ addEventListener() {}, removeEventListener() {} }),
  };
  const sdk = await import('../../js/backend/sdk.js');
  sdk.resetSdk();
  try {
    const first = sdk.ensureSdk();
    bad[0].onerror();
    assert.equal(await first, null);
    assert.equal(sdk.sdkFailed(), true);

    const second = sdk.ensureSdk();
    assert.equal(bad.length, 2, 'после сбоя можно попробовать снова');
    bad[1].onerror();
    await second;
  } finally {
    delete globalThis.document;
  }
});

test('демо-режим (нет ключей) не создаёт клиент и не грузит SDK', () => {
  /* config.js читает ?demo=1 из location один раз при импорте, поэтому
     проверяем в отдельном процессе — иначе кэш модулей уже содержит ключи. */
  const code = `
    globalThis.location = { search: '?demo=1' };
    globalThis.window = {
      addEventListener() {},
      supabase: { createClient() { throw new Error('в демо клиент создавать нельзя'); } },
    };
    globalThis.document = { createElement() { throw new Error('в демо SDK грузить нельзя'); } };
    const m = await import('./js/backend/supabaseClient.js?case=demo');
    const c = await m.ensureClient();
    process.stdout.write(JSON.stringify({ sb: m.sb, client: c, backend: m.HAS_BACKEND, stored: window.__relikSb !== undefined }));
  `;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'),
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr.slice(0, 400));
  assert.deepEqual(JSON.parse(run.stdout), {
    sb: null, client: null, backend: false, stored: false,
  });
});
