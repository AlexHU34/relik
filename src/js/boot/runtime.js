/* Relik — фоновая обвязка запуска: плашка сети, обновление service worker,
   обслуживание хранилища. Всё это не должно тормозить первую отрисовку. */
import { $ } from '../ui/utils.js';
import { icon } from '../ui/icons.js';
import { t } from '../i18n/i18n.js';
import { toast } from '../ui/toast.js';
import { sweepExpired } from '../backend/expiry.js';
import { ensurePersistentStorage, autoPruneMedia } from '../db/mediaCache.js';


/* ── Плашка состояния сети ─────────────────────────────────── */
export function initNetBar() {
  const bar = $('#netBar');
  const text = $('#netText');
  const ic = $('#netIc');
  if (!bar || !text || !ic) return;

  let offline = navigator.onLine === false;
  let hideTimer = 0;

  const paint = (state, message) => {
    clearTimeout(hideTimer);
    bar.hidden = false;
    bar.classList.remove('ok', 'bad');
    if (state) bar.classList.add(state);
    ic.innerHTML = icon(state === 'ok' ? 'checkCircle' : 'wifiOff', 15);
    text.textContent = message;
  };

  const showOffline = () => paint('bad', t('net.offline'));
  const showRestored = () => {
    paint('ok', t('net.restored'));
    hideTimer = setTimeout(() => { bar.hidden = true; }, 2600);
  };

  if (offline) showOffline();

  window.addEventListener('offline', () => {
    offline = true;
    showOffline();
  });
  window.addEventListener('online', () => {
    if (!offline) return;
    offline = false;
    showRestored();
    sweepExpired().catch(() => {});
  });
  document.addEventListener('relik:lang', () => {
    if (offline) showOffline();
  });
}

/* ── Обновление service worker: показываем «Обновить» ───────── */
export function initServiceWorker() {
  if (!('serviceWorker' in navigator) || !location.protocol.startsWith('http')) return;

  let hadController = !!navigator.serviceWorker.controller;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    /* первый controller — это первая установка, а не обновление */
    if (!hadController) { hadController = true; return; }
    toast(t('update.available'), {
      type: 'warn',
      duration: 0,
      action: { label: t('update.reload'), onClick: () => location.reload() },
    });
  });

  navigator.serviceWorker.register('sw.js').then((reg) => {
    const notifyWaiting = () => {
      if (!reg.waiting) return;
      toast(t('update.available'), {
        type: 'warn',
        duration: 0,
        action: {
          label: t('update.reload'),
          onClick: () => {
            reg.waiting?.postMessage({ type: 'SKIP_WAITING' });
            location.reload();
          },
        },
      });
    };
    if (reg.waiting) notifyWaiting();
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      if (!nw) return;
      nw.addEventListener('statechange', () => {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) notifyWaiting();
      });
    });
  }).catch(() => {});
}

/* ── Обслуживание хранилища в фоне (не тормозит запуск) ───── */
export function scheduleStorageUpkeep() {
  const run = () => {
    ensurePersistentStorage().catch(() => {});
    autoPruneMedia().then((res) => {
      if (res && res.removed) console.info(`Media cache: removed ${res.removed} file(s)`);
    }).catch(() => {});
  };
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(run, { timeout: 8000 });
  } else {
    setTimeout(run, 2500);
  }
}
