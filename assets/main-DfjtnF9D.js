/* Relik — точка входа: сборка экранов, вход, демо-сценарий */
import { APP, SUPABASE } from './config.js';
import { t, initI18n, applyDom } from './i18n/i18n.js';
import { idb } from './db/idb.js';
import { seedIfEmpty, USERS, demoMessage } from './data/mock.js';
import { S, chatById } from './ui/state.js';
import { $ } from './ui/utils.js';
import { applyA11y } from './ui/a11y.js';
import { icon } from './ui/icons.js';
import { toast } from './ui/toast.js';
import { initSidebar, renderSidebar, touchSidebar, loadChats as reloadChats } from './ui/sidebar.js';
import { initChatView, showChat, deliverMessage, showTyping, hideTyping, rerenderAll, clearTtlTimers } from './ui/chatView.js';import { initComposer, refreshBar, retryFailedMessages, retryOutbox, processScheduled } from './ui/composer.js';
import { initModals, openSettings, contactClicked, openNewChat, openPeople, openRequests, refreshRequests, startContactRealtime, closeTransientOverlays } from './ui/modals.js';
import { openRecoveryFlow, maybePromptBackup } from './ui/keyRecovery.js';
import { sweepExpired } from './backend/expiry.js';
import { initPalette, openPalette } from './ui/palette.js';
import { initRecovery } from './ui/recovery.js';
import { seedDemoRequests } from './backend/contacts.js';
import { initTelemetry, logEvent } from './backend/telemetry.js';
import { initNetBar, initServiceWorker, scheduleStorageUpkeep } from './boot/runtime.js';
import {
  initAuth, paintAuth, animateWelcome, routeAfterLogin, isRealBackend, bindAuthHooks,
} from './boot/auth.js';

bindAuthHooks({ enterApp });
import { loadBlocks } from './backend/blocks.js';
import { initRouter, route, showApp, showAuth } from './ui/router.js';
import { applyTheme, currentTheme } from './ui/themes.js';
import { applySavedFont, currentFontId, restoreCustomFont } from './ui/fonts.js';
import { initDevice } from './ui/device.js';
import { maybeShowIosHint } from './ui/iosHint.js';
import { sb } from './backend/supabaseClient.js';
import { signOut, restoreSession, updateLastSeen, saveAvatar } from './backend/auth.js';
import { retryPendingProfile } from './backend/auth.js';
import { subscribeAllMessages, previewTextFor, loadLatestPreviews } from './backend/messages.js';
import { playMessage } from './ui/sounds.js';
import { notifyMessage } from './ui/notify.js';
import { initCalls, stopCalls } from './ui/calls.js';
import { initPin, armPin } from './ui/pin.js';
import { applyPrefs, isMuted, applyRemotePrefs } from './ui/prefs.js';
import { enablePrefsSync, loadRemotePrefs } from './backend/prefsSync.js';
import { clearGroupKeyCache } from './backend/groupKeys.js';
import { clearMediaObjectUrls } from './backend/storage.js';
import { ensureDeviceV2, clearDeviceV2 } from './backend/devices.js';
import { clearV2Sessions } from './backend/v2Messages.js';
import { CRYPTO_V2 } from './config.js';

