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

    const finish = (value) => {
      document.removeEventListener('keydown', onKey, true);
      ov.classList.add('out');
      setTimeout(() => ov.remove(), 160);
      resolve(value);
    };
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
