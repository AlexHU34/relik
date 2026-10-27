#!/usr/bin/env node
/* Relik — проверка целостности ассетов и офлайн-оболочки.
   Ловит три класса поломок, которые иначе видит только пользователь:

   1) файл есть в sw.js ASSETS, но его нет в репозитории → SW молча пропускает
      (allSettled), офлайн-оболочка остаётся с дырой;
   2) файл подключён в index.html/css, но его нет → 404 на проде;
   3) модуль лежит в js/, но не попал в ASSETS → офлайн-режим и PWA ломаются.

   Запуск: node scripts/check-assets.mjs [--json]
   Код возврата: 1 — есть ошибки. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JSON_OUT = process.argv.includes('--json');

const errors = [];
const warnings = [];

const rel = (p) => p.replace(process.env.SEP || /\\/g, '/');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

function walk(dir, ext) {
  const out = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const child = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(child, ext));
    else if (!ext || child.endsWith(ext)) out.push(child);
  }
  return out;
}

/* ── 1. ASSETS из sw.js ───────────────────────────────────── */
const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
const block = (sw.match(/const ASSETS = \[([\s\S]*?)\];/) || [])[1];
if (!block) {
  errors.push('sw.js: не найден массив ASSETS');
}
const assets = [...(block || '').matchAll(/'([^']+)'/g)]
  .map((m) => m[1])
  .map((p) => (p === './' ? 'index.html' : p.replace(/^\.\//, '')));

for (const a of assets) {
  if (!exists(a)) errors.push(`sw.js ASSETS: ${a} — файла нет в репозитории`);
}

/* ── 2. Ссылки в index.html ───────────────────────────────── */
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const htmlRefs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
  .map((m) => m[1])
  .filter((u) => u && !/^(https?:|data:|mailto:|#|\/\/)/.test(u))
  .map((u) => u.split('?')[0].split('#')[0]);

for (const r of htmlRefs) {
  if (!exists(r)) errors.push(`index.html: ${r} — 404`);
}

/* ── 3. url(...) в CSS ────────────────────────────────────── */
for (const css of walk('css', '.css')) {
  const text = fs.readFileSync(path.join(ROOT, css), 'utf8')
    /* вырезаем data:-URI целиком: внутри inline-SVG бывают вложенные url(%23n) */
    .replace(/url\(\s*(['"])data:[\s\S]*?\1\s*\)/g, 'url(data:removed)');
  for (const m of text.matchAll(/url\((['"]?)([^)'"]+)\1\)/g)) {
    const u = m[2].trim();
    if (!u || /^(https?:|data:|#)/.test(u) || u.includes('%')) continue;
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(css), u.split('?')[0]));
    if (!exists(target)) errors.push(`${css}: ${u} — 404`);
  }
}

/* ── 4. Модули js/ ↔ ASSETS ───────────────────────────────── */
const modules = walk('js', '.js');
const assetSet = new Set(assets);
for (const m of modules) {
  if (!assetSet.has(m)) {
    warnings.push(`${m} — не в ASSETS (офлайн/PWA не закэшируют)`);
  }
}

/* ── 5. Статические импорты: цели существуют ──────────────── */
for (const m of modules) {
  const text = fs.readFileSync(path.join(ROOT, m), 'utf8');
  for (const im of text.matchAll(/(?:from|import)\s+['"](\.[^'"]+)['"]/g)) {
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(m), im[1]));
    if (!exists(target)) errors.push(`${m}: импорт ${im[1]} — файла нет`);
  }
  for (const im of text.matchAll(/import\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(m), im[1]));
    if (!exists(target)) errors.push(`${m}: динамический импорт ${im[1]} — файла нет`);
  }
}

/* ── 6. Версия кэша и версия приложения ───────────────────── */
const verMatch = sw.match(/const VER = 'relik-v([\d.]+)'/);
const cfg = fs.readFileSync(path.join(ROOT, 'js', 'config.js'), 'utf8');
const appVer = (cfg.match(/version:\s*'([\d.]+)'/) || [])[1];
if (verMatch && appVer && verMatch[1] !== appVer) {
  warnings.push(`sw.js VER = relik-v${verMatch[1]}, а js/config.js version = ${appVer} — при изменении ассетов VER нужно поднимать`);
}

/* ── 7. Прочие страницы, на которые ссылается приложение ──── */
for (const page of ['legal.html', 'welcome.html', 'manifest.json', 'version.json', '.nojekyll']) {
  if (!exists(page)) warnings.push(`${page} отсутствует`);
}

/* ── Итог ─────────────────────────────────────────────────── */
const result = {
  assets: assets.length,
  modules: modules.length,
  errors,
  warnings,
};

if (JSON_OUT) {
  console.log(JSON.stringify(result, null, 2));
} else {
  if (warnings.length) {
    console.log(`Предупреждения (${warnings.length}):`);
    for (const w of warnings) console.log('  ! ' + w);
  }
  if (errors.length) {
    console.log(`\nОшибки (${errors.length}):`);
    for (const e of errors) console.log('  ✗ ' + e);
  }
  console.log(`\nASSETS: ${assets.length} · модулей: ${modules.length} · ошибок: ${errors.length} · предупреждений: ${warnings.length}`);
  if (!errors.length) console.log('Офлайн-оболочка целая.');
}

process.exit(errors.length ? 1 : 0);
