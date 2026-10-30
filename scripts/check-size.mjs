#!/usr/bin/env node
/* Relik — лимит размера модулей.
   Правило: один файл — одна причина для изменения. Цель — 400 строк.

   Легаси-файлы занесены в LEGACY с текущим размером: расти им нельзя,
   уменьшаться — можно и нужно. `--update` опускает лимиты до факта
   (только вниз), чтобы прогресс закреплялся.

   node scripts/check-size.mjs
   node scripts/check-size.mjs --update
   node scripts/check-size.mjs --json */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = fileURLToPath(import.meta.url);
const args = new Set(process.argv.slice(2));
const UPDATE = args.has('--update');
const JSON_OUT = args.has('--json');

const LIMIT = 400;
const DATA_LIMIT = 1200;
const DATA = new Set(['js/i18n/ru.js', 'js/i18n/en.js']);

/* Файлы, которые ещё не разрезаны. Значения только уменьшаются. */
const LEGACY = {
  'js/ui/chatView.js': 2840,
  'js/ui/modals.js': 1759,
  'js/ui/composer.js': 1567,
  'js/main.js': 1154,
  'js/backend/messages.js': 786,
  'js/ui/calls.js': 640,
  'js/ui/palette.js': 518,
  'js/backend/auth.js': 494,
  'js/crypto/v2/protocol.js': 436,
  'js/ui/sidebar.js': 427,
};

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

const files = walk(path.join(ROOT, 'js')).map((f) => {
  const text = fs.readFileSync(f, 'utf8');
  return { file: path.relative(ROOT, f).replace(/\\/g, '/'), lines: text.split('\n').length - 1 };
});

const errors = [];
const warnings = [];
const legacy = [];

for (const { file, lines } of files) {
  if (DATA.has(file)) {
    if (lines > DATA_LIMIT) errors.push(`${file}: ${lines} стр. > ${DATA_LIMIT} (данные i18n)`);
    continue;
  }
  const cap = LEGACY[file] ?? LIMIT;
  if (LEGACY[file]) {
    legacy.push({ file, lines, cap });
    if (lines > cap) errors.push(`${file}: ${lines} стр. > лимит ${cap} (растёт, нужно резать)`);
    else if (lines < cap * 0.8) warnings.push(`${file}: ${lines} стр. — лимит можно опустить до ${lines}`);
  } else if (lines > LIMIT) {
    errors.push(`${file}: ${lines} стр. > ${LIMIT} (разбей на модули)`);
  }
}

const pct = Math.round((legacy.reduce((a, f) => a + f.lines, 0) / files.reduce((a, f) => a + f.lines, 0)) * 100);
const over = legacy.filter((f) => f.lines > LIMIT).length;

if (JSON_OUT) {
  console.log(JSON.stringify({ files: files.length, legacy, errors, warnings }, null, 2));
} else {
  console.log(`Проверка размера модулей: ${files.length} файлов, лимит ${LIMIT} стр.`);
  if (legacy.length) {
    console.log(`легаси > ${LIMIT} стр.: ${over} файлов, ${pct}% всего кода`);
    for (const f of legacy.sort((a, b) => b.lines - a.lines)) {
      const flag = f.lines > LIMIT ? '•' : ' ';
      console.log(`  ${flag} ${String(f.lines).padStart(5)} / ${String(f.cap).padStart(5)}  ${f.file}`);
    }
  }
  for (const w of warnings) console.log(`  ↳ ${w}`);
  if (errors.length) {
    console.error('\n✖ Слишком большие модули:');
    for (const e of errors) console.error('  ' + e);
  } else {
    console.log('\n✔ Лимиты соблюдены');
  }
}

if (UPDATE) {
  const next = {};
  for (const f of legacy.sort((a, b) => a.file.localeCompare(b.file))) {
    next[f.file] = Math.min(f.cap, f.lines); /* только вниз */
  }
  let src = fs.readFileSync(SELF, 'utf8');
  const block = 'const LEGACY = {\n' + Object.entries(next).map(([k, v]) => `  '${k}': ${v},`).join('\n') + '\n};';
  src = src.replace(/const LEGACY = \{[\s\S]*?\};/, block);
  fs.writeFileSync(SELF, src);
  console.log(`\nЛимиты обновлены: ${Object.keys(next).length} файлов`);
}

if (errors.length && !UPDATE) process.exit(1);
