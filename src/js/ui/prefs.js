/* Relik — локальные настройки интерфейса: закреплённые и приглушённые чаты,
   отметки прочтения, размер текста, обои, акцент, анимации, Enter-отправка.
   Хранятся в localStorage (переживают перезагрузку, работают без сети). */
import { saveRemotePrefs } from '../backend/prefsSync.js';

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
  folders: {},         // chatId -> 'work' | 'archive'
  ttl: {},             // chatId -> секунды (0 = выкл)
  ttlSince: {},        // chatId -> когда включили TTL
  textSize: 'normal',  // compact | normal | large
  wallpaper: 'none',   // см. WALLPAPERS
  customWall: null,    // data URL для «Свои обои»
  accent: 'theme',     // см. ACCENTS
  enterToSend: true,
  motion: true,
  hideOnline: false,
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
      folders: { ...(raw.folders || {}) },
      ttl: { ...(raw.ttl || {}) },
      ttlSince: { ...(raw.ttlSince || {}) },
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
    saveRemotePrefs(prefs);
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

/* ── папки чатов ─────────────────────────────────────────── */
export const CHAT_FOLDERS = ['work', 'archive'];

export function getChatFolder(chatId) {
  const value = prefs.folders[chatId];
  return CHAT_FOLDERS.includes(value) ? value : '';
}

export function setChatFolder(chatId, folder) {
  if (!chatId) return '';
  if (CHAT_FOLDERS.includes(folder)) prefs.folders[chatId] = folder;
  else delete prefs.folders[chatId];
  savePrefs();
  return getChatFolder(chatId);
}

/* ── исчезающие сообщения ─────────────────────────────────── */
export const TTL_OPTIONS = [0, 5, 60, 86400];

export function getChatTtl(chatId) {
  const value = Number(prefs.ttl[chatId]) || 0;
  return TTL_OPTIONS.includes(value) ? value : 0;
}

export function getChatTtlSince(chatId) {
  return Number(prefs.ttlSince[chatId]) || 0;
}

export function setChatTtl(chatId, seconds, since = Date.now()) {
  if (!chatId) return 0;
  const value = TTL_OPTIONS.includes(Number(seconds)) ? Number(seconds) : 0;
  if (value) {
    prefs.ttl[chatId] = value;
    prefs.ttlSince[chatId] = Number(since) || Date.now();
  } else {
    delete prefs.ttl[chatId];
    delete prefs.ttlSince[chatId];
  }
  savePrefs();
  return value;
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
  delete prefs.folders[chatId];
  delete prefs.ttl[chatId];
  delete prefs.ttlSince[chatId];
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

/* Скрывать онлайн-статус от других (last_seen уходит в 1970) */
export function setHideOnline(on) {
  prefs.hideOnline = !!on;
  savePrefs();
}

/* Слияние настроек с сервера (закрепы/мьюты — объединяем, оформление — сервер) */
export function applyRemotePrefs(remote) {
  if (!remote || typeof remote !== 'object') return false;
  if (remote.pinned && typeof remote.pinned === 'object') {
    prefs.pinned = { ...remote.pinned };
  }
  if (remote.muted && typeof remote.muted === 'object') {
    prefs.muted = { ...remote.muted };
  }
  if (remote.folders && typeof remote.folders === 'object') {
    prefs.folders = { ...remote.folders };
  }
  if (TEXT_SIZES.includes(remote.textSize)) prefs.textSize = remote.textSize;
  if (WALLPAPERS.some((w) => w.id === remote.wallpaper) && remote.wallpaper !== 'custom') {
    prefs.wallpaper = remote.wallpaper;
  }
  if (ACCENTS.some((a) => a.id === remote.accent)) prefs.accent = remote.accent;
  if (typeof remote.enterToSend === 'boolean') prefs.enterToSend = remote.enterToSend;
  if (typeof remote.motion === 'boolean') prefs.motion = remote.motion;
  savePrefs();
  applyPrefs();
  return true;
}
