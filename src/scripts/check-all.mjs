#!/usr/bin/env node
/* Relik — все проверки одной командой: node scripts/check-all.mjs
   От дешёвых к дорогим; падение любой — стоп в конце с кодом 1. */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function walkJs(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (['node_modules', 'vendor', 'dist', 'shots'].includes(e.name)) continue;
      walkJs(full, out);
    } else if (/\.(js|mjs)$/.test(e.name)) {
      out.push(full);
    }
  }
  return out;
}

function run(cmd, args, { shell = false } = {}) {
  return spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', shell });
}

const steps = [
  ['синтаксис модулей', () => {
    const bad = walkJs(path.join(ROOT, 'js'))
      .concat(walkJs(path.join(ROOT, 'scripts')))
      .filter((f) => run(process.execPath, ['--check', f]).status !== 0);
    return { ok: bad.length === 0, detail: bad.map((f) => path.relative(ROOT, f)).join('\n') };
  }],
  ['ассеты и офлайн-оболочка', () => shell('scripts/check-assets.mjs')],
  ['паритет RU/EN', () => shell('scripts/check-i18n.mjs')],
  ['CSP и хеши inline-скриптов', () => shell('scripts/check-csp.mjs')],
  ['лимит размера модулей', () => shell('scripts/check-size.mjs')],
  ['бюджет KPI', () => shell('scripts/kpi.mjs', '--check')],
  ['юнит-тесты', () => shell('scripts/test.mjs')],
  ['типы (tsc)', () => {
    const r = run('npx.cmd', ['tsc', '--noEmit'], { shell: true });
    return { ok: r.status === 0, detail: (r.stdout || '') + (r.stderr || '') };
  }],
  ['линтер (eslint)', () => {
    const r = run('npx.cmd', ['eslint', 'js', 'scripts', '--max-warnings', '999'], { shell: true });
    return { ok: r.status === 0, detail: (r.stdout || '') + (r.stderr || '') };
  }],
];

function shell(script, ...args) {
  const r = run(process.execPath, [script, ...args]);
  return { ok: r.status === 0, detail: (r.stdout || '') + (r.stderr || '') };
}

let failed = 0;
const t0 = Date.now();

for (const [name, fn] of steps) {
  const started = Date.now();
  let res;
  try {
    res = fn();
  } catch (err) {
    res = { ok: false, detail: String(err) };
  }
  const ms = Date.now() - started;
  console.log(`${res.ok ? '✔' : '✖'} ${name} (${ms} мс)`);
  if (!res.ok) {
    failed++;
    if (res.detail) console.log(res.detail.split('\n').slice(-25).map((l) => '   ' + l).join('\n'));
  }
}

console.log(`\n${failed ? `✖ падений: ${failed}` : '✔ всё зелёное'} за ${((Date.now() - t0) / 1000).toFixed(1)} с`);
process.exit(failed ? 1 : 0);
