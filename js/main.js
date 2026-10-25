/* Relik — точка входа: сборка экранов, вход, демо-сценарий */
import { APP, SUPABASE } from './config.js';
import { t, initI18n, applyDom } from './i18n/i18n.js';
import { idb } from './db/idb.js';
import { seedIfEmpty, USERS, ME, demoMessage } from './data/mock.js';
import { S, chatById } from './ui/state.js';
import { $ } from './ui/utils.js';
import { icon } from './ui/icons.js';
import { toast } from './ui/toast.js';
import { initSidebar, renderSidebar, touchSidebar, loadChats as reloadChats } from './ui/sidebar.js';
import { initChatView, showChat, deliverMessage, showTyping, hideTyping, rerenderAll, clearTtlTimers } from './ui/chatView.js';import { initComposer, refreshBar, retryFailedMessages, retryOutbox, processScheduled } from './ui/composer.js';
import { initModals, openSettings, contactClicked, openNewChat, openPeople, openRequests, refreshRequests, startContactRealtime } from './ui/modals.js';
import { seedDemoRequests } from './backend/contacts.js';
import { initRouter, route, showApp, showAuth } from './ui/router.js';
import { applyTheme, currentTheme } from './ui/themes.js';
import { applySavedFont, currentFontId, restoreCustomFont } from './ui/fonts.js';
import { initDevice } from './ui/device.js';
import { sb } from './backend/supabaseClient.js';
import { signUp, signIn, signOut, restoreSession, updateLastSeen, verifySignupCode, saveAvatar } from './backend/auth.js';
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

/* ── экран входа (демо или реальный Supabase) ── */
let authMode = 'login';
let lastPass = '';
let verifyEmail = '';
let verifyMode = 'email';
let pendingSignup = null;
const isRealBackend = !!sb; // использует ли реальный Supabase

function paintAuth() {
  $('#authGo').textContent = t(authMode === 'login' ? 'auth.login' : 'auth.create');
  $('#nameField').hidden = authMode === 'login';
  document.querySelectorAll('.auth-tab').forEach((b) => {
    b.classList.toggle('on', b.dataset.mode === authMode);
  });

  // Показываем заметку о демо-режиме если нет Supabase
  const note = $('.auth-note');
  if (note) {
    note.hidden = isRealBackend;
  }

  // Анимация приветствия
  animateWelcome();
}

/* ── «Welcome to Relik!» — побуквенное появление (вход + пустой чат) ── */
let welcomeRun = 0;
function animateWelcome() {
  const text = 'Welcome to Relik!';
  const run = ++welcomeRun;

  /* экран входа */
  const authEl = $('#authWelcome');
  if (authEl) {
    authEl.textContent = '';
    let i = 0;
    clearInterval(authEl._timer);
    authEl._timer = setInterval(() => {
      if (run !== welcomeRun) { clearInterval(authEl._timer); return; }
      if (i < text.length) { authEl.textContent += text[i]; i++; }
      else clearInterval(authEl._timer);
    }, 55);
  }

  /* пустой чат: побуквенно + мигающий курсор */
  const target = document.querySelector('.welcome-title i');
  if (target) {
    target.innerHTML = '';
    const caret = document.createElement('span');
    caret.className = 'caret';
    target.appendChild(caret);
    let j = 0;
    const step = () => {
      if (run !== welcomeRun || !caret.isConnected) return;
      if (j >= text.length) { setTimeout(() => caret.remove(), 1200); return; }
      const ch = document.createElement('span');
      ch.className = 'ch';
      ch.textContent = text[j] === ' ' ? '\u00A0' : text[j];
      target.insertBefore(ch, caret);
      requestAnimationFrame(() => ch.classList.add('on'));
      j++;
      setTimeout(step, 55);
    };
    setTimeout(step, 350);
  }
}

