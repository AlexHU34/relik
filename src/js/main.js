/* Relik — точка входа: тема, язык, экран входа.
   Код приложения (чат, сайдбар, модалки) грузится отдельным чанком
   только после входа или при наличии сохранённой сессии. */
import { APP } from './config.js';
import { initI18n, applyDom } from './i18n/i18n.js';
import { idb } from './db/idb.js';
import { USERS } from './data/mock.js';
import { S } from './ui/state.js';
import { initTelemetry, logEvent } from './backend/telemetry.js';
import { initNetBar, initServiceWorker, scheduleStorageUpkeep, bootDone, initPwaOpen, quick, withTimeout } from './boot/runtime.js';
import { initAuth, isRealBackend, bindAuthHooks } from './boot/auth.js';
import { showAuth } from './ui/screens.js';
import { applyPrefs } from './ui/prefs.js';
import { applyTheme, currentTheme } from './ui/themes.js';
import { applySavedFont, currentFontId, restoreCustomFont } from './ui/fonts.js';
import { initDevice } from './ui/device.js';
import { maybeShowIosHint } from './ui/iosHint.js';
import { restoreSession } from './backend/auth.js';
import { ensureSdk, HAS_BACKEND } from './backend/sdk.js';
import { loadApp, prefetchApp, wireAppPrefetch } from './boot/lazyApp.js';

bindAuthHooks({
  enterApp: async (welcomeKey) => {
    const app = await loadApp();
    await app.startApp(welcomeKey);
  },
});

async function boot() {
  initTelemetry();
  logEvent('boot', { ua: navigator.userAgent.slice(0, 120) });
  await initI18n();
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

  /* Пользователь коснулся поля входа — значит, скорее всего, сейчас войдёт:
     качаем чанк приложения параллельно с вводом, а не после нажатия кнопки. */
  wireAppPrefetch();

  /* Профиль из кэша: если входили раньше — сразу грузим приложение */
  try {
    const cached = await quick(idb.get('settings', 'me'), 1500);
    if (cached?.value) S.me = cached.value;
  } catch (e) { /* ignore */ }
  if (!isRealBackend) S.users = USERS;

  if (S.me) {
    /* Кэш профиля есть — сразу в приложение, но клиенту Supabase нужен SDK.
       Грузим его до старта приложения (первый экран уже не ждём: splash). */
    if (HAS_BACKEND) await ensureSdk();
    const app = await loadApp();
    await app.bootApp();
    return;
  }

  showAuth();
  bootDone();
  if (!HAS_BACKEND) {
    /* Демо открывается одним кликом — грузим приложение в фоне. */
    setTimeout(() => { prefetchApp().catch(() => {}); }, 400);
    return;
  }

  /* SDK — после первой отрисовки: 213 КБ больше не держат экран входа.
     Дальше это первое действие с бэкендом (проверка сохранённой сессии). */
  const sdk = await ensureSdk();
  if (!sdk) {
    logEvent('sdk_load_failed', { url: 'js/vendor/supabase.js' });
    console.warn('[relik] Supabase SDK не загрузился — остаёмся на экране входа');
    return;
  }

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
initPwaOpen();

/* Заголовок и версия */
document.title = APP.name;
console.info(`%cRelik v${APP.version}`, 'color:#5b6cf9;font-weight:bold', `· ${APP.phase}`);

boot().catch((err) => {
  console.error('Boot failed:', err);
  if (window.relikBoot) window.relikBoot.fail('Не удалось запустить Relik', err && err.message ? err.message : err);
});
