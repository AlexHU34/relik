/* Relik — разметка сообщения: пузырь, медиа, реакции, опросы, галочки.
   Чистые функции, которые возвращают HTML-строку. Состояние экрана
   (поиск, выбор, открытая панель) приходит через bindRenderView. */
import { S, user } from '../state.js';
import { esc, avatarHtml, fmtSize, fmtDur, fmtTime } from '../utils.js';
import { icon } from '../icons.js';
import { t } from '../../i18n/i18n.js';
import { formatText, isEmojiOnly, safeMediaSrc } from '../richText.js';
import { EMOJI_QUICK } from '../../config.js';
import { toast } from '../toast.js';

let view = () => ({ searchIndex: 0, selectMode: false, selectedMsgs: new Set(), toolsOpen: null });
export function bindRenderView(fn) { view = fn; }

let hooks = { getEls: () => ({}), votePoll: () => {}, byId: () => null, escapeId: (id) => String(id) };
export function bindRenderHooks(next = {}) { hooks = { ...hooks, ...next }; }
export function msgHtml(m, first, hitIndex = -1) {
  const v = view();
  const mine = m.sender === 'u_me';
  const u = mine ? S.me : user(m.sender);
  const searchCls = hitIndex >= 0 ? ` search-hit${hitIndex === v.searchIndex ? ' search-current' : ''}` : '';
  const selectCls = v.selectMode ? ` selectable${v.selectedMsgs.has(m.id) ? ' selected' : ''}` : '';
  const hasMedia = ['image', 'video', 'file', 'voice', 'album', 'videoNote'].includes(m.type);
  const cls = `msg${first ? ' first' : ' cont'}${mine ? ' mine' : ''}${hasMedia ? ' has-media' : ''}${v.toolsOpen === m.id ? ' tools-open' : ''}${S.reactOpen === m.id ? ' react-open' : ''}${searchCls}${selectCls}`;
  const av = mine ? '' : avatarHtml(u);
  const body = bubbleHtml(m, mine);
  const pick = S.reactOpen === m.id ? rxPickHtml() : '';
  return `<div class="${cls}" data-mid="${esc(m.id)}" data-hit-index="${hitIndex}">${av}
    <div class="bubble">${body}${pick}</div>
  </div>`;
}

function mediaErrorHtml(round = false) {
  return `<button type="button" class="msg-broken as-btn${round ? ' round' : ''}" data-media-retry>
    ${icon('alert', 16)} <span>${t('media.retry')}</span>
  </button>`;
}

function mediaLoadHtml(round = false, kind = 'video') {
  return `<button type="button" class="msg-loading as-btn${round ? ' round' : ''}" data-media-retry>
    ${icon(kind === 'video' ? 'play' : 'dl', 16)} <span>${t('media.load')}</span>
  </button>`;
}

