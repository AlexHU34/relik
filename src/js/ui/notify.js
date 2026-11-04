/* Relik — системные уведомления браузера (когда вкладка не активна) */
import { t } from '../i18n/i18n.js';
import { isMuted } from './prefs.js';

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

export function notifyMessage(chat, text, onClick, opts = {}) {
  if (!notificationsEnabled()) return;
  const mention = !!opts.mention;
  /* Упоминание пробивает mute: иначе в «тихой» группе его не заметить. */
  if (isMuted(chat?.id) && !mention) return;
  if (document.visibilityState === 'visible') return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;

  try {
    const title = mention
      ? `${t('notify.mention')} · ${chat?.title || t('app.name')}`
      : (chat?.title || t('app.name'));
    const n = new Notification(title, {
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
