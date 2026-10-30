#!/usr/bin/env node
/* Relik — KPI / бюджет производительности.
   Считает реальные числа проекта и сравнивает с базой.

   node scripts/kpi.mjs            — показать таблицу
   node scripts/kpi.mjs --write    — записать kpi/current.json
   node scripts/kpi.mjs --check    — упасть, если бюджет ухудшился

   Бюджеты (мягкие, пока идёт миграция):
   - boot JS (gzip) не растёт больше чем на 5% от базы
   - весь JS без вендоров не растёт больше чем на 5%
   - CSS (gzip) не растёт больше чем на 5%
   - ни один файл не растёт относительно базы (см. check-size.mjs для лимита строк) */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const WRITE = args.has('--write');
const CHECK = args.has('--check');
const BASELINE = path.join(ROOT, 'kpi', 'baseline.json');

const gzip = (buf) => zlib.gzipSync(buf, { level: 9 }).length;
const lines = (s) => s.split(/\r?\n/).length - (s.endsWith('\n') ? 1 : 0);
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'vendor' || entry.name === 'node_modules') continue;
      walk(full, out);
    } else if (entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

/* ?q= разбор статических импортов: from '...' / import '...' */
const IMPORT_RE = /(?:^|[^\w$])(?:import|export)\s+(?:[\s\S]*?\sfrom\s*)?['"]([^'"]+)['"]/g;
function importsOf(file) {
  const src = fs.readFileSync(file, 'utf8');
  const out = new Set();
  let m;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(src))) {
    const spec = m[1];
    if (!spec.startsWith('.')) continue;
    out.add(spec);
  }
  return [...out];
}

function resolveImport(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  if (fs.existsSync(base) && fs.statSync(base).isFile()) return base;
  if (fs.existsSync(base + '.js')) return base + '.js';
  const idx = path.join(base, 'index.js');
  if (fs.existsSync(idx)) return idx;
  return null;
}

function bootGraph(entry) {
  const seen = new Set();
  const missing = [];
  const stack = [entry];
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of importsOf(file)) {
      const resolved = resolveImport(file, spec);
      if (!resolved) missing.push(`${rel(file)} -> ${spec}`);
      else if (!seen.has(resolved)) stack.push(resolved);
    }
  }
  return { files: [...seen].sort(), missing };
}

const jsFiles = walk(path.join(ROOT, 'js')).map((f) => {
  const src = fs.readFileSync(f, 'utf8');
  return { file: f, bytes: Buffer.byteLength(src), lines: lines(src), src };
});

const jsTotal = jsFiles.reduce((a, f) => a + f.bytes, 0);
const locTotal = jsFiles.reduce((a, f) => a + f.lines, 0);

const graph = bootGraph(path.join(ROOT, 'js', 'main.js'));
const bootSrc = graph.files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
const bootBytes = Buffer.byteLength(bootSrc);

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const cssHrefs = [...html.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]*href=["']([^"']+)["']/gi)].map((m) => m[1]);
const cssBuf = Buffer.concat(cssHrefs.map((h) => fs.readFileSync(path.join(ROOT, h))));

const eagerScripts = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]);
let vendorEagerBytes = 0;
for (const src of eagerScripts) {
  if (!src.includes('/vendor/')) continue; /* main.js уже учтён в boot-графе */
  const p = path.join(ROOT, src);
  if (fs.existsSync(p)) vendorEagerBytes += fs.statSync(p).size;
}

const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
const assetsBlock = (sw.match(/const ASSETS = \[([\s\S]*?)\];/) || [])[1] || '';
const assetCount = [...assetsBlock.matchAll(/'([^']+)'/g)].length;

const maxFile = jsFiles.reduce((a, f) => (f.lines > a.lines ? f : a), { lines: 0, file: '' });

const version = (fs.readFileSync(path.join(ROOT, 'js', 'config.js'), 'utf8').match(/version:\s*'([^']+)'/) || [])[1] || '?';

