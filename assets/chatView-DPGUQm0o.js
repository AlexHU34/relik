/* Relik — представление чата: шапка, лента, пузыри, реакции, голос */
import { S, user, chatTitle, chatById, bus } from './state.js';
import { $, esc, fmtDay, avatarHtml, snippet } from './utils.js';
import { syncExpanded } from './a11y.js';
import { icon } from './icons.js';
import { t } from '../i18n/i18n.js';
import { idb } from '../db/idb.js';
import { SUPABASE } from '../config.js';
import { openLightbox } from './modals.js';
import { openMenu } from './menu.js';
import { toast } from './toast.js';
import { renderSidebar } from './sidebar.js';
import { refreshBar, resetComposer, loadEdit, retryMessage, votePoll, sendReaction, closePoll } from './composer.js';
import { playMessage } from './sounds.js';
import { notifyMessage } from './notify.js';
import { initTyping, stopTyping } from '../backend/presence.js';
import { currentDevice } from './device.js';
import { startCall } from './calls.js';
import { getReadAt, setReadAt, isMuted, prefs, getChatTtl, getChatTtlSince, setChatTtl } from './prefs.js';
import { safeMediaSrc } from './richText.js';
import { loadMessagesPage, loadOlderMessages, fetchMessagesSince, subscribeToChat, updateReadReceipt, deleteMessage as deleteMessageBackend } from '../backend/messages.js';
import { hydrateMessagesMedia, hydrateMessageMedia } from '../backend/storage.js';
import { hasGroupKeysTable } from '../backend/groupKeys.js';
import { ensureDmMember } from '../backend/chats.js';
import { markTiming } from '../backend/telemetry.js';

import { openRecoveryFlow } from './keyRecovery.js';
import { PAGE_SIZE, mergeMessages, windowOf, oldestTs } from './msgWindow.js';
import {
  changeChatTtl, clearTtlForChat, clearTtlTimers, clearTtlTimer, scheduleTtlForChat,
  applyTtlFromHistory, paintTtl, bindTtlHooks,
} from './chat/ttl.js';

/* TTL-модуль не должен импортировать chatView (циклическая зависимость),
   поэтому отдаём ему только нужные функции. */
bindTtlHooks({ renderMessages, renderPin });
export { clearTtlTimers };

import {
  applyReadState, sendReadUpto, scheduleDemoRead, openReadInfo,
  refreshMessageStatus, bindReadHooks,
} from './chat/receipts.js';
import { playVoice, cycleSpeed } from './chat/voice.js';
import {
  exitSelect, startSelect, toggleSelect, syncSelectBar, copyText, copySelected, deleteSelected,
  forwardSelected, isSelectMode, selectedIds, bindSelectHooks,
} from './chat/select.js';

bindReadHooks({
  getEls: () => els,
  ticksHtml: (m, mine) => ticksHtml(m, mine),
  metaHtml: (m, mine) => metaHtml(m, mine),
  showTools: (el) => showTools(el),
  isToolsOpen: (id) => toolsOpen === id,
  escapeId: (id) => nonzeroEscape(id),
});
export { refreshMessageStatus };

bindForwardHooks({ deliverMessage, renderMessages });

import {
  openChatProfile, toggleProfileQr, copyProfileFingerprint,
  warnPeerKeyChange, reportMessage, acceptFingerprint,
} from './chat/profile.js';
import {
  openForward, forwardToMany, toggleForwardTarget, bindForwardHooks,
} from './chat/forward.js';
import {
  msgHtml, tallyReactions, ticksHtml, metaHtml, toolsHtml, rxPickHtml, votePollOption,
  refreshMessageReactions, refreshPollCard, bindRenderView, bindRenderHooks,
} from './chat/render.js';

bindRenderView(() => ({ searchIndex, selectMode: isSelectMode(), selectedMsgs: selectedIds(), toolsOpen }));
bindRenderHooks({
  getEls: () => els,
  votePoll: (m, i) => votePoll(m, i),
  byId: (id) => byId(id),
  escapeId: (id) => nonzeroEscape(id),
});
export { refreshMessageReactions, refreshPollCard };

bindSelectHooks({
  getEls: () => els,
  byId: (id) => byId(id),
  escapeId: (id) => nonzeroEscape(id),
  closeTools: () => closeTools(),
  closeReact: () => closeReact(),
  renderMessages: () => renderMessages(),
  renderSidebar: () => renderSidebar(),
  renderPin: () => renderPin(),
});

let els = {};
let loadingOlder = false;
let searchQuery = '';
let searchHits = [];
let searchIndex = 0;
let searchInputTimer = 0;
let lastSearchQuery = '';
let unseenCount = 0;
let currentSubscription = null; // Realtime subscription
let pollTimer = null;           // страховочный опрос активного чата
let realtimeStatus = 'offline'; // статус канала Supabase Realtime
let activeSyncTick = null;
let toolsOpen = null;           // панель действий сообщения (тап на телефоне)
let autoScrolling = false;
let showLocked = false;         // показывать недоступные (нерасшифрованные) сообщения
let groupMigrationWarned = false;

