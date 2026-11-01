/* Relik — полоса очереди исходящих над полем ввода.
   Отдельный модуль: composer.js упёрся в лимит строк, а логика тут своя —
   «ждут сети / не ушло» на активный чат и кнопка «Отправить сейчас».

   Модуль сам находит свои элементы по id и подписывается один раз, поэтому
   композеру достаточно вызвать paintQueueBar() после отправки. */
import { S } from '../state.js';
import { $ } from '../utils.js';
import { t } from '../../i18n/i18n.js';
import { icon } from '../icons.js';
import { toast } from '../toast.js';
import { retryOutbox } from './retry.js';

let wired = false;

/* Без сети медиа не отправить: объект грузится в Storage до отправки сообщения.
   Говорим это прямо, иначе человек видит «не удалось отправить» и не понимает, что делать. */
export function offlineMediaBlocked() {
  if (navigator.onLine !== false) return false;
  toast(t('comp.mediaOffline'), { type: 'error' });
  return true;
}

function ensureWired() {
  if (wired) return;
  wired = true;
  const ic = $('#qbIc');
  if (ic) ic.innerHTML = icon('clock', 15);
  $('#qbSend')?.addEventListener('click', () => { retryOutbox(); });
  window.addEventListener('online', paintQueueBar);
  window.addEventListener('offline', paintQueueBar);
  /* retry.js и композер сообщают, что состояние очереди изменилось */
  document.addEventListener('relik:outbox', paintQueueBar);
}

function countPending() {
  const list = S.messages[S.active] || [];
  let waiting = 0;
  let failed = 0;
  for (const m of list) {
    if (m.sender !== 'u_me' || m.hidden) continue;
    if (m.status === 'queued') waiting += 1;
    else if (m.status === 'error') failed += 1;
  }
  return { waiting, failed };
}

export function paintQueueBar() {
  ensureWired();
  const bar = $('#queueBar');
  if (!bar) return;
  const { waiting, failed } = countPending();
  if (!waiting && !failed) { bar.hidden = true; return; }
  const parts = [];
  if (waiting) parts.push(t('comp.queueWaiting').replace('{n}', String(waiting)));
  if (failed) parts.push(t('comp.queueFailed').replace('{n}', String(failed)));
  const text = $('#qbText');
  if (text) text.textContent = parts.join(' · ');
  /* без сети кнопка бессмысленна — не дразним */
  const send = $('#qbSend');
  if (send) send.hidden = navigator.onLine === false;
  bar.hidden = false;
}