function initAuth() {
  const form = $('#authForm');
  const card = $('#authCard');

  /* вкладки Вход / Регистрация */
  document.querySelectorAll('.auth-tab').forEach((b) => {
    b.addEventListener('click', () => {
      authMode = b.dataset.mode === 'signup' ? 'signup' : 'login';
      paintAuth();
    });
  });

  /* показать/скрыть пароль */
  const passToggle = $('#passToggle');
  if (passToggle) {
    passToggle.innerHTML = icon('eye', 17);
    passToggle.addEventListener('click', () => {
      const pass = $('#authPass');
      const show = pass.type === 'password';
      pass.type = show ? 'text' : 'password';
      passToggle.innerHTML = icon(show ? 'eyeOff' : 'eye', 17);
      pass.focus();
    });
  }

  /* сброс пароля */
  const forgot = $('#forgotBtn');
  if (forgot) {
    forgot.addEventListener('click', async () => {
      const email = $('#authEmail').value.trim().toLowerCase();
      if (!/.+@.+\..+/.test(email)) { toast(t('auth.badEmail')); return; }
      if (!isRealBackend || !sb) { toast(t('auth.resetDemo')); return; }
      try {
        const { error } = await sb.auth.resetPasswordForEmail(email, {
          redirectTo: location.origin + location.pathname,
        });
        if (error) throw error;
        toast(t('auth.resetSent'));
      } catch (err) {
        toast(err.message || t('auth.resetError'));
      }
    });
  }

  /* иконки в полях и фичах */
  const ic = (sel, name) => { const el = $(sel); if (el) el.innerHTML = icon(name, 16); };
  ic('#emailIc', 'mail');
  ic('#passIc', 'lock');
  ic('#nameIc', 'user');
  ic('#trustIc', 'shield');
  ic('#bf1', 'shield');
  ic('#bf2', 'spark');
  ic('#bf3', 'lock');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('#authEmail').value.trim().toLowerCase();
    const pass = $('#authPass').value;
    const name = $('#authName').value.trim();
    const bad = (why) => {
      card.classList.remove('shake'); void card.offsetWidth; card.classList.add('shake');
      toast(why);
    };
    if (!/.+@.+\..+/.test(email)) return bad(t('auth.badEmail'));
    if (pass.length < 6) return bad(t('auth.shortPass'));
    if (authMode === 'signup' && !name) return bad(t('auth.needName'));

    lastPass = pass;

    /* Регистрация: сначала спрашиваем код доступа */
    if (authMode === 'signup' && isRealBackend) {
      pendingSignup = { email, pass, name };
      showVerify(null, 'invite');
      return;
    }

    try {
      if (isRealBackend) {
        if (authMode === 'signup') {
          sessionStorage.setItem('relik.pendingName', name);
          const res = await signUp(email, pass);
          if (res && res.pending) {
            showVerify(email);
            return;
          }
          S.me = res;
        } else {
          try {
            S.me = await signIn(email, pass);
          } catch (err) {
            if (/confirm|not confirmed/i.test(err.message || '')) {
              showVerify(email);
              return;
            }
            throw err;
          }
        }
      } else {
        // Демо-режим
        S.me = {
          ...ME,
          name: authMode === 'signup' ? name : email.split('@')[0].replace(/[._-]/g, ' '),
          mail: email,
        };
        await idb.put('settings', { key: 'me', value: S.me });
      }

      await enterApp(authMode === 'login' ? 'auth.welcomeLogin' : 'auth.welcomeSignup');
    } catch (err) {
      const msg = err.message || '';
      const offline = /failed to fetch|network|load failed|timeout|abort|offline/i.test(msg);
      bad(offline ? t('net.unreachable') : (msg || t('auth.error')));
    }
  });

  /* подтверждение email кодом */
  wireVerify();

  paintAuth();
}