/* ── инициализация и делегирование ─────────────────────────── */
export function initChatView() {
  els.msgs = $('#msgs');
  els.toBottom = $('#toBottom');
  els.toBottom.innerHTML = icon('arrowDown', 18);
  els.msgs.addEventListener('click', onMsgClick);
  /* Панель действий: показываем только у сообщения под курсором.
     На тач-устройствах её открывает тап (см. onMsgClick). */
  els.msgs.addEventListener('pointerover', (e) => {
    if (isSelectMode()) return;
    if (e.pointerType === 'touch') return;
    const el = e.target.closest?.('.msg');
    if (!el || el.contains(e.relatedTarget)) return;
    showTools(el);
  });
  els.msgs.addEventListener('pointerout', (e) => {
    if (e.pointerType === 'touch') return;
    const el = e.target.closest?.('.msg');
    if (!el || el.contains(e.relatedTarget)) return;
    if (el.classList.contains('tools-open') || el.classList.contains('react-open')) return;
    el.querySelectorAll(':scope > .bubble > .tools').forEach((t) => t.remove());
  });
  let earlierTimer = 0;
  els.msgs.addEventListener('scroll', () => {
    updateToBottom();
    /* У верхней кромки тихо догружаем предыдущую страницу — как в мессенджерах. */
    if (els.msgs.scrollTop > 80 || earlierTimer) return;
    earlierTimer = setTimeout(() => { earlierTimer = 0; }, 600);
    els.msgs.querySelector('[data-load-earlier]')?.click();
  }, { passive: true });
  els.toBottom.addEventListener('click', () => scrollBottom(false));
  $('#selClose').innerHTML = icon('x', 16);
  $('#selClose').title = t('common.close');
  $('#selClose').setAttribute('aria-label', t('common.close'));
  $('#selClose').addEventListener('click', exitSelect);
  $('#selForward').addEventListener('click', forwardSelected);
  $('#selCopy').addEventListener('click', copySelected);
  $('#selDelete').addEventListener('click', deleteSelected);
  $('#backBtn').addEventListener('click', () => {
    exitSelect();
    stopActiveSync();
    stopTyping();
    location.hash = '#/app';
    S.active = null;
    $('#appView').classList.remove('pane-chat');
    showChat();
  });
  $('#videoCallBtn').addEventListener('click', () => {
    const chat = chatById(S.active);
    if (chat) startCall(chat, { video: true });
  });
  $('#shareBtn').addEventListener('click', shareChat);
  $('#callBtn').addEventListener('click', () => {
    const chat = chatById(S.active);
    if (chat) startCall(chat);
  });
  $('#infoBtn').addEventListener('click', openChatProfile);
  $('#chatWho').addEventListener('click', openChatProfile);
  $('#profileCall').addEventListener('click', () => {
    const chat = chatById(S.active);
    $('#profileOv').hidden = true;
    if (chat) startCall(chat);
  });
  $('#profileVideo').addEventListener('click', () => {
    const chat = chatById(S.active);
    $('#profileOv').hidden = true;
    if (chat) startCall(chat, { video: true });
  });
  $('#fpCopy') && ($('#fpCopy').innerHTML = icon('copy', 16));
  $('#fpCopy')?.addEventListener('click', copyProfileFingerprint);
  $('#fpCode')?.addEventListener('click', copyProfileFingerprint);
  $('#fpAccept')?.addEventListener('click', () => acceptFingerprint());
  $('#fpQrBtn')?.addEventListener('click', toggleProfileQr);
  $('#ttlSeg')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-ttl]');
    const chat = chatById(S.active);
    if (btn && chat) changeChatTtl(chat, Number(btn.dataset.ttl));
  });

  /* поиск по чату: подсветка совпадений + переход между ними */
  $('#chatSearchBtn').innerHTML = icon('search', 18);
  $('#csIc').innerHTML = icon('search', 16);
  $('#chatSearchClose').innerHTML = icon('x', 17);
  $('#chatSearchPrev').innerHTML = icon('chevronUp', 17);
  $('#chatSearchNext').innerHTML = icon('chevronDown', 17);
  $('#chatSearchPrev').title = t('chat.searchPrev');
  $('#chatSearchNext').title = t('chat.searchNext');
  $('#chatSearchBtn').addEventListener('click', () => toggleSearch(true));
  $('#chatSearchClose').addEventListener('click', () => toggleSearch(false));
  $('#chatSearchPrev').addEventListener('click', () => jumpToHit(-1));
  $('#chatSearchNext').addEventListener('click', () => jumpToHit(1));
  $('#chatSearchInput').addEventListener('input', (e) => {
    const value = e.target.value.trim();
    clearTimeout(searchInputTimer);
    /* не перерисовываем 240 сообщений на каждую букву */
    searchInputTimer = setTimeout(async () => {
      searchQuery = value;
      searchIndex = 0;
      renderMessages();
      if (searchQuery && searchHits.length) { jumpTo(searchHits[searchIndex]); return; }
      /* В памяти только последняя страница — на длинном чате поиск бы «врал».
         Догружаем до трёх страниц истории, но только пока запрос тот же. */
      const id = S.active;
      if (!searchQuery || !id || !S.msgMore?.[id]) return;
      for (let i = 0; i < 3 && S.msgMore?.[id] && searchQuery === value; i++) {
        const chat = chatById(id);
        const before = oldestTs(S.messages[id] || []);
        if (!chat || !before) break;
        try {
          const { messages, hasMore } = await loadOlderMessages(id, before, chat.kind, chat.publicKey);
          if (S.active !== id || searchQuery !== value) return;
          S.msgMore = { ...(S.msgMore || {}), [id]: hasMore };
          if (!messages.length) break;
          S.messages[id] = mergeMessages(messages, S.messages[id] || []);
          renderMessages();
          if (searchHits.length) { jumpTo(searchHits[searchIndex]); break; }
        } catch (err) {
          console.warn('Search history error:', err);
          break;
        }
      }
    }, 110);
  });
  $('#chatSearchInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      jumpToHit(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      toggleSearch(false);
    }
  });

  /* Ctrl/Cmd+F — поиск по открытому чату */
  /* видео-кружки: прячем ▶, когда играет, и возвращаем на паузе */
  els.msgs.addEventListener('play', (e) => {
    if (e.target.matches?.('.video-note video')) e.target.closest('.video-note')?.classList.add('playing');
  }, true);
  ['pause', 'ended'].forEach((evt) => els.msgs.addEventListener(evt, (e) => {
    if (e.target.matches?.('.video-note video')) e.target.closest('.video-note')?.classList.remove('playing');
  }, true));

  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey) return;
    if (!(e.code === 'KeyF' || String(e.key).toLowerCase() === 'f')) return;
    if (!S.active) return;
    if (document.querySelector('.overlay:not([hidden]), .lightbox:not([hidden]), .call-overlay:not([hidden])')) return;
    e.preventDefault();
    toggleSearch(true);
  });

  /* закреплённое */
  $('#pinIc').innerHTML = icon('pin', 15);
  $('#pinClose').innerHTML = icon('x', 15);
  $('#pinBar').addEventListener('click', (e) => {
    if (e.target.closest('#pinClose')) return;
    const id = $('#pinBar').dataset.mid;
    if (id) jumpTo(id);
  });
  $('#pinClose').addEventListener('click', () => unpin());

  /* диагностика расшифровки */
  const decIc = $('#decryptIc');
  if (decIc) decIc.innerHTML = icon('alert', 16);
  $('#decryptFix')?.addEventListener('click', () => { openRecoveryFlow(); });
  $('#decryptClose')?.addEventListener('click', () => {
    const bar = $('#decryptBar');
    if (!bar) return;
    bar.dataset.hiddenFor = S.active || '';
    bar.hidden = true;
  });

  /* пересылка: выбор нескольких чатов */
  $('#fwdList').addEventListener('click', (e) => {
    const item = e.target.closest('[data-fwd-cid]');
    if (!item) return;
    const on = toggleForwardTarget(item.dataset.fwdCid);
    item.classList.toggle('on', on);
  });
  $('#fwdGo').addEventListener('click', () => forwardToMany());


  /* свайп вправо по чату = «назад» (как в Telegram) */
  const pane = $('#chatPane');
  let sx = 0, sy = 0;
  pane.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    sx = t.clientX; sy = t.clientY;
  }, { passive: true });
  pane.addEventListener('touchend', (e) => {
    if (!sx) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - sx;
    const dy = Math.abs(t.clientY - sy);
    sx = 0;
    if (dx > 80 && dy < 60 && $('#appView').classList.contains('pane-chat')) {
      exitSelect();
      stopActiveSync();
      location.hash = '#/app';
      S.active = null;
      $('#appView').classList.remove('pane-chat');
      showChat();
    }
  }, { passive: true });

  /* «Показать раньше»: сначала расширяем окно из памяти, затем — страница с сервера */
  els.msgs.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-load-earlier]');
    if (!btn) return;
    const id = S.active;
    if (!id) return;
    const limit = S.renderLimit?.[id] || PAGE_SIZE;
    const total = (S.messages[id] || []).filter((m) => !m.hidden).length;

    if (total > limit) {
      S.renderLimit = { ...(S.renderLimit || {}), [id]: limit + PAGE_SIZE };
      renderMessages({ prepend: true });
      return;
    }

    if (!S.msgMore?.[id] || loadingOlder) return;
    loadingOlder = true;
    btn.classList.add('loading');
    btn.setAttribute('aria-busy', 'true');
    try {
      const chat = chatById(id);
      const before = oldestTs(S.messages[id] || []);
      if (!chat || !before) return;
      const { messages, hasMore } = await loadOlderMessages(id, before, chat.kind, chat.publicKey);
      if (S.active !== id) return;
      S.msgMore = { ...(S.msgMore || {}), [id]: hasMore };
      if (messages.length) {
        S.messages[id] = mergeMessages(messages, S.messages[id] || []);
        S.renderLimit = { ...(S.renderLimit || {}), [id]: limit + PAGE_SIZE };
        renderMessages({ prepend: true });
        hydrateMessagesMedia(messages).then((changed) => {
          if (changed && S.active === id) renderMessages({ prepend: true });
        }).catch(() => {});
      } else {
        renderMessages({ prepend: true });
      }
    } catch (err) {
      console.warn('Load older error:', err);
      toast(t('chat.loadEarlierFail'), { type: 'error' });
    } finally {
      loadingOlder = false;
      btn.classList.remove('loading');
      btn.removeAttribute('aria-busy');
    }
  });

  /* двойной клик по сообщению — ответ */
  els.msgs.addEventListener('dblclick', (e) => {
    if (isSelectMode()) return;
    if (e.target.closest('a,button,input,textarea,.msg-img')) return;
    const msgEl = e.target.closest('.msg');
    const m = msgEl && byId(msgEl.dataset.mid);
    if (!m || m.deleted || m.hidden) return;
    S.editing = null;
    S.reply = { id: m.id, name: m.sender === 'u_me' ? t('msg.you') : user(m.sender).name, snippet: snippet(m) };
    refreshBar();
    $('#ta')?.focus();
  });

  /* возврат из «вниз» — счётчик новых сообщений сбрасывается */
  els.toBottom.addEventListener('click', () => { unseenCount = 0; updateToBottom(); });

  /* сайдбар очистил историю / убрал чат — обновляем ленту без перезагрузки */
  bus.addEventListener('chat:cleared', (e) => {
    const id = e.detail?.id;
    if (!id) return;
    clearTtlForChat(id);
    S.messages[id] = [];
    if (S.unreadFrom) S.unreadFrom[id] = 0;
    if (S.active === id) renderMessages();
  });
  bus.addEventListener('chat:removed', (e) => {
    clearTtlForChat(e.detail?.id);
    if (S.active === e.detail?.id) {
      S.active = null;
      showChat();
    }
  });
  bus.addEventListener('chat:updated', (e) => {
    if (S.active === e.detail?.id) {
      renderHeader();
      renderMessages();
    }
  });

  /* вернулись в браузер/вкладку — сразу подтягиваем новые сообщения */
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && activeSyncTick) activeSyncTick();
    if (document.visibilityState === 'visible' && S.active) sendReadUpto(S.active);
  });

  /* связь вернулась — догружаем медиа, которое не открылось офлайн */
  window.addEventListener('online', () => {
    const id = S.active;
    if (!id) return;
    const list = S.messages[id] || [];
    if (!list.some((m) => m.media || (m.album || []).some((it) => it?.path))) return;
    hydrateMessagesMedia(list).then((changed) => {
      if (changed && S.active === id) renderMessages();
    }).catch(() => {});
  });

  /* тап мимо сообщения закрывает панель действий и реакции */
  document.addEventListener('click', (e) => {
    if (!toolsOpen && !S.reactOpen) return;
    if (e.target.closest('.msg')) return;
    closeTools();
    closeReact();
  });

  /* Esc закрывает панель действий/реакции, не трогая остальные слои */
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (isSelectMode()) { exitSelect(); return; }
    if (!toolsOpen && !S.reactOpen) return;
    closeTools();
    closeReact();
  });
}

