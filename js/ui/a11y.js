/* Relik — доступность: подписи и состояния для экранных дикторов.
   Иконочные кнопки не имеют текста, поэтому без aria-label диктор читает
   просто «кнопка». Функция идемпотентная: её можно звать после любой
   перерисовки и после смены языка — она не плодит дубли и обновляет
   подписи, которые сами были скопированы из title. */
import { $, $$ } from './utils.js';
import { t } from '../i18n/i18n.js';

/* Кнопки без текста и без title: id → ключ перевода */
const LABELS = {
  passToggle: 'auth.showPassword',
  callSwitch: 'call.switchCamera',
  callRec: 'call.record',
  callCamera: 'call.camera',
  callScreen: 'call.share',
  callMute: 'call.mute',
  callEnd: 'call.hangup',
  callAccept: 'call.accept',
  callDecline: 'call.decline',
  circleClose: 'common.close',
  rbX: 'common.close',
  fpQrBtn: 'fp.qr',
  fpCode: 'fp.copy',
};

/* Пары «переключатель → панель»: aria-expanded должен отражать реальность */
const EXPANDERS = [
  ['emojiBtn', 'emojiPop'],
  ['attachBtn', 'attachMenu'],
  ['chatSearchBtn', 'chatSearch'],
  ['fpQrBtn', 'fpQr'],
];

export function applyA11y(root = document) {
  /* 1. title → aria-label. title всплывает подсказкой, но диктор его
        читает не всегда, поэтому дублируем. */
  $$('[title]', root).forEach((el) => {
    const title = (el.getAttribute('title') || '').trim();
    if (!title) return;
    const fromTitle = el.dataset.a11yFromTitle === '1';
    if (!el.getAttribute('aria-label') || fromTitle) {
      el.setAttribute('aria-label', title);
      el.dataset.a11yFromTitle = '1';
    }
  });

  /* 2. Все кнопки закрытия окон — «Закрыть». */
  $$('[data-close]', root).forEach((el) => {
    if (!el.getAttribute('aria-label')) el.setAttribute('aria-label', t('common.close'));
  });

  /* 3. Известные иконочные кнопки. passToggle подписывается отдельно:
        у него две подписи (показать/скрыть пароль). */
  for (const [id, key] of Object.entries(LABELS)) {
    const el = document.getElementById(id);
    if (!el || id === 'passToggle') continue;
    el.setAttribute('aria-label', t(key));
  }

  /* 4. Состояние раскрытия панелей. */
  for (const [btnId, boxId] of EXPANDERS) {
    const btn = document.getElementById(btnId);
    const box = document.getElementById(boxId);
    if (btn && box) btn.setAttribute('aria-expanded', String(!box.hidden));
  }
}

/* Точечные помощники для мест, где состояние меняется по клику. */
export function syncExpanded() {
  for (const [btnId, boxId] of EXPANDERS) {
    const btn = document.getElementById(btnId);
    const box = document.getElementById(boxId);
    if (btn && box) btn.setAttribute('aria-expanded', String(!box.hidden));
  }
}

export function setExpanded(btnId, open) {
  const btn = document.getElementById(btnId);
  if (btn) btn.setAttribute('aria-expanded', String(Boolean(open)));
}

export function setLabel(id, key) {
  const el = document.getElementById(id);
  if (el) el.setAttribute('aria-label', t(key));
}
