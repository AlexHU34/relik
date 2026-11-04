/* Окна истории: чат открывается хвостом, «показать раньше» — страницей
   строго старше курсора. Ошибка здесь = потерянные сообщения или вечная
   кнопка «показать раньше». */
import test from 'node:test';
import assert from 'node:assert/strict';

import { HISTORY_PAGE, HISTORY_TAIL, tailSlice, beforeSlice } from '../../js/ui/msgWindow.js';

const msg = (id, ts) => ({ id, ts, sender: 'u_me', type: 'text', text: id });
const make = (n) => Array.from({ length: n }, (_, i) => msg('m' + i, i + 1));

test('хвост: берём последние N и знаем, что старые остались', () => {
  const { messages, more } = tailSlice(make(1000), 300);
  assert.equal(messages.length, 300);
  assert.equal(messages[0].id, 'm700');
  assert.equal(messages[299].id, 'm999');
  assert.equal(more, true);
});

test('хвост: ровно N сообщений — старых нет', () => {
  const { messages, more } = tailSlice(make(HISTORY_TAIL), HISTORY_TAIL);
  assert.equal(messages.length, HISTORY_TAIL);
  assert.equal(more, false);
});

test('хвост: короткая и пустая история', () => {
  assert.deepEqual(tailSlice([], 10), { messages: [], more: false });
  assert.equal(tailSlice(null, 10).more, false);
  assert.equal(tailSlice([msg('a', 1)], 10).messages.length, 1);
});

test('хвост: мусорный limit не ломает окно', () => {
  /* 0/мусор → значение по умолчанию, а не пустая лента */
  assert.equal(tailSlice(make(5), 0).messages.length, 5);
  assert.equal(tailSlice(make(5), 'abc').messages.length, 5);
});

test('раньше: только строго старше курсора, порядок сохранён', () => {
  const list = make(500);
  const { messages, more } = beforeSlice(list, 401, 120);
  assert.equal(messages.length, 120);
  assert.equal(messages[messages.length - 1].id, 'm399');
  assert.equal(messages[0].id, 'm280');
  assert.equal(more, true);
});

test('раньше: курсор ровно на первом сообщении — пусто', () => {
  const { messages, more } = beforeSlice(make(10), 1, 5);
  assert.deepEqual(messages, []);
  assert.equal(more, false);
});

test('раньше: остаток меньше страницы — more=false', () => {
  const { messages, more } = beforeSlice(make(300), 51, HISTORY_PAGE);
  assert.equal(messages.length, 50);
  assert.equal(messages[0].id, 'm0');
  assert.equal(more, false);
});

test('раньше: битый курсор не возвращает всю историю', () => {
  assert.deepEqual(beforeSlice(make(10), 0, 5).messages, []);
  assert.deepEqual(beforeSlice(make(10), 'abc', 5).messages, []);
});

test('раньше: страница ровно совпадает с шагом и есть что-то до неё', () => {
  const list = make(240);
  const first = beforeSlice(list, 241, HISTORY_PAGE);
  assert.equal(first.messages.length, HISTORY_PAGE);
  assert.equal(first.more, true, 'осталось ещё 120');
  const second = beforeSlice(list, 121, HISTORY_PAGE);
  assert.equal(second.messages.length, HISTORY_PAGE);
  assert.equal(second.more, false);
  assert.equal(second.messages[0].id, 'm0');
});
