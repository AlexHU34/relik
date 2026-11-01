/* Relik — ленивая загрузка Supabase SDK.
   213 КБ (54 КБ gzip) — это 82% критического пути: раньше SDK стоял в <head>
   и тормозил первый экран на медленной сети. Теперь он грузится только когда
   реально нужен бэкенд: восстановление сессии, вход, первый запрос данных.
   В демо-режиме (нет ключей) SDK не скачивается вообще.

   Файл — UMD (window.supabase), поэтому подключаем его тегом <script>, а не
   import(): так работает SRI и не нужен бандл на 213 КБ. */

import { SUPABASE } from '../config.js';

/* Реальный бэкенд или демо — решается по ключам, а не по факту загрузки SDK:
   до загрузки клиента ещё нет, а режим уже должен быть известен. */
export const HAS_BACKEND = !!(SUPABASE.url && SUPABASE.anonKey);

const SRC = 'js/vendor/supabase.js';
const TIMEOUT_MS = 25000;

let promise = null;
let failed = false;

function existing() {
  try {
    return typeof window !== 'undefined' && window.supabase ? window.supabase : null;
  } catch (e) {
    return null;
  }
}

/* SRI приходит из сборки (meta в dist/index.html); в dev его нет. */
function integrityOf() {
  try {
    const m = document.querySelector('meta[name="relik-sdk-sri"]');
    return m ? m.getAttribute('content') || '' : '';
  } catch (e) {
    return '';
  }
}

function load() {
  return new Promise((resolve) => {
    if (typeof document === 'undefined') { resolve(null); return; }

    let timer = null;
    let settled = false;
    const finish = (lib) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (lib) { failed = false; } else { failed = true; promise = null; }
      resolve(lib);
    };

    let script;
    try {
      script = document.createElement('script');
      script.src = new URL(SRC, document.baseURI).href;
      script.async = true;
      const sri = integrityOf();
      if (sri) { script.integrity = sri; script.crossOrigin = 'anonymous'; }
      script.onload = () => finish(existing());
      script.onerror = () => finish(null);
    } catch (e) {
      finish(null);
      return;
    }

    /* Без таймаута зависший запрос держал бы вход вечно. */
    timer = setTimeout(() => finish(null), TIMEOUT_MS);

    try {
      document.head.appendChild(script);
    } catch (e) {
      finish(null);
    }
  });
}

/** Загружает SDK один раз. Возвращает window.supabase или null. */
export function ensureSdk() {
  if (!HAS_BACKEND) return Promise.resolve(null);
  const lib = existing();
  if (lib) return Promise.resolve(lib);
  if (!promise) promise = load();
  return promise;
}

/** Синхронная проверка: SDK уже загружен и доступен. */
export function sdkLoaded() {
  return !!existing();
}

/** Была ли последняя попытка неудачной (для понятной ошибки в UI). */
export function sdkFailed() {
  return failed;
}

/** Сбросить состояние — для тестов и кнопки «Повторить». */
export function resetSdk() {
  promise = null;
  failed = false;
}