export function bubbleHtml(m, mine) {
  if (m.deleted) return `<div class="msg-deleted">${t('msg.deleted')}</div>`;
  if (m.decryptFailed) {
    return `<div class="msg-broken">${icon('lock', 16)} ${t('msg.decryptFailed')}</div>`;
  }
  let out = '';
  if (m.forwarded) out += `<div class="fwd-label">${icon('forward', 12)} ${t('msg.forwarded')}</div>`;
  if (m.replyTo) out += `<button class="reply-quote" data-jump="${esc(m.replyTo.id)}">
      <span class="rq-name">${esc(m.replyTo.name)}</span>
      <span class="rq-text">${esc(m.replyTo.snippet)}</span>
    </button>`;
  if (m.type === 'poll') out += pollHtml(m);
  if (m.type === 'image') {
    const src = safeMediaSrc(m.file?.src, 'image');
    const thumb = safeMediaSrc(m.file?.thumb, 'image');
    out += src
      ? `<button class="msg-img" type="button" aria-label="${esc(m.file?.name || t('msg.photo'))}"><img src="${esc(src)}" loading="lazy" decoding="async" alt="${esc(m.file?.name || t('msg.photo'))}"></button>`
      : (thumb
        ? `<button class="msg-img" type="button" aria-label="${esc(m.file?.name || t('msg.photo'))}"><img class="thumb" src="${esc(thumb)}" loading="lazy" decoding="async" alt=""></button>`
        : (m.media
          ? (m.mediaError ? mediaErrorHtml() : `<div class="msg-loading">${icon('image', 18)} ${t('media.loading')}</div>`)
          : `<div class="msg-broken">${icon('image', 18)} ${t('media.broken')}</div>`));
  }
  if (m.type === 'video') {
    const src = safeMediaSrc(m.file?.src, 'video');
    const thumb = safeMediaSrc(m.file?.thumb, 'image');
    out += src
      ? `<video class="msg-video" src="${esc(src)}"${thumb ? ` poster="${esc(thumb)}"` : ''} controls playsinline preload="metadata"></video>`
      : (thumb
        ? `<div class="msg-video pending"><img src="${esc(thumb)}" loading="lazy" decoding="async" alt=""><span>${icon('play', 22)}</span></div>`
        : (m.media
          ? (m.mediaError ? mediaErrorHtml() : mediaLoadHtml(false, 'video'))
          : `<div class="msg-broken">${icon('video', 18)} ${t('media.broken')}</div>`));
  }
  if (m.type === 'videoNote') {
    const src = safeMediaSrc(m.file?.src, 'video');
    const thumb = safeMediaSrc(m.file?.thumb, 'image');
    out += src
      ? `<button class="video-note" type="button"><video src="${esc(src)}"${thumb ? ` poster="${esc(thumb)}"` : ''} playsinline loop preload="metadata"></video>
          <span class="vn-play">${icon('play', 20)}</span></button>`
      : (thumb
        ? `<button class="video-note" type="button"><img src="${esc(thumb)}" loading="lazy" decoding="async" alt=""><span class="vn-play">${icon('play', 20)}</span></button>`
        : (m.media
          ? (m.mediaError ? mediaErrorHtml(true) : mediaLoadHtml(true, 'video'))
          : `<div class="msg-broken">${icon('video', 18)} ${t('media.broken')}</div>`));
  }
  if (m.type === 'album') {
    const items = Array.isArray(m.album) ? m.album : [];
    if (!items.length) {
      out += `<div class="msg-broken">${icon('image', 18)} ${t('media.broken')}</div>`;
    } else {
      out += `<div class="album${items.length === 1 ? ' one' : ''}">${items.map((it, i) => {
        const src = safeMediaSrc(it?.src, 'image');
        const thumb = safeMediaSrc(it?.thumb, 'image');
        const img = src || thumb;
        return img
          ? `<button type="button" class="album-item" data-album-idx="${i}"><img src="${esc(img)}" loading="lazy" decoding="async" alt="">${!src ? '<span class="album-load">•</span>' : ''}</button>`
          : `<span class="album-item pending${it?.error ? ' failed' : ''}">${icon('image', 18)}</span>`;
      }).join('')}</div>`;
    }
  }
  if (m.type === 'file') {
    const ready = !!m.file?.src;
    const failed = !!m.media && !ready && m.mediaError;
    out += `<div class="file-row${ready ? '' : ' no-src'}${failed ? ' retry' : ''}"${failed ? ' data-media-retry role="button"' : ''}>
      <span class="file-ic">${icon('file', 20)}</span>
      <span class="file-info"><span class="file-name">${esc(m.file?.name || t('msg.file'))}</span>
      <span class="file-size">${m.media && !ready ? t(failed ? 'media.retry' : 'media.loading') : fmtSize(m.file?.size)}</span></span>
      ${ready ? `<span class="file-dl">${icon('dl', 17)}</span>` : (failed ? `<span class="file-dl">${icon('refresh', 16)}</span>` : '')}</div>`;
  }
  if (m.type === 'voice') {
    if (!m.voice?.src && m.media) {
      out += m.mediaError
        ? mediaErrorHtml()
        : `<div class="msg-loading">${icon('mic', 16)} ${t('media.loading')}</div>`;
    } else {
      out += `<div class="voice">
        <button class="v-play">${icon('play', 17)}</button>
        <span class="v-bars">${(m.voice?.bars || []).map((h) => `<i style="height:${Math.round(h * 100)}%"></i>`).join('')}</span>
        <span class="v-dur">${fmtDur(m.voice?.dur || 0)}</span>
        <button class="v-speed" data-speed="${m.voice?.rate || 1}" title="${t('msg.voiceSpeed')}">${m.voice?.rate || 1}×</button>
      </div>`;
    }
  }
  if (m.text && ['text', 'image', 'file', 'video'].includes(m.type)) {
    const emoji = m.type === 'text' && isEmojiOnly(m.text);
    out += `<div class="msg-text${emoji ? ' emoji-only' : ''}">${formatText(m.text)}</div>`;
  }
  out += reactionsHtml(m);
  out += metaHtml(m, mine);
  return out;
}

export function reactionsHtml(m) {
  if (!m.reactions?.length) return '';
  return `<div class="rx-row">${m.reactions.map((r) =>
    `<button class="rx${r.by.includes('u_me') ? ' mine' : ''}" data-rx="${esc(r.e)}">${esc(r.e)}${r.by.length > 1 ? `<b>${r.by.length}</b>` : ''}</button>`).join('')}</div>`;
}

