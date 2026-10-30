/* Контраст всех тем по WCAG 2.1 (AA).
   Проверяем то, что читает человек: основной текст, вторичный, подписи,
   текст в своих и чужих пузырях, акцент как текст и иконки.

   Нормативы: обычный текст — 4.5:1, крупный (>=18.66px bold или >=24px) — 3:1,
   нетекстовые элементы (иконки, рамки, индикаторы) — 3:1. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { THEMES } from '../../js/ui/themeDefs.js';

const tokensCss = readFileSync(new URL('../../css/tokens.css', import.meta.url), 'utf8');

function cssVar(name) {
  const m = tokensCss.match(new RegExp(name.replace(/-/g, '\\-') + ':\\s*([^;]+);'));
  return m ? m[1].trim() : null;
}

function lum(hex) {
  const h = String(hex).replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/* Базовая тема «relik» берёт значения из tokens.css (vars у неё нет). */
const base = {
  bg: cssVar('--bg'),
  surface: cssVar('--surface'),
  tx: cssVar('--tx'),
  tx2: cssVar('--tx-2'),
  tx3: cssVar('--tx-3'),
  mine: cssVar('--mine-bg'),
  accent: cssVar('--indigo'),
};

function palette(theme) {
  if (!theme.vars) return base;
  const v = theme.vars;
  return {
    bg: v['--bg'],
    surface: v['--surface'],
    tx: v['--tx'],
    tx2: v['--tx-2'],
    tx3: v['--tx-3'],
    mine: v['--mine-bg'],
    accent: v['--accent'],
  };
}

const AA_TEXT = 4.5;
const AA_LARGE = 3;

test('все темы задают обязательные переменные', () => {
  for (const theme of THEMES) {
    const p = palette(theme);
    for (const key of ['bg', 'surface', 'tx', 'tx2', 'tx3', 'mine', 'accent']) {
      assert.ok(p[key], `${theme.id}: нет ${key}`);
    }
  }
});

test('основной текст читается в каждой теме (AA, 4.5:1)', () => {
  const bad = [];
  for (const theme of THEMES) {
    const p = palette(theme);
    for (const bg of [p.bg, p.surface, p.mine]) {
      const c = contrast(p.tx, bg);
      if (c < AA_TEXT) bad.push(`${theme.id}: tx на ${bg} = ${c.toFixed(2)}`);
    }
  }
  assert.deepEqual(bad, [], 'низкий контраст основного текста:\n' + bad.join('\n'));
});

test('вторичный текст читается в каждой теме (AA, 4.5:1)', () => {
  const bad = [];
  for (const theme of THEMES) {
    const p = palette(theme);
    for (const bg of [p.bg, p.surface]) {
      const c = contrast(p.tx2, bg);
      if (c < AA_TEXT) bad.push(`${theme.id}: tx2 на ${bg} = ${c.toFixed(2)}`);
    }
  }
  assert.deepEqual(bad, [], 'низкий контраст вторичного текста:\n' + bad.join('\n'));
});

test('подписи (--tx-3) читаются в каждой теме (AA, 4.5:1)', () => {
  const bad = [];
  for (const theme of THEMES) {
    const p = palette(theme);
    for (const bg of [p.bg, p.surface]) {
      const c = contrast(p.tx3, bg);
      if (c < AA_TEXT) bad.push(`${theme.id}: tx3 на ${bg} = ${c.toFixed(2)}`);
    }
  }
  assert.deepEqual(bad, [], 'низкий контраст подписей:\n' + bad.join('\n'));
});

test('акцент различим как элемент интерфейса (3:1)', () => {
  const bad = [];
  for (const theme of THEMES) {
    const p = palette(theme);
    const c = contrast(p.accent, p.bg);
    if (c < AA_LARGE) bad.push(`${theme.id}: accent на bg = ${c.toFixed(2)}`);
  }
  assert.deepEqual(bad, [], 'акцент сливается с фоном:\n' + bad.join('\n'));
});

test('текст на акцентной кнопке читается (4.5:1)', () => {
  const bad = [];
  for (const theme of THEMES) {
    const p = palette(theme);
    /* цвет текста на CTA выбирается темой: --on-accent */
    const on = theme.vars ? theme.vars['--on-accent'] : cssVar('--on-accent');
    assert.ok(on, theme.id + ': нет --on-accent');
    const c = contrast(on, p.accent);
    if (c < AA_TEXT) bad.push(`${theme.id}: ${on} на accent = ${c.toFixed(2)}`);
  }
  assert.deepEqual(bad, [], 'текст на акценте слишком бледный:\n' + bad.join('\n'));
});

test('контраст не деградирует: список тем не пустеет', () => {
  assert.ok(THEMES.length >= 10, 'тем стало меньше — проверьте THEME_DEFS');
  assert.ok(THEMES.some((t) => t.id === 'light'), 'светлая тема пропала');
});
