/* Политика повторов при обрывах сети: что повторяем, а что нет.
   Без этого при одном ERR_CONNECTION_RESET падала загрузка списка чатов,
   хотя повтор через полсекунды обычно проходит. */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isRetryableError, retryDelay, withRetry,
} from '../../js/backend/netRetry.js';

test('повторяем только транспортные сбои', () => {
  assert.equal(isRetryableError(new TypeError('Failed to fetch')), true);
  assert.equal(isRetryableError(new Error('TypeError: Load failed')), true);
  assert.equal(isRetryableError(new Error('net::ERR_CONNECTION_RESET')), true);
  assert.equal(isRetryableError(new Error('timeout of 10000ms exceeded')), true);
  assert.equal(isRetryableError({ message: 'boom', code: '503' }), true);
  assert.equal(isRetryableError({ message: 'boom', status: 429 }), true);
  assert.equal(isRetryableError({ message: 'boom', status: 502 }), true);
});

test('не повторяем ошибки данных и прав', () => {
  assert.equal(isRetryableError({ message: 'row-level security', code: '42501' }), false);
  assert.equal(isRetryableError({ message: 'bad request', status: 400 }), false);
  assert.equal(isRetryableError({ message: 'jwt expired', status: 401 }), false);
  assert.equal(isRetryableError({ message: 'duplicate key', code: '23505' }), false);
  assert.equal(isRetryableError({ message: 'not found', status: 404 }), false);
  assert.equal(isRetryableError(null), false);
  assert.equal(isRetryableError(new Error('Совсем другая ошибка')), false);
});

test('пауза растёт и упирается в потолок', () => {
  const fixed = () => 0.5; /* множитель 1.0 */
  const seq = [0, 1, 2, 3, 9].map((n) => retryDelay(n, fixed));
  assert.equal(seq[0], 700);
  assert.equal(seq[1], 1400);
  assert.equal(seq[2], 2800);
  assert.ok(seq[3] > seq[2]);
  assert.equal(seq[4], 8000, 'дальше — потолок');
});

test('джиттер не даёт синхронных волн', () => {
  const low = retryDelay(2, () => 0);
  const high = retryDelay(2, () => 0.999);
  assert.ok(low < high);
  assert.ok(low >= 1680, 'нижняя граница 2800 * 0.6');
  assert.ok(high <= 3920, 'верхняя граница 2800 * 1.4');
});

test('успех с первой попытки не ждёт', async () => {
  const waits = [];
  let calls = 0;
  const result = await withRetry(async () => { calls += 1; return 'ok'; }, {
    wait: async (ms) => { waits.push(ms); },
  });
  assert.equal(result, 'ok');
  assert.equal(calls, 1);
  assert.deepEqual(waits, []);
});

test('обрыв повторяется и запрос проходит', async () => {
  let calls = 0;
  const waits = [];
  const result = await withRetry(async (i) => {
    calls += 1;
    if (i < 2) throw new TypeError('Failed to fetch');
    return 'данные';
  }, { wait: async (ms) => { waits.push(ms); }, random: () => 0.5 });
  assert.equal(result, 'данные');
  assert.equal(calls, 3);
  assert.deepEqual(waits, [700, 1400]);
});

test('ошибку данных не повторяем вовсе', async () => {
  let calls = 0;
  let thrown = null;
  try {
    await withRetry(async () => {
      calls += 1;
      throw { message: 'permission denied', code: '42501' };
    }, { wait: async () => {} });
  } catch (err) {
    thrown = err;
  }
  assert.equal(thrown?.code, '42501');
  assert.equal(calls, 1);
});

test('после всех попыток отдаём последнюю ошибку', async () => {
  let calls = 0;
  await assert.rejects(() => withRetry(async () => {
    calls += 1;
    throw new TypeError('Failed to fetch');
  }, { attempts: 2, wait: async () => {} }), /Failed to fetch/);
  assert.equal(calls, 2);
});

test('паузы не копятся дольше потолка и сообщают о повторе', async () => {
  const waits = [];
  const retries = [];
  await assert.rejects(() => withRetry(async () => {
    throw { message: 'boom', status: 503 };
  }, {
    attempts: 5,
    cap: 1000,
    random: () => 0.5,
    wait: async (ms) => { waits.push(ms); },
    onRetry: (n, ms) => retries.push([n, ms]),
  }));
  assert.deepEqual(waits, [700, 1000, 1000, 1000]);
  assert.deepEqual(retries.map((r) => r[0]), [1, 2, 3, 4]);
});