/* ── статичные иконки и заголовки кнопок (перерисовка при смене языка) ── */
function paintChrome() {
  const paint = (sel, ic, title) => {
    const b = $(sel);
    if (!b) return;
    /* сохраняем счётчик-бейдж внутри кнопки */
    const badge = b.querySelector('.dot-badge');
    if (ic) b.innerHTML = icon(ic, 18) + (badge ? badge.outerHTML : '');
    if (title) {
      b.title = t(title);
      b.setAttribute('aria-label', t(title));
    }
  };
  paint('#newChatBtn', 'plus', 'side.newChat');
  paint('#peopleBtn', 'search', 'side.findPeople');
  paint('#requestsBtn', 'mail', 'side.requests');
  paint('#settingsBtn', 'sliders', 'side.settings');
  paint('#logoutBtn', 'logout', 'side.logout');
  paint('#backBtn', 'back');
  paint('#videoCallBtn', 'video', 'chat.videoCall');
  paint('#shareBtn', 'link', 'chat.share');
  paint('#callBtn', 'phone', 'chat.call');
  paint('#infoBtn', 'info', 'chat.info');
  paint('#chatSearchBtn', 'search', 'chat.searchPh');
  const searchIc = $('#searchIc');
  if (searchIc) searchIc.innerHTML = icon('search', 16);
  const demoIc = $('#demoIc');
  if (demoIc) demoIc.innerHTML = icon('spark', 16);
  const dropIc = $('#dropIc');
  if (dropIc) dropIc.innerHTML = icon('clip', 28);
  const clearIc = $('#clearLocalIc');
  if (clearIc) clearIc.innerHTML = icon('database', 16);
  const groupAddIc = $('#groupAddIc');
  if (groupAddIc) groupAddIc.innerHTML = icon('userPlus', 16);

  const title = (sel, key) => {
    const el = $(sel);
    if (!el) return;
    el.title = t(key);
    el.setAttribute('aria-label', t(key));
  };
  title('#backBtn', 'common.back');
  title('#selClose', 'common.close');
  title('#chatSearchClose', 'common.close');
  title('#chatSearchPrev', 'chat.searchPrev');
  title('#chatSearchNext', 'chat.searchNext');
  title('#pinClose', 'common.close');
  title('#rebX', 'common.close');
  title('#recCancel', 'comp.cancelRecord');
  title('#toBottom', 'chat.toBottom');
  title('#lbX', 'common.close');
  title('#lbDl', 'media.download');
  title('#attachBtn', 'comp.attach');
  title('#emojiBtn', 'comp.emoji');
  title('#recCancel', 'comp.cancelRecord');

  const send = $('#sendBtn');
  if (send) {
    const mic = send.classList.contains('mic');
    send.title = t(mic ? 'comp.voice' : 'comp.send');
    send.setAttribute('aria-label', send.title);
  }
}


/* ── запуск приложения после входа/регистрации ── */
async function enterApp(welcomeKey) {
  showApp();
  armPin();
  if (isRealBackend) {
    reloadChats().then(() => { S.chatsLoading = false; renderSidebar(true); retryOutbox(); }).catch(() => { S.chatsLoading = false; });
  }
  renderSidebar();
  showChat();
  paintEmptyChips();

  const pendingJoin = sessionStorage.getItem('relik.pendingJoin');
  if (pendingJoin) {
    sessionStorage.removeItem('relik.pendingJoin');
    location.hash = `#/join/${pendingJoin}`;
  } else {
    routeAfterLogin();
  }
  handlePwaAction();

  animateWelcome();
  toast(t(welcomeKey));
  $('#authPass').value = '';
  maybeDemo();
  startGlobalRealtime();
  initCalls();
  if (CRYPTO_V2.enabled) ensureDeviceV2().catch(() => {});
  retryPendingProfile().catch(() => {});
  processScheduled().catch(() => {});
  sweepExpired(true).catch(() => {});
  setTimeout(() => maybePromptBackup().catch(() => {}), 1800);
  syncPrefsFromCloud().catch(() => {});
}


/* PWA-ярлыки: ./?action=new|settings|search — открываем нужный экран
   после входа и убираем action из URL, чтобы он не срабатывал снова. */
function handlePwaAction() {
  if (!S.me) return;
  let action = '';
  try {
    const u = new URL(location.href);
    action = u.searchParams.get('action') || '';
    if (action) {
      u.searchParams.delete('action');
      history.replaceState(null, '', u.pathname + u.search + u.hash);
    }
  } catch (e) {
    return;
  }
  if (!action) return;
  setTimeout(() => {
    if (action === 'new') openNewChat();
    else if (action === 'settings') openSettings();
    else if (action === 'search') openPalette('');
    else if (action === 'people') openPeople();
  }, 220);
}

/* ── проверка, что Supabase-сессия ещё жива ───────────────── */
let sessionCheckedAt = 0;
async function validateSession(force = false) {
  if (!isRealBackend || !S.me?.id) return;
  if (!force && Date.now() - sessionCheckedAt < 60000) return;
  sessionCheckedAt = Date.now();
  try {
    const { data, error } = await sb.auth.getUser();
    if (error || !data?.user) {
      const msg = error?.message || '';
      if (/jwt|session|401|invalid|missing/i.test(msg)) {
        S.me = null;
        S.chats = [];
        S.active = null;
        S.messages = {};
        showAuth();
        toast(t('auth.sessionExpired'), { type: 'error' });
      }
    } else if (data.user.id !== S.me.id) {
      /* В браузере активна сессия другого аккаунта */
      S.me = null;
      S.chats = [];
      S.active = null;
      S.messages = {};
      showAuth();
      toast(t('auth.otherTab'), { type: 'error', duration: 0 });
    }
  } catch (e) { /* офлайн — не выкидываем из аккаунта */ }
}

