/* Relik — темы оформления (10 вариантов) */
import { applyAccent } from './prefs.js';

const hexRgba = (hex, a) => {
  const h = hex.replace('#', '');
  const f = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(f, 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return `rgba(${r},${g},${b},${a})`;
};

/* t: bg, surface, surface2, surface3, raise, line, line2, tx, tx2, tx3,
      a1, a2, a3 (акценты), mine, mineLine, theirs, theirsLine                          */
const THEME_DEFS = [
  {
    id: 'relik', name: 'Relik Dark',
    t: null, /* базовая тема из tokens.css */
  },
  {
    id: 'midnight', name: 'Midnight',
    t: {
      bg: '#05070d', surface: '#0a0f17', surface2: '#0e141f', surface3: '#131b28', raise: '#182233',
      line: '#1b2433', line2: '#263247', tx: '#e6eaf5', tx2: '#909bb1', tx3: '#5a6478',
      a1: '#38bdf8', a2: '#6366f1', a3: '#a855f7',
      mine: '#16233a', mineLine: '#23344f', theirs: '#0f1622', theirsLine: '#1b2533',
    },
  },
  {
    id: 'ocean', name: 'Ocean',
    t: {
      bg: '#06101a', surface: '#0a1723', surface2: '#0e1e2d', surface3: '#13283a', raise: '#18334a',
      line: '#1b3347', line2: '#24405a', tx: '#e3f0f7', tx2: '#8fa8b8', tx3: '#5b7486',
      a1: '#2dd4bf', a2: '#0ea5e9', a3: '#6366f1',
      mine: '#10344a', mineLine: '#174a68', theirs: '#0c1c28', theirsLine: '#16303f',
    },
  },
  {
    id: 'forest', name: 'Forest',
    t: {
      bg: '#07110c', surface: '#0b1a12', surface2: '#0f2318', surface3: '#142c1f', raise: '#1a3a29',
      line: '#1c3a2a', line2: '#27503a', tx: '#e5f2ea', tx2: '#93ac9e', tx3: '#647a6c',
      a1: '#34d399', a2: '#10b981', a3: '#84cc16',
      mine: '#123a28', mineLine: '#1a4f37', theirs: '#0b1a12', theirsLine: '#173326',
    },
  },
  {
    id: 'sunset', name: 'Sunset',
    t: {
      bg: '#140b10', surface: '#1c0f15', surface2: '#24131b', surface3: '#2d1822', raise: '#3a1f2c',
      line: '#3a202c', line2: '#4b2938', tx: '#f6e9ee', tx2: '#bfa3ad', tx3: '#8a6f79',
      a1: '#fb923c', a2: '#f43f5e', a3: '#d946ef',
      mine: '#3a1a24', mineLine: '#522534', theirs: '#1c1117', theirsLine: '#35202a',
    },
  },
  {
    id: 'rose', name: 'Rose',
    t: {
      bg: '#120b12', surface: '#1a0f1a', surface2: '#221322', surface3: '#2b182b', raise: '#381f38',
      line: '#382038', line2: '#482a48', tx: '#f3e8f3', tx2: '#bda3bd', tx3: '#876c87',
      a1: '#ec4899', a2: '#d946ef', a3: '#8b5cf6',
      mine: '#35173a', mineLine: '#4a2052', theirs: '#1a101a', theirsLine: '#2f1c2f',
    },
  },
  {
    id: 'nord', name: 'Nord',
    t: {
      bg: '#0e141b', surface: '#131a23', surface2: '#18212c', surface3: '#1e2835', raise: '#25313f',
      line: '#243040', line2: '#314155', tx: '#e5ecf5', tx2: '#94a3b8', tx3: '#64748b',
      a1: '#88c0d0', a2: '#81a1c1', a3: '#b48ead',
      mine: '#1b2a3a', mineLine: '#2b4055', theirs: '#141c26', theirsLine: '#243142',
    },
  },
  {
    id: 'grape', name: 'Grape',
    t: {
      bg: '#100a18', surface: '#171021', surface2: '#1e142b', surface3: '#261937', raise: '#332046',
      line: '#332044', line2: '#472d5c', tx: '#f0e9f8', tx2: '#b9a6cc', tx3: '#8b78a3',
      a1: '#c084fc', a2: '#a855f7', a3: '#6366f1',
      mine: '#2a183e', mineLine: '#3f2459', theirs: '#1a1126', theirsLine: '#332044',
    },
  },
  {
    id: 'mono', name: 'Mono',
    t: {
      bg: '#0b0b0d', surface: '#111114', surface2: '#16161a', surface3: '#1c1c21', raise: '#24242b',
      line: '#26262b', line2: '#333338', tx: '#ececef', tx2: '#a3a3ab', tx3: '#6e6e78',
      a1: '#d4d4d8', a2: '#a1a1aa', a3: '#71717a',
      mine: '#26262c', mineLine: '#35353d', theirs: '#141419', theirsLine: '#232329',
    },
  },
  {
    id: 'amoled', name: 'AMOLED',
    t: {
      bg: '#000000', surface: '#050505', surface2: '#0a0a0a', surface3: '#101010', raise: '#161616',
      line: '#1a1a1a', line2: '#262626', tx: '#f5f5f5', tx2: '#a0a0a0', tx3: '#6a6a6a',
      a1: '#60a5fa', a2: '#818cf8', a3: '#c084fc',
      mine: '#101018', mineLine: '#1c1c2a', theirs: '#070709', theirsLine: '#17171b',
    },
  },
  {
    id: 'sepia', name: 'Sepia',
    t: {
      bg: '#1a150f', surface: '#211a12', surface2: '#2a2117', surface3: '#34291d', raise: '#42341f',
      line: '#423426', line2: '#554433', tx: '#f2e8da', tx2: '#bfae97', tx3: '#8d7c66',
      a1: '#eab308', a2: '#f59e0b', a3: '#f97316',
      mine: '#3a2b18', mineLine: '#52402a', theirs: '#211a12', theirsLine: '#362a1c',
    },
  },
  {
    id: 'light', name: 'Light',
    t: {
      bg: '#f5f7fb', surface: '#ffffff', surface2: '#eef1f7', surface3: '#e4e9f2', raise: '#ffffff',
      line: '#dbe1ec', line2: '#c8d1e0', tx: '#1a2230', tx2: '#5a6577', tx3: '#66707f',
      a1: '#3b82f6', a2: '#6366f1', a3: '#8b5cf6',
      mine: '#dbe6ff', mineLine: '#c3d4f7', theirs: '#ffffff', theirsLine: '#e2e8f2',
      metaMine: '#4054c9', quoteName: '#4054c9', tick: '#3f6fe0',
      authBg: 'rgba(255,255,255,.82)', chatHeadBg: 'rgba(255,255,255,.85)', quoteBg: 'rgba(238,241,247,.9)',
    },
  },
];

export const THEMES = THEME_DEFS.map((d) => {
  if (!d.t) return { id: d.id, name: d.name, swatch: ['#0b0e14', '#5b6cf9'] };
  const t = d.t;
  const vars = {
    '--bg': t.bg,
    '--surface': t.surface,
    '--surface-2': t.surface2,
    '--surface-3': t.surface3,
    '--raise': t.raise,
    '--line': t.line,
    '--line-2': t.line2,
    '--tx': t.tx,
    '--tx-2': t.tx2,
    '--tx-3': t.tx3,
    '--blue': t.a1,
    '--indigo': t.a2,
    '--violet': t.a3,
    '--grad': `linear-gradient(135deg,${t.a1},${t.a2} 50%,${t.a3})`,
    '--accent': t.a2,
    '--accent-soft': hexRgba(t.a2, 0.15),
    '--accent-glow': hexRgba(t.a2, 0.4),
    '--bg-glow-1': hexRgba(t.a1, 0.09),
    '--bg-glow-2': hexRgba(t.a3, 0.08),
    '--mine-bg': t.mine,
    '--mine-line': t.mineLine,
    '--theirs-bg': t.theirs,
    '--theirs-line': t.theirsLine,
    '--quote-name': t.quoteName || hexRgba(t.a2, 0.9),
    '--tick-read': t.tick || '#7ea6ff',
    '--meta-mine': t.metaMine || '#a2abff',
    '--auth-bg': t.authBg || hexRgba(t.surface, 0.72),
    '--chat-head-bg': t.chatHeadBg || hexRgba(t.surface, 0.8),
    '--reply-quote-bg': t.quoteBg || hexRgba(t.bg, 0.45),
  };
  return { id: d.id, name: d.name, swatch: [t.bg, t.a2], vars };
});

const ALL_VARS = ['--bg', '--surface', '--surface-2', '--surface-3', '--raise', '--line', '--line-2',
  '--tx', '--tx-2', '--tx-3', '--blue', '--indigo', '--violet', '--grad', '--accent',
  '--accent-soft', '--accent-glow', '--bg-glow-1', '--bg-glow-2', '--mine-bg', '--mine-line',
  '--theirs-bg', '--theirs-line', '--quote-name', '--tick-read', '--meta-mine', '--auth-bg',
  '--chat-head-bg', '--reply-quote-bg'];

export function applyTheme(id, persist = true) {
  const theme = THEMES.find((x) => x.id === id) || THEMES[0];
  const root = document.documentElement;
  for (const key of ALL_VARS) root.style.removeProperty(key);
  if (theme.vars) {
    for (const [k, v] of Object.entries(theme.vars)) root.style.setProperty(k, v);
  }
  applyAccent(root);
  root.dataset.theme = theme.id;
  root.style.colorScheme = theme.id === 'light' ? 'light' : 'dark';
  if (persist) localStorage.setItem('relik.theme', theme.id);
}

export function currentTheme() {
  const saved = localStorage.getItem('relik.theme');
  return THEMES.some((t) => t.id === saved) ? saved : 'relik';
}
