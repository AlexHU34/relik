/* Relik — применение тем оформления (10 вариантов + светлая).
   Данные и CSS-переменные — в themeDefs.js (чистый модуль, покрыт тестами). */
import { applyAccent } from './prefs.js';
import { THEMES, ALL_VARS } from './themeDefs.js';

export { THEMES };

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
