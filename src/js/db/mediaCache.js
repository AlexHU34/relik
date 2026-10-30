/* Relik — управление локальным медиа-кэшем.
   Расшифрованные фото/видео/файлы лежат в IndexedDB (`media`), чтобы чат
   открывался без сети. Здесь считаем занятое место, аккуратно вытесняем
   самое старое (LRU) и просим браузер не чистить хранилище.
   Сообщения, ключи и профиль эти функции не трогают. */

import { idb } from './idb.js';

/* Совпадает с лимитом storage.js, но с запасом по байтам */
export const MEDIA_MAX_ITEMS = 120;
export const MEDIA_MAX_BYTES = 64 * 1024 * 1024;
const AUTO_TRIGGER = 0.85;   // доля квоты, после которой убираемся
const AUTO_TARGET = 0.7;     // до какой доли лимитов чистим

/* Чистый расчёт того, что нужно выбросить (без IndexedDB — удобно тестировать) */
export function prunePlan(records = [], opts = {}) {
  const maxItems = Number.isFinite(opts.maxItems) ? opts.maxItems : MEDIA_MAX_ITEMS;
  const maxBytes = Number.isFinite(opts.maxBytes) ? opts.maxBytes : MEDIA_MAX_BYTES;
  const sorted = [...records].sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0));
  let bytes = 0;
  for (const rec of sorted) bytes += Number(rec?.blob?.size) || 0;
  let count = sorted.length;
  const drop = [];
  for (const rec of sorted) {
    if (count <= maxItems && bytes <= maxBytes) break;
    drop.push(rec);
    count -= 1;
    bytes -= Number(rec?.blob?.size) || 0;
  }
  return { drop, count, bytes: Math.max(0, bytes) };
}

/* ── Оценка хранилища (может быть недоступна в приватном режиме) ── */
export async function storageEstimate() {
  try {
    if (!navigator.storage?.estimate) return { usage: 0, quota: 0 };
    const e = await navigator.storage.estimate();
    return { usage: Number(e?.usage) || 0, quota: Number(e?.quota) || 0 };
  } catch (e) {
    return { usage: 0, quota: 0 };
  }
}

let persisted = null;

/* Просим браузер не вытеснять IndexedDB при нехватке места */
export async function ensurePersistentStorage() {
  try {
    if (!navigator.storage?.persist) { persisted = false; return false; }
    if (await navigator.storage.persisted?.()) { persisted = true; return true; }
    persisted = await navigator.storage.persist();
    return !!persisted;
  } catch (e) {
    persisted = false;
    return false;
  }
}

export async function persistedStorage() {
  if (persisted !== null) return persisted;
  try {
    persisted = !!(await navigator.storage?.persisted?.());
  } catch (e) {
    persisted = false;
  }
  return persisted;
}

/* ── Что сейчас лежит в кэше медиа ── */
export async function mediaStats() {
  let records = [];
  try {
    records = await idb.getAll('media');
  } catch (e) {
    records = [];
  }
  let bytes = 0;
  let oldest = 0;
  for (const rec of records) {
    const size = Number(rec?.blob?.size) || 0;
    bytes += size;
    const at = Number(rec?.at) || 0;
    if (at && (!oldest || at < oldest)) oldest = at;
  }
  return { count: records.length, bytes, oldest };
}

/* ── Вытеснение по LRU ── */
export async function pruneMediaCache(opts = {}) {
  let records = [];
  try {
    records = await idb.getAll('media');
  } catch (e) {
    return { removed: 0, freed: 0, left: 0 };
  }
  const plan = prunePlan(records, opts);
  let freed = 0;
  for (const rec of plan.drop) {
    freed += Number(rec?.blob?.size) || 0;
    try {
      await idb.del('media', rec.path);
    } catch (e) { /* запись могли уже удалить */ }
  }
  return { removed: plan.drop.length, freed, left: plan.count };
}

/* Явная очистка (кнопка в настройках). Текущие objectURL не отзываем:
   уже открытые в ленте фото остаются видны до перезагрузки. */
export async function clearMediaCache() {
  const before = await mediaStats();
  try {
    await idb.clear('media');
  } catch (e) { /* ignore */ }
  return before;
}

/* Фоновое обслуживание при запуске: если кэш разросся или диск почти
   заполнен — оставляем самое свежее. Возвращает отчёт или null. */
export async function autoPruneMedia() {
  let stats;
  try {
    stats = await mediaStats();
  } catch (e) {
    return null;
  }
  const est = await storageEstimate();
  const tooBig = stats.count > MEDIA_MAX_ITEMS || stats.bytes > MEDIA_MAX_BYTES;
  const lowDisk = est.quota > 0 && (est.usage / est.quota) > AUTO_TRIGGER;
  if (!tooBig && !lowDisk) return null;

  const quotaBudget = est.quota > 0 ? Math.floor(est.quota * 0.12) : MEDIA_MAX_BYTES;
  return pruneMediaCache({
    maxItems: Math.floor(MEDIA_MAX_ITEMS * AUTO_TARGET),
    maxBytes: Math.min(MEDIA_MAX_BYTES * AUTO_TARGET, Math.max(8 * 1024 * 1024, quotaBudget)),
  });
}
