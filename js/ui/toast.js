/* Relik — всплывающие уведомления */
import { icon } from './icons.js';

export function toast(msg) {
  const wrap = document.getElementById('toasts');
  if (!wrap) return;
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `${icon('info', 15)}<span></span>`;
  el.lastElementChild.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 260);
  }, 2400);
}
