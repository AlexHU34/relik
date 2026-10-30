/* Проверка CSP: хеши inline-скриптов в index.html должны совпадать
   с реальным содержимым. Если кто-то поправит inline-скрипт и забудет
   обновить хеш — браузер заблокирует запуск, и приложение не откроется.
   Лучше узнать об этом здесь.

   Запуск: node scripts/check-csp.mjs */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

const metaRe = /<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]*>/i;
const metaTag = html.match(metaRe);
if (!metaTag) {
  console.error('CSP: meta Content-Security-Policy не найдена в index.html');
  process.exit(1);
}

/* content берём отдельно: внутри него одинарные кавычки, поэтому нельзя
   ограничивать класс символов и кавычками, и апострофами */
const contentMatch = metaTag[0].match(/content\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
const csp = contentMatch ? (contentMatch[1] ?? contentMatch[2] ?? '') : '';
if (!csp) {
  console.error('CSP: не удалось прочитать content у meta-тега');
  process.exit(1);
}
const declared = new Set(
  [...csp.matchAll(/'sha256-([A-Za-z0-9+/=]+)'/g)].map((m) => m[1]),
);

const inlineRe = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
const actual = new Map();
let m;
let i = 0;
while ((m = inlineRe.exec(html))) {
  i += 1;
  actual.set(createHash('sha256').update(m[1], 'utf8').digest('base64'), i);
}

let failed = false;

if (!actual.size) {
  console.log('CSP: inline-скриптов нет, хеши не требуются');
} else {
  for (const [hash, idx] of actual) {
    if (!declared.has(hash)) {
      console.error(`CSP: inline-скрипт #${idx} не разрешён. Добавьте в script-src: 'sha256-${hash}'`);
      failed = true;
    }
  }
  for (const hash of declared) {
    if (!actual.has(hash)) {
      console.error(`CSP: хеш 'sha256-${hash}' больше не соответствует ни одному скрипту — удалите его`);
      failed = true;
    }
  }
}

/* Директивы, без которых защита бессмысленна */
for (const need of ["object-src 'none'", "base-uri 'self'"]) {
  if (!csp.includes(need)) {
    console.error(`CSP: отсутствует директива ${need}`);
    failed = true;
  }
}

if (failed) process.exit(1);
console.log(`CSP: ок (${actual.size} inline-скрипт(ов), ${declared.size} хеш(ей))`);
