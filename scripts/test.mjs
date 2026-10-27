/* Запуск юнит-тестов без зависимостей: node scripts/test.mjs
   (node --test не умеет directory-аргумент как путь, поэтому собираем файлы сами). */
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const dir = new URL('./tests/', import.meta.url);
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.test.mjs'))
  .sort()
  .map((f) => fileURLToPath(new URL(f, dir)));

if (!files.length) {
  console.error('Не найдено ни одного *.test.mjs в scripts/tests');
  process.exit(1);
}

const res = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(res.status ?? 1);