function onMsgClick(e) {
  if (isSelectMode()) {
    const pick = e.target.closest('.msg');
    if (pick) {
      e.preventDefault();
      toggleSelect(pick.dataset.mid);
      return;
    }
  }
  if (e.target.closest('[data-show-locked]')) {
    showLocked = !showLocked;
    renderMessages();
    return;
  }
  /* ссылки в тексте открываются браузером и не должны открывать панель действий */
  if (e.target.closest('a[href]')) return;
  const actEl = e.target.closest('[data-act]');
  const pickEl = e.target.closest('[data-pick]');
  const rxBt = e.target.closest('[data-rx]');
  const imgEl = e.target.closest('.msg-img');
  const playEl = e.target.closest('.v-play');
  const speedEl = e.target.closest('[data-speed]');
  const quoteEl = e.target.closest('.reply-quote');
  const msgEl = e.target.closest('.msg');
  const m = msgEl && byId(msgEl.dataset.mid);

  if (e.target.closest('.ticks.read') && m) { openReadInfo(m); return; }

  if (pickEl && m) { toggleReaction(m, pickEl.dataset.pick); return; }
  if (rxBt && m) { toggleReaction(m, rxBt.dataset.rx); return; }
  const retryEl = e.target.closest('[data-media-retry]');
  if (retryEl && m) {
    m.mediaError = false;
    if (Array.isArray(m.album)) m.album.forEach((it) => { it.error = false; });
    hydrateMessageMedia(m).then(() => {
      if (m.mediaError) toast(t('media.broken'), { type: 'error' });
      renderMessages();
    }).catch(() => {});
    return;
  }
  const pollEl = e.target.closest('[data-poll-opt]');
  if (pollEl && m?.type === 'poll') { votePollOption(m, Number(pollEl.dataset.pollOpt)); return; }
  const pollClose = e.target.closest('[data-poll-close]');
  if (pollClose && m?.type === 'poll') { closePoll(m); return; }
  if (imgEl && m) {
    const full = safeMediaSrc(m.file?.src, 'image');
    const thumb = safeMediaSrc(m.file?.thumb, 'image');
    if (full) { openLightbox(full, m.file.name); return; }
    if (thumb) {
      openLightbox(thumb, m.file?.name || t('msg.photo'));
      hydrateMessageMedia(m).then(() => {
        const src = safeMediaSrc(m.file?.src, 'image');
        if (src && !document.getElementById('lightbox')?.hidden) openLightbox(src, m.file.name);
      }).catch(() => {});
      return;
    }
    toast(t('media.broken'), { type: 'error' });
    return;
  }
  const albumEl = e.target.closest('[data-album-idx]');
  if (albumEl && m?.type === 'album') {
    const index = Number(albumEl.dataset.albumIdx);
    const item = (m.album || [])[index];
    const full = safeMediaSrc(item?.src, 'image');
    const thumb = safeMediaSrc(item?.thumb, 'image');
    const gallery = (m.album || []).map((it) => ({
      src: safeMediaSrc(it?.src, 'image') || safeMediaSrc(it?.thumb, 'image'),
      name: it?.name || t('msg.photo'),
    })).filter((it) => it.src);
    if (full) { openLightbox(full, item?.name || t('msg.photo'), gallery); return; }
    if (thumb) {
      openLightbox(thumb, item?.name || t('msg.photo'), gallery);
      hydrateMessageMedia(m).then(() => {
        const src = safeMediaSrc(item?.src, 'image');
        if (src && !document.getElementById('lightbox')?.hidden) {
          const updated = (m.album || []).map((it) => ({
            src: safeMediaSrc(it?.src, 'image') || safeMediaSrc(it?.thumb, 'image'),
            name: it?.name || t('msg.photo'),
          })).filter((it) => it.src);
          openLightbox(src, item?.name || t('msg.photo'), updated);
        }
      }).catch(() => {});
      return;
    }
    toast(t('media.broken'), { type: 'error' });
    return;
  }
  const vnEl = e.target.closest('.video-note');
  if (vnEl && m?.type === 'videoNote') {
    const vid = vnEl.querySelector('video');
    if (!vid) {
      hydrateMessageMedia(m).then((changed) => {
        if (changed && S.active === m.chatId) renderMessages();
        if (m.mediaError) toast(t('media.broken'), { type: 'error' });
      }).catch(() => {});
      return;
    }
    if (vid.paused) {
      document.querySelectorAll('.video-note video').forEach((v) => { if (v !== vid) v.pause(); });
      vid.play().catch(() => {});
      vnEl.classList.add('playing');
    } else {
      vid.pause();
      vnEl.classList.remove('playing');
    }
    return;
  }
  const videoPending = e.target.closest('.msg-video.pending');
  if (videoPending && m?.type === 'video') {
    hydrateMessageMedia(m).then((changed) => {
      if (changed && S.active === m.chatId) renderMessages();
      if (m.mediaError) toast(t('media.broken'), { type: 'error' });
    }).catch(() => {});
    return;
  }
  const fileEl = e.target.closest('.file-row');
  if (fileEl && m?.type === 'file' && m.file?.src) {
    const src = safeMediaSrc(m.file.src, 'file');
    if (!src) { toast(t('media.broken'), { type: 'error' }); return; }
    const a = document.createElement('a');
    a.href = src;
    a.download = m.file.name || 'file';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    return;
  }
  if (playEl && m) { playVoice(m, playEl); return; }
  if (speedEl && m) { cycleSpeed(m, speedEl); return; }
  if (quoteEl) { jumpTo(quoteEl.dataset.jump); return; }
  if (actEl && m) {
    const act = actEl.dataset.act;
    if (act === 'reply') { S.editing = null; S.reply = { id: m.id, name: user(m.sender).name, snippet: snippet(m) }; refreshBar(); closeReact(); }
    else if (act === 'react') {
      const willOpen = S.reactOpen !== m.id;
      closeReact();
      if (willOpen) {
        S.reactOpen = m.id;
        const bubble = msgEl.querySelector(':scope > .bubble');
        bubble?.insertAdjacentHTML('beforeend', rxPickHtml());
        msgEl.classList.add('react-open');
        /* .tools скрывает CSS (.react-open .tools{opacity:0});
           удалять панель внутри клика нельзя — событие всплывёт
           до document уже без предка .msg и закроет выбор реакций. */
      }
    }
    else if (act === 'select') { startSelect(m); }
    else if (act === 'retry') { retryMessage(m); }
    else if (act === 'copy') {
      const text = m.text || '';
      copyText(text).then((ok) => {
        toast(t(ok ? 'msg.copied' : 'toast.error'), { type: ok ? 'success' : 'error' });
      });
    }
    else if (act === 'edit') { S.editing = m.id; S.reply = null; loadEdit(m); closeReact(); }
    else if (act === 'pin') {
      const chat = chatById(S.active);
      chat.pin = { id: m.id, text: snippet(m) };
      idb.put('settings', { key: 'pin:' + chat.id, value: chat.pin });
      idb.put('chats', chat);
      renderPin();
      toast(t('chat.pinnedToast'));
      closeReact();
    }
    else if (act === 'forward') { openForward(m); closeReact(); }
    else if (act === 'report') { reportMessage(m); closeReact(); }
    else if (act === 'readby') { openReadInfo(m); closeReact(); }
    else if (act === 'del') {
      openMenu([
        {
          label: t('msg.deleteMe'),
          icon: 'trash',
          onClick: () => deleteMessageLocal(m),
        },
        {
          label: t('msg.deleteAll'),
          icon: 'trash',
          danger: true,
          onClick: () => deleteMessageEverywhere(m),
        },
      ], { anchor: actEl, align: 'right' });
      closeReact();
    }
    if (act !== 'react' && toolsOpen) closeTools();
    return;
  }
  if (S.reactOpen) closeReact();
  /* на телефоне действия по сообщению открываются тапом */
  if (m && !e.target.closest('[data-act],[data-pick],[data-rx],[data-poll-opt],.poll,.reply-quote,.msg-img,.msg-video,.video-note,.album,.voice')) {
    const touch = currentDevice() === 'phone' || window.matchMedia('(hover: none)').matches;
    if (touch) {
      toggleTools(msgEl, m);
    }
  }
}

