/* Relik — точка входа: тема, язык, экран входа.
   Код приложения (чат, сайдбар, модалки) грузится отдельным чанком
   только после входа или при наличии сохранённой сессии. */
import { APP } from './config.js';
import { initI18n, applyDom } from './i18n/i18n.js';
import { idb } from './db/idb.js';
import { USERS } from './data/mock.js';
import { S } from './ui/state.js';
import { initTelemetry, logEvent } from './backend/telemetry.js';
import { initNetBar, initServiceWorker, scheduleStorageUpkeep, bootDone } from './boot/runtime.js';
import { initAuth, isRealBackend, bindAuthHooks } from './boot/auth.js';
import { showAuth } from './ui/screens.js';
import { applyPrefs } from './ui/prefs.js';
import { applyTheme, currentTheme } from './ui/themes.js';
import { applySavedFont, currentFontId, restoreCustomFont } from './ui/fonts.js';
import { initDevice } from './ui/device.js';
import { maybeShowIosHint } from './ui/iosHint.js';
import { restoreSession } from './backend/auth.js';

const quick = (p, ms = 2500) => Promise.race([
  Promise.resolve(p).catch(() => null),
  new Promise((r) => setTimeout(() => r(null), ms)),
]);

/* Жёсткий таймаут с ошибкой: «нет ответа» нельзя путать с «нет сессии» */
const withTimeout = (p, ms) => Promise.race([
  Promise.resolve(p),
  new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)),
]);

/* Экран входа не импортирует приложение: подгружаем его по факту входа. */
async function loadApp() {
  const mod = await import('./boot/app.js');
  return mod;
}

bindAuthHooks({
  enterApp: async (welcomeKey) => {
    const app = await loadApp();
    await app.startApp(welcomeKey);
  },
});

async function boot() {
  initTelemetry();
  logEvent('boot', { ua: navigator.userAgent.slice(0, 120) });
  initI18n();
  applyDom();

  /* тема и шрифт — до первого рендера */
  applyPrefs();
  applyTheme(currentTheme(), false);
  applySavedFont();
  if (currentFontId() === 'custom') {
    try { await restoreCustomFont(); } catch (e) { /* ignore */ }
  }

  /* раскладка подстраивается автоматически: телефон / планшет / компьютер */
  initDevice();

  /* сеть и обновления */
  initNetBar();
  initServiceWorker();
  scheduleStorageUpkeep();
  maybeShowIosHint();

  initAuth();

  /* Профиль из кэша: если входили раньше — сразу грузим приложение */
  try {
    const cached = await quick(idb.get('settings', 'me'), 1500);
    if (cached?.value) S.me = cached.value;
  } catch (e) { /* ignore */ }
  if (!isRealBackend) S.users = USERS;

  if (S.me) {
    const app = await loadApp();
    await app.bootApp();
    return;
  }

  showAuth();
  bootDone();
  if (!isRealBackend) return;

  /* Токен мог остаться, а кэш профиля — нет (например, почистили IndexedDB) */
  try {
    const m = await withTimeout(restoreSession(), 12000);
    if (!m) return;
    S.me = m;
    await idb.put('settings', { key: 'me', value: m }).catch(() => {});
    const app = await loadApp();
    await app.bootApp();
  } catch (e) { /* остаёмся на экране входа — это нормально */ }
}

/* Открыть чат по клику на push-уведомление */
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (e) => {
    const url = e.data && e.data.type === 'relik:open-chat' ? e.data.url : '';
    if (!url) return;
    try {
      const u = new URL(url, location.href);
      if (u.hash) location.hash = u.hash;
    } catch (err) { /* ignore */ }
  });
}

/* Заголовок и версия */
document.title = APP.name;
console.info(`%cRelik v${APP.version}`, 'color:#5b6cf9;font-weight:bold', `· ${APP.phase}`);

boot().catch((err) => {
  console.error('Boot failed:', err);
  if (window.relikBoot) window.relikBoot.fail('Не удалось запустить Relik', err && err.message ? err.message : err);
});
