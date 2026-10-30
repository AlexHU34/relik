/* Relik — подтверждение действий (удаление, очистка истории, выход из группы).
   Собственный диалог вместо window.confirm: тема, клавиатура, мобильный вид. */
import { t } from '../i18n/i18n.js';
import { icon } from './icons.js';
import { esc } from './utils.js';

export function confirmAction(opts = {}) {
  return new Promise((resolve) => {
    const {
      title = t('common.confirm'),
      text = '',
      ok = t('common.ok'),
      cancel = t('common.cancel'),
      danger = false,
      iconName = danger ? 'alert' : 'info',
    } = opts;

    const ov = document.createElement('div');
    ov.className = 'overlay confirm-ov';
    ov.innerHTML = `<div class="modal confirm-modal" role="alertdialog" aria-modal="true" aria-labelledby="confirmTitle">
      <div class="confirm-body">
        <span class="confirm-ic${danger ? ' danger' : ''}">${icon(iconName, 22)}</span>
        <h3 id="confirmTitle">${esc(title)}</h3>
        ${text ? `<p>${esc(text)}</p>` : ''}
      </div>
      <div class="m-foot">
        <button class="btn btn-ghost" type="button" data-no>${esc(cancel)}</button>
        <button class="btn${danger ? ' btn-danger' : ''}" type="button" data-yes>${esc(ok)}</button>
      </div>
    </div>`;
    document.body.appendChild(ov);
    const previousFocus = document.activeElement;

    const finish = (value) => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('keydown', onTab, true);
      ov.classList.add('out');
      setTimeout(() => {
        ov.remove();
        if (previousFocus?.isConnected) {
          try { previousFocus.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
        }
      }, 160);
      resolve(value);
    };
    const onTab = (e) => {
      if (e.key !== 'Tab') return;
      const list = [...ov.querySelectorAll('button:not([disabled])')].filter((b) => b.getClientRects().length > 0);
      if (!list.length) return;
      const first = list[0];
      const last = list[list.length - 1];
      if (!ov.contains(document.activeElement)) {
        e.preventDefault();
        first.focus();
        return;
      }
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onTab, true);
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish(false);
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        finish(true);
      }
    };

    ov.querySelector('[data-no]').addEventListener('click', () => finish(false));
    ov.querySelector('[data-yes]').addEventListener('click', () => finish(true));
    ov.addEventListener('click', (e) => { if (e.target === ov) finish(false); });
    document.addEventListener('keydown', onKey, true);
    setTimeout(() => ov.querySelector('[data-yes]')?.focus(), 40);
  });
}