function byId(id) {
  return (S.messages[S.active] || []).find((m) => m.id === id);
}

/* Удаление: у себя — скрываем только на этом устройстве; у всех — помечаем на сервере */
function afterMessageRemoved(m) {
  const chat = chatById(S.active);
  if (!chat) return;
  if (chat.pin?.id === m.id) {
    delete chat.pin;
    idb.del('settings', 'pin:' + chat.id);
    renderPin();
  }
  const last = (S.messages[S.active] || []).filter((x) => !x.hidden).pop();
  chat.last = last ? { ts: last.ts, from: last.sender, type: last.type, text: last.text || '' } : null;
  idb.put('chats', chat);
  renderSidebar();
}

function deleteMessageLocal(m) {
  clearTtlTimer(m.id);
  m.hidden = true;
  m.localDeleted = true;
  idb.put('messages', m).then(() => {
    renderMessages();
    afterMessageRemoved(m);
  });
  toast(t('msg.deletedLocal'), { type: 'success' });
}

function deleteMessageEverywhere(m) {
  clearTtlTimer(m.id);
  if (SUPABASE.url && SUPABASE.anonKey) {
    deleteMessageBackend(m.id).catch((err) => console.error('Delete error:', err));
  }
  m.deleted = true;
  m.text = '';
  idb.put('messages', m).then(() => {
    renderMessages();
    afterMessageRemoved(m);
  });
  toast(t('msg.deletedEverywhere'), { type: 'success' });
}

/* ── ссылка-приглашение в чат ──────────────────────────────── */
async function shareChat() {
  const chat = chatById(S.active);
  if (!chat) return;
  const link = `${location.origin}${location.pathname}#/join/${chat.id}`;
  try {
    await navigator.clipboard.writeText(link);
    toast(t('chat.linkCopied'));
  } catch (err) {
    toast(link);
  }
}

/* Панель реакций закрываем точечно — без пересборки всей ленты. */
function closeReact() {
  if (!S.reactOpen) return;
  S.reactOpen = null;
  const open = els.msgs?.querySelectorAll('.react-open') || [];
  open.forEach((el) => {
    el.classList.remove('react-open');
    el.querySelectorAll(':scope > .bubble > .rx-pick').forEach((p) => p.remove());
  });
}

/* ── «Живая» лента: Realtime + тихий опрос на случай сбоя сокета ── */


function stopActiveSync() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  activeSyncTick = null;
}

/* ── добавляет только новые сообщения в конец ленты ──
   Возвращает false, если безопаснее перерисовать всё (поиск, ограничение
   истории, баннеры, приветствие). */
function appendToFeed(newMsgs) {
  if (!newMsgs.length || searchQuery) return false;
  const holder = els.msgs;
  if (!holder) return false;
  if (holder.querySelector('.chat-welcome, .locked-banner')) return false;

  const visible = (S.messages[S.active] || [])
    .filter((m) => !m.hidden && (!m.decryptFailed || showLocked));
  const limit = S.renderLimit?.[S.active] || PAGE_SIZE;

  const firstNew = visible.findIndex((m) => m.id === newMsgs[0].id);
  if (firstNew <= 0) return false;

  /* Достигли страницы истории: не пересобираем всю ленту из-за одного
     нового сообщения — убираем самые старые узлы и дописываем новые.
     Баннер «показать раньше» уже есть, ему только увеличиваем счётчик. */
  const overflow = visible.length - limit;
  if (overflow > 0) {
    const banner = holder.querySelector('.load-earlier');
    if (!banner) return false; // первый раз — пусть отрисует renderMessages и создаст баннер
    const nodes = [...holder.querySelectorAll('.msg')];
    for (let i = 0; i < overflow && i < nodes.length; i++) nodes[i].remove();
    /* заголовки дней, оставшиеся без сообщений */
    while (holder.firstElementChild && holder.firstElementChild.classList.contains('day')) {
      holder.firstElementChild.remove();
    }
    const count = banner.querySelector('b');
    if (count) count.textContent = String((Number(count.textContent) || 0) + overflow);
  }
  let prev = visible[firstNew - 1];
  let day = new Date(prev.ts).toDateString();

  let html = '';
  for (const m of newMsgs) {
    const nd = new Date(m.ts).toDateString();
    const newDay = nd !== day;
    if (newDay) {
      html += `<div class="day"><span>${fmtDay(m.ts)}</span></div>`;
      day = nd;
    }
    const cont = !newDay && prev.sender === m.sender && (m.ts - prev.ts) < 4 * 60e3;
    html += msgHtml(m, !cont, -1);
    prev = m;
  }

  const typing = holder.querySelector('.typing');
  if (typing) typing.remove();
  holder.insertAdjacentHTML('beforeend', html);
  if (S.typingChat === S.active) holder.insertAdjacentHTML('beforeend', typingHtml());
  if (toolsOpen) {
    const el = holder.querySelector(`.msg[data-mid="${nonzeroEscape(toolsOpen)}"]`);
    if (el && !el.querySelector(':scope > .bubble > .tools')) { el.classList.add('tools-open'); showTools(el); }
  }
  return true;
}

