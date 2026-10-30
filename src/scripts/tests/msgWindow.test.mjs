/* Тесты чистой логики окна ленты: без DOM и без сети. */
import test from 'node:test';
import assert from 'node:assert/strict';

import { PAGE_SIZE, SERVER_PAGE, mergeMessages, windowOf, oldestTs, nextLimit } from '../../js/ui/msgWindow.js';

const msg = (id, ts, extra = {}) => ({ id, ts, sender: 'u_me', type: 'text', text: id, ...extra });

test('окно: короткая лента отдаётся целиком', () => {
  const list = [msg('a', 1), msg('b', 2)];
  const win = windowOf(list, PAGE_SIZE);
  assert.equal(win.visible.length, 2);
  assert.equal(win.hiddenCount, 0);
});

test('окно: длинная лента обрезается с конца', () => {
  const list = Array.from({ length: 600 }, (_, i) => msg('m' + i, i + 1));
  const win = windowOf(list, PAGE_SIZE);
  assert.equal(win.visible.length, PAGE_SIZE);
  assert.equal(win.hiddenCount, 600 - PAGE_SIZE);
  assert.equal(win.visible[win.visible.length - 1].id, 'm599');
});

test('окно: мусорные входы не ломают рендер', () => {
  assert.deepEqual(windowOf(null, 10), { visible: [], hiddenCount: 0 });
  assert.equal(windowOf([msg('a', 1)], 0).visible.length, 1);
});

test('слияние: сервер — источник правды, порядок по времени', () => {
  const merged = mergeMessages([msg('b', 20), msg('a', 10)], []);
  assert.deepEqual(merged.map((m) => m.id), ['a', 'b']);
});

test('слияние: локальное «удалено у себя» переживает перезагрузку страницы', () => {
  const merged = mergeMessages([msg('a', 10)], [msg('a', 10, { localDeleted: true })]);
  assert.equal(merged[0].hidden, true);
  assert.equal(merged[0].localDeleted, true);
});

test('слияние: отправка в процессе не превращается в галочку', () => {
  const merged = mergeMessages([msg('a', 10, { status: 'sent' })], [msg('a', 10, { status: 'sending' })]);
  assert.equal(merged[0].status, 'sending');
});

test('слияние: ошибка отправки не теряется', () => {
  const merged = mergeMessages([msg('a', 10, { status: 'sent' })], [msg('a', 10, { status: 'error' })]);
  assert.equal(merged[0].status, 'error');
});

test('слияние: прочитанность сохраняется', () => {
  const merged = mergeMessages([msg('a', 10)], [msg('a', 10, { status: 'read' })]);
  assert.equal(merged[0].status, 'read');
});

test('слияние: локальные сообщения, которых нет на сервере, остаются', () => {
  const merged = mergeMessages([msg('a', 10)], [msg('local', 5, { status: 'sending' })]);
  assert.deepEqual(merged.map((m) => m.id), ['local', 'a']);
});

test('слияние: TTL-отметка не затирается страницей с сервера', () => {
  const merged = mergeMessages([msg('a', 10)], [msg('a', 10, { ttlStartedAt: 123 })]);
  assert.equal(merged[0].ttlStartedAt, 123);
});

test('oldestTs: самый старый курсор пагинации', () => {
  assert.equal(oldestTs([msg('a', 50), msg('b', 10), msg('c', 90)]), 10);
  assert.equal(oldestTs([]), 0);
  assert.equal(oldestTs([{ id: 'x' }]), 0);
});

test('nextLimit: шаг окна растёт и не уходит в NaN', () => {
  assert.equal(nextLimit(PAGE_SIZE, 50), PAGE_SIZE + 50);
  assert.equal(nextLimit(undefined, 0), PAGE_SIZE);
  assert.equal(nextLimit('abc', -5), PAGE_SIZE);
});

test('размеры страниц: DOM больше серверной страницы', () => {
  assert.ok(PAGE_SIZE > SERVER_PAGE);
});

/* ── надёжность доставки: слияние сервера и локального outbox ── */

test('слияние: локальное «удалено у меня» побеждает и прячет сообщение', () => {
  const merged = mergeMessages([msg('a', 10)], [msg('a', 10, { localDeleted: true })]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].hidden, true);
  assert.equal(merged[0].localDeleted, true);
});

test('слияние: истёкшее по TTL сообщение не возвращается с сервера', () => {
  const merged = mergeMessages([msg('a', 10)], [msg('a', 10, { expired: true, hidden: true, localDeleted: true })]);
  assert.equal(merged[0].expired, true);
  assert.equal(merged[0].hidden, true);
});

test('слияние: ошибка отправки не теряется, если сервер прислал копию', () => {
  const merged = mergeMessages([msg('a', 10)], [msg('a', 10, { status: 'error' })]);
  assert.equal(merged[0].status, 'error', 'пользователь должен видеть «не отправлено»');
});

test('слияние: «отправляется» не перебивается серверным «отправлено»', () => {
  const merged = mergeMessages([msg('a', 10)], [msg('a', 10, { status: 'sending' })]);
  assert.equal(merged[0].status, 'sending');
});

test('слияние: дубликаты с сервера не размножают сообщение', () => {
  const merged = mergeMessages([msg('a', 10), msg('a', 10)], [msg('a', 10), msg('a', 10)]);
  assert.equal(merged.length, 1);
});

test('слияние: порядок всегда по времени, даже если пришло не по порядку', () => {
  const merged = mergeMessages([msg('a', 30), msg('b', 10)], [msg('c', 20)]);
  assert.deepEqual(merged.map((m) => m.id), ['b', 'c', 'a']);
});
