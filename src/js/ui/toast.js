/* Relik — всплывающие уведомления: типы, действия, очередь */
import { icon } from './icons.js';

const ICONS = { info: 'info', success: 'check', error: 'alert', warn: 'alert' };

export function toast(msg, opts = {}) {
  const wrap = document.getElementById('toasts');
  if (!wrap) return null;
  const type = ICONS[opts.type] ? opts.type : 'info';
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.innerHTML = `<span class="toast-ic">${icon(ICONS[type], 15)}</span><span class="toast-text"></span>`;
  el.querySelector('.toast-text').textContent = String(msg ?? '');

  const close = () => {
    if (!el.isConnected || el.classList.contains('out')) return;
    el.classList.add('out');
    setTimeout(() => el.remove(), 260);
  };

  if (opts.action && opts.action.label) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'toast-act';
    b.textContent = opts.action.label;
    b.addEventListener('click', () => {
      try { opts.action.onClick?.(); } finally { close(); }
    });
    el.appendChild(b);
  }

  wrap.appendChild(el);
  /* не копим бесконечную стопку */
  while (wrap.children.length > 4) wrap.firstElementChild.remove();

  const duration = Number(opts.duration ?? (opts.action ? 5200 : 2600));
  if (duration > 0) setTimeout(close, duration);
  return { el, close };
}