function startActiveSync(id, chat) {
  stopActiveSync();
  let busy = false;

  const tick = async () => {
    if (busy || !S.me || S.active !== id) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    busy = true;
    try {
      const list = S.messages[id] || [];
      const lastTs = list.reduce((max, m) => Math.max(max, m.ts || 0), 0);
      /* берём с небольшим запасом: дубликаты отсекаем по id */
      const fresh = await fetchMessagesSince(id, lastTs ? lastTs - 5000 : 0, chat.kind, chat.publicKey);
      if (!fresh.length || S.active !== id) return;
      await hydrateMessagesMedia(fresh).catch(() => {});

      let added = 0;
      const addedMsgs = [];
      S.messages[id] = S.messages[id] || [];
      for (const m of fresh) {
        const i = S.messages[id].findIndex((x) => x.id === m.id);
        if (i >= 0) {
          const old = S.messages[id][i];
          const merged = {
            ...old,
            ...m,
            reactions: old.reactions?.length ? old.reactions : m.reactions,
          };
          if (old.ttlStartedAt && !m.ttlStartedAt) merged.ttlStartedAt = old.ttlStartedAt;
          if (old.expired) { merged.hidden = true; merged.expired = true; merged.localDeleted = true; }
          S.messages[id][i] = merged;
        } else {
          S.messages[id].push(m);
          addedMsgs.push(m);
          added++;
        }
      }

      applyReadState(id);

      if (added) {
        /* сообщения пришли сами — перерисовываем без перезагрузки страницы */
        const st = els.msgs.scrollTop + els.msgs.clientHeight >= els.msgs.scrollHeight - 140;
        const incoming = fresh.some((m) => m.sender !== 'u_me' && !m.hidden);
        if (!st && incoming) unseenCount += fresh.filter((m) => m.sender !== 'u_me' && !m.hidden).length;
        /* в обычном случае дописываем только новые узлы: без пересборки всей ленты */
        const visibleNew = addedMsgs.filter((m) => !m.hidden && (!m.decryptFailed || showLocked));
        const appended = visibleNew.length ? appendToFeed(visibleNew) : false;
        if (!appended) renderMessages();
        if (st) {
          /* мгновенно: анимация прокрутки на каждое новое сообщение ощущается тормозом */
          scrollBottom(false);
          sendReadUpto(id);
        } else {
          updateToBottom();
        }
        if (incoming) updateReadReceipt(id).catch(() => {});
      }
      scheduleTtlForChat(id);

      const last = S.messages[id].filter((m) => !m.hidden).pop();
      if (last) {
        chat.last = { ts: last.ts, from: last.sender, type: last.type, text: last.text || '' };
        await idb.put('chats', chat);
        renderSidebar();
      }
    } catch (err) {
      /* офлайн или RLS — просто попробуем на следующем тике */
    } finally {
      busy = false;
    }
  };

  activeSyncTick = tick;
  /* Если realtime подключён, опрос нужен только как страховка — реже.
     Без realtime (VPN, RLS, сеть) держим частый опрос. */
  const period = realtimeStatus === 'SUBSCRIBED' ? 15000 : 4000;
  pollTimer = setInterval(tick, period);
}