/* ── запуск приложения после входа/регистрации ── */
async function enterApp(welcomeKey) {
  showApp();
  armPin();
  if (isRealBackend) {
    reloadChats().then(() => retryOutbox()).catch((err) => console.error('Load chats error:', err));
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

  animateWelcome();
  toast(t(welcomeKey));
  $('#authPass').value = '';
  maybeDemo();
  startGlobalRealtime();
  initCalls();
  if (CRYPTO_V2.enabled) ensureDeviceV2().catch(() => {});
  retryPendingProfile().catch(() => {});
  processScheduled().catch(() => {});
  syncPrefsFromCloud().catch(() => {});
}

/* ── код доступа / подтверждение email ── */
function showVerify(email, mode = 'email') {
  verifyMode = mode;
  verifyEmail = email || '';
  const isInvite = mode === 'invite';

  $('#verifyTitle').textContent = t(isInvite ? 'verify.inviteTitle' : 'verify.title');
  $('#verifySub').textContent = t(isInvite ? 'verify.inviteSub' : 'verify.sub');
  $('#verifyEmail').textContent = verifyEmail;

  const inp = $('#verifyCode');
  inp.value = '';
  inp.classList.toggle('invite', isInvite);
  inp.maxLength = isInvite ? 20 : 7;
  inp.inputMode = isInvite ? 'text' : 'numeric';
  inp.autocomplete = isInvite ? 'off' : 'one-time-code';
  inp.placeholder = t(isInvite ? 'verify.invitePh' : 'verify.ph');

  $('#verifyResend').hidden = isInvite;
  $('#verifyGo').textContent = t(isInvite ? 'verify.continue' : 'verify.confirm');
  $('#verifyOv').hidden = false;
  setTimeout(() => inp.focus(), 60);
}

async function checkInviteCode(code) {
  const expected = 'RELIK2013';
  const timeout = new Promise((resolve) => setTimeout(() => resolve('timeout'), 8000));
  const request = (async () => {
    try {
      const { data, error } = await sb.rpc('check_signup_code', { code });
      if (error) {
        const missing = /could not find|does not exist|schema cache|function/i.test(error.message || '');
        return missing ? code === expected : false;
      }
      return data === true;
    } catch (e) {
      return code === expected;
    }
  })();
  return await Promise.race([request, timeout]);
}

async function submitAccessCode() {
  const code = $('#verifyCode').value.trim().toUpperCase();
  if (!code) { toast(t('verify.needCode')); return; }

  $('#verifyGo').disabled = true;
  $('#verifyGo').textContent = t('verify.checking');

  const check = await checkInviteCode(code);
  if (check === 'timeout') {
    $('#verifyGo').disabled = false;
    $('#verifyGo').textContent = t('verify.continue');
    toast(t('verify.timeout'), { type: 'error' });
    return;
  }
  if (!check) {
    $('#verifyGo').disabled = false;
    $('#verifyGo').textContent = t('verify.continue');
    toast(t('verify.wrongInvite'));
    return;
  }

  const p = pendingSignup;
  if (!p) { $('#verifyOv').hidden = true; return; }

  try {
    $('#verifyGo').textContent = t('verify.creating');
    sessionStorage.setItem('relik.pendingName', p.name);
    const res = await signUp(p.email, p.pass);
    if (res && res.pending) {
      showVerify(p.email, 'email');
      return;
    }
    S.me = res;
    pendingSignup = null;
    $('#verifyOv').hidden = true;
    await enterApp('auth.welcomeSignup');
  } catch (err) {
    const msg = err.message || '';
    if (/rate limit|over_email_send_rate_limit/i.test(msg)) toast(t('verify.emailGate'));
    else if (/profile-timeout|timeout/i.test(msg)) toast(t('verify.timeout'));
    else toast(msg || t('verify.error'));
  } finally {
    $('#verifyGo').disabled = false;
    $('#verifyGo').textContent = t(verifyMode === 'invite' ? 'verify.continue' : 'verify.confirm');
  }
}

function wireVerify() {
  $('#verifyCode').addEventListener('input', (e) => {
    if (verifyMode !== 'email') {
      e.target.value = e.target.value.toUpperCase().replace(/\s+/g, '');
      return;
    }
    const d = e.target.value.replace(/\D/g, '').slice(0, 6);
    e.target.value = d.length > 3 ? `${d.slice(0, 3)}-${d.slice(3)}` : d;
  });

  $('#verifyGo').addEventListener('click', async () => {
    if (verifyMode === 'invite') { await submitAccessCode(); return; }

    const digits = $('#verifyCode').value.replace(/\D/g, '');
    if (digits.length !== 6) { toast(t('verify.badCode')); return; }
    try {
      $('#verifyGo').disabled = true;
      S.me = await verifySignupCode(verifyEmail, digits, lastPass);
      $('#verifyOv').hidden = true;
      await enterApp('auth.welcomeSignup');
    } catch (err) {
      toast(err.message || t('verify.error'));
    } finally {
      $('#verifyGo').disabled = false;
    }
  });

  $('#verifyResend').addEventListener('click', async () => {
    if (!isRealBackend || !sb) { toast(t('auth.resetDemo')); return; }
    try {
      const { error } = await sb.auth.resend({ type: 'signup', email: verifyEmail });
      if (error) throw error;
      toast(t('verify.sent'));
    } catch (err) {
      toast(err.message || t('verify.error'));
    }
  });
}

function routeAfterLogin() {
  if (!location.hash || location.hash.startsWith('#/auth') || location.hash === '#/') {
    location.hash = '#/app';
  } else {
    route();
  }
  renderSidebar();
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
  try { if (window.relikBoot) window.relikBoot.done(); } catch (e) { /* ignore */ }
}

/* ── Плашка состояния сети ─────────────────────────────────── */
function initNetBar() {
  const bar = $('#netBar');
  const text = $('#netText');
  const ic = $('#netIc');
  if (!bar || !text || !ic) return;

  let offline = navigator.onLine === false;
  let hideTimer = 0;

  const paint = (state, message) => {
    clearTimeout(hideTimer);
    bar.hidden = false;
    bar.classList.remove('ok', 'bad');
    if (state) bar.classList.add(state);
    ic.innerHTML = icon(state === 'ok' ? 'checkCircle' : 'wifiOff', 15);
    text.textContent = message;
  };

  const showOffline = () => paint('bad', t('net.offline'));
  const showRestored = () => {
    paint('ok', t('net.restored'));
    hideTimer = setTimeout(() => { bar.hidden = true; }, 2600);
  };

  if (offline) showOffline();

  window.addEventListener('offline', () => {
    offline = true;
    showOffline();
  });
  window.addEventListener('online', () => {
    if (!offline) return;
    offline = false;
    showRestored();
  });
  document.addEventListener('relik:lang', () => {
    if (offline) showOffline();
  });
}

/* ── Обновление service worker: показываем «Обновить» ───────── */
function initServiceWorker() {
  if (!('serviceWorker' in navigator) || !location.protocol.startsWith('http')) return;

  let hadController = !!navigator.serviceWorker.controller;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    /* первый controller — это первая установка, а не обновление */
    if (!hadController) { hadController = true; return; }
    toast(t('update.available'), {
      type: 'warn',
      duration: 0,
      action: { label: t('update.reload'), onClick: () => location.reload() },
    });
  });

  navigator.serviceWorker.register('sw.js').then((reg) => {
    const notifyWaiting = () => {
      if (!reg.waiting) return;
      toast(t('update.available'), {
        type: 'warn',
        duration: 0,
        action: {
          label: t('update.reload'),
          onClick: () => {
            reg.waiting?.postMessage({ type: 'SKIP_WAITING' });
            location.reload();
          },
        },
      });
    };
    if (reg.waiting) notifyWaiting();
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      if (!nw) return;
      nw.addEventListener('statechange', () => {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) notifyWaiting();
      });
    });
  }).catch(() => {});
}