/* ── кнопки сайдбара и шапки ── */
function initChrome() {
  $('#newChatBtn').addEventListener('click', openNewChat);
  $('#peopleBtn').addEventListener('click', openPeople);
  $('#requestsBtn').addEventListener('click', openRequests);
  $('#emptyNewChat').addEventListener('click', openNewChat);
  $('#emptySettings').addEventListener('click', openSettings);
  $('#emptyInvite')?.addEventListener('click', async () => {
    const link = `${location.origin}${location.pathname.replace(/index\.html$/, '')}`;
    try {
      await navigator.clipboard.writeText(link);
      toast(t('chat.inviteCopied'), { type: 'success' });
    } catch (e) {
      toast(link, { duration: 0 });
    }
  });
  $('#ncList').addEventListener('click', contactClicked);
  $('#sideLogo').addEventListener('click', () => { location.hash = '#/app'; S.active = null; showChat(); });
  $('#meChip').addEventListener('click', openSettings);
  $('#settingsBtn').addEventListener('click', openSettings);
  $('#logoutBtn').addEventListener('click', async () => {
    if (isRealBackend) {
      try {
        await signOut();
      } catch (err) {
        console.error('Logout error:', err);
      }
    } else {
      await idb.del('settings', 'me');
    }
    S.me = null;
    S.chats = [];
    S.active = null;
    S.messages = {};
    S.unreadFrom = {};
    S.renderLimit = {};
    S.drafts = {};
    S.typingChat = null;
    clearGroupKeyCache().catch(() => {});
    clearMediaObjectUrls();
    clearTtlTimers();
    clearDeviceV2().catch(() => {});
    clearV2Sessions().catch(() => {});
    document.title = 'Relik';
    try { navigator.clearAppBadge?.(); } catch (e) { /* ignore */ }
    stopCalls();
    stopSidebarRefresh();
    if (globalSub) { globalSub.unsubscribe(); globalSub = null; }
    location.hash = '#/auth';
    showAuth();
    toast(t(isRealBackend ? 'toast.loggedOut' : 'toast.logout'));
  });
}

/* ── чипы в пустом состоянии чата ── */
function paintEmptyChips() {
  const el = $('#emptyChips');
  if (!el) return;
  el.innerHTML = isRealBackend
    ? `<span class="chip">${icon('lock', 14)} ${t('chat.e2eChip')}</span>
       <span class="chip">${icon('shield', 14)} ${t('chat.freeChip')}</span>`
    : `<span class="chip">${t('chat.demoTitle')}</span>
       <span class="chip">${t('chat.demoText')}</span>`;
}

/* ── Синхронизация закрепов/мьютов и оформления между устройствами ── */
async function syncPrefsFromCloud() {
  if (!isRealBackend || !S.me) return;
  enablePrefsSync();
  const remote = await loadRemotePrefs();
  if (!remote) return;
  if (applyRemotePrefs(remote)) {
    applyTheme(currentTheme(), false);
    renderSidebar();
    rerenderAll();
  }
}

/* ── глобальные уведомления о новых сообщениях ── */
let globalSub = null;
let sidebarTimer = null;
let sidebarBusy = false;