/* ── открытие чата ─────────────────────────────────────────── */
export async function openChat(id) {
  const chat = chatById(id);
  if (!chat) {
    S.active = null;
    $('#appView').classList.remove('pane-chat');
    if (location.hash.startsWith('#/chat/')) location.hash = '#/app';
    return;
  }

  // Отписываемся от предыдущего чата
  exitSelect();
  stopActiveSync();
  realtimeStatus = 'offline';
  if (currentSubscription) {
    currentSubscription.unsubscribe();
    currentSubscription = null;
  }

  /* Черновик предыдущего чата сохраняем до смены активного: иначе
     быстрый переход терял набранный текст. */
  const prevId = S.active;
  if (prevId && prevId !== id && !S.editing) {
    const prevText = $('#ta')?.value || '';
    S.drafts[prevId] = prevText.trim() ? prevText : '';
    if (prevText.trim()) idb.put('settings', { key: 'draft:' + prevId, value: prevText }).catch(() => {});
    else idb.del('settings', 'draft:' + prevId).catch(() => {});
  }

  S.active = id;
  S.reply = null; S.editing = null; S.reactOpen = null;
  showLocked = false;  toolsOpen = null;
  unseenCount = 0;
  searchHits = [];
  searchIndex = 0;
  S.typingUser = null;
  refreshBar(); resetComposer();

  /* Откуда показывать «новые сообщения»: отметка прочтения до открытия */
  const prevReadAt = getReadAt(id);
  S.unreadFrom = S.unreadFrom || {};
  S.unreadFrom[id] = chat.unread ? prevReadAt : 0;

  $('#chatSearch').hidden = true;
  searchQuery = '';
  $('#chatSearchInput').value = '';

  if (chat.unread) { chat.unread = 0; await idb.put('chats', chat); }
  setReadAt(id);

  /* Один раз за сессию: если миграция ключей групп не выполнена,
     честно предупреждаем — сообщения пока уходят без E2E. */
  if (chat.kind === 'group' && SUPABASE.url && SUPABASE.anonKey && !groupMigrationWarned) {
    groupMigrationWarned = true;
    hasGroupKeysTable().then((ok) => {
      if (!ok) toast(t('chat.groupE2eOff'), { type: 'warn', duration: 7000 });
    }).catch(() => {});
  }
  if (chat.kind === 'dm') warnPeerKeyChange(chat).catch(() => {});

  /* Мгновенно показываем кэш, сеть — фоном */
  S.messages[id] = await idb.messagesOf(id);
  applyReadState(id);
  applyTtlFromHistory(id);
  scheduleTtlForChat(id);
  showChat();
  scrollToStartPosition(id);
  renderSidebar();
  sendReadUpto(id);

  /* Медиа из Storage догружаем в фоне: интерфейс не ждёт файлы */
  hydrateMessagesMedia(S.messages[id]).then((changed) => {
    if (changed && S.active === id) renderMessages({ keepScroll: true });
  }).catch(() => {});

  /* черновик и закреплённое */
  try {
    const draft = await idb.get('settings', 'draft:' + id);
    const pin = await idb.get('settings', 'pin:' + id);
    chat.pin = pin?.value || null;
    S.drafts[id] = draft?.value || '';
    const ta = $('#ta');
    if (ta) {
      ta.value = draft?.value || '';
      ta.dispatchEvent(new Event('input'));
    }
    renderSidebar();
  } catch (e) { /* ignore */ }
  renderPin();

  if (SUPABASE.url && SUPABASE.anonKey) {
    /* старый личный чат мог остаться без второго участника —
       тогда собеседник не видит сообщения. Чиним один раз. */
    if (chat.kind === 'dm' && chat.userId) {
      ensureDmMember(id, chat.userId).catch(() => {});
    }
    /* свежие сообщения из бэкенда (не блокируем UI): последняя страница,
       остальная история — по кнопке «показать раньше» */
    loadMessagesPage(id, chat.kind, chat.publicKey)
      .then(async ({ messages: msgs, hasMore }) => {
        if (S.active !== id) return;
        S.msgMore = { ...(S.msgMore || {}), [id]: hasMore };
        /* сервер — источник правды, но локальные «отправляется/ошибка» не теряем */
        S.messages[id] = mergeMessages(msgs, S.messages[id] || []);
        applyReadState(id);
        applyTtlFromHistory(id);
        scheduleTtlForChat(id);
        renderMessages();
        hydrateMessagesMedia(S.messages[id]).then((changed) => {
          if (changed && S.active === id) renderMessages();
        }).catch(() => {});
        await updateReadReceipt(id).catch(() => {});
        setReadAt(id);
        sendReadUpto(id);
        /* зависшие в «отправляется» после аварийного закрытия — пробуем дослать */
        if (navigator.onLine !== false) {
          S.messages[id]
            .filter((m) => m.sender === 'u_me' && m.status === 'sending' && Date.now() - (m.ts || 0) > 20000)
            .slice(0, 8)
            .forEach((m) => retryMessage(m));
        }
        const lastMsg = [...msgs].reverse().find((m) => !m.hidden);
        if (lastMsg) {
          chat.last = { ts: lastMsg.ts, from: lastMsg.sender, type: lastMsg.type, text: lastMsg.text || '' };
          idb.put('chats', chat);
          renderSidebar();
        }
      })
      .catch((err) => console.error('Load messages error:', err));
  }

  // Подписываемся на Realtime
  if (SUPABASE.url && SUPABASE.anonKey) {
    initTyping(id, (uid) => {
      S.typingUser = uid || null;
      showTyping(id);
      clearTimeout(window.__typingT);
      window.__typingT = setTimeout(() => hideTyping(id), 2600);
    });
    currentSubscription = subscribeToChat(id, {
      onMessage: async (msg) => {
        S.messages[id] = S.messages[id] || [];
        if (S.messages[id].some((x) => x.id === msg.id)) return;
        await hydrateMessageMedia(msg).catch(() => {});
        S.messages[id].push(msg);
        if (msg.sender !== 'u_me' && !msg.hidden && !isMuted(id)) playMessage();
        if (msg.sender !== 'u_me' && !msg.hidden) announceIncoming(msg);
        if (msg.hidden) {
          /* голос/реакция/закрытие/прочтение: обновляем только нужный блок */
          if (msg.type === 'read') applyReadState(id);
          else if (msg.type === 'ttl' && msg.ttl) {
            if (msg.sender !== 'u_me') {
              setChatTtl(id, Number(msg.ttl.sec) || 0, msg.ts);
              scheduleTtlForChat(id);
              if (S.active === id) {
                paintTtl(chatById(id));
                toast(t('ttl.updated'), { type: 'info' });
              }
            }
          }
          else if (msg.type === 'vote' && msg.vote?.p) refreshPollCard(msg.vote.p);
          else if (msg.type === 'pollclose' && msg.close?.p) refreshPollCard(msg.close.p);
          else if (msg.type === 'rx' && msg.reaction?.m) refreshMessageReactions(msg.reaction.m);
          else if (S.active === id) renderMessages();
          return;
        }
        if (S.active === id) {
          const near = isNearBottom();
          if (!near && msg.sender !== 'u_me') unseenCount++;
          const appended = appendToFeed([msg]);
          if (!appended) renderMessages();
          scheduleTtlForChat(id);
          if (near) {
            scrollBottom(false);
            if (!document.hidden) sendReadUpto(id);
          } else {
            updateToBottom();
          }
        }
        const c = chatById(id);
        if (c) {
          c.last = { ts: msg.ts, from: msg.sender, type: msg.type, text: msg.text || '' };
          if (S.active !== id) c.unread = (c.unread || 0) + 1;
          await idb.put('chats', c);
          renderSidebar();
          if (document.hidden) notifyMessage(c, snippet(msg), () => { location.hash = `#/chat/${id}`; });
        }
      },
      onEdit: (msgId, updates) => {
        const m = (S.messages[id] || []).find((x) => x.id === msgId);
        if (m) {
          Object.assign(m, updates);
          if (updates.deleted && !m.expired && getChatTtl(id) && (m.ts || 0) >= getChatTtlSince(id)) {
            clearTtlTimer(m.id);
            m.hidden = true;
            m.localDeleted = true;
            m.expired = true;
            idb.put('messages', m).catch(() => {});
          }
          if (S.active === id) renderMessages();
          const chat = chatById(id);
          const last = (S.messages[id] || []).filter((x) => !x.hidden).pop();
          if (chat && last && last.id === msgId) {
            chat.last = { ts: last.ts, from: last.sender, type: last.type, text: last.text || '' };
            idb.put('chats', chat);
            renderSidebar();
          }
        }
      },
      onDelete: (msgId) => {
        S.messages[id] = (S.messages[id] || []).filter((x) => x.id !== msgId);
        if (S.active === id) renderMessages();
        const chat = chatById(id);
        if (chat) {
          const last = (S.messages[id] || []).filter((x) => !x.hidden).pop();
          chat.last = last ? { ts: last.ts, from: last.sender, type: last.type, text: last.text || '' } : null;
          idb.put('chats', chat);
          renderSidebar();
        }
      },
      /* realtime подключился/отвалился — меняем частоту страховочного опроса */
      onStatus: (status) => {
        realtimeStatus = status;
        if (S.active === id) startActiveSync(id, chat);
      },
    }, chat.kind, chat.publicKey);

    /* Realtime может отвалиться (сеть, VPN, RLS) — опрос добирает пропущенное */
    startActiveSync(id, chat);
  }

  if (currentDevice() === 'phone') $('#appView').classList.add('pane-chat');
  $('#ta')?.focus();
}

/* Показ пустого состояния или чата */
export function showChat() {
  const has = S.active && chatById(S.active);
  $('#chatEmpty').hidden = !!has;
  $('#chatActive').hidden = !has;
  if (has) { renderHeader(); renderMessages(); }
}


/* ── шапка чата ────────────────────────────────────────────── */
function renderHeader() {
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
  /* Кнопка шапки — единственный элемент без текстовой подписи для диктора */
  const whoBtn = $('#chatWho');
  if (whoBtn) whoBtn.setAttribute('aria-label', `${chatTitle(chat)}, ${st.textContent}`);
}

