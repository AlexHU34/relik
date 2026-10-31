/* Relik — экран входа: демо и Supabase, регистрация, код доступа, верификация.
   enterApp остаётся в main.js и приходит через bindAuthHooks. */
import { $ } from '../ui/utils.js';
import { icon } from '../ui/icons.js';
import { t } from '../i18n/i18n.js';
import { toast } from '../ui/toast.js';
import { S } from '../ui/state.js';
import { idb } from '../db/idb.js';
import { ME } from '../data/mock.js';
import { sb } from '../backend/supabaseClient.js';
import { signUp, signIn, authHealth, authErrorMessage, isValidUsername, isUsernameTaken, verifySignupCode } from '../backend/auth.js';
import { setReencryptPassword, openRecoveryFlow } from '../ui/keyRecovery.js';
import { logEvent } from '../backend/telemetry.js';
import { route } from '../ui/router.js';
import { renderSidebar } from '../ui/sidebar.js';

let hooks = { enterApp: async () => {} };
export function bindAuthHooks(next = {}) { hooks = { ...hooks, ...next }; }
/* ── экран входа (демо или реальный Supabase) ── */
let authMode = 'login';
let lastPass = '';
let verifyEmail = '';
let verifyMode = 'email';
let pendingSignup = null;
export const isRealBackend = !!sb; // использует ли реальный Supabase

