#!/usr/bin/env node
/* Relik — сборка: Vite (бандл, минификация, хеши) + генерация sw.js + проверки.
   node scripts/build.mjs            — собрать dist/
   node scripts/build.mjs --verbose  — показать, что копируется */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
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

/* CNAME включаем только когда домен уже настроен в DNS:
   иначе GitHub Pages переключится на несуществующий адрес и сайт «пропадёт». */
if (fs.existsSync(path.join(ROOT, 'CNAME'))) {
  copyFile(path.join(ROOT, 'CNAME'), path.join(DIST, 'CNAME'));
} else {
  log('CNAME нет — публикуем на github.io');
}

/* Вендоры грузятся по жёсткому пути (script src / new URL), их копируем как есть. */
for (const f of ['supabase.js', 'qrcode.js']) {
  const src = path.join(ROOT, 'js', 'vendor', f);
  if (fs.existsSync(src)) copyFile(src, path.join(DIST, 'js', 'vendor', f));
}

/* Служебные страницы (tools/status.html, health, preflight) читают настройки
   из ../js/config.js простым текстом. Vite бандлит config в чанк, поэтому
   без этой копии на проде они видели 404 и писали «Supabase не настроен». */
copyFile(path.join(ROOT, 'js', 'config.js'), path.join(DIST, 'js', 'config.js'));

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

/* SRI для вендорного SDK: если файл подменят (сервер, CDN, кэш),
   браузер откажется его выполнять. Хеш считается от того, что реально в dist.
   SDK грузится динамически (js/backend/sdk.js), поэтому хеш кладём в meta:
   статического тега <script> на критическом пути больше нет. */
const vendorSdk = path.join(DIST, 'js', 'vendor', 'supabase.js');
if (fs.existsSync(vendorSdk)) {
  const sri = 'sha384-' + createHash('sha384').update(fs.readFileSync(vendorSdk)).digest('base64');
  if (/<meta[^>]*name="relik-sdk-sri"/.test(indexHtml)) {
    indexHtml = indexHtml.replace(/(<meta name="relik-sdk-sri" content=")[^"]*(")/, `$1${sri}$2`);
  } else if (/<meta name="relik-sdk"/.test(indexHtml)) {
    indexHtml = indexHtml.replace(
      /(<meta name="relik-sdk"[^>]*>)/,
      `$1\n  <meta name="relik-sdk-sri" content="${sri}">`,
    );
    log('SRI для supabase.js → meta relik-sdk-sri');
  } else {
    console.warn('  ! в index.html нет meta[name=relik-sdk] — SRI для SDK не записан');
  }
}
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
  .filter((f) => f !== './sw.js' && f !== './CNAME')
  .sort();

let sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
sw = sw.replace(/const VER = '[^']+';/, `const VER = 'relik-v${version}';`);
sw = sw.replace(
  /const ASSETS = \[[\s\S]*?\];/,
  `const ASSETS = [\n${files.map((f) => `  '${f}',`).join('\n')}\n];`,
);
if (!sw.includes(`relik-v${version}`)) throw new Error('sw.js: не удалось подставить VER');
fs.writeFileSync(path.join(DIST, 'sw.js'), sw);

/* ── integrity.json: SHA-256 каждого файла сборки ─────────────
   Любой может проверить, что сайт отдаёт ровно то, что собрано из исходников
   (scripts/verify-live.mjs). Файл создаётся последним и сам себя не хеширует. */
const integrity = { version, generatedAt: new Date().toISOString(), algorithm: 'sha256', files: {} };
for (const abs of walk(DIST).sort()) {
  const relFile = './' + path.relative(DIST, abs).replace(/\\/g, '/');
  if (relFile === './integrity.json') continue;
  integrity.files[relFile] = createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
}
fs.writeFileSync(path.join(DIST, 'integrity.json'), JSON.stringify(integrity, null, 2) + '\n');

/* ── Итог ─────────────────────────────────────────────────── */
const total = files.reduce((a, f) => a + fs.statSync(path.join(DIST, f.replace(/^\.\//, ''))).size, 0);
const hashed = files.filter((f) => /-[A-Za-z0-9_-]{8}\.(js|css|woff2|png)$/.test(f));

console.log(`▸ dist: ${files.length} файлов, ${kb(total)}`);
console.log(`▸ sw.js: ${files.length} записей в ASSETS, версия relik-v${version}`);
console.log(`▸ хешированных ассетов: ${hashed.length}`);
if (fs.existsSync(path.join(DIST, 'assets')) && fs.readdirSync(path.join(DIST, 'assets')).some((f) => f.endsWith('.map'))) {
  console.warn('  ! в dist есть sourcemap — уберите (sourcemap: false)');
}