/* ── лента ─────────────────────────────────────────────────── */
export function renderMessages(opts = {}) {
  const __t0 = performance.now();
  const chat = chatById(S.active);
  if (!chat) return;
  const raw = S.messages[S.active] || [];
  const locked = raw.filter((m) => !m.hidden && m.decryptFailed);
  const all = raw.filter((m) => !m.hidden && (!m.decryptFailed || showLocked));
  const rxMap = tallyReactions(raw);

  const q = searchQuery.toLowerCase();
  searchHits = q
    ? all.filter((m) => String(m.poll?.q || m.text || '').toLowerCase().includes(q)).map((m) => m.id)
    : [];
  /* Новый запрос — начинаем с самого свежего совпадения. */
  if (q !== lastSearchQuery) {
    lastSearchQuery = q;
    searchIndex = searchHits.length ? searchHits.length - 1 : 0;
  }
  if (searchIndex >= searchHits.length) searchIndex = Math.max(0, searchHits.length - 1);

  let limit = S.renderLimit?.[S.active] || PAGE_SIZE;
  /* Поиск не рендерит всю историю: показываем последние сообщения и
     догружаем окно только если текущее совпадение оказалось выше. */
  if (q && searchHits.length) {
    const currentId = searchHits[Math.min(searchIndex, searchHits.length - 1)];
    const idx = all.findIndex((m) => m.id === currentId);
    if (idx >= 0 && all.length - idx > limit) limit = all.length - idx + 12;
  }
  const win = windowOf(all, limit);
  const visible = win.visible;
  const hiddenCount = win.hiddenCount;

  const countEl = $('#chatSearchCount');
  if (countEl) {
    countEl.textContent = q
      ? (searchHits.length ? `${searchIndex + 1}/${searchHits.length}` : '0')
      : '';
  }

  if (!all.length && !locked.length) {
    els.msgs.innerHTML = `<div class="chat-welcome">
      <span class="w-ic">${icon('lock', 26)}</span>
      <b>${t('chat.welcomeTitle')}</b>
      <span>${t('chat.welcomeSub')}</span>
    </div>`;
    if (els.toBottom) els.toBottom.hidden = true;
    return;
  }

  if (q && !searchHits.length) {
    els.msgs.innerHTML = `<div class="chat-welcome"><span class="w-ic">${icon('search', 24)}</span><b>${t('chat.searchEmpty')}</b></div>`;
    if (els.toBottom) els.toBottom.hidden = true;
    return;
  }

  const beforeH = els.msgs.scrollHeight;
  const beforeT = els.msgs.scrollTop;
  const stick = isNearBottom();

  let html = '';
  if (locked.length) {
    html += `<button type="button" class="locked-banner" data-show-locked>
      ${icon('lock', 15)}
      <span>${t('chat.lockedCount').replace('{n}', String(locked.length))}</span>
      <b>${t(showLocked ? 'chat.hide' : 'chat.show')}</b>
    </button>`;
  }
  const moreOnServer = !!S.msgMore?.[S.active];
  if (hiddenCount > 0 || (moreOnServer && !q)) {
    html += `<button type="button" class="load-earlier" data-load-earlier>
      ${icon('chevronUp', 15)} <span>${t('chat.loadEarlier')}</span>${hiddenCount ? `<b>${hiddenCount}</b>` : ''}
    </button>`;
  }

  const unreadFrom = S.unreadFrom?.[S.active] || 0;
  let dividerShown = !unreadFrom;
  let prev = null;
  for (const m of visible) {
    if (rxMap.has(m.id)) m.reactions = rxMap.get(m.id);
    const newDay = !prev || new Date(m.ts).toDateString() !== new Date(prev.ts).toDateString();
    if (newDay) html += `<div class="day"><span>${fmtDay(m.ts)}</span></div>`;
    if (!dividerShown && m.ts > unreadFrom) {
      html += `<div class="day new-divider"><span>${t('chat.newMessages')}</span></div>`;
      dividerShown = true;
    }
    const cont = prev && prev.sender === m.sender && !newDay && (m.ts - prev.ts) < 4 * 60e3;
    const hitIndex = searchHits.indexOf(m.id);
    html += msgHtml(m, !cont, hitIndex);
    prev = m;
  }
  if (S.typingChat === S.active && !q) html += typingHtml();

  els.msgs.innerHTML = html;
  paintDecryptBar();
  markTiming('render_messages', performance.now() - __t0, { n: visible.length });

  /* на телефоне панель действий не должна пропадать после перерисовки */
  if (toolsOpen) {
    const el = els.msgs.querySelector(`.msg[data-mid="${nonzeroEscape(toolsOpen)}"]`);
    if (el) { el.classList.add('tools-open'); showTools(el); }
    else toolsOpen = null;
  }

  if (opts.prepend) {
    els.msgs.scrollTop = beforeT + (els.msgs.scrollHeight - beforeH);
  } else if (stick || opts.forceBottom) {
    scrollBottom(false);
  }

  /* картинки увеличивают ленту после отрисовки — если были внизу, остаёмся внизу */
  if (stick || opts.forceBottom) {
    els.msgs.querySelectorAll('img').forEach((img) => {
      if (img.complete) return;
      img.addEventListener('load', () => {
        if (S.active && isNearBottom()) {
          const prev = els.msgs.style.scrollBehavior;
          els.msgs.style.scrollBehavior = 'auto';
          els.msgs.scrollTop = els.msgs.scrollHeight;
          els.msgs.style.scrollBehavior = prev;
        }
      }, { once: true });
    });
  }

  renderPin();
  updateToBottom();
  if (isSelectMode()) syncSelectBar();
}

/* ── поиск ─────────────────────────────────────────────────── */
function toggleSearch(show) {
  const bar = $('#chatSearch');
  bar.hidden = !show;
  syncExpanded();
  if (show) {
    setTimeout(() => { $('#chatSearchInput').focus(); $('#chatSearchInput').select(); }, 40);
  } else {
    clearTimeout(searchInputTimer);
    searchQuery = '';
    searchHits = [];
    searchIndex = 0;
    lastSearchQuery = '';
    $('#chatSearchInput').value = '';
    renderMessages();
  }
}

function jumpToHit(delta) {
  if (!searchHits.length) return;
  searchIndex = (searchIndex + delta + searchHits.length) % searchHits.length;
  renderMessages();
  jumpTo(searchHits[searchIndex]);
}

/* Открываем чат на первом непрочитанном, иначе — внизу */
function scrollToStartPosition(id) {
  const apply = () => {
    if (S.active !== id) return;
    const divider = els.msgs.querySelector('.new-divider');
    const top = divider
      ? Math.max(0, divider.offsetTop - els.msgs.clientHeight * 0.3)
      : els.msgs.scrollHeight;
    const prev = els.msgs.style.scrollBehavior;
    els.msgs.style.scrollBehavior = 'auto';
    els.msgs.scrollTop = top;
    els.msgs.style.scrollBehavior = prev;
    updateToBottom();
  };
  requestAnimationFrame(() => {
    apply();
    requestAnimationFrame(apply);
  });

  /* фото догружаются после первого кадра — удерживаем низ, если мы уже внизу */
  els.msgs.querySelectorAll('img').forEach((img) => {
    if (img.complete) return;
    img.addEventListener('load', () => {
      if (S.active !== id) return;
      const gap = els.msgs.scrollHeight - els.msgs.scrollTop - els.msgs.clientHeight;
      if (!els.msgs.querySelector('.new-divider') && gap < 700) apply();
    }, { once: true });
  });
}

/* ── закреплённое сообщение ────────────────────────────────── */
function renderPin() {
  const chat = chatById(S.active);
  const bar = $('#pinBar');
  if (!bar) return;
  if (!chat || !chat.pin) { bar.hidden = true; return; }
  bar.hidden = false;
  bar.dataset.mid = chat.pin.id;
  $('#pinText').textContent = chat.pin.text || '';
}

function unpin() {
  const chat = chatById(S.active);
  if (!chat) return;
  delete chat.pin;
  idb.put('chats', chat);
  idb.del('settings', 'pin:' + chat.id);
  renderPin();
}