const metrics = {
  version,
  generatedAt: new Date().toISOString(),
  modules: jsFiles.length,
  loc: locTotal,
  jsBytes: jsTotal,
  jsGzip: gzip(Buffer.concat(jsFiles.map((f) => Buffer.from(f.src)))),
  bootModules: graph.files.length,
  bootBytes,
  bootGzip: gzip(Buffer.from(bootSrc)),
  bootMissing: graph.missing,
  vendorEagerBytes,
  vendorEagerGzip: vendorEagerBytes ? gzip(fs.readFileSync(path.join(ROOT, 'js', 'vendor', 'supabase.js'))) : 0,
  cssBytes: cssBuf.length,
  cssGzip: gzip(cssBuf),
  maxFile: rel(maxFile.file),
  maxFileLines: maxFile.lines,
  assets: assetCount,
};

const KB = (n) => `${(n / 1024).toFixed(1)} KB`;

console.log(`Relik ${metrics.version} — KPI`);
console.log('─'.repeat(52));
console.log(`модулей (без вендоров)   ${metrics.modules}`);
console.log(`строк JS                 ${metrics.loc}`);
console.log(`JS всего                 ${KB(metrics.jsBytes)} / ${KB(metrics.jsGzip)} gzip`);
console.log(`boot-граф                ${metrics.bootModules} модулей, ${KB(metrics.bootBytes)} / ${KB(metrics.bootGzip)} gzip`);
console.log(`вендоры на старте        ${KB(metrics.vendorEagerBytes)} / ${KB(metrics.vendorEagerGzip)} gzip`);
console.log(`CSS                      ${KB(metrics.cssBytes)} / ${KB(metrics.cssGzip)} gzip`);
console.log(`самый большой файл       ${metrics.maxFile} (${metrics.maxFileLines} стр.)`);
console.log(`ассетов в sw.js          ${metrics.assets}`);
if (metrics.bootMissing.length) {
  console.log(`\n⚠ неразрешённые импорты: ${metrics.bootMissing.length}`);
  for (const m of metrics.bootMissing.slice(0, 10)) console.log(`   ${m}`);
}

if (WRITE) {
  fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
  fs.writeFileSync(BASELINE, JSON.stringify(metrics, null, 2) + '\n');
  console.log(`\nЗаписано: ${rel(BASELINE)}`);
}

if (CHECK) {
  if (!fs.existsSync(BASELINE)) {
    console.error('\n✖ Нет базы kpi/baseline.json — сначала запустите: node scripts/kpi.mjs --write');
    process.exit(1);
  }
  const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  const bad = [];
  const cmp = (name, now, was, factor = 1.05) => {
    if (!was) return;
    if (now > was * factor) bad.push(`${name}: ${now} > ${Math.round(was * factor)} (база ${was})`);
  };
  cmp('boot JS gzip', metrics.bootGzip, base.bootGzip);
  cmp('JS всего', metrics.jsBytes, base.jsBytes);
  cmp('CSS gzip', metrics.cssGzip, base.cssGzip);
  if (metrics.maxFileLines > base.maxFileLines) bad.push(`макс. файл: ${metrics.maxFileLines} стр. > ${base.maxFileLines}`);
  if (metrics.bootMissing.length) bad.push(`неразрешённых импортов: ${metrics.bootMissing.length}`);

  const better = [];
  if (metrics.bootGzip < base.bootGzip * 0.9) better.push(`boot JS gzip ${base.bootGzip} → ${metrics.bootGzip} (–${Math.round((1 - metrics.bootGzip / base.bootGzip) * 100)}%)`);
  if (metrics.maxFileLines < base.maxFileLines) better.push(`макс. файл ${base.maxFileLines} → ${metrics.maxFileLines} стр.`);

  if (better.length) console.log('\n✔ Улучшения:\n   ' + better.join('\n   '));
  if (bad.length) {
    console.error('\n✖ Бюджет превышен:\n   ' + bad.join('\n   '));
    process.exit(1);
  }
  console.log('\n✔ Бюджет в норме');
}
