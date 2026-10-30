/* Relik — подсказка для iPhone: push приходят только у PWA «на экране Домой». */

import { t } from '../i18n/i18n.js';
import { esc } from './utils.js';

const KEY = 'relik.iosHint';

export function maybeShowIosHint() {
  try {
    const ua = navigator.userAgent || '';
    const iOS = /iPad|iPhone|iPod/.test(ua)
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const standalone = window.matchMedia?.('(display-mode: standalone)').matches
      || window.navigator.standalone === true;
    if (!iOS || standalone) return;
    if (localStorage.getItem(KEY) === 'off') return;

    const bar = document.createElement('div');
    bar.className = 'ios-hint';
    bar.setAttribute('role', 'status');
    bar.innerHTML = `<span>${esc(t('ios.hint'))}</span>`
      + `<button class="btn btn-ghost" type="button">${esc(t('ios.ok'))}</button>`;
    document.body.appendChild(bar);
    bar.querySelector('button').addEventListener('click', () => {
      try { localStorage.setItem(KEY, 'off'); } catch (e) { /* приватный режим */ }
      bar.remove();
    });
  } catch (e) { /* ignore */ }
}
