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

/* То же для служебных страниц: раньше ../js/config.js был 404 на проде,
   и status/health/preflight молча показывали «Supabase не настроен». */
for (const page of walk(DIST).filter((f) => f.endsWith('.html'))) {
  const relPage = path.relative(DIST, page).replace(/\\/g, '/');
  const dir = path.posix.dirname(relPage);
  const text = fs.readFileSync(page, 'utf8');
  for (const m of text.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const raw = m[1];
    if (!raw || /^(https?:|data:|mailto:|#|\/\/|javascript:)/.test(raw)) continue;
    const clean = raw.split('?')[0].split('#')[0];
    if (!clean || clean.endsWith('/') || clean === '..' || clean === '.') continue;
    const target = path.posix.normalize(dir === '.' ? clean : `${dir}/${clean}`).replace(/^\.\//, '');
    if (target.startsWith('..')) continue;
    if (!exists(target)) errors.push(`${relPage}: ${raw} — 404`);
  }
}

/* ── 3. Вендоры, которые грузятся по жёсткому пути ─────────── */
for (const f of ['js/vendor/supabase.js', 'js/vendor/qrcode.js']) {
  if (!exists(f)) errors.push(`${f} — нет в dist (грузится из HTML/по URL)`);
}

/* ── 4. manifest.json: иконки на месте ─────────────────────── */
const manifest = JSON.parse(fs.readFileSync(path.join(DIST, 'manifest.json'), 'utf8'));
for (const icon of manifest.icons || []) {
  if (!exists(icon.src)) errors.push(`manifest.json: ${icon.src} — 404`);
}
/* Манифест должен подключаться из корня: из assets/ относительные пути к
   иконкам ломаются (получается /assets/assets/icons/...). */
if (!/href=["']\.?\/?manifest\.json["']/.test(html)) {
  errors.push('index.html: ссылка на manifest.json переписана сборкой (PWA-иконки не найдутся)');
}
if (fs.existsSync(path.join(DIST, 'assets'))) {
  const dup = fs.readdirSync(path.join(DIST, 'assets')).filter((f) => /^manifest-.*\.json$/.test(f));
  if (dup.length) errors.push(`в dist/assets остался дубль манифеста: ${dup.join(', ')}`);
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
/* Vite режет бандл на чанки: entry может статически импортировать другие
   файлы (словари, общие модули) — они грузятся до выполнения и тоже входят
   в критический путь. Динамические import(...) сюда не попадают. */
const queue = critical.filter((c) => c.endsWith('.js'));
const seenJs = new Set(queue);
while (queue.length) {
  const rel = queue.pop();
  const absJs = path.join(DIST, rel.replace(/^\.?\//, ''));
  if (!fs.existsSync(absJs)) continue;
  const src = fs.readFileSync(absJs, 'utf8');
  for (const m of src.matchAll(/(?:from|import)\s*["'](\.\/[^"']+\.js)["']/g)) {
    const next = path.posix
      .normalize(path.posix.join(path.posix.dirname(rel), m[1]))
      .replace(/^\.\//, '');
    if (seenJs.has(next) || !fs.existsSync(path.join(DIST, next))) continue;
    seenJs.add(next);
    critical.push(next);
    queue.push(next);
  }
}
const criticalBufs = [];
let bootRaw = 0;
for (const c of critical) {
  const p = path.join(DIST, c.replace(/^\.?\//, ''));
  if (fs.existsSync(p)) {
    bootRaw += fs.statSync(p).size;
    criticalBufs.push(fs.readFileSync(p));
  } else errors.push(`критический путь: ${c} — 404`);
}
const cssEntry = critical.filter((c) => c.endsWith('.css')).map((c) => path.join(DIST, c.replace(/^\.?\//, '')));
const cssBytes = cssEntry.reduce((a, f) => a + (fs.existsSync(f) ? fs.statSync(f).size : 0), 0);

/* Ленивый вендор: его вес виден отдельно и в критический путь не входит.
   Если он вернётся статическим тегом — check-dist выше это уже поймал. */
const lazyVendorPath = path.join(DIST, 'js', 'vendor', 'supabase.js');
const lazyVendorBytes = fs.existsSync(lazyVendorPath) ? fs.statSync(lazyVendorPath).size : 0;
const criticalGzip = gzip(Buffer.concat(criticalBufs));

/* ── 8. Домен: если CNAME есть, он должен быть валидным ─────── */
const cnamePath = path.join(DIST, 'CNAME');
if (fs.existsSync(cnamePath)) {
  const host = fs.readFileSync(cnamePath, 'utf8').trim();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) errors.push(`CNAME: некорректный домен «${host}»`);
} else {
  warnings.push('CNAME нет — сайт отдаётся с github.io');
}

/* ── 9. Целостность: SRI ленивого вендора и манифест хешей ──── */
const vendorAbs = path.join(DIST, 'js', 'vendor', 'supabase.js');
if (fs.existsSync(vendorAbs)) {
  const want = 'sha384-' + createHash('sha384').update(fs.readFileSync(vendorAbs)).digest('base64');
  const tag = (html.match(/<meta[^>]*name=["']relik-sdk-sri["'][^>]*>/) || [])[0] || '';
  if (!tag) errors.push('index.html: нет meta relik-sdk-sri — SRI для ленивого SDK не записан');
  else if (!tag.includes(want)) errors.push('index.html: SRI supabase.js не совпадает с файлом');
  /* 213 КБ SDK не должны вернуться на критический путь: это главный тормоз
     первого экрана. Грузится только через js/backend/sdk.js. */
  if (/<script[^>]+src=["'][^"']*js\/vendor\/supabase\.js/.test(html)) {
    errors.push('index.html: supabase.js снова статическим тегом — SDK должен грузиться лениво');
  }
}

const integrityPath = path.join(DIST, 'integrity.json');
if (!fs.existsSync(integrityPath)) {
  errors.push('integrity.json отсутствует — нельзя проверить целостность сборки');
} else {
  const manifest = JSON.parse(fs.readFileSync(integrityPath, 'utf8'));
  const listed = manifest.files || {};
  for (const [relFile, hash] of Object.entries(listed)) {
    const abs = path.join(DIST, relFile.replace(/^\.\//, ''));
    if (!fs.existsSync(abs)) { errors.push(`integrity: ${relFile} — нет в dist`); continue; }
    const actual = createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
    if (actual !== hash) errors.push(`integrity: ${relFile} — хеш не совпадает`);
  }
  for (const abs of walk(DIST)) {
    const relFile = './' + path.relative(DIST, abs).replace(/\\/g, '/');
    if (relFile === './integrity.json') continue;
    if (!listed[relFile]) errors.push(`integrity: ${relFile} — не описан в манифесте`);
  }
}

/* ── 10. Мелочи ─────────────────────────────────────────────── */
const maps = walk(DIST).filter((f) => f.endsWith('.map'));
if (maps.length) warnings.push(`в dist ${maps.length} sourcemap — лишний вес`);
if (!exists('.nojekyll')) warnings.push('.nojekyll отсутствует — GitHub Pages может включить Jekyll');

/* ── 11. Бюджет критического пути (сборка, а не исходники) ─────
   kpi.mjs следит за исходниками, а здесь — за тем, что реально уезжает
   в браузер: минифицированный entry + CSS. Рост больше 5% = откат. */
const DIST_BASELINE = path.join(ROOT, 'kpi', 'dist-baseline.json');
const budget = { criticalBytes: bootRaw, criticalGzip, lazyVendorBytes, cssBytes };
if (process.argv.includes('--write-baseline')) {
  fs.mkdirSync(path.dirname(DIST_BASELINE), { recursive: true });
  fs.writeFileSync(DIST_BASELINE, JSON.stringify({ generatedAt: new Date().toISOString(), ...budget }, null, 2) + '\n');
  console.log(`Бюджет записан: ${path.relative(ROOT, DIST_BASELINE).replace(/\\/g, '/')}`);
} else if (fs.existsSync(DIST_BASELINE)) {
  try {
    const base = JSON.parse(fs.readFileSync(DIST_BASELINE, 'utf8'));
    const cap = Math.ceil((base.criticalGzip || 0) * 1.05);
    if (base.criticalGzip && criticalGzip > cap) {
      errors.push(`критический путь вырос: ${kb(criticalGzip)} gzip > ${kb(cap)} (база ${kb(base.criticalGzip)})`);
    } else if (base.criticalGzip && criticalGzip < base.criticalGzip * 0.9) {
      warnings.push(`критический путь уменьшился: ${kb(base.criticalGzip)} → ${kb(criticalGzip)} gzip (обновите базу: --write-baseline)`);
    }
  } catch (e) {
    warnings.push('kpi/dist-baseline.json повреждён — бюджет не проверен');
  }
}

const result = {
  files: walk(DIST).length,
  assets: assets.length,
  criticalFiles: critical.length,
  bootBytes: bootRaw,
  bootGzip: criticalGzip,
  lazyVendorBytes,
  cssBytes,
  errors,
  warnings,
};

if (JSON_OUT) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`dist: ${result.files} файлов · ASSETS ${result.assets} · критический путь ${result.criticalFiles} файлов, ${kb(result.bootBytes)} / ${kb(result.bootGzip)} gzip`);
  console.log(`ленивый SDK: ${kb(result.lazyVendorBytes)} (вне критического пути)`);
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
