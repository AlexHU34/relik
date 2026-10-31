#!/usr/bin/env node
/* Relik — проверка живого сайта по манифесту сборки.
   Скачивает integrity.json и сверяет SHA-256 каждого файла с тем, что лежит
   на сервере. Ловит подмену JS, битый деплой и «залипший» CDN.

   node scripts/verify-live.mjs [https://relik.best/] */
import { createHash } from 'node:crypto';

const BASE = (process.argv[2] || 'https://relik.best/').replace(/\/?$/, '/');
const ORIGIN = new URL(BASE).origin;

async function getText(rel) {
  const url = new URL(rel.replace(/^\.\//, ''), BASE).href;
  const res = await fetch(url, { cache: 'no-store', headers: { 'cache-control': 'no-cache' } });
  if (!res.ok) throw new Error(`${rel}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

const t0 = Date.now();
let manifest;
try {
  manifest = JSON.parse((await getText('integrity.json')).toString('utf8'));
} catch (err) {
  console.error(`✖ Не удалось получить integrity.json: ${err.message}`);
  process.exit(1);
}

const entries = Object.entries(manifest.files || {});
if (!entries.length) {
  console.error('✖ integrity.json пустой');
  process.exit(1);
}

let bad = 0;
let checked = 0;
const failures = [];

/* небольшими пачками, чтобы не завалить сервер */
const CONCURRENCY = 6;
for (let i = 0; i < entries.length; i += CONCURRENCY) {
  const chunk = entries.slice(i, i + CONCURRENCY);
  await Promise.all(chunk.map(async ([rel, want]) => {
    try {
      const buf = await getText(rel);
      const got = createHash('sha256').update(buf).digest('hex');
      checked++;
      if (got !== want) { bad++; failures.push(`${rel}: хеш не совпадает`); }
    } catch (err) {
      bad++;
      failures.push(err.message);
    }
  }));
}

const version = manifest.version || '?';
if (bad) {
  console.error(`✖ ${BASE} — версия ${version}: ${bad} из ${entries.length} файлов не совпали`);
  for (const f of failures.slice(0, 20)) console.error('  ' + f);
  process.exit(1);
}

console.log(`✔ ${ORIGIN} — версия ${version}: ${checked} файлов совпали (${((Date.now() - t0) / 1000).toFixed(1)} с)`);
