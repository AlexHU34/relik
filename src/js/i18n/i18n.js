/* Relik — i18n: перевод, применение к DOM, переключение языка */
import RU from './ru.js';
import EN from './en.js';

const DICTS = { ru: RU, en: EN };

function detect() {
  const saved = localStorage.getItem('relik.lang');
  if (saved && DICTS[saved]) return saved;
  const nav = (navigator.language || 'ru').toLowerCase();
  return nav.startsWith('ru') ? 'ru' : 'en';
}

export let lang = detect();

/* Получить строку по ключу; фолбэк — английский */
export function t(key) {
  return DICTS[lang]?.[key] ?? DICTS.en[key] ?? key;
}

/* Применить data-i18n / data-i18n-ph к DOM */
export function applyDom(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  root.querySelectorAll('[data-i18n-ph]').forEach((el) => {
    el.placeholder = t(el.dataset.i18nPh);
  });
}

/* Переключить язык и оповестить приложение */
export function setLang(l) {
  if (!DICTS[l] || l === lang) return;
  lang = l;
  localStorage.setItem('relik.lang', l);
  document.documentElement.lang = l;
  applyDom();
  document.dispatchEvent(new CustomEvent('relik:lang'));
}

export function initI18n() {
  document.documentElement.lang = lang;
  applyDom();
}
