#!/usr/bin/env node
/* Relik — проверка воспроизводимости сборки.
   Собирает проект дважды с одинаковым окружением и сравнивает SHA-256 всех
   файлов из integrity.json. Если сборка «плавает» (время, порядок обхода,
   случайные идентификаторы), скрипт покажет, какие файлы разошлись.

   node scripts/reproducible.mjs */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

function buildOnce(label) {
  /* Windows не даёт удалить dist, если его держит открытым другой процесс
     (например, http.server). Пробуем несколько раз, потом понятно падаем. */
  try {
    fs.rmSync(DIST, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (err) {
    console.error(`✖ Не удалось очистить dist перед сборкой «${label}»: ${err.code || err.message}`);
    console.error('  Закройте локальный сервер (python -m http.server) и повторите.');
    process.exit(1);
  }
  const res = spawnSync(process.execPath, ['scripts/build.mjs'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, TZ: 'UTC', SOURCE_DATE_EPOCH: '0' },
  });
  if (res.status !== 0) {
    console.error(`✖ Сборка «${label}» упала:\n` + (res.stdout || '') + (res.stderr || ''));
    process.exit(1);
  }
  const file = path.join(DIST, 'integrity.json');
  if (!fs.existsSync(file)) {
    console.error(`✖ После сборки «${label}» нет integrity.json`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8')).files || {};
}

function diff(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out = [];
  for (const k of keys) {
    if (a[k] !== b[k]) out.push({ file: k, first: a[k] || '—', second: b[k] || '—' });
  }
  return out;
}

const t0 = Date.now();
console.log('▸ сборка №1…');
const first = buildOnce('первая');
console.log('▸ сборка №2…');
const second = buildOnce('вторая');

const files = Object.keys(first).length;
const diffs = diff(first, second);

if (!diffs.length) {
  console.log(`✔ Воспроизводимо: ${files} файлов совпали за ${((Date.now() - t0) / 1000).toFixed(1)} с`);
  process.exit(0);
}

console.error(`✖ Сборка не воспроизводима: ${diffs.length} файлов из ${files} разошлись`);
for (const d of diffs.slice(0, 15)) console.error(`  ${d.file}\n    ${d.first}\n    ${d.second}`);
console.error('\nПодсказка: чаще всего виноваты timestamp в файле, Math.random в билд-скрипте');
console.error('или нестабильный порядок обхода каталога. Для сравнения между машинами');
console.error('нужны одинаковые версии Node/npm/Vite и package-lock.json.');
process.exit(1);
