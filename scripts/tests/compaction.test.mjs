/* Тесты компакции истории: что можно удалять, а что нельзя. */
import test from 'node:test';
import assert from 'node:assert/strict';

import { planCompaction, KEEP_PER_CHAT, OLDER_THAN_DAYS } from '../../js/db/compaction.js';

const DAY = 86400e3;
const NOW = Date.UTC(2026, 9, 27);
const old = (i, chatId = 'c1') => ({ id: `o${i}`, chatId, ts: NOW - (400 + i) * DAY, status: 'sent' });
const fresh = (i, chatId = 'c1') => ({ id: `f${i}`, chatId, ts: NOW - i * 1000, status: 'sent' });

test('свежие сообщения не удаляются никогда', () => {
  const list = Array.from({ length: 50 }, (_, i) => fresh(i));
  assert.deepEqual(planCompaction(list, { now: NOW }), []);
});

test('старые сверх лимита удаляются', () => {
  const list = [...Array.from({ length: 10 }, (_, i) => fresh(i)), ...Array.from({ length: 10 }, (_, i) => old(i))];
  const remove = planCompaction(list, { now: NOW, keepPerChat: 12 });
  assert.equal(remove.length, 8);
  assert.ok(remove.every((id) => id.startsWith('o')));
});

test('в пределах лимита старые остаются', () => {
  const list = Array.from({ length: 5 }, (_, i) => old(i));
  assert.deepEqual(planCompaction(list, { now: NOW, keepPerChat: 10 }), []);
});

test('недосланное и ошибочное не удаляется даже если старое и сверх лимита', () => {
  const list = [
    ...Array.from({ length: 4 }, (_, i) => fresh(i)),
    { id: 'sending', chatId: 'c1', ts: NOW - 999 * DAY, status: 'sending' },
    { id: 'error', chatId: 'c1', ts: NOW - 999 * DAY, status: 'error' },
    old(1),
  ];
  const remove = planCompaction(list, { now: NOW, keepPerChat: 2 });
  assert.ok(!remove.includes('sending'));
  assert.ok(!remove.includes('error'));
  assert.ok(remove.includes('o1'));
});

test('лимит считается отдельно для каждого чата', () => {
  const list = [
    ...Array.from({ length: 5 }, (_, i) => old(i, 'a')),
    ...Array.from({ length: 5 }, (_, i) => old(i, 'b')),
  ];
  const remove = planCompaction(list, { now: NOW, keepPerChat: 3 });
  assert.equal(remove.length, 4);
  assert.ok(remove.every((id) => id.startsWith('o')));
});

test('нулевой лимит и нулевой срок — ничего не удаляем', () => {
  const list = [old(1), old(2)];
  assert.equal(planCompaction(list, { now: NOW, keepPerChat: 0, olderThanDays: 0 }).length, 0);
});

test('порог «старше N дней» соблюдается точно', () => {
  const justInside = { id: 'in', chatId: 'c', ts: NOW - 179 * DAY, status: 'sent' };
  const justOutside = { id: 'out', chatId: 'c', ts: NOW - 181 * DAY, status: 'sent' };
  const remove = planCompaction([justInside, justOutside], { now: NOW, keepPerChat: 1 });
  assert.deepEqual(remove, ['out']);
});

test('мусор на входе не ломает проход', () => {
  assert.deepEqual(planCompaction(null, {}), []);
  assert.deepEqual(planCompaction([null, {}, { id: 'x' }], { keepPerChat: 0 }), []);
});

test('дефолты заданы и разумны', () => {
  assert.ok(KEEP_PER_CHAT >= 100 && KEEP_PER_CHAT <= 1000);
  assert.ok(OLDER_THAN_DAYS >= 30);
});
