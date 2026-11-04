/* Упоминания: @username в тексте сообщения.
   Ошибка здесь либо теряет уведомление («вас упомянули»), либо спамит им:
   «a@demo.ru» в письме не должно считаться упоминанием. */
import test from 'node:test';
import assert from 'node:assert/strict';

import { mentionTokens, myHandles, mentionsMe } from '../../js/ui/mentions.js';

const me = { id: 'u1', name: 'Демо', username: 'demo' };

test('простые упоминания собираются без @ и в нижнем регистре', () => {
  assert.deepEqual(mentionTokens('привет @demo и @Demo_2'), ['demo', 'demo_2']);
  assert.deepEqual(mentionTokens('@alina, ты тут?'), ['alina']);
  assert.deepEqual(mentionTokens(''), []);
  assert.deepEqual(mentionTokens(null), []);
});

test('регистр и кириллица', () => {
  assert.equal(mentionsMe('Привет, @DEMO!', me), true);
  assert.equal(mentionsMe('@демо посмотри', { username: 'демо' }), true);
});

test('двухсловное имя не путается с упоминанием', () => {
  const withName = { name: 'Анна Мария', username: '' };
  assert.deepEqual(myHandles(withName), []);
  assert.equal(mentionsMe('@Анна привет', withName), false);
});

test('однословное имя работает как @ник', () => {
  assert.equal(mentionsMe('@Алина глянь', { name: 'Алина' }), true);
  assert.equal(mentionsMe('@Алина2 глянь', { name: 'Алина' }), false);
});

test('почта и ссылки не считаются упоминанием', () => {
  assert.equal(mentionsMe('пиши на a@demo.ru', me), false);
  assert.equal(mentionsMe('https://site.ru/@demo', me), false);
  assert.equal(mentionsMe('@@demo', me), false);
});

test('похожий, но другой ник — не моё упоминание', () => {
  assert.equal(mentionsMe('@demoo привет', me), false);
  assert.equal(mentionsMe('@demo_x привет', me), false);
  assert.equal(mentionsMe('@dem привет', me), false);
});

test('без @ — не упоминание, а без ника узнавать нечего', () => {
  assert.equal(mentionsMe('demo, ты тут?', me), false);
  assert.equal(mentionsMe('@demo', {}), false);
  assert.equal(mentionsMe('@demo', null), false);
});

test('упоминание в середине и конце текста', () => {
  assert.equal(mentionsMe('смотри @demo вот это', me), true);
  assert.equal(mentionsMe('вопрос к @demo', me), true);
  assert.equal(mentionsMe('(@demo)', me), true);
  assert.equal(mentionsMe('текст@demo', me), false, 'слитно с буквой — это почта/ник канала');
});

test('несколько упоминаний подряд', () => {
  assert.deepEqual(mentionTokens('@demo @alina @max'), ['demo', 'alina', 'max']);
  assert.equal(mentionsMe('@alina @demo', me), true);
});