function startGlobalRealtime() {
  if (!S.me) return;

  /* заявки в контакты работают и в демо-режиме:
     счётчик на конверте + live-обновление */
  refreshRequests().catch(() => {});
  startContactRealtime();
  /* блокировки: скрыть чаты и запретить отправку */
  loadBlocks().then(() => renderSidebar()).catch(() => {});
  /* realtime может быть не включён для таблицы — тихо сверяем раз в 30 с */
  if (!window.__reqTimer) {
    window.__reqTimer = setInterval(() => {
      if (document.visibilityState === 'visible' && S.me) refreshRequests().catch(() => {});
    }, 30000);
  }

  if (!isRealBackend || globalSub) return;
  globalSub = subscribeAllMessages(async (row) => {
    if (!row) return;
    const chat = chatById(row.conversation_id);
    if (!chat) {
      /* Новый чат создан другим человеком, пока мы были онлайн.
         Подтягиваем список, иначе сообщение некуда положить. */
      reloadChats().then(() => renderSidebar()).catch(() => {});
      return;
    }
    if (row.sender_id === S.me.id) return; // свои сообщения обрабатываются локально
    if (S.active === row.conversation_id) return; // открытый чат — своя подписка

    const text = await previewTextFor(row, chat);
    if (text == null) return; // голос в опросе не показываем
    chat.last = { ts: Date.now(), from: row.sender_id, type: 'text', text };
    chat.unread = (chat.unread || 0) + 1;
    await idb.put('chats', chat);
    renderSidebar();
    if (!isMuted(chat.id)) {
      playMessage();
      notifyMessage(chat, text, () => { location.hash = `#/chat/${chat.id}`; });
    }
  });

  /* Realtime может не дойти (сеть/RLS) — раз в 10 секунд тихо сверяем список */
  if (!sidebarTimer) {
    sidebarTimer = setInterval(refreshChatListQuiet, 10000);
  }
}

function stopSidebarRefresh() {
  if (sidebarTimer) { clearInterval(sidebarTimer); sidebarTimer = null; }
}

/* Тихая синхронизация превью в списке чатов — без перезагрузки страницы */
async function refreshChatListQuiet() {
  if (!isRealBackend || !S.me || sidebarBusy) return;
  if (document.visibilityState === 'hidden') return;
  sidebarBusy = true;
  try {
    const latest = await loadLatestPreviews();
    let changed = false;
    let incoming = false;
    let audible = false;

    /* Если появился чат, которого нет в локальном списке (его создал
       собеседник), сначала перечитываем список чатов. */
    const known = new Set(S.chats.map((c) => c.id));
    const hasUnknown = [...latest.keys()].some((id) => !known.has(id));
    if (hasUnknown) {
      await reloadChats();
      changed = true;
    }

    for (const chat of S.chats) {
      const rows = latest.get(chat.id) || [];
      for (const row of rows) {
        const ts = new Date(row.created_at).getTime();
        if ((chat.last?.ts || 0) >= ts) break;

        const text = await previewTextFor(row, chat);
        if (text == null) continue; // голос/реакция/опрос/прочтение
        const mine = row.sender_id === S.me.id;
        chat.last = { ts, from: mine ? 'u_me' : row.sender_id, type: 'text', text };
        if (!mine) {
          if (S.active !== chat.id) chat.unread = (chat.unread || 0) + 1;
          incoming = true;
          if (!isMuted(chat.id)) audible = true;
        }
        await idb.put('chats', chat);
        changed = true;
        break;
      }
    }

    if (changed) renderSidebar();
    if (incoming && audible) playMessage();
  } catch (err) {
    /* тихо: сеть/RLS восстановятся сами */
  } finally {
    sidebarBusy = false;
  }
}

/* ── демо-сцена: в чат «прилетает» живое сообщение ── */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function maybeDemo() {
  if (!S.me || sessionStorage.getItem('relik.demo')) return;
  sessionStorage.setItem('relik.demo', '1');
  setTimeout(async () => {
    if (!chatById('c_alina')) return;
    showTyping('c_alina');
    await wait(2200);
    hideTyping('c_alina');
    deliverMessage('c_alina', demoMessage());
  }, 6000);
}

/* ── запуск ── */
const quick = (p, ms = 2500) => Promise.race([
  Promise.resolve(p).catch(() => null),
  new Promise((r) => setTimeout(() => r(null), ms)),
]);

/* Жёсткий таймаут с ошибкой: нужен там, где «нет ответа» нельзя путать с «нет сессии» */
const withTimeout = (p, ms) => Promise.race([
  Promise.resolve(p),
  new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)),
]);

/* Заглушка загрузки из index.html убирается, как только что-то показано */
function bootDone() {
  document.documentElement.dataset.boot = 'done';
  try { if (window.relikBoot) window.relikBoot.done(); } catch (e) { /* ignore */ }
}


