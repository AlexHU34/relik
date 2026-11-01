/* Relik — i18n: словари, перевод DOM, переключение языка.
   Русский — интерфейс по умолчанию, поэтому он в основном бандле.
   Английский словарь (33 КБ исходников) грузится отдельным чанком только
   тем, у кого язык en: на первом экране незачем тянуть оба. */

import RU from './ru.js';

const DICTS = { ru: RU };
let EN = null;

function detectLang() {
  let saved = null;
  try { saved = localStorage.getItem('relik.lang'); } catch (e) { /* приватный режим */ }
  if (saved === 'ru' || saved === 'en') return saved;
  const nav = (navigator.language || 'ru').toLowerCase();
  return nav.startsWith('ru') ? 'ru' : 'en';
}

export let lang = detectLang();

async function ensureDict(l) {
  if (l !== 'en' || DICTS.en) return;
  try {
    const mod = await import('./en.js');
    EN = mod.default;
    DICTS.en = EN;
  } catch (e) {
    console.warn('i18n: en.js не загрузился, остаёмся на русском');
  }
}

/* Перевод по ключу. Пока en не загружен — показываем русский, а не ключ. */
export function t(key) {
  return DICTS[lang]?.[key] ?? RU[key] ?? key;
}

/* Подставляем data-i18n / data-i18n-ph в DOM */
export function applyDom(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  root.querySelectorAll('[data-i18n-ph]').forEach((el) => {
    el.placeholder = t(el.dataset.i18nPh);
  });
}

/* Переключение языка: словарь догружается, если его ещё нет. */
export async function setLang(l) {
  if ((l !== 'ru' && l !== 'en') || l === lang) return;
  lang = l;
  try { localStorage.setItem('relik.lang', l); } catch (e) { /* ignore */ }
  document.documentElement.lang = l;
  await ensureDict(l);
  applyDom();
  document.dispatchEvent(new CustomEvent('relik:lang'));
}

export async function initI18n() {
  await ensureDict(lang);
  document.documentElement.lang = lang;
  applyDom();
}