export function pollHtml(m) {
  const opts = Array.isArray(m.poll?.o) ? m.poll.o : [];
  const { counts, voters, mine, closed, votersByOption } = tallyPoll(m);
  const rows = opts.map((label, i) => {
    const pct = voters ? Math.round((counts[i] / voters) * 100) : 0;
    const on = mine.includes(i);
    const names = m.poll?.anon
      ? ''
      : (votersByOption[i] || [])
        .map((uid) => user(uid).name)
        .slice(0, 3)
        .join(', ') + ((votersByOption[i] || []).length > 3 ? ' +' + ((votersByOption[i] || []).length - 3) : '');
    return `<button type="button" class="poll-opt${on ? ' on' : ''}${closed ? ' closed' : ''}" data-poll-opt="${i}"${closed ? ' disabled' : ''}>
      <span class="poll-fill" style="width:${pct}%"></span>
      <span class="poll-mark">${on ? icon('check', 12) : ''}</span>
      <span class="poll-text">
        <span class="poll-label">${esc(label)}</span>
        ${names ? `<span class="poll-who">${esc(names)}</span>` : ''}
      </span>
      <span class="poll-count">${counts[i]}</span>
    </button>`;
  }).join('');

  const hint = closed
    ? t('poll.closed')
    : (mine.length ? t('poll.yourVote') : (m.poll?.multi ? t('poll.hintMulti') : t('poll.hint')));
  const canClose = !closed && m.sender === 'u_me';

  return `<div class="poll${closed ? ' poll-ended' : ''}">
    <div class="poll-head">${icon('poll', 16)}<span>${esc(m.poll?.q || m.text || '')}</span></div>
    <div class="poll-opts">${rows}</div>
    <div class="poll-meta"><span>${t('poll.votes')}: ${voters}</span><span>${hint}</span></div>
    ${canClose ? `<button type="button" class="poll-close" data-poll-close="${esc(m.id)}">${t('poll.close')}</button>` : ''}
  </div>`;
}

/* Реакции: последнее событие пользователя по каждому эмодзи */
export function tallyReactions(raw) {
  const latest = new Map();

  for (const x of raw) {
    if (x.type !== 'rx' || !x.reaction) continue;
    const r = x.reaction;
    const key = `${x.sender}|${r.m}|${r.e}`;
    const prev = latest.get(key);
    if (!prev || (x.ts || 0) >= (prev.ts || 0)) latest.set(key, x);
  }

  const touched = new Set();
  const byMessage = new Map();

  for (const x of latest.values()) {
    const id = x.reaction.m;
    touched.add(id);
    if (!x.reaction.on) continue;
    if (!byMessage.has(id)) byMessage.set(id, new Map());
    const emojiMap = byMessage.get(id);
    if (!emojiMap.has(x.reaction.e)) emojiMap.set(x.reaction.e, []);
    emojiMap.get(x.reaction.e).push(x.sender);
  }

  const out = new Map();
  for (const id of touched) {
    const emojiMap = byMessage.get(id);
    out.set(id, emojiMap
      ? [...emojiMap.entries()].map(([e, by]) => ({ e, by }))
      : []);
  }
  return out;
}

/* Обновляем только реакции сообщения */
export function refreshMessageReactions(messageId) {
  if (S.active == null) return;
  const m = hooks.byId(messageId);
  if (!m) return;

  const map = tallyReactions(S.messages[S.active] || []);
  if (map.has(m.id)) m.reactions = map.get(m.id);

  const id = hooks.escapeId(messageId);
  const bubble = hooks.getEls().msgs.querySelector(`[data-mid="${id}"] .bubble`);
  if (!bubble) return;

  const html = reactionsHtml(m);
  const row = bubble.querySelector('.rx-row');
  if (html) {
    if (row) row.outerHTML = html;
    else {
      const meta = bubble.querySelector('.msg-meta');
      if (meta) meta.insertAdjacentHTML('beforebegin', html);
      else bubble.insertAdjacentHTML('beforeend', html);
    }
  } else if (row) {
    row.remove();
  }
}

/* Обновляем только карточку опроса — без перерисовки всей ленты */
export function refreshPollCard(pollId) {
  if (S.active == null) return;
  const m = hooks.byId(pollId);
  if (!m || m.type !== 'poll') return;

  const id = hooks.escapeId(pollId);
  const el = hooks.getEls().msgs.querySelector(`[data-mid="${id}"] .poll`);
  if (!el) return;

  const box = document.createElement('div');
  box.innerHTML = pollHtml(m);
  const next = box.firstElementChild;
  if (next) el.replaceWith(next);
}

