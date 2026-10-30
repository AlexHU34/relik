/* Разметка сообщений: экранирование, ссылки, медиа, реакции.
   Это вынесенный из chatView код, поэтому проверяем его отдельно —
   здесь самая опасная зона (innerHTML + пользовательский текст). */
import test from 'node:test';
import assert from 'node:assert/strict';

import { installShim } from './_shim.mjs';

installShim();

const render = await import('../../js/ui/chat/render.js');
const { S } = await import('../../js/ui/state.js');

S.me = { id: 'me', name: 'Me' };
S.users = [{ id: 'u1', name: 'Alice', hue: 10 }];
S.active = 'c1';

const msg = (extra = {}) => ({
  id: 'm1', chatId: 'c1', sender: 'u1', ts: Date.now(), type: 'text',
  text: 'привет', reactions: [], status: 'sent', ...extra,
});

test('разметка: HTML в тексте экранируется', () => {
  const html = render.bubbleHtml(msg({ text: '<img src=x onerror=alert(1)>' }), false);
  assert.ok(!html.includes('<img src=x'), 'сырой тег не должен попасть в HTML');
  assert.ok(html.includes('&lt;img'), 'тег должен быть экранирован');
});

test('разметка: javascript: в ссылке не становится ссылкой', () => {
  const html = render.bubbleHtml(msg({ text: 'javascript:alert(1)' }), false);
  assert.ok(!/href="javascript:/i.test(html));
});

test('разметка: обычная https-ссылка остаётся ссылкой', () => {
  const html = render.bubbleHtml(msg({ text: 'смотри https://example.com/a' }), false);
  assert.ok(/href="https:\/\/example\.com\/a"/.test(html));
});

test('разметка: опасный src медиа отбрасывается', () => {
  const html = render.bubbleHtml(msg({ type: 'image', file: { src: 'javascript:alert(1)', name: 'x.png' } }), false);
  assert.ok(!/src="javascript:/i.test(html));
});

test('разметка: удалённое сообщение не показывает текст', () => {
  const html = render.bubbleHtml(msg({ deleted: true, text: 'секрет' }), false);
  assert.ok(!html.includes('секрет'));
});

test('разметка: меню действий не содержит текста сообщения', () => {
  const html = render.toolsHtml(msg({ text: 'секретный текст' }), true);
  assert.ok(!html.includes('секретный текст'));
  assert.ok(html.includes('data-act="reply"'));
});

test('реакции: агрегируются по сообщениям из скрытых rx-событий', () => {
  const rx = (sender, ts, m, e, on) => ({ id: 'e' + sender + ts, type: 'rx', sender, ts, reaction: { m, e, on } });
  const map = render.tallyReactions([
    rx('u1', 1, 'a', '👍', true),
    rx('u2', 2, 'a', '👍', true),
    rx('u1', 3, 'b', '🔥', true),
  ]);
  assert.equal(map.get('a')[0].by.length, 2, 'два разных пользователя');
  assert.equal(map.get('b')[0].e, '🔥');

  const afterRemove = render.tallyReactions([
    rx('u1', 1, 'a', '👍', true),
    rx('u2', 2, 'a', '👍', true),
    rx('u2', 5, 'a', '👍', false),
  ]);
  assert.equal(afterRemove.get('a').length, 1);
  assert.deepEqual(afterRemove.get('a')[0].by, ['u1'], 'последнее событие пользователя побеждает');
});

test('разметка: msgHtml содержит id сообщения и статус выбора', () => {
  render.bindRenderView(() => ({ searchIndex: 0, selectMode: false, selectedMsgs: new Set(), toolsOpen: null }));
  const html = render.msgHtml(msg(), true);
  assert.ok(html.includes('data-mid="m1"'));
  assert.ok(!html.includes('selected'));
});
