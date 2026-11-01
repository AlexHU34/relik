/* Relik — строка статуса сервера на экране входа: «проверяем… / сервер доступен /
   сервер недоступен» и кнопка «Повторить», если SDK не загрузился (сеть, VPN,
   блокировка). Вынесено из boot/auth.js, чтобы модуль входа не разрастался. */

import { t } from '../i18n/i18n.js';
import { $ } from './utils.js';
import { authHealth } from '../backend/auth.js';
import { sdkLoaded, sdkFailed, resetSdk, ensureSdk } from '../backend/sdk.js';

export function initAuthStatus() {
  const line = $('#authServer');
  if (!line) return;

  line.hidden = false;
  line.textContent = t('auth.checking');
  let tries = 0;
  let poll = 0;

  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'auth-retry';
  retry.textContent = t('auth.retry');
  retry.hidden = true;
  retry.addEventListener('click', () => {
    retry.hidden = true;
    tries = 0;
    line.classList.remove('bad');
    line.textContent = t('auth.checking');
    resetSdk();
    /* Сброса мало: нужно снова запустить загрузку SDK, иначе опрос будет
       вечно ждать файл, который никто не запросил. */
    ensureSdk().catch(() => {});
    poll = startPoll();
  });
  line.after(retry);

  const check = () => {
    authHealth().then((h) => {
      line.classList.toggle('bad', !h.ok);
      line.textContent = h.ok
        ? t('auth.serverOk').replace('{ms}', String(h.ms))
        : t('auth.serverDown');
      retry.hidden = h.ok;
    }).catch(() => {
      line.classList.add('bad');
      line.textContent = t('auth.serverDown');
      retry.hidden = false;
    });
  };

  /* SDK грузится лениво: ждём его появления, не запуская загрузку сами. */
  const startPoll = () => setInterval(() => {
    tries += 1;
    if (sdkLoaded()) {
      clearInterval(poll);
      poll = 0;
      check();
      return;
    }
    if (sdkFailed() || tries > 60) {
      clearInterval(poll);
      poll = 0;
      line.classList.add('bad');
      line.textContent = t('auth.serverDown');
      retry.hidden = false;
    }
  }, 500);

  poll = startPoll();
}
