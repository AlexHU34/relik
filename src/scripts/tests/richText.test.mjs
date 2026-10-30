/* Тесты разметки сообщений: экранирование, ссылки, безопасные медиа-источники.
   Это главный барьер против XSS в ленте — регресс здесь недопустим. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { installShim } from './_shim.mjs';

installShim();
const { formatText, isEmojiOnly, safeMediaSrc, isSafeHref } = await import('../../js/ui/richText.js');

test('HTML в тексте сообщения экранируется', () => {
  const html = formatText('<img src=x onerror=alert(1)>');
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;img'));
});

test('кавычки не вырываются из атрибута', () => {
  const html = formatText('" onmouseover="alert(1)');
  assert.ok(!/onmouseover="/.test(html));
});

test('обычная https-ссылка становится кликабельной и безопасной', () => {
  const html = formatText('смотри https://relik.chat/a?b=1');
  assert.match(html, /href="https:\/\/relik\.chat\/a\?b=1"/);
  assert.match(html, /rel="noopener noreferrer/);
  assert.match(html, /target="_blank"/);
});

test('javascript: не превращается в ссылку', () => {
  const html = formatText('javascript:alert(1)');
  assert.ok(!html.includes('href='));
});

test('www без схемы получает https', () => {
  assert.match(formatText('www.example.org'), /href="https:\/\/www\.example\.org"/);
});

test('data:text/html не проходит как медиа', () => {
  assert.equal(safeMediaSrc('data:text/html;base64,PHNjcmlwdD4='), '');
});

test('javascript: и vbscript: не проходят как медиа', () => {
  assert.equal(safeMediaSrc('javascript:alert(1)'), '');
  assert.equal(safeMediaSrc('  javascript:alert(1)'), '');
  assert.equal(safeMediaSrc('vbscript:msgbox'), '');
});

test('нормальные источники проходят', () => {
  assert.ok(safeMediaSrc('https://x.test/a.png', 'image'));
  assert.ok(safeMediaSrc('blob:https://x.test/uuid', 'video'));
  assert.ok(safeMediaSrc('data:image/png;base64,iVBORw0KGgo=', 'image'));
});

test('safeMediaSrc терпит пустые значения', () => {
  for (const v of [null, undefined, '', 0]) assert.equal(safeMediaSrc(v), '');
});

test('isSafeHref: только http(s) и mailto-подобные случаи', () => {
  assert.equal(isSafeHref('https://a.test'), true);
  assert.equal(isSafeHref('http://a.test'), true);
  assert.equal(isSafeHref('javascript:alert(1)'), false);
  assert.equal(isSafeHref('#anchor'), false);
});

test('эмодзи-только распознаётся, текст — нет', () => {
  assert.equal(isEmojiOnly('😀🔥'), true);
  assert.equal(isEmojiOnly('привет 😀'), false);
});
