/* Relik — всплывающее контекстное меню (чаты, сообщения, участники).
   Одно меню на страницу, с клавиатурой, кликом мимо и авто-позиционированием. */
import { icon } from './icons.js';
import { esc } from './utils.js';

let menuEl = null;
let closeHandler = null;

export function closeMenu() {
  if (menuEl) {
    const el = menuEl;
    menuEl = null;
    el.classList.add('out');
    setTimeout(() => el.remove(), 120);
  }
  if (closeHandler) {
    document.removeEventListener('pointerdown', closeHandler, true);
    document.removeEventListener('keydown', closeHandler, true);
    document.removeEventListener('scroll', closeHandler, true);
    window.removeEventListener('resize', closeHandler);
    window.removeEventListener('blur', closeHandler);
    closeHandler = null;
  }
}

function onDocPointer(e) {
  if (menuEl && !menuEl.contains(e.target)) closeMenu();
}

function onDocKey(e) {
  if (e.key === 'Escape') {
    e.stopPropagation();
    closeMenu();
  }
}

/*
  openMenu([
    { label: 'Закрепить', icon: 'pin', onClick() {} },
    { sep: true },
    { label: 'Удалить', icon: 'trash', danger: true, onClick() {} },
  ], { x, y } | { anchor: HTMLElement, align: 'left'|'right' });
*/
export function openMenu(items, opts = {}) {
  closeMenu();
  const list = (items || []).filter(Boolean);
  if (!list.length) return;

  const el = document.createElement('div');
  el.className = 'ctx-menu';
  el.setAttribute('role', 'menu');
  el.innerHTML = list.map((it, i) => {
    if (it.sep) return '<div class="ctx-sep" role="separator"></div>';
    const cls = `ctx-item${it.danger ? ' danger' : ''}${it.disabled ? ' disabled' : ''}`;
    return `<button type="button" role="menuitem" class="${cls}" data-i="${i}"${it.disabled ? ' disabled' : ''}>
      <span class="ctx-ic">${icon(it.icon || 'info', 16)}</span>
      <span class="ctx-label">${esc(it.label || '')}</span>
      ${it.hint ? `<span class="ctx-hint">${esc(it.hint)}</span>` : ''}
    </button>`;
  }).join('');

  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-i]');
    if (!b || b.disabled) return;
    const item = list[Number(b.dataset.i)];
    closeMenu();
    if (item && !item.disabled) item.onClick?.(item);
  });

  document.body.appendChild(el);
  menuEl = el;

  /* позиционируем после вставки, чтобы знать размеры */
  const pad = 8;
  let left;
  let top;
  const rect = el.getBoundingClientRect();
  if (opts.anchor) {
    const a = opts.anchor.getBoundingClientRect();
    left = opts.align === 'right' ? a.right - rect.width : a.left;
    top = a.bottom + 6;
    if (top + rect.height > innerHeight - pad) top = Math.max(pad, a.top - rect.height - 6);
  } else {
    left = Number(opts.x || 0);
    top = Number(opts.y || 0);
    if (top + rect.height > innerHeight - pad) top = Math.max(pad, top - rect.height);
  }
  left = Math.min(Math.max(pad, left), innerWidth - rect.width - pad);
  top = Math.min(Math.max(pad, top), innerHeight - rect.height - pad);
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
  el.classList.add('in');

  closeHandler = (e) => {
    if (e.type === 'pointerdown') onDocPointer(e);
    else if (e.type === 'keydown') onDocKey(e);
    else closeMenu();
  };
  /* таймаут: клик, открывший меню, не должен его сразу закрыть */
  setTimeout(() => {
    if (!menuEl) return;
    document.addEventListener('pointerdown', closeHandler, true);
    document.addEventListener('keydown', closeHandler, true);
    document.addEventListener('scroll', closeHandler, true);
    window.addEventListener('resize', closeHandler);
    window.addEventListener('blur', closeHandler);
  }, 0);

  return el;
}

/* Долгое нажатие (телефон/планшет): 480 мс без движения. */
export function bindLongPress(el, handler, ms = 480) {
  let timer = null;
  let sx = 0;
  let sy = 0;
  let fired = false;

  const clear = () => {
    if (timer) { clearTimeout(timer); timer = null; }
  };

  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    if (e.target.closest('button')) return;
    sx = e.clientX;
    sy = e.clientY;
    fired = false;
    clear();
    timer = setTimeout(() => {
      timer = null;
      fired = true;
      if (navigator.vibrate) navigator.vibrate(12);
      handler(e);
    }, ms);
  }, { passive: true });

  el.addEventListener('pointermove', (e) => {
    if (!timer) return;
    if (Math.abs(e.clientX - sx) > 10 || Math.abs(e.clientY - sy) > 10) clear();
  }, { passive: true });

  ['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) => el.addEventListener(ev, clear, { passive: true }));

  el.addEventListener('click', (e) => {
    if (!fired) return;
    fired = false;
    e.preventDefault();
    e.stopPropagation();
  }, true);
}
