/* Relik — шапка активного чата: кто, статус, кнопки звонков.
   Вынесено из chatView.js (он на жёстком лимите строк). Здесь же метка
   «· из кэша» из ../netBadge.js: она живёт в строке статуса, как «connecting…». */
import { S, chatById, chatTitle } from '../state.js';
import { $, esc, avatarHtml } from '../utils.js';
import { t } from '../../i18n/i18n.js';
import { decorateStatus } from '../netBadge.js';

export function renderHeader() {
  const chat = chatById(S.active);
  const isDm = chat.kind === 'dm';
  const callBtn = $('#callBtn');
  const videoBtn = $('#videoCallBtn');
  if (callBtn) callBtn.hidden = !isDm;
  if (videoBtn) videoBtn.hidden = !isDm;
  const u = isDm
    ? (S.users.find((x) => x.id === chat.userId) || { name: chat.title || '…', hue: chat.hue ?? 0, seen: 'offline' })
    : null;
  $('#chatWhoAvatar').innerHTML = avatarHtml(u || { name: chat.title, hue: chat.hue ?? 5 }, { online: u?.seen === 'online' });
  $('#chatWhoName').innerHTML = esc(chatTitle(chat));
  const st = $('#chatWhoStatus');
  st.classList.remove('online');
  if (isDm) {
    const uname = u.username ? '@' + u.username : '';
    if (u.seen === 'online') {
      st.textContent = uname ? `${uname} · ${t('chat.online')}` : t('chat.online');
      st.classList.add('online');
    } else {
      st.textContent = uname || t('chat.' + u.seen);
    }
  } else {
    st.textContent = t('chat.members').replace('{n}', String((chat.members?.length || 0) + 1));
  }
  const statusText = decorateStatus(st);
  /* Кнопка шапки — единственный элемент без текстовой подписи для диктора */
  const whoBtn = $('#chatWho');
  if (whoBtn) whoBtn.setAttribute('aria-label', `${chatTitle(chat)}, ${statusText}`);
}
