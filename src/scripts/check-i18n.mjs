/* Проверка паритета переводов RU/EN: каждый ключ должен быть в обоих файлах.
   Запуск: node scripts/check-i18n.mjs
   Код возврата 1, если есть расхождения. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'js', 'i18n');
const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
const keys = (src) => new Set([...src.matchAll(/^\s*'([^']+)':/gm)].map((m) => m[1]));

const ru = keys(read('ru.js'));
const en = keys(read('en.js'));

const onlyRu = [...ru].filter((k) => !en.has(k));
const onlyEn = [...en].filter((k) => !ru.has(k));

/* Дополнительно: используемые в коде ключи должны существовать */
const root = path.join(dir, '..', '..');
const used = new Set();
const walk = (p) => {
  for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
    if (entry.name === 'vendor' || entry.name === 'i18n' || entry.name === 'node_modules') continue;
    const full = path.join(p, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(js|html)$/.test(entry.name)) {
      const src = fs.readFileSync(full, 'utf8');
      for (const m of src.matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g)) used.add(m[1]);
      for (const m of src.matchAll(/data-i18n(?:-ph)?="([a-zA-Z0-9_.]+)"/g)) used.add(m[1]);
    }
  }
};
walk(path.join(root, 'js'));
walk(root);

const missing = [...used].filter((k) => !k.endsWith('.') && !ru.has(k));

console.log(`ключей RU: ${ru.size}, EN: ${en.size}`);
if (onlyRu.length) console.log(`только в RU (${onlyRu.length}): ${onlyRu.join(', ')}`);
if (onlyEn.length) console.log(`только в EN (${onlyEn.length}): ${onlyEn.join(', ')}`);
if (missing.length) console.log(`используются, но не переведены (${missing.length}): ${missing.join(', ')}`);

if (onlyRu.length || onlyEn.length || missing.length) process.exit(1);
console.log('паритет в порядке');
