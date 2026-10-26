/* Relik — утилиты: экранирование, формат времени/дат, сниппеты, аватары */
import { lang, t } from '../i18n/i18n.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

export function fmtTime(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(lang === 'ru' ? 'ru' : 'en', { hour: '2-digit', minute: '2-digit' });
}

export function fmtDay(ts) {
  const d = new Date(ts), n = new Date();
  if (Number.isNaN(d.getTime())) return '';
  const sameDay = d.toDateString() === n.toDateString();
  if (sameDay) return t('chat.today');
  const y = new Date(n); y.setDate(n.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return t('chat.yesterday');
  const sameYear = d.getFullYear() === n.getFullYear();
  return new Intl.DateTimeFormat(lang === 'ru' ? 'ru' : 'en', sameYear
    ? { day: 'numeric', month: 'short' }
    : { day: 'numeric', month: 'short', year: 'numeric' }).format(d);
}

export function fmtSize(b) {
  const n = Number(b) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(1) + ' GB';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + ' MB';
  if (n >= 1e3) return Math.round(n / 1e3) + ' KB';
  return n + ' B';
}

export function fmtDur(s) {
  const total = Math.max(0, Math.round(Number(s) || 0));
  const m = Math.floor(total / 60), r = total % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

/* Короткий текст для превью и цитат */
export function snippet(m) {
  if (!m) return '';
  if (m.deleted) return t('msg.deleted');
  if (m.decryptFailed) return '🔒 ' + t('msg.decryptFailed');
  switch (m.type) {
    case 'image': return `${t('msg.photo')} 📷`;
    case 'video': return `${t('msg.video')} 🎥`;
    case 'videoNote': return `${t('msg.videoNote')} ⭕`;
    case 'album': return `${t('msg.album')} 🖼`;
    case 'file':  return `📄 ${m.file?.name || t('msg.file')}`;
    case 'voice': return `🎙 ${t('msg.voice')}${m.voice ? ' · ' + fmtDur(m.voice.dur) : ''}`;
    case 'poll':  return `📊 ${m.poll?.q || m.text || t('comp.poll')}`;
    case 'vote':  return '';
    default: return String(m.text || '').replace(/\s+/g, ' ').trim();
  }
}

/* Безопасный источник для <img>: https, data:image, blob или локальный путь.
   Отсекает javascript:, http: (mixed content) и protocol-relative //evil. */
export function safeImgSrc(src) {
  const s = String(src || '').trim();
  if (!s) return '';
  if (/^\/\//.test(s)) return '';
  if (/^(https:\/\/|data:image\/|blob:)/i.test(s)) return s;
  if (/^(\.\/|\/|assets\/)/i.test(s)) return s;
  return '';
}

/* Аватар с буквой или фото; opts: {sm, lg, online} */
export function avatarHtml(u, opts = {}) {
  if (!u) return '';
  const cls = ['avatar', opts.sm ? 'sm' : '', opts.lg ? 'lg' : ''].filter(Boolean).join(' ');
  const dot = opts.online ? '<i class="online-dot"></i>' : '';
  const src = safeImgSrc(u.avatar);
  const inner = src
    ? `<img src="${esc(src)}" alt="">`
    : `<b>${esc((u.name || '?').slice(0, 1).toUpperCase())}</b>`;
  const hue = Number(u.hue);
  return `<span class="${cls}" data-h="${Number.isFinite(hue) ? hue : 0}">${inner}${dot}</span>`;
}


/* Превью последнего сообщения для списка чатов */
export function preview(chat) {
  const l = chat.last;
  if (!l) return `<span style="color:var(--tx-3)">${t('chat.previewEmpty')}</span>`;
  const who = l.from === 'u_me' ? `<span class="who">${t('msg.you')}:</span> ` : '';
  return `${who}${esc(snippet(l))}`;
}
