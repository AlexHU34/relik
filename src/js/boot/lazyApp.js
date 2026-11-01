/* Relik — ленивый чанк приложения (~215 КБ) и его ранняя загрузка.
   Держим здесь, чтобы main.js оставался короткой точкой входа.

   Почему заранее: качать 215 КБ в момент нажатия «Войти» на 3G — это
   несколько секунд пустого экрана. Начинаем по фокусу в поле входа
   (пользователь уже собрался входить), в демо — просто в фоне. */

let chunk = null;

export function prefetchApp() {
  if (chunk) return chunk;
  chunk = import('./app.js');
  /* Помечаем rejection обработанным, но сбрасываем кэш — следующий вызов
     попробует снова (успешный import() кэшируется браузером навсегда). */
  chunk.catch(() => { chunk = null; });
  return chunk;
}

export function loadApp() {
  return prefetchApp();
}

/** Подписаться на первое касание полей входа. Вызывать после initAuth(). */
export function wireAppPrefetch() {
  const wake = () => { prefetchApp().catch(() => {}); };
  for (const id of ['authEmail', 'authPass']) {
    document.getElementById(id)?.addEventListener('focus', wake, { once: true });
  }
}
