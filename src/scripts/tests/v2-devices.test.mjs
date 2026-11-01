/* Политика устройств для crypto v2: кого адресовать в конверте.
   Проверяем то, из-за чего фан-аут может вырасти: брошенные устройства,
   отсутствие метки времени, порядок «свежие первыми» и жёсткий лимит. */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  pickActiveDevices, needsTouch, DEVICE_MAX_AGE_DAYS, DEVICE_FANOUT_LIMIT,
} from '../../js/crypto/v2/devicePolicy.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 0, 1);
const dev = (deviceId, daysAgo) => ({ deviceId, updatedAt: NOW - daysAgo * DAY });

test('устройства: свежие попадают в конверт', () => {
  const list = pickActiveDevices([dev('a', 0), dev('b', 3)], { now: NOW });
  assert.deepEqual(list.map((d) => d.deviceId), ['a', 'b']);
});

test('устройства: брошенные (старше maxAgeDays) отбрасываются', () => {
  const list = pickActiveDevices([
    dev('fresh', 1),
    dev('old', DEVICE_MAX_AGE_DAYS + 1),
    dev('exactly', DEVICE_MAX_AGE_DAYS),
  ], { now: NOW });
  assert.deepEqual(list.map((d) => d.deviceId), ['fresh', 'exactly']);
});

test('устройства: строка без updated_at считается живой (старые записи)', () => {
  const list = pickActiveDevices([{ deviceId: 'legacy' }, dev('new', 0)], { now: NOW });
  assert.deepEqual(list.map((d) => d.deviceId).sort(), ['legacy', 'new']);
});

test('устройства: мусор без deviceId не попадает в конверт', () => {
  const list = pickActiveDevices([null, {}, { deviceId: '' }, dev('ok', 0)], { now: NOW });
  assert.deepEqual(list.map((d) => d.deviceId), ['ok']);
});

test('устройства: порядок — свежие первыми, и не больше лимита', () => {
  const many = Array.from({ length: DEVICE_FANOUT_LIMIT + 5 }, (_, i) => dev('d' + i, i));
  const list = pickActiveDevices(many, { now: NOW });
  assert.equal(list.length, DEVICE_FANOUT_LIMIT);
  assert.deepEqual(list.map((d) => d.deviceId), ['d0', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7']);
});

test('устройства: лимит и окно можно переопределить', () => {
  const list = pickActiveDevices([dev('a', 0), dev('b', 1), dev('c', 2)], { now: NOW, limit: 2 });
  assert.deepEqual(list.map((d) => d.deviceId), ['a', 'b']);
  const strict = pickActiveDevices([dev('a', 0), dev('b', 2)], { now: NOW, maxAgeDays: 1 });
  assert.deepEqual(strict.map((d) => d.deviceId), ['a']);
});

test('устройства: пустой список — пустой конверт', () => {
  assert.deepEqual(pickActiveDevices(null, { now: NOW }), []);
  assert.deepEqual(pickActiveDevices([], { now: NOW }), []);
});

test('метка активности: продлеваем раз в сутки, а не на каждом запуске', () => {
  assert.equal(needsTouch(0, NOW), true, 'без метки — продлить');
  assert.equal(needsTouch(NOW - 1000, NOW), false, 'только что продлевали');
  assert.equal(needsTouch(NOW - 2 * DAY, NOW), true, 'сутки прошли');
});
