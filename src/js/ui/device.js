/* Relik — авто-подстройка под устройство (телефон / планшет / компьютер)
   Ручного выбора нет: раскладка определяется по экрану и пересчитывается
   при изменении размера окна / повороте экрана. */

export function suggestDevice() {
  const w = window.innerWidth || document.documentElement.clientWidth || 0;
  if (w < 640) return 'phone';
  if (w < 1100) return 'tablet';
  return 'desktop';
}

/* Текущий режим раскладки (используется роутером и чатом) */
export function currentDevice() {
  return suggestDevice();
}

export function applyDevice() {
  const root = document.documentElement;
  const d = suggestDevice();
  if (root.dataset.device !== d) root.dataset.device = d;
  return d;
}

let bound = false;

export function initDevice() {
  /* старый ручной выбор больше не действует — чистим ключ */
  try { localStorage.removeItem('relik.device'); } catch (e) { /* ignore */ }

  applyDevice();

  if (bound) return suggestDevice();
  bound = true;

  window.addEventListener('resize', applyDevice);
  window.addEventListener('orientationchange', applyDevice);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', applyDevice);

  return suggestDevice();
}
