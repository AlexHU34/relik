/* Конверт v2: адресация нескольким устройствам.
   Проверяем главное свойство: каждое устройство достаёт только свою «коробку»,
   а старые одиночные конверты продолжают читаться. */
import test from 'node:test';
import assert from 'node:assert/strict';

import { packEnvelope, pickBox, envelopeDevices, isAddressedTo } from '../../js/crypto/v2/envelope.js';

const box = (id) => ({ header: { n: id }, iv: 'iv-' + id, ct: 'ct-' + id });

test('конверт: пустой список устройств не создаёт конверт', () => {
  assert.equal(packEnvelope({ fromDevice: 'A', ts: 1, boxes: {} }), null);
});

test('конверт: каждое устройство читает только своё', () => {
  const env = packEnvelope({
    fromDevice: 'A',
    ts: 100,
    boxes: { B1: box('B1'), B2: box('B2'), A2: box('A2') },
  });
  assert.deepEqual(envelopeDevices(env).sort(), ['A2', 'B1', 'B2']);
  assert.equal(pickBox(env, 'B1').ct, 'ct-B1');
  assert.equal(pickBox(env, 'B2').ct, 'ct-B2');
  assert.equal(pickBox(env, 'A2').ct, 'ct-A2');
  assert.equal(pickBox(env, 'CHUZHOY'), null, 'чужое устройство не должно читать');
  assert.equal(env.toDevice, null, 'адресат не один');
  assert.equal(isAddressedTo(env, 'B1'), true);
  assert.equal(isAddressedTo(env, 'X'), false);
});

test('конверт: старый одиночный формат всё ещё читается', () => {
  const legacy = { v: 2, fromDevice: 'A', toDevice: 'B1', ts: 5, header: {}, iv: 'i', ct: 'c' };
  assert.equal(pickBox(legacy, 'B1').ct, 'c');
  assert.equal(pickBox(legacy, 'B2'), null);
  assert.deepEqual(envelopeDevices(legacy), ['B1']);
});

test('конверт: битые данные не роняют расшифровку', () => {
  assert.equal(pickBox(null, 'B1'), null);
  assert.equal(pickBox({ v: 1 }, 'B1'), null);
  assert.equal(pickBox({ v: 2, toDevice: 'B1' }, 'B1'), null, 'нет header/iv/ct');
  assert.equal(pickBox({ v: 2, envelopes: null }, 'B1'), null);
});

test('конверт: размер растёт с числом устройств (ожидаемо)', () => {
  const one = packEnvelope({ fromDevice: 'A', ts: 1, boxes: { B1: box('B1') } });
  const three = packEnvelope({ fromDevice: 'A', ts: 1, boxes: { B1: box('B1'), B2: box('B2'), B3: box('B3') } });
  const grew = JSON.stringify(three).length - JSON.stringify(one).length;
  assert.ok(grew > 60, `две дополнительные коробки должны добавить вес, а добавили ${grew}`);
  assert.equal(envelopeDevices(three).length, 3);
});
