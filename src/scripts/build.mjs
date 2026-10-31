#!/usr/bin/env node
/* Relik — сборка: Vite (бандл, минификация, хеши) + генерация sw.js + проверки.
   node scripts/build.mjs            — собрать dist/
   node scripts/build.mjs --verbose  — показать, что копируется */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const VERBOSE = process.argv.includes('--verbose');
process.chdir(ROOT);

const log = (...a) => { if (VERBOSE) console.log('  ', ...a); };
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  log(`${from} → ${path.relative(ROOT, to)}`);
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

console.log('▸ Vite build…');
await build({ logLevel: VERBOSE ? 'info' : 'warn' });

/* ── Статика, которую Vite не трогает ─────────────────────── */
const statics = ['version.json', 'manifest.json', '.nojekyll'];
for (const f of statics) {
  if (fs.existsSync(path.join(ROOT, f))) copyFile(path.join(ROOT, f), path.join(DIST, f));
  else console.warn(`  ! нет ${f}`);
}

/* Вендоры грузятся по жёсткому пути (script src / new URL), их копируем как есть. */
for (const f of ['supabase.js', 'qrcode.js']) {
  const src = path.join(ROOT, 'js', 'vendor', f);
  if (fs.existsSync(src)) copyFile(src, path.join(DIST, 'js', 'vendor', f));
}

/* Иконки нужны manifest.json и apple-touch-icon по неизменяемым путям. */
const icons = path.join(ROOT, 'assets', 'icons');
if (fs.existsSync(icons)) {
  fs.cpSync(icons, path.join(DIST, 'assets', 'icons'), { recursive: true });
  log('assets/icons → dist/assets/icons');
}

/* Vite копирует manifest.json в assets/ и переписывает ссылку в HTML.
   Внутри манифеста пути к иконкам относительные («assets/icons/...»),
   поэтому из /assets/ они превращаются в /assets/assets/icons/... (404).
   Возвращаем ссылку на корневой manifest.json и убираем копию. */
const distAssets = path.join(DIST, 'assets');
if (fs.existsSync(distAssets)) {
  for (const f of fs.readdirSync(distAssets)) {
    if (/^manifest-.*\.json$/.test(f)) fs.unlinkSync(path.join(distAssets, f));
  }
}
const indexPath = path.join(DIST, 'index.html');
let indexHtml = fs.readFileSync(indexPath, 'utf8');
indexHtml = indexHtml.replace(/href="\.?\/?assets\/manifest-[^"]+\.json"/g, 'href="./manifest.json"');
fs.writeFileSync(indexPath, indexHtml);
if (!/href="\.?\/?manifest\.json"/.test(indexHtml)) {
  console.warn('  ! ссылка на manifest.json не найдена в index.html — проверьте PWA');
}

/* ── sw.js: ASSETS собираем из фактического dist ───────────── */
const cfg = fs.readFileSync(path.join(ROOT, 'js', 'config.js'), 'utf8');
const version = (cfg.match(/version:\s*'([\d.]+)'/) || [])[1];
if (!version) throw new Error('не нашёл version в js/config.js');

const files = walk(DIST)
  .map((f) => './' + path.relative(DIST, f).replace(/\\/g, '/'))
  .filter((f) => f !== './sw.js')
  .sort();

let sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
sw = sw.replace(/const VER = '[^']+';/, `const VER = 'relik-v${version}';`);
sw = sw.replace(
  /const ASSETS = \[[\s\S]*?\];/,
  `const ASSETS = [\n${files.map((f) => `  '${f}',`).join('\n')}\n];`,
);
if (!sw.includes(`relik-v${version}`)) throw new Error('sw.js: не удалось подставить VER');
fs.writeFileSync(path.join(DIST, 'sw.js'), sw);

/* ── Итог ─────────────────────────────────────────────────── */
const total = files.reduce((a, f) => a + fs.statSync(path.join(DIST, f.replace(/^\.\//, ''))).size, 0);
const hashed = files.filter((f) => /-[A-Za-z0-9_-]{8}\.(js|css|woff2|png)$/.test(f));

console.log(`▸ dist: ${files.length} файлов, ${kb(total)}`);
console.log(`▸ sw.js: ${files.length} записей в ASSETS, версия relik-v${version}`);
console.log(`▸ хешированных ассетов: ${hashed.length}`);
if (fs.existsSync(path.join(DIST, 'assets')) && fs.readdirSync(path.join(DIST, 'assets')).some((f) => f.endsWith('.map'))) {
  console.warn('  ! в dist есть sourcemap — уберите (sourcemap: false)');
}
