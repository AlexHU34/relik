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
];

const DEFAULTS = () => ({
  pinned: {},          // chatId -> true
  muted: {},           // chatId -> true
  readAt: {},          // chatId -> timestamp последнего прочтения
  textSize: 'normal',  // compact | normal | large
  wallpaper: 'none',   // см. WALLPAPERS
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
