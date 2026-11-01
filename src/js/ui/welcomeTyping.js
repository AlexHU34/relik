/* Relik — анимация «Welcome to Relik!»: побуквенное появление на экране входа
   и в пустом чате. Вынесено из boot/auth.js, чтобы модуль входа не разрастался. */

import { $ } from './utils.js';

let welcomeRun = 0;

export function animateWelcome() {
  const text = 'Welcome to Relik!';
  const run = ++welcomeRun;

  /* экран входа */
  const authEl = $('#authWelcome');
  if (authEl) {
    authEl.textContent = '';
    let i = 0;
    clearInterval(authEl._timer);
    authEl._timer = setInterval(() => {
      if (run !== welcomeRun) { clearInterval(authEl._timer); return; }
      if (i < text.length) { authEl.textContent += text[i]; i++; }
      else clearInterval(authEl._timer);
    }, 55);
  }

  /* пустой чат: побуквенно + мигающий курсор */
  const target = document.querySelector('.welcome-title i');
  if (target) {
    target.innerHTML = '';
    const caret = document.createElement('span');
    caret.className = 'caret';
    target.appendChild(caret);
    let j = 0;
    const step = () => {
      if (run !== welcomeRun || !caret.isConnected) return;
      if (j >= text.length) { setTimeout(() => caret.remove(), 1200); return; }
      const ch = document.createElement('span');
      ch.className = 'ch';
      ch.textContent = text[j] === ' ' ? '\u00A0' : text[j];
      target.insertBefore(ch, caret);
      requestAnimationFrame(() => ch.classList.add('on'));
      j++;
      setTimeout(step, 55);
    };
    setTimeout(step, 350);
  }
}