/* Последний голос каждого участника; для мультивыбора — весь набор */
export function tallyPoll(pollMsg) {
  const all = S.messages[S.active] || [];
  const latest = new Map();
  let closed = false;

  for (const m of all) {
    if (m.type === 'pollclose' && m.close?.p === pollMsg.id) closed = true;
    if (m.type !== 'vote' || !m.vote || m.vote.p !== pollMsg.id) continue;
    const prev = latest.get(m.sender);
    if (!prev || (m.ts || 0) >= (prev.ts || 0)) latest.set(m.sender, m);
  }

  const total = Array.isArray(pollMsg.poll?.o) ? pollMsg.poll.o.length : 0;
  const counts = Array(total).fill(0);
  const votersByOption = Array.from({ length: total }, () => []);
  let voters = 0;
  let mine = [];

  for (const [uid, m] of latest) {
    const v = (m.vote.v || []).filter((i) => Number.isInteger(i) && i >= 0 && i < total);
    if (!v.length) continue;
    voters++;
    for (const i of v) {
      counts[i]++;
      votersByOption[i].push(uid);
    }
    if (uid === 'u_me' || uid === S.me?.id) mine = v;
  }

  return { counts, voters, mine, closed, votersByOption };
}

export function votePollOption(m, index) {
  const { mine, closed } = tallyPoll(m);
  if (closed) return;
  let next;

  if (m.poll?.multi) {
    next = mine.includes(index)
      ? mine.filter((i) => i !== index)
      : [...mine, index].sort((a, b) => a - b);
  } else {
    if (mine.length === 1 && mine[0] === index) {
      toast(t('poll.alreadyVoted'));
      return;
    }
    next = [index];
  }

  hooks.votePoll(m, next);
}

export function ticksHtml(m, mine) {
  if (!mine || m.deleted) return '';
  if (m.status === 'error') {
    return `<button class="ticks err" data-act="retry" title="${t('comp.sendOffline')}">${icon('alert', 13)}</button>`;
  }
  if (m.status === 'sending') {
    return `<span class="ticks sending" title="${t('comp.sending')}">${icon('clock', 13)}</span>`;
  }
  if (m.status === 'read') {
    return `<span class="ticks read" title="${t('msg.read')}">${icon('check2', 13)}</span>`;
  }
  return `<span class="ticks" title="${t('msg.delivered')}">${icon('check', 13)}</span>`;
}

export function metaHtml(m, mine) {
  const edited = m.edited ? `<span class="msg-edited">${t('msg.edited')}</span>` : '';
  return `<div class="msg-meta"><span>${fmtTime(m.ts)}</span>${edited}${ticksHtml(m, mine)}</div>`;
}

export function toolsHtml(m, mine) {
  const isText = m.type === 'text';
  const canForward = ['text', 'image', 'file', 'voice', 'video', 'videoNote', 'album'].includes(m.type);
  const canDelete = mine;
  const tools = [
    `<button type="button" data-act="reply" title="${t('msg.reply')}" aria-label="${t('msg.reply')}">${icon('reply', 15)}</button>`,
    `<button type="button" data-act="react" title="${t('msg.react')}" aria-label="${t('msg.react')}">${icon('smile', 15)}</button>`,
    `<button type="button" data-act="select" title="${t('msg.select')}" aria-label="${t('msg.select')}">${icon('check2', 15)}</button>`,
    canForward ? `<button type="button" data-act="forward" title="${t('msg.forward')}" aria-label="${t('msg.forward')}">${icon('forward', 15)}</button>` : '',
    `<button type="button" data-act="pin" title="${t('msg.pin')}" aria-label="${t('msg.pin')}">${icon('pin', 15)}</button>`,
    isText ? `<button type="button" data-act="copy" title="${t('msg.copy')}" aria-label="${t('msg.copy')}">${icon('copy', 15)}</button>` : '',
    mine && m.status === 'read' ? `<button type="button" data-act="readby" title="${t('msg.readBy')}" aria-label="${t('msg.readBy')}">${icon('users', 15)}</button>` : '',
    mine && isText && m.cryptoVersion !== 2 ? `<button type="button" data-act="edit" title="${t('msg.edit')}" aria-label="${t('msg.edit')}">${icon('pencil', 15)}</button>` : '',
    canDelete ? `<button type="button" data-act="del" title="${t('msg.remove')}" aria-label="${t('msg.remove')}">${icon('trash', 15)}</button>` : '',
    !mine ? `<button type="button" data-act="report" title="${t('report.title')}" aria-label="${t('report.title')}">${icon('alert', 15)}</button>` : '',
  ].join('');
  return `<div class="tools">${tools}</div>`;
}

export function rxPickHtml() {
  return `<div class="rx-pick">${EMOJI_QUICK.map((e) => `<button data-pick="${e}">${e}</button>`).join('')}</div>`;
}
