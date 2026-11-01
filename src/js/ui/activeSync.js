/* Relik — «догнать сейчас» для открытого чата.
   chatView регистрирует здесь свою функцию тика, а boot/realtime вызывает
   её после переподключения realtime. Отдельный модуль, чтобы не тянуть
   chatView в те места, где нужен только толчок синхронизации. */

let tick = null;

export function registerActiveSync(fn) {
  tick = typeof fn === 'function' ? fn : null;
}

export function syncActiveNow() {
  try { tick?.(); } catch (e) { /* синк не должен ломать вызывающего */ }
}
