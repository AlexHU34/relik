/* Relik — утилиты: экранирование, формат времени/дат, сниппеты, аватары */
import { lang, t } from '../i18n/i18n.js';
import { user } from './state.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

export function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString(lang === 'ru' ? 'ru' : 'en', { hour: '2-digit', minute: '2-digit' });
}

export function fmtDay(ts) {
  const d = new Date(ts), n = new Date();
  const sameDay = d.toDateString() === n.toDateString();
  if (sameDay) return t('chat.today');
  const y = new Date(n); y.setDate(n.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return t('chat.yesterday');
  return new Intl.DateTimeFormat(lang === 'ru' ? 'ru' : 'en', { day: 'numeric', month: 'short' }).format(d);
}

export function fmtDur(s) {
  const m = Math.floor(s / 60), r = Math.round(s % 60);
  return `${m}:${String(r).padStart(2, '0')}`;
}

/* Короткий текст для превью и цитат */
export function snippet(m) {
  if (!m) return '';
  if (m.deleted) return t('msg.deleted');
  switch (m.type) {
    case 'image': return `${t('msg.photo')} 📷`;
    case 'file':  return `📄 ${m.file?.name || t('msg.file')}`;
    case 'voice': return `🎙 ${t('msg.voice')}${m.voice ? ' · ' + fmtDur(m.voice.dur) : ''}`;
    case 'poll':  return `📊 ${m.poll?.q || m.text || t('comp.poll')}`;
    case 'vote':  return '';
    default: return String(m.text || '').replace(/\s+/g, ' ').trim();
  }
}

/* Аватар с буквой или фото; opts: {sm, lg, online} */
export function avatarHtml(u, opts = {}) {
  if (!u) return '';
  const cls = ['avatar', opts.sm ? 'sm' : '', opts.lg ? 'lg' : ''].filter(Boolean).join(' ');
  const dot = opts.online ? '<i class="online-dot"></i>' : '';
  const inner = u.avatar
    ? `<img src="${esc(u.avatar)}" alt="">`
    : `<b>${esc((u.name || '?').slice(0, 1).toUpperCase())}</b>`;
  return `<span class="${cls}" data-h="${u.hue ?? 0}">${inner}${dot}</span>`;
}

/* Превью последнего сообщения для списка чатов */
export function preview(chat) {
  const l = chat.last;
  if (!l) return `<span style="color:var(--tx-3)">${t('chat.previewEmpty')}</span>`;
  const who = l.from === 'u_me' ? `<span class="who">${t('msg.you')}:</span> ` : '';
  return `${who}${esc(snippet(l))}`;
}
