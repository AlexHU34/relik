/* Relik — локальные настройки интерфейса: закреплённые и приглушённые чаты,
   отметки прочтения, размер текста, обои, анимации, Enter-отправка.
   Хранятся в localStorage (переживают перезагрузку, работают без сети). */

const KEY = 'relik.prefs.v2';

export const TEXT_SIZES = ['compact', 'normal', 'large'];
export const WALLPAPERS = [
  { id: 'none', name: 'Без обоев', labelKey: 'wall.none' },
  { id: 'glow', name: 'Aurora', labelKey: 'wall.glow' },
  { id: 'dots', name: 'Точки', labelKey: 'wall.dots' },
  { id: 'grid', name: 'Сетка', labelKey: 'wall.grid' },
  { id: 'waves', name: 'Волны', labelKey: 'wall.waves' },
  { id: 'custom', name: 'Свои', labelKey: 'wall.custom' },
];

export const ACCENTS = [
  { id: 'theme', labelKey: 'accent.theme', c: null },
  { id: 'blue', labelKey: 'accent.blue', c: ['#4e7fff', '#5b6cf9', '#9f5cf6'] },
  { id: 'teal', labelKey: 'accent.teal', c: ['#2dd4bf', '#0ea5e9', '#6366f1'] },
  { id: 'green', labelKey: 'accent.green', c: ['#34d399', '#10b981', '#84cc16'] },
  { id: 'amber', labelKey: 'accent.amber', c: ['#fbbf24', '#f59e0b', '#f97316'] },
  { id: 'rose', labelKey: 'accent.rose', c: ['#fb7185', '#f43f5e', '#d946ef'] },
  { id: 'violet', labelKey: 'accent.violet', c: ['#a78bfa', '#8b5cf6', '#d946ef'] },
];

const hexRgba = (hex, a) => {
  const h = hex.replace('#', '');
  const f = h.length === 3 ? h.split('').map((ch) => ch + ch).join('') : h;
  const n = parseInt(f, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

const DEFAULTS = () => ({
  pinned: {},          // chatId -> true
  muted: {},           // chatId -> true
  readAt: {},          // chatId -> timestamp последнего прочтения
  textSize: 'normal',  // compact | normal | large
  wallpaper: 'none',   // см. WALLPAPERS
  customWall: null,    // data URL для «Свои обои»
  accent: 'theme',     // см. ACCENTS
  enterToSend: true,
  motion: true,
});

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!raw || typeof raw !== 'object') return DEFAULTS();
    const d = DEFAULTS();
    return {
      ...d,
      ...raw,
      pinned: { ...(raw.pinned || {}) },
      muted: { ...(raw.muted || {}) },
      readAt: { ...(raw.readAt || {}) },
    };
  } catch (e) {
    return DEFAULTS();
  }
}

export const prefs = load();

let saveTimer = null;
export function savePrefs() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch (e) { /* приватный режим */ }
  }, 60);
}

export function isPinned(chatId) {
  return !!prefs.pinned[chatId];
}

export function togglePinned(chatId) {
  if (!chatId) return false;
  if (prefs.pinned[chatId]) delete prefs.pinned[chatId];
  else prefs.pinned[chatId] = true;
  savePrefs();
  return !!prefs.pinned[chatId];
}

export function isMuted(chatId) {
  return !!prefs.muted[chatId];
}

export function toggleMuted(chatId) {
  if (!chatId) return false;
  if (prefs.muted[chatId]) delete prefs.muted[chatId];
  else prefs.muted[chatId] = true;
  savePrefs();
  return !!prefs.muted[chatId];
}

export function getReadAt(chatId) {
  return Number(prefs.readAt[chatId] || 0);
}

export function setReadAt(chatId, ts = Date.now()) {
  if (!chatId) return;
  prefs.readAt[chatId] = ts;
  savePrefs();
}

export function clearChatPrefs(chatId) {
  delete prefs.pinned[chatId];
  delete prefs.muted[chatId];
  delete prefs.readAt[chatId];
  savePrefs();
}

/* ── Применение визуальных префов к <html> ─────────────────── */
export function applyPrefs() {
  const root = document.documentElement;
  const size = TEXT_SIZES.includes(prefs.textSize) ? prefs.textSize : 'normal';
  const wall = WALLPAPERS.some((w) => w.id === prefs.wallpaper) ? prefs.wallpaper : 'none';
  root.dataset.textsize = size;
  root.dataset.wallpaper = wall;
  root.dataset.motion = prefs.motion === false ? 'off' : 'on';
  if (wall === 'custom' && prefs.customWall) {
    root.style.setProperty('--chat-wall', `url("${prefs.customWall}")`);
  } else {
    root.style.removeProperty('--chat-wall');
  }
}

export function setCustomWall(dataUrl) {
  prefs.customWall = dataUrl || null;
  if (prefs.customWall) prefs.wallpaper = 'custom';
  else if (prefs.wallpaper === 'custom') prefs.wallpaper = 'none';
  savePrefs();
  applyPrefs();
}

/* Акцент применяется после темы и перекрывает её цветовые переменные */
export function applyAccent(root = document.documentElement) {
  const a = ACCENTS.find((x) => x.id === prefs.accent);
  if (!a || !a.c) {
    delete root.dataset.accent;
    return false;
  }
  const [c1, c2, c3] = a.c;
  const vars = {
    '--blue': c1,
    '--indigo': c2,
    '--violet': c3,
    '--grad': `linear-gradient(135deg,${c1},${c2} 50%,${c3})`,
    '--accent': c2,
    '--accent-soft': hexRgba(c2, 0.15),
    '--accent-glow': hexRgba(c2, 0.4),
    '--bg-glow-1': hexRgba(c1, 0.09),
    '--bg-glow-2': hexRgba(c3, 0.08),
  };
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  root.dataset.accent = a.id;
  return true;
}

export function setAccent(id) {
  if (!ACCENTS.some((a) => a.id === id)) return;
  prefs.accent = id;
  savePrefs();
  applyAccent();
}

export function setTextSize(size) {
  if (!TEXT_SIZES.includes(size)) return;
  prefs.textSize = size;
  savePrefs();
  applyPrefs();
}

export function setWallpaper(id) {
  if (!WALLPAPERS.some((w) => w.id === id)) return;
  prefs.wallpaper = id;
  savePrefs();
  applyPrefs();
}

export function setMotion(on) {
  prefs.motion = !!on;
  savePrefs();
  applyPrefs();
}

export function setEnterToSend(on) {
  prefs.enterToSend = !!on;
  savePrefs();
}