/* ── запуск ── */
async function boot() {
  initTelemetry();
  logEvent('boot', { ua: navigator.userAgent.slice(0, 120) });
  initI18n();
  applyDom();

  /* тема и шрифт — до первого рендера */
  applyPrefs();
  applyTheme(currentTheme(), false);
  applySavedFont();
  if (currentFontId() === 'custom') {
    try { await restoreCustomFont(); } catch (e) { /* ignore */ }
  }

  /* раскладка подстраивается автоматически: телефон / планшет / компьютер */
  initDevice();

  /* сеть и обновления */
  initNetBar();
  initServiceWorker();
  scheduleStorageUpkeep();
  maybeShowIosHint();

  /* Весь UI собираем сразу, не дожидаясь сети */
  initSidebar();
  initChatView();
  initComposer();
  initModals();
  initPalette();
  initRecovery();
  initRouter();
  initAuth();
  initPin();
  initChrome();
  paintChrome();
  applyA11y();

  document.addEventListener('relik:lang', () => {
    applyDom();
    paintChrome();
    paintAuth();
    paintEmptyChips();
    rerenderAll();
    refreshBar();
    applyA11y();
  });

  /* при смене чата/экрана закрываем открытые окна (как в Telegram) */
  window.addEventListener('hashchange', () => {
    closeTransientOverlays();
    if (location.hash === '#/app' || location.hash === '' || location.hash === '#/') {
      setTimeout(animateWelcome, 60);
    }
  });

  /* тик: пересчитать времена в списке */
  setInterval(touchSidebar, 30000);

  /* тик: обновление presence (если есть реальный бэкенд) */
  if (isRealBackend) {
    setInterval(updateLastSeen, 30000);
    /* при возврате в окно — обновить чаты и статусы */
  window.addEventListener('focus', () => {
    if (S.me) reloadChats().then(() => retryOutbox()).catch(() => {});
    validateSession();
    refreshRequests().catch(() => {});
  });
  }

  /* сервис-воркер регистрируется в initServiceWorker() выше */

  if (isRealBackend) {
    /* Из кэша показываем мгновенно, сессию проверяем в фоне */
    const cachedMe = await quick(idb.get('settings', 'me'), 2000);
    if (cachedMe?.value) S.me = cachedMe.value;

    if (S.me) {
      S.chats = (await quick(idb.getAll('chats'), 2000)) || [];
      S.chatsLoading = !S.chats.length;
      showApp();
      armPin();
      renderSidebar(true);
      startGlobalRealtime();
      initCalls();
      syncPrefsFromCloud().catch(() => {});
      if (CRYPTO_V2.enabled) ensureDeviceV2().catch(() => {});
      maybeDemo();
      handlePwaAction();
      reloadChats()
        .then(() => { S.chatsLoading = false; renderSidebar(true); })
        .catch(() => { S.chatsLoading = false; renderSidebar(true); });
    } else {
      showAuth();
    }

    route();
    renderSidebar();
    paintEmptyChips();
    animateWelcome();
    bootDone();                       // ← экран уже на месте, белой заглушки больше нет
    if (S.me) validateSession(true);

    /* дальше — только фон: сеть может быть медленной или недоступной */
    withTimeout(restoreSession(), 12000)
      .then(async (m) => {
        if (!m) {
          if (S.me) {                 // кэш был, но сессия протухла
            S.me = null;
            S.chats = [];
            showAuth();
          }
          return;
        }
        const fresh = !S.me || S.me.id !== m.id;
        const cachedAvatar = !fresh && S.me?.avatar ? S.me.avatar : null;
        S.me = m;
        /* аватар, сохранённый раньше только в браузере, досохраняем на бэкенд */
        if (!m.avatar && cachedAvatar) {
          S.me.avatar = cachedAvatar;
          saveAvatar(cachedAvatar).catch((err) => console.warn('Avatar sync failed:', err));
        }
        idb.put('settings', { key: 'me', value: S.me }).catch(() => {});
        if (m.keyMissing && m.hasRecovery) {
          /* локального ключа нет (новое устройство / чистка браузера),
             но резервная копия фразой есть — предлагаем восстановить */
          setTimeout(() => openRecoveryFlow({ force: true }), 900);
        } else if (!m.keyMissing && m.hasRecovery === false) {
          setTimeout(() => maybePromptBackup().catch(() => {}), 2000);
        }
        if (fresh) {
          showApp();
          armPin();
          renderSidebar();
          initCalls();
          startGlobalRealtime();
          syncPrefsFromCloud().catch(() => {});
      if (CRYPTO_V2.enabled) ensureDeviceV2().catch(() => {});
          maybeDemo();
          route();
          handlePwaAction();
        }
        reloadChats().then(() => retryOutbox()).catch(() => {});
      })
      .catch((err) => console.warn('Session check failed:', err));

    /* проверка доступности сервера: без связи/VPN покажем понятное сообщение */
    probeServer();
    return;
  }

  /* ── демо-режим на IndexedDB ── */
  try {
    S.users = USERS;
    S.chats = (await quick(idb.getAll('chats'), 2000)) || [];
    const meRec = await quick(idb.get('settings', 'me'), 2000);
    S.me = meRec?.value || null;
    /* Сид генерирует превью и занимает пару секунд — не держим им первую отрисовку.
       Когда закончит, перечитываем список чатов. */
    seedIfEmpty().then(() => reloadChats()).catch(() => {});
  } catch (err) {
    console.error('Demo init error:', err);
  }

  if (S.me) {
    showApp();
    armPin();
    maybeDemo();
    seedDemoRequests(S.users).then(() => refreshRequests()).catch(() => {});
    startGlobalRealtime();
    initCalls();
    handlePwaAction();
  } else {
    showAuth();
  }
  route();
  renderSidebar();
  paintEmptyChips();
  animateWelcome();
  bootDone();
}

