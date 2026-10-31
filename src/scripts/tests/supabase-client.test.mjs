/* Supabase-клиент: один клиент на вкладку и устойчивость к порядку скриптов.
   Регресс этого места уже ломал прод: SDK грузился после модулей, supabaseClient
   создавался с null, и все запросы данных молча падали. */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { installShim } from './_shim.mjs';

installShim();

const realConsoleError = console.error;

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

test('если SDK ещё не выполнился, клиент появляется после load (живая привязка)', async () => {
  const win = fakeWindow(false);
  globalThis.window = win;
  console.error = () => {};
  try {
    const mod = await import('../../js/backend/supabaseClient.js?case=sdk-late');
    assert.equal(mod.sb, null, 'без SDK клиента быть не может');

    win.supabase = { createClient: () => win.__client };
    win.fire('load');

    assert.equal(mod.sb, win.__client, 'после загрузки SDK привязка должна обновиться');
  } finally {
    console.error = realConsoleError;
  }
});

test('демо-режим (нет ключей) не создаёт клиент', () => {
  /* config.js читает ?demo=1 из location один раз при импорте, поэтому
     проверяем в отдельном процессе — иначе кэш модулей уже содержит ключи. */
  const code = `
    globalThis.location = { search: '?demo=1' };
    globalThis.window = {
      addEventListener() {},
      supabase: { createClient() { throw new Error('в демо клиент создавать нельзя'); } },
    };
    const m = await import('./js/backend/supabaseClient.js?case=demo');
    process.stdout.write(JSON.stringify({ sb: m.sb, stored: window.__relikSb !== undefined }));
  `;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'),
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr.slice(0, 400));
  assert.deepEqual(JSON.parse(run.stdout), { sb: null, stored: false });
});
