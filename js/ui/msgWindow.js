/* Relik — чистая логика окна ленты сообщений.
   Без DOM и без состояния приложения: так её можно покрыть тестами
   (scripts/tests/msgWindow.test.mjs) и переиспользовать в chatView. */

/* Сколько сообщений держим в DOM. Больше — лаги при перерисовке. */
export const PAGE_SIZE = 240;

/* Сколько строк тянем с сервера за один заход. */
export const SERVER_PAGE = 50;

/* Слияние серверной страницы с локальной лентой: сервер — источник правды,
   но локальные «отправляется / ошибка / удалено у себя» не теряются. */
export function mergeMessages(server, local) {
  const map = new Map((server || []).map((m) => [m.id, m]));
  for (const m of local || []) {
    const s = map.get(m.id);
    if (!s) map.set(m.id, m);
    else {
      if (m.status === 'read') s.status = 'read'; // локальная отметка прочтения не теряется
      if (m.localDeleted) { s.hidden = true; s.localDeleted = true; } // «удалено у себя»
      if (m.ttlStartedAt && !s.ttlStartedAt) s.ttlStartedAt = m.ttlStartedAt;
      if (m.expired) { s.hidden = true; s.expired = true; s.localDeleted = true; }
      /* незавершённая отправка важнее серверного «sent»: иначе часики
         превратятся в галочку у сообщения, которое ещё не ушло */
      if (m.status === 'sending' && s.status !== 'sending') s.status = 'sending';
      if (m.status === 'error') s.status = 'error';
    }
  }
  return [...map.values()].sort((a, b) => (a.ts || 0) - (b.ts || 0));
}

/* Видимое окно ленты: последние `limit` сообщений. */
export function windowOf(list, limit) {
  const arr = Array.isArray(list) ? list : [];
  const n = Math.max(1, Number(limit) || PAGE_SIZE);
  if (arr.length <= n) return { visible: arr, hiddenCount: 0 };
  return { visible: arr.slice(-n), hiddenCount: arr.length - n };
}

/* Время самого старого сообщения — курсор для загрузки предыдущей страницы. */
export function oldestTs(list) {
  let min = 0;
  for (const m of list || []) {
    const ts = Number(m && m.ts) || 0;
    if (ts && (!min || ts < min)) min = ts;
  }
  return min;
}

/* Размер следующего шага окна при «показать раньше». */
export function nextLimit(current, added = 0, page = PAGE_SIZE) {
  const base = Math.max(Number(current) || page, page);
  return base + Math.max(0, Number(added) || 0) || page;
}