/* Тихая проверка сервера: не показываем ложное «нет сети».
   Реальные проблемы видны при действиях (вход, отправка сообщения). */
let serverChecked = false;
async function probeServer() {
  if (serverChecked || !SUPABASE.url) return;
  serverChecked = true;
  try {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), 15000) : null;
    const res = await fetch(`${SUPABASE.url}/auth/v1/health`, {
      method: 'GET',
      cache: 'no-store',
      signal: ctrl ? ctrl.signal : undefined,
      headers: { apikey: SUPABASE.anonKey },
    });
    if (timer) clearTimeout(timer);
    if (res.status >= 500) console.warn('Server health:', res.status);
  } catch (err) {
    console.warn('Server health check failed:', err && err.message ? err.message : err);
  }
}

/* Связь восстановилась — досылаем недоставленные сообщения и обновляем чаты */
window.addEventListener('online', () => {
  if (!S.me) return;
  retryFailedMessages();
  retryOutbox();
  retryPendingProfile().catch(() => {});
  reloadChats().catch(() => {});
});

/* Вторая вкладка не должна незаметно ломать сессию первой */
window.addEventListener('storage', (e) => {
  if (e.key !== 'relik-auth' || !e.newValue || !S.me) return;
  try {
    const data = JSON.parse(e.newValue);
    const uid = data?.user?.id || data?.currentSession?.user?.id;
    if (uid && uid !== S.me.id) {
      S.me = null;
      S.chats = [];
      S.active = null;
      S.messages = {};
      showAuth();
      toast(t('auth.otherTab'), { type: 'error', duration: 0 });
    }
  } catch (err) { /* не session JSON */ }
});

/* Вернулись во вкладку — тоже проверяем очередь исходящих */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.me) {
    retryOutbox();
    validateSession();
  }
});

/* Очередь исходящих не должна ждать фокуса: раз в 20 секунд пробуем снова,
   пока приложение открыто и есть сеть. */
setInterval(() => {
  if (!S.me || document.visibilityState !== 'visible') return;
  retryOutbox();
}, 20000);

/* Открыть чат по клику на push-уведомление */
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (e) => {
    const url = e.data && e.data.type === 'relik:open-chat' ? e.data.url : '';
    if (!url) return;
    try {
      const u = new URL(url, location.href);
      if (u.hash) location.hash = u.hash;
    } catch (err) { /* ignore */ }
  });
}

/* Заголовок и версия */
document.title = APP.name;
console.info(`%cRelik v${APP.version}`, 'color:#5b6cf9;font-weight:bold', `· ${APP.phase}`);

boot().catch((err) => {
  console.error('Boot failed:', err);
  if (window.relikBoot) window.relikBoot.fail('Не удалось запустить Relik', err && err.message ? err.message : err);
});