/* ── запуск ── */
async function boot() {
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

  /* Весь UI собираем сразу, не дожидаясь сети */
  initSidebar();
  initChatView();
  initComposer();
  initModals();
  initRouter();
  initAuth();
  initPin();
  initChrome();
  paintChrome();

  document.addEventListener('relik:lang', () => {
    applyDom();
    paintChrome();
    paintAuth();
    paintEmptyChips();
    rerenderAll();
    refreshBar();
  });

  /* при возврате к пустому состоянию — повторить приветствие */
  window.addEventListener('hashchange', () => {
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
      showApp();
      armPin();
      renderSidebar();
      startGlobalRealtime();
      initCalls();
      syncPrefsFromCloud().catch(() => {});
      if (CRYPTO_V2.enabled) ensureDeviceV2().catch(() => {});
      maybeDemo();
      reloadChats().catch(() => {});
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
    await quick(seedIfEmpty(), 2500);
    S.users = USERS;
    S.chats = (await quick(idb.getAll('chats'), 2000)) || [];
    const meRec = await quick(idb.get('settings', 'me'), 2000);
    S.me = meRec?.value || null;
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

/* Заголовок и версия */
document.title = APP.name;
console.info(`%cRelik v${APP.version}`, 'color:#5b6cf9;font-weight:bold', `· ${APP.phase}`);

boot().catch((err) => {
  console.error('Boot failed:', err);
  if (window.relikBoot) window.relikBoot.fail('Не удалось запустить Relik', err && err.message ? err.message : err);
});
