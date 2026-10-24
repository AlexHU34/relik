/* Relik — точка входа: сборка экранов, вход, демо-сценарий */
import { APP, SUPABASE } from './config.js';
import { t, initI18n, applyDom } from './i18n/i18n.js';
import { idb } from './db/idb.js';
import { seedIfEmpty, USERS, ME, demoMessage } from './data/mock.js';
import { S, chatById } from './ui/state.js';
import { $, avatarHtml } from './ui/utils.js';
import { icon } from './ui/icons.js';
import { toast } from './ui/toast.js';
import { initSidebar, renderSidebar, touchSidebar, loadChats as reloadChats } from './ui/sidebar.js';
import { initChatView, showChat, deliverMessage, showTyping, hideTyping, rerenderAll } from './ui/chatView.js';
import { initComposer, refreshBar } from './ui/composer.js';
import { initModals, openSettings, contactClicked, openNewChat } from './ui/modals.js';
import { initRouter, route, showApp, showAuth } from './ui/router.js';
import { applyTheme, currentTheme } from './ui/themes.js';
import { applySavedFont, currentFontId, restoreCustomFont } from './ui/fonts.js';
import { initDevice } from './ui/device.js';
import { sb } from './backend/supabaseClient.js';
import { signUp, signIn, signOut, restoreSession, updateProfile, updateLastSeen, verifySignupCode } from './backend/auth.js';
import { loadChats, searchUsers, getProfile } from './backend/chats.js';
import { loadMessages, subscribeToChat, updateReadReceipt, subscribeAllMessages, previewTextFor } from './backend/messages.js';
import { playMessage } from './ui/sounds.js';
import { initCalls, stopCalls } from './ui/calls.js';

/* ── статичные иконки и заголовки кнопок (перерисовка при смене языка) ── */
function paintChrome() {
  const paint = (sel, ic, title) => {
    const b = $(sel);
    if (!b) return;
    if (ic) b.innerHTML = icon(ic, 18);
    if (title) b.title = t(title);
  };
  paint('#newChatBtn', 'plus', 'side.newChat');
  paint('#settingsBtn', 'sliders', 'side.settings');
  paint('#logoutBtn', 'logout', 'side.logout');
  paint('#backBtn', 'back');
  paint('#videoCallBtn', 'video', 'chat.videoCall');
  paint('#shareBtn', 'link', 'chat.share');
  paint('#callBtn', 'phone', 'chat.call');
  paint('#infoBtn', 'info');
  $('#searchIc').innerHTML = icon('search', 16);
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
  if (isRealBackend) {
    reloadChats().catch((err) => console.error('Load chats error:', err));
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
}

async function submitAccessCode() {
  const code = $('#verifyCode').value.trim().toUpperCase();
  if (!code) { toast(t('verify.needCode')); return; }
  if (!(await checkInviteCode(code))) { toast(t('verify.wrongInvite')); return; }

  const p = pendingSignup;
  if (!p) { $('#verifyOv').hidden = true; return; }

  try {
    $('#verifyGo').disabled = true;
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
    else toast(msg || t('verify.error'));
  } finally {
    $('#verifyGo').disabled = false;
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

/* ── кнопки сайдбара и шапки ── */
function initChrome() {
  $('#newChatBtn').addEventListener('click', openNewChat);
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
    stopCalls();
    if (globalSub) { globalSub.unsubscribe(); globalSub = null; }
    location.hash = '#/auth';
    showAuth();
    toast(t('toast.logout'));
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

/* ── глобальные уведомления о новых сообщениях ── */
let globalSub = null;

function startGlobalRealtime() {
  if (!isRealBackend || !S.me || globalSub) return;
  globalSub = subscribeAllMessages(async (row) => {
    if (!row) return;
    const chat = chatById(row.conversation_id);
    if (!chat) return;
    if (row.sender_id === S.me.id) return; // свои сообщения обрабатываются локально
    if (S.active === row.conversation_id) return; // открытый чат — своя подписка

    const text = await previewTextFor(row, chat);
    chat.last = { ts: Date.now(), from: row.sender_id, type: 'text', text };
    chat.unread = (chat.unread || 0) + 1;
    await idb.put('chats', chat);
    renderSidebar();
    playMessage();
  });
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

/* ── запуск ── */
async function boot() {
  initI18n();
  applyDom();

  /* тема и шрифт — до первого рендера */
  applyTheme(currentTheme(), false);
  applySavedFont();
  if (currentFontId() === 'custom') {
    try { await restoreCustomFont(); } catch (e) { /* ignore */ }
  }

  /* раскладка подстраивается автоматически: телефон / планшет / компьютер */
  initDevice();

  /* Весь UI собираем сразу, не дожидаясь сети */
  initSidebar();
  initChatView();
  initComposer();
  initModals();
  initRouter();
  initAuth();
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
      if (S.me) reloadChats().catch(() => {});
    });
  }

  /* сервис-воркер — офлайн-оболочка (PWA) */
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  if (isRealBackend) {
    /* Из кэша показываем мгновенно, сессию проверяем в фоне */
    const cachedMe = await quick(idb.get('settings', 'me'), 2000);
    if (cachedMe?.value) S.me = cachedMe.value;

    if (S.me) {
      S.chats = (await quick(idb.getAll('chats'), 2000)) || [];
      showApp();
      renderSidebar();
      startGlobalRealtime();
      initCalls();
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
        S.me = m;
        idb.put('settings', { key: 'me', value: m }).catch(() => {});
        if (fresh) {
          showApp();
          renderSidebar();
          initCalls();
          startGlobalRealtime();
          maybeDemo();
          route();
        }
        reloadChats().catch(() => {});
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
    maybeDemo();
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

/* Сервер недоступен (нет сети, блокировка, нужен VPN) — один раз говорим об этом */
let serverChecked = false;
async function probeServer() {
  if (serverChecked || !SUPABASE.url) return;
  serverChecked = true;
  try {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), 9000) : null;
    const res = await fetch(`${SUPABASE.url}/auth/v1/health`, {
      method: 'GET',
      cache: 'no-store',
      signal: ctrl ? ctrl.signal : undefined,
    });
    if (timer) clearTimeout(timer);
    if (res.status >= 500) throw new Error('HTTP ' + res.status);
  } catch (err) {
    console.warn('Server unreachable:', err);
    toast(t('net.unreachable'));
  }
}

/* Заголовок и версия */
document.title = APP.name;
console.info(`%cRelik v${APP.version}`, 'color:#5b6cf9;font-weight:bold', `· ${APP.phase}`);

boot().catch((err) => {
  console.error('Boot failed:', err);
  if (window.relikBoot) window.relikBoot.fail('Не удалось запустить Relik', err && err.message ? err.message : err);
});