function scrollBottom(smooth = true) {
  if (prefs.motion === false) smooth = false;
  if (els.toBottom) els.toBottom.hidden = true;
  unseenCount = 0;
  autoScrolling = true;
  const top = els.msgs.scrollHeight;
  if (smooth) {
    els.msgs.scrollTo({ top, behavior: 'smooth' });
  } else {
    /* мгновенный прыжок: CSS scroll-behavior:smooth иначе анимирует и открытие чата */
    const prev = els.msgs.style.scrollBehavior;
    els.msgs.style.scrollBehavior = 'auto';
    els.msgs.scrollTop = top;
    els.msgs.style.scrollBehavior = prev;
  }
  clearTimeout(scrollBottom._t);
  scrollBottom._t = setTimeout(() => {
    /* страховка: если браузер не анимировал плавный скролл — прыгаем вниз */
    if (!isNearBottom()) els.msgs.scrollTop = els.msgs.scrollHeight;
    autoScrolling = false;
    updateToBottom();
  }, smooth ? 420 : 0);
}

function isNearBottom() {
  return els.msgs.scrollHeight - els.msgs.scrollTop - els.msgs.clientHeight < 160;
}

function updateToBottom() {
  if (!els.toBottom || autoScrolling) return;
  const near = isNearBottom();
  const show = !!(S.active && (!near || unseenCount > 0));
  els.toBottom.hidden = !show;
  if (!show) unseenCount = 0;
  els.toBottom.innerHTML = icon('arrowDown', 18) +
    (unseenCount ? `<span class="tb-count">${unseenCount > 9 ? '9+' : unseenCount}</span>` : '');
  if (near && S.active && document.visibilityState !== 'hidden') sendReadUpto(S.active);
}

function paintDecryptBar() {
  const bar = $('#decryptBar');
  if (!bar) return;
  const id = S.active;
  const n = id ? (S.messages[id] || []).filter((m) => m.decryptFailed && !m.deleted && !m.hidden).length : 0;
  if (!n) { bar.hidden = true; return; }
  if (bar.dataset.hiddenFor === id) { bar.hidden = true; return; }
  bar.hidden = false;
  const text = $('#decryptText');
  if (text) text.textContent = t('decrypt.text').replace('{n}', String(n));
}

/* ── разметка сообщения ────────────────────────────────────── */

/* ── панель действий ─────────────────────────────────────────
   Кнопки создаются только для сообщения под курсором/тапом.
   Раньше 8 кнопок с SVG были в каждом сообщении — до 79% DOM
   длинной ленты уходило на невидимые панели. */
function showTools(el) {
  if (!el) return;
  const m = byId(el.dataset.mid);
  if (!m || m.deleted || m.decryptFailed) return;
  const bubble = el.querySelector(':scope > .bubble');
  if (!bubble || bubble.querySelector(':scope > .tools')) return;
  bubble.insertAdjacentHTML('beforeend', toolsHtml(m, m.sender === 'u_me'));
}

function closeTools() {
  toolsOpen = null;
  const holder = els.msgs;
  if (!holder) return;
  holder.querySelectorAll('.msg.tools-open').forEach((el) => el.classList.remove('tools-open'));
  holder.querySelectorAll('.msg > .bubble > .tools').forEach((t) => t.remove());
}

function toggleTools(el, m) {
  if (!el || !m) return;
  const wasOpen = toolsOpen === m.id;
  closeTools();
  if (wasOpen) return;
  toolsOpen = m.id;
  el.classList.add('tools-open');
  showTools(el);
}



/* ── реакции ───────────────────────────────────────────────── */
function toggleReaction(m, emoji) {
  const mine = (m.reactions || []).some((r) => r.e === emoji && r.by.includes('u_me'));
  closeReact();
  sendReaction(m, emoji, !mine);
}


/* ── переход к цитате ──────────────────────────────────────── */
function jumpTo(id) {
  let el = els.msgs.querySelector(`[data-mid="${nonzeroEscape(id)}"]`);
  if (!el) {
    /* сообщение за пределами первой страницы — догружаем ленту до него */
    const all = (S.messages[S.active] || []).filter((m) => !m.hidden);
    const idx = all.findIndex((m) => m.id === id);
    if (idx < 0) return;
    const need = all.length - idx + 20;
    const cur = S.renderLimit?.[S.active] || PAGE_SIZE;
    if (need > cur) {
      S.renderLimit = { ...(S.renderLimit || {}), [S.active]: need };
      renderMessages({ prepend: true });
      el = els.msgs.querySelector(`[data-mid="${nonzeroEscape(id)}"]`);
    }
  }
  if (!el) return;
  el.scrollIntoView({ block: 'center', behavior: prefs.motion === false ? 'auto' : 'smooth' });
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1100);
}

function nonzeroEscape(id) {
  return (window.CSS && CSS.escape) ? CSS.escape(String(id)) : String(id).replace(/"/g, '\\"');
}

/* ── typing ────────────────────────────────────────────────── */
function typingHtml() {
  const chat = chatById(S.active);
  const uid = S.typingUser || (chat?.kind === 'group'
    ? (chat.members || []).find((x) => x !== S.me?.id) || chat.members?.[0]
    : chat?.userId);
  const u = uid ? user(uid) : { name: '…', hue: 5 };
  const who = chat?.kind === 'group' && uid ? `<span class="typing-who">${esc(u.name)}</span>` : '';
  return `<div class="msg first typing">${avatarHtml(u)}<div class="bubble">${who}<div class="dots"><i></i><i></i><i></i></div></div></div>`;
}

export function showTyping(chatId) {
  S.typingChat = chatId;
  if (S.active === chatId) renderMessages();
}
export function hideTyping(chatId) {
  if (S.typingChat !== chatId) return;
  S.typingChat = null;
  S.typingUser = null;
  if (S.active === chatId) renderMessages();
}

/* ── доступность: объявляем новое сообщение скринридеру ───── */
function announceIncoming(msg) {
  if (!msg || msg.hidden || msg.sender === 'u_me') return;
  if (document.visibilityState === 'hidden') return;
  const el = document.getElementById('srLive');
  if (!el) return;
  const who = user(msg.sender)?.name || '';
  el.textContent = who ? `${who}: ${snippet(msg)}` : snippet(msg);
  clearTimeout(announceIncoming._t);
  announceIncoming._t = setTimeout(() => { el.textContent = ''; }, 2500);
}

/* ── доставка сообщения (совместно с composer и демо-сценарием) ─ */
export async function deliverMessage(chatId, msg) {
  const chat = chatById(chatId);
  if (!chat) return;
  S.messages[chatId] = S.messages[chatId] || [];
  S.messages[chatId].push(msg);
  await idb.put('messages', msg);
  chat.last = { ts: msg.ts, from: msg.sender, type: msg.type, text: msg.text || '' };
  if (S.active !== chatId) chat.unread = (chat.unread || 0) + 1;
  await idb.put('chats', chat);
  if (msg.sender === 'u_me' && !msg.hidden) scheduleDemoRead(chatId, msg);
  if (S.active === chatId) {
    const near = isNearBottom();
    if (!near && msg.sender !== 'u_me') unseenCount++;
    const appended = appendToFeed([msg]);
    if (!appended) renderMessages();
    if (near) scrollBottom();
    else updateToBottom();
    if (near) setReadAt(chatId);
  }
  renderSidebar();
  if (msg.sender !== 'u_me' && !isMuted(chatId)) playMessage();
  if (S.active === chatId) announceIncoming(msg);
  scheduleTtlForChat(chatId);
}

/* Перечитать (при смене языка/обновлении) */
export function rerenderAll() {
  if (S.active) { renderHeader(); renderMessages(); }
  renderSidebar();
}
