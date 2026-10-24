/* Relik — системные уведомления браузера (когда вкладка не активна) */
import { t } from '../i18n/i18n.js';

const KEY = 'relik.notify';

export function notificationsEnabled() {
  try {
    return localStorage.getItem(KEY) === 'on';
  } catch (e) {
    return false;
  }
}

export async function setNotifications(on) {
  if (!('Notification' in window)) throw new Error(t('settings.notifyUnsupported'));

  if (on && Notification.permission !== 'granted') {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') throw new Error(t('settings.notifyDenied'));
  }

  try {
    localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch (e) { /* приватный режим */ }
  return on;
}

export function notifyMessage(chat, text, onClick) {
  if (!notificationsEnabled()) return;
  if (document.visibilityState === 'visible') return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;

  try {
    const n = new Notification(chat?.title || t('app.name'), {
      body: text || '…',
      icon: 'assets/icons/icon-192.png',
      tag: chat?.id || 'relik',
      silent: false,
    });
    n.onclick = () => {
      window.focus();
      try { onClick?.(); } catch (e) { /* ignore */ }
      n.close();
    };
  } catch (e) { /* некоторые браузеры запрещают конструктор */ }
}
