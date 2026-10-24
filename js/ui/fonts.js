/* Relik — шрифты: 20 вариантов + загрузка своего */
import { idb } from '../db/idb.js';

export const FONTS = [
  { id: 'inter', name: 'Inter', stack: '"Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif', google: 'Inter:wght@400;500;600;700' },
  { id: 'system', name: 'Системный', stack: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' },
  { id: 'roboto', name: 'Roboto', stack: '"Roboto", system-ui, sans-serif', google: 'Roboto:wght@400;500;700' },
  { id: 'opensans', name: 'Open Sans', stack: '"Open Sans", system-ui, sans-serif', google: 'Open+Sans:wght@400;500;600;700' },
  { id: 'lato', name: 'Lato', stack: '"Lato", system-ui, sans-serif', google: 'Lato:wght@400;700' },
  { id: 'montserrat', name: 'Montserrat', stack: '"Montserrat", system-ui, sans-serif', google: 'Montserrat:wght@400;500;600;700' },
  { id: 'poppins', name: 'Poppins', stack: '"Poppins", system-ui, sans-serif', google: 'Poppins:wght@400;500;600' },
  { id: 'nunito', name: 'Nunito', stack: '"Nunito", system-ui, sans-serif', google: 'Nunito:wght@400;500;600;700' },
  { id: 'raleway', name: 'Raleway', stack: '"Raleway", system-ui, sans-serif', google: 'Raleway:wght@400;500;600;700' },
  { id: 'rubik', name: 'Rubik', stack: '"Rubik", system-ui, sans-serif', google: 'Rubik:wght@400;500;600' },
  { id: 'manrope', name: 'Manrope', stack: '"Manrope", system-ui, sans-serif', google: 'Manrope:wght@400;500;600;700' },
  { id: 'ubuntu', name: 'Ubuntu', stack: '"Ubuntu", system-ui, sans-serif', google: 'Ubuntu:wght@400;500;700' },
  { id: 'ptsans', name: 'PT Sans', stack: '"PT Sans", system-ui, sans-serif', google: 'PT+Sans:wght@400;700' },
  { id: 'golos', name: 'Golos Text', stack: '"Golos Text", system-ui, sans-serif', google: 'Golos+Text:wght@400;500;600;700' },
  { id: 'unbounded', name: 'Unbounded', stack: '"Unbounded", system-ui, sans-serif', google: 'Unbounded:wght@400;500;600' },
  { id: 'jost', name: 'Jost', stack: '"Jost", system-ui, sans-serif', google: 'Jost:wght@400;500;600' },
  { id: 'outfit', name: 'Outfit', stack: '"Outfit", system-ui, sans-serif', google: 'Outfit:wght@400;500;600' },
  { id: 'spacegrotesk', name: 'Space Grotesk', stack: '"Space Grotesk", system-ui, sans-serif', google: 'Space+Grotesk:wght@400;500;600' },
  { id: 'dmsans', name: 'DM Sans', stack: '"DM Sans", system-ui, sans-serif', google: 'DM+Sans:wght@400;500;600' },
  { id: 'sora', name: 'Sora', stack: '"Sora", system-ui, sans-serif', google: 'Sora:wght@400;500;600' },
  { id: 'ibmplex', name: 'IBM Plex Sans', stack: '"IBM Plex Sans", system-ui, sans-serif', google: 'IBM+Plex+Sans:wght@400;500;600' },
  { id: 'comfortaa', name: 'Comfortaa', stack: '"Comfortaa", system-ui, sans-serif', google: 'Comfortaa:wght@400;500;600' },
];

const loaded = new Set();

export function loadFont(id) {
  const f = FONTS.find((x) => x.id === id);
  if (!f || !f.google || loaded.has(f.id)) return;
  loaded.add(f.id);
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = `https://fonts.googleapis.com/css2?family=${f.google}&display=swap`;
  document.head.appendChild(link);
}

export function applyFontStack(stack, persist) {
  document.documentElement.style.setProperty('--font', stack);
  if (persist) localStorage.setItem('relik.font', stack);
}

export function applyFont(id, persist = true) {
  const f = FONTS.find((x) => x.id === id) || FONTS[0];
  loadFont(f.id);
  applyFontStack(f.stack, persist);
  if (persist) localStorage.setItem('relik.fontId', id);
}

export async function registerCustomFont(name, data) {
  const family = 'RelikCustom';
  const face = new FontFace(family, data);
  await face.load();
  document.fonts.add(face);
  applyFontStack(`"${family}", system-ui, sans-serif`);
  return family;
}

export async function saveCustomFont(file) {
  const buf = await file.arrayBuffer();
  await idb.put('settings', { key: 'customFont', value: { name: file.name, data: buf } });
  await registerCustomFont(file.name, buf);
}

export async function restoreCustomFont() {
  try {
    const rec = await idb.get('settings', 'customFont');
    if (rec?.value?.data) {
      await registerCustomFont(rec.value.name, rec.value.data);
      return true;
    }
  } catch (e) { /* ignore */ }
  return false;
}

export function currentFontId() {
  return localStorage.getItem('relik.fontId') || 'inter';
}

/* Применить сохранённый шрифт при старте */
export function applySavedFont() {
  const id = currentFontId();
  if (id === 'custom') {
    const stack = localStorage.getItem('relik.font');
    if (stack) document.documentElement.style.setProperty('--font', stack);
  } else {
    applyFont(id, false);
  }
}
