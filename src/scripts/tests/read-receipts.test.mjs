/* Тесты извлечённой логики: прочтения и окно TTL.
   Модули браузерные, поэтому сначала ставим шим localStorage. */
import test from 'node:test';
import assert from 'node:assert/strict';

import { installShim } from './_shim.mjs';

installShim();

const receipts = await import('../../js/ui/chat/receipts.js');
const ttl = await import('../../js/ui/chat/ttl.js');
const prefs = await import('../../js/ui/prefs.js');
const { S } = await import('../../js/ui/state.js');

S.me = { id: 'me', name: 'Me' };

const read = (sender, upto, extra = {}) => ({ id: 'r' + sender + upto, type: 'read', sender, ts: upto, read: { upto }, ...extra });

test('прочтения: берём максимум по каждому участнику', () => {
  const map = receipts.readUptos([read('u1', 10), read('u1', 30), read('u2', 20)]);
  assert.equal(map.get('u1'), 30);
  assert.equal(map.get('u2'), 20);
});

test('прочтения: свои отметки и обычные сообщения игнорируются', () => {
  const map = receipts.readUptos([
    read('u_me', 99),
    read('me', 98),
    { id: 'm1', type: 'text', sender: 'u1', text: 'привет' },
    { id: 'm2', type: 'read', sender: 'u1', read: null },
  ]);
  assert.equal(map.size, 0);
});

test('прочтения: в личке нужен один собеседник, в группе — все участники', () => {
  assert.deepEqual(receipts.requiredReaders({ kind: 'dm', userId: 'u1' }), ['u1']);
  assert.deepEqual(receipts.requiredReaders({ kind: 'group', members: ['a', 'b', 'a', null] }), ['a', 'b']);
  assert.deepEqual(receipts.requiredReaders(null), []);
});

test('прочтения: без DOM точечное обновление молча ничего не делает', () => {
  S.active = 'c1';
  assert.doesNotThrow(() => receipts.refreshMessageStatus({ id: 'm1', chatId: 'c1', status: 'sent' }));
});

test('TTL: окно считается только для живых сообщений после включения', () => {
  const chatId = 'c_ttl_test';
  prefs.setChatTtl(chatId, 60, 1000);
  const alive = { id: 'm1', chatId, ts: 2000, type: 'text' };
  assert.equal(ttl.ttlWindow(alive), 60000, '60 секунд в миллисекундах');

  const old = { id: 'm2', chatId, ts: 500, type: 'text' };
  assert.equal(ttl.ttlWindow(old), 0, 'сообщение старше включения TTL не исчезает');

  assert.equal(ttl.ttlWindow({ ...alive, hidden: true }), 0);
  assert.equal(ttl.ttlWindow({ ...alive, deleted: true }), 0);
  assert.equal(ttl.ttlWindow({ ...alive, expired: true }), 0);
  assert.equal(ttl.ttlWindow(null), 0);

  prefs.setChatTtl(chatId, 0, 0);
  assert.equal(ttl.ttlWindow(alive), 0, 'TTL выключен');
});

test('TTL: clearTtlTimers безопасен при пустом состоянии', () => {
  assert.doesNotThrow(() => ttl.clearTtlTimers());
  assert.doesNotThrow(() => ttl.clearTtlForChat('нет-такого'));
});
