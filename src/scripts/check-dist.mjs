#!/usr/bin/env node
/* Relik — проверка собранного dist/ перед деплоем.
   Ловит то, что не видно в исходниках: битые пути после хеширования,
   потерянные вендоры, разросшийся критический путь, сломанную CSP.

   node scripts/check-dist.mjs [--json] */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const JSON_OUT = process.argv.includes('--json');

const errors = [];
const warnings = [];
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
const gzip = (buf) => zlib.gzipSync(buf, { level: 9 }).length;

if (!fs.existsSync(DIST)) {
  console.error('dist/ нет — сначала node scripts/build.mjs');
  process.exit(1);
}

const walk = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
};

const exists = (rel) => fs.existsSync(path.join(DIST, rel.replace(/^\.?\//, '')));

/* ── 1. sw.js: каждый ASSETS существует ────────────────────── */
const swText = fs.readFileSync(path.join(DIST, 'sw.js'), 'utf8');
const assets = [...((swText.match(/const ASSETS = \[([\s\S]*?)\];/) || [])[1] || '').matchAll(/'([^']+)'/g)]
  .map((m) => m[1])
  .filter((p) => p !== './');
for (const a of assets) if (!exists(a)) errors.push(`sw.js ASSETS: ${a} — нет в dist`);
if (!assets.length) errors.push('sw.js: пустой ASSETS');

/* ── 2. index.html: все локальные ссылки живые ─────────────── */
const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
  .map((m) => m[1])
  .filter((u) => u && !/^(https?:|data:|mailto:|#|\/\/)/.test(u))
  .map((u) => u.split('?')[0].split('#')[0]);
for (const r of refs) if (!exists(r)) errors.push(`index.html: ${r} — 404`);

/* ── 3. Вендоры, которые грузятся по жёсткому пути ─────────── */
for (const f of ['js/vendor/supabase.js', 'js/vendor/qrcode.js']) {
  if (!exists(f)) errors.push(`${f} — нет в dist (грузится из HTML/по URL)`);
}

/* ── 4. manifest.json: иконки на месте ─────────────────────── */
const manifest = JSON.parse(fs.readFileSync(path.join(DIST, 'manifest.json'), 'utf8'));
for (const icon of manifest.icons || []) {
  if (!exists(icon.src)) errors.push(`manifest.json: ${icon.src} — 404`);
}

/* ── 5. CSP: хеши inline-скриптов совпадают ────────────────── */
const meta = html.match(/<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]*>/i);
if (!meta) errors.push('CSP: meta-тег потерялся при сборке');
else {
  const content = (meta[0].match(/content\s*=\s*(?:"([^"]*)"|'([^']*)')/i) || []);
  const csp = content[1] ?? content[2] ?? '';
  const declared = new Set([...csp.matchAll(/'sha256-([A-Za-z0-9+/=]+)'/g)].map((m) => m[1]));
  const actual = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
    .map((m) => createHash('sha256').update(m[1], 'utf8').digest('base64'));
  for (const h of actual) if (!declared.has(h)) errors.push(`CSP: inline-скрипт не разрешён (sha256-${h})`);
  if (csp && !csp.includes("script-src 'self'")) warnings.push('CSP: script-src без \'self\' — бандл не загрузится');
}

/* ── 6. Критический путь: что грузится до первой отрисовки ─── */
const preloads = [...html.matchAll(/<link[^>]+rel=["'](?:modulepreload|stylesheet)["'][^>]+href=["']([^"']+)["']/g)]
  .map((m) => m[1]);
const entry = (html.match(/<script[^>]+type=["']module["'][^>]+src=["']([^"']+)["']/) || [])[1];
const critical = [...new Set([entry, ...preloads].filter(Boolean))];
let bootRaw = 0;
for (const c of critical) {
  const p = path.join(DIST, c.replace(/^\.?\//, ''));
  if (fs.existsSync(p)) bootRaw += fs.statSync(p).size;
  else errors.push(`критический путь: ${c} — 404`);
}
const cssEntry = critical.filter((c) => c.endsWith('.css')).map((c) => path.join(DIST, c.replace(/^\.?\//, '')));
const cssBytes = cssEntry.reduce((a, f) => a + (fs.existsSync(f) ? fs.statSync(f).size : 0), 0);

/* ── 7. Мелочи ─────────────────────────────────────────────── */
const maps = walk(DIST).filter((f) => f.endsWith('.map'));
if (maps.length) warnings.push(`в dist ${maps.length} sourcemap — лишний вес`);
if (!exists('.nojekyll')) warnings.push('.nojekyll отсутствует — GitHub Pages может включить Jekyll');

const result = {
  files: walk(DIST).length,
  assets: assets.length,
  criticalFiles: critical.length,
  bootBytes: bootRaw,
  bootGzip: gzip(Buffer.concat(critical.filter((c) => fs.existsSync(path.join(DIST, c.replace(/^\.?\//, '')))).map((c) => fs.readFileSync(path.join(DIST, c.replace(/^\.?\//, '')))))),
  cssBytes,
  errors,
  warnings,
};

if (JSON_OUT) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`dist: ${result.files} файлов · ASSETS ${result.assets} · критический путь ${result.criticalFiles} файлов, ${kb(result.bootBytes)} / ${kb(result.bootGzip)} gzip`);
  if (warnings.length) {
    console.log(`Предупреждения (${warnings.length}):`);
    for (const w of warnings) console.log('  ! ' + w);
  }
  if (errors.length) {
    console.log(`\nОшибки (${errors.length}):`);
    for (const e of errors) console.log('  ✗ ' + e);
  } else {
    console.log('Сборка целая.');
  }
}
process.exit(errors.length ? 1 : 0);