export function paintAuth() {
  $('#authGo').textContent = t(authMode === 'login' ? 'auth.login' : 'auth.create');
  $('#nameField').hidden = authMode === 'login';
  $('#consentField').hidden = authMode === 'login';
  $('#usernameField').hidden = authMode === 'login';
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
export function animateWelcome() {
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

export function initAuth() {
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
    passToggle.setAttribute('aria-label', t('auth.showPassword'));
    passToggle.setAttribute('aria-pressed', 'false');
    passToggle.addEventListener('click', () => {
      const pass = $('#authPass');
      const show = pass.type === 'password';
      pass.type = show ? 'text' : 'password';
      passToggle.innerHTML = icon(show ? 'eyeOff' : 'eye', 17);
      passToggle.setAttribute('aria-label', t(show ? 'auth.hidePassword' : 'auth.showPassword'));
      passToggle.setAttribute('aria-pressed', String(show));
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
  ic('#usernameIc', 'user');
  ic('#trustIc', 'shield');
  ic('#bf1', 'shield');
  ic('#bf2', 'spark');
  ic('#bf3', 'lock');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('#authEmail').value.trim().toLowerCase();
    const pass = $('#authPass').value;
    const name = $('#authName').value.trim();
    const username = authMode === 'signup'
      ? $('#authUsername').value.trim().replace(/^@+/, '')
      : '';
    const bad = (why) => {
      card.classList.remove('shake'); void card.offsetWidth; card.classList.add('shake');
      toast(why);
    };
    if (!/.+@.+\..+/.test(email)) return bad(t('auth.badEmail'));
    if (pass.length < 6) return bad(t('auth.shortPass'));
    if (authMode === 'signup' && !name) return bad(t('auth.needName'));
    if (authMode === 'signup' && !$('#authConsent').checked) return bad(t('auth.needConsent'));
    if (authMode === 'signup') {
      if (!username) return bad(t('auth.needUsername'));
      if (!isValidUsername(username)) return bad(t('auth.badUsername'));
      try {
        if (await isUsernameTaken(username)) return bad(t('auth.usernameTaken'));
      } catch (e) { /* проверка не критична — конфликт поймаем на вставке */ }
    }

    lastPass = pass;

    /* Регистрация: сначала спрашиваем код доступа */
    if (authMode === 'signup' && isRealBackend) {
      pendingSignup = { email, pass, name, username };
      showVerify(null, 'invite');
      return;
    }

    const go = $('#authGo');
    if (go.disabled) return;
    const label = go.textContent;
    go.disabled = true;
    go.textContent = t('auth.working');

    try {
      if (isRealBackend) {
        if (authMode === 'signup') {
          sessionStorage.setItem('relik.pendingName', name);
          const res = await signUp(email, pass, name, username);
          if (res && res.pending) {
            showVerify(email);
            return;
          }
          S.me = res;
        } else {
          try {
            S.me = await signIn(email, pass);
            setReencryptPassword(pass);
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

      await hooks.enterApp(authMode === 'login' ? 'auth.welcomeLogin' : 'auth.welcomeSignup');
      if (S.me?.keyError) {
        setTimeout(() => openRecoveryFlow({ force: true, password: pass }), 600);
      }
    } catch (err) {
      const friendly = authErrorMessage(err);
      const offline = /fetch|network|timeout|abort|load failed|offline/i.test(String(err?.message || ''));
      bad(offline ? t('net.unreachable') : friendly);
      logEvent('auth_failed', { mode: authMode, code: err?.code || '', message: String(err?.message || '').slice(0, 120) });
    } finally {
      go.disabled = false;
      go.textContent = t(authMode === 'login' ? 'auth.login' : 'auth.create');
    }
  });

  /* подтверждение email кодом */
  wireVerify();

  /* статус сервера под кнопкой: видно, живой ли Supabase */
  if (isRealBackend) {
    const line = $('#authServer');
    if (line) {
      line.hidden = false;
      line.textContent = t('auth.checking');
      authHealth().then((h) => {
        line.classList.toggle('bad', !h.ok);
        line.textContent = h.ok
          ? t('auth.serverOk').replace('{ms}', String(h.ms))
          : t('auth.serverDown');
      }).catch(() => {
        line.classList.add('bad');
        line.textContent = t('auth.serverDown');
      });
    }
  }

  paintAuth();
}

/* ── код доступа / подтверждение email ── */
export function showVerify(email, mode = 'email') {
  verifyMode = mode;
  verifyEmail = email || '';
  const isInvite = mode === 'invite';

  $('#verifyTitle').textContent = t(isInvite ? 'verify.inviteTitle' : 'verify.title');
  $('#verifySub').textContent = t(isInvite ? 'verify.inviteSub' : 'verify.sub');
  $('#verifyEmail').textContent = verifyEmail;

  const inp = $('#verifyCode');
  inp.value = '';
  inp.classList.toggle('invite', isInvite);
  inp.maxLength = isInvite ? 20 : 12;
  inp.inputMode = isInvite ? 'text' : 'numeric';
  inp.autocomplete = isInvite ? 'off' : 'one-time-code';
  inp.placeholder = t(isInvite ? 'verify.invitePh' : 'verify.ph');

  $('#verifyResend').hidden = isInvite;
  $('#verifyGo').textContent = t(isInvite ? 'verify.continue' : 'verify.confirm');
  $('#verifyOv').hidden = false;
  setTimeout(() => inp.focus(), 60);
}

export async function checkInviteCode(code) {
  const expected = 'LAREK1999';
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

export async function submitAccessCode() {
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
    if (p.username) sessionStorage.setItem('relik.pendingUsername', p.username);
    const res = await signUp(p.email, p.pass, p.name, p.username);
    if (res && res.pending) {
      showVerify(p.email, 'email');
      return;
    }
    S.me = res;
    pendingSignup = null;
    $('#verifyOv').hidden = true;
    await hooks.enterApp('auth.welcomeSignup');
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

export function wireVerify() {
  $('#verifyCode').addEventListener('input', (e) => {
    if (verifyMode !== 'email') {
      e.target.value = e.target.value.toUpperCase().replace(/\s+/g, '');
      return;
    }
    const d = e.target.value.replace(/\D/g, '').slice(0, 10);
    /* Supabase умеет 6–10 цифр; 6 и 8 показываем с дефисом. */
    e.target.value = d.length === 6
      ? `${d.slice(0, 3)}-${d.slice(3)}`
      : d.length === 8
        ? `${d.slice(0, 4)}-${d.slice(4)}`
        : d;
  });

  $('#verifyGo').addEventListener('click', async () => {
    if (verifyMode === 'invite') { await submitAccessCode(); return; }

    const digits = $('#verifyCode').value.replace(/\D/g, '');
    if (digits.length < 6 || digits.length > 10) { toast(t('verify.badCode')); return; }
    try {
      $('#verifyGo').disabled = true;
      S.me = await verifySignupCode(verifyEmail, digits, lastPass);
      $('#verifyOv').hidden = true;
      await hooks.enterApp('auth.welcomeSignup');
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

export function routeAfterLogin() {
  if (!location.hash || location.hash.startsWith('#/auth') || location.hash === '#/') {
    location.hash = '#/app';
  } else {
    route();
  }
  renderSidebar();
}
