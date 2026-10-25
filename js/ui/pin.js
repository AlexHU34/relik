/* Relik — локальный PIN-код при открытии приложения.
   Это экранная блокировка устройства, а не шифрование переписки:
   PIN хранится только как PBKDF2-хеш в localStorage. */

import { $ } from './utils.js';
import { t } from '../i18n/i18n.js';
import { toast } from './toast.js';
import { S } from './state.js';
import { confirmAction } from './dialog.js';

const KEY = 'relik.pin.v1';
const ITERATIONS = 120000;
const AUTO_LOCK_MS = 60 * 1000;

let cfg = null;                 // { salt, hash, len }
let mode = 'unlock';            // unlock | verify | set | repeat
let buffer = '';
let pending = null;             // { mode: 'set' | 'verify', resolve, value }
let bound = false;
let armed = false;
let hiddenAt = 0;

function readCfg() {
  if (cfg) return cfg;
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (raw?.salt && raw?.hash && Number(raw.len) >= 4) cfg = raw;
  } catch (e) { /* ignore */ }
  return cfg;
}

export function hasPin() {
  return !!readCfg();
}

const toBase64 = (arr) => btoa(String.fromCharCode(...new Uint8Array(arr)));

async function deriveHash(pin, saltB64) {
  const salt = Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0));
  const material = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(String(pin)), 'PBKDF2', false, ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    material,
    256,
  );
  return toBase64(bits);
}

async function savePin(pin) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const saltB64 = toBase64(salt);
  const hash = await deriveHash(pin, saltB64);
  cfg = { salt: saltB64, hash, len: String(pin).length, at: Date.now() };
  localStorage.setItem(KEY, JSON.stringify(cfg));
}

async function checkPin(pin) {
  const c = readCfg();
  if (!c) return false;
  const hash = await deriveHash(pin, c.salt);
  return hash === c.hash;
}

function clearPin() {
  cfg = null;
  localStorage.removeItem(KEY);
}

/* ── UI ───────────────────────────────────────────────────── */
function els() {
  return {
    root: $('#pinLock'),
    dots: $('#pinDots'),
    sub: $('#pinSub'),
    title: $('#pinLock .pin-title'),
    card: $('#pinLock .pin-card'),
    forgot: $('#pinForgot'),
    cancel: $('#pinCancel'),
  };
}

function paintDots() {
  const e = els();
  if (!e.dots) return;
  const size = Math.max(4, Math.min(8, buffer.length || (mode === 'unlock' ? readCfg()?.len : 4) || 4));
  e.dots.innerHTML = Array.from({ length: size }, (_, i) =>
    `<i class="${i < buffer.length ? 'on' : ''}"></i>`).join('');
}

function setHint(title, sub = '', showForgot = false) {
  const e = els();
  if (e.title) e.title.textContent = title;
  if (e.sub) { e.sub.textContent = sub; e.sub.hidden = !sub; }
  if (e.forgot) e.forgot.hidden = !showForgot;
  if (e.cancel) e.cancel.hidden = showForgot;
}

function shake() {
  const e = els();
  if (!e.card) return;
  e.card.classList.remove('shake');
  void e.card.offsetWidth;
  e.card.classList.add('shake');
}

function resetBuffer() {
  buffer = '';
  paintDots();
}

function showLock() {
  const e = els();
  if (!e.root) return;
  e.root.hidden = false;
  resetBuffer();
  if (mode === 'unlock') {
    setHint(t('pin.title'), t('pin.sub'), true);
  }
}

function hideLock() {
  const e = els();
  if (e.root) e.root.hidden = true;
  resetBuffer();
}

export function lockNow() {
  if (!hasPin()) return;
  if (!S.me) return;
  mode = 'unlock';
  pending = null;
  showLock();
  setTimeout(() => { if (!els().root?.hidden) document.addEventListener('keydown', onKey); }, 40);
}

function onKey(e) {
  if (els().root?.hidden) {
    document.removeEventListener('keydown', onKey);
    return;
  }
  if (/^[0-9]$/.test(e.key)) { e.preventDefault(); press(e.key); }
  else if (e.key === 'Backspace') { e.preventDefault(); press('back'); }
  else if (e.key === 'Escape' && mode !== 'unlock') { e.preventDefault(); cancelAsk(); }
  else if (e.key === 'Enter') { e.preventDefault(); submit(); }
}

function cancelAsk() {
  const resolve = pending?.resolve;
  pending = null;
  hideLock();
  resolve?.(false);
}

function press(digit) {
  if (digit === 'back') {
    buffer = buffer.slice(0, -1);
    paintDots();
    return;
  }
  if (digit === 'clear') {
    resetBuffer();
    return;
  }
  if (digit === 'ok') { submit(); return; }
  if (!/^[0-9]$/.test(digit)) return;
  if (buffer.length >= 8) return;
  buffer += digit;
  paintDots();
  if (navigator.vibrate) navigator.vibrate(8);
  /* для PIN известной длины не заставляем жать OK */
  const c = readCfg();
  if (mode === 'unlock' && c && buffer.length === Number(c.len)) {
    setTimeout(submit, 90);
  }
}

async function submit() {
  if (!buffer) return;
  const value = buffer;

  if (mode === 'unlock') {
    if (await checkPin(value)) {
      hideLock();
      armed = true;
      document.removeEventListener('keydown', onKey);
    } else {
      shake();
      resetBuffer();
      toast(t('pin.wrong'), { type: 'error' });
    }
    return;
  }

  if (mode === 'verify') {
    if (await checkPin(value)) {
      const resolve = pending?.resolve;
      pending = null;
      hideLock();
      resolve?.(true);
    } else {
      shake();
      resetBuffer();
      toast(t('pin.wrong'), { type: 'error' });
    }
    return;
  }

  if (mode === 'set') {
    if (value.length < 4) {
      shake();
      toast(t('pin.tooShort'), { type: 'error' });
      return;
    }
    pending = { ...(pending || {}), value };
    mode = 'repeat';
    buffer = '';
    paintDots();
    setHint(t('pin.repeat'), t('pin.setSub'), false);
    return;
  }

  if (mode === 'repeat') {
    if (value !== pending?.value) {
      shake();
      toast(t('pin.mismatch'), { type: 'error' });
      mode = 'set';
      pending = { ...(pending || {}), value: null };
      resetBuffer();
      setHint(t('pin.setTitle'), t('pin.setSub'), false);
      return;
    }
    await savePin(value);
    const resolve = pending?.resolve;
    pending = null;
    hideLock();
    resolve?.(true);
  }
}

/* ── Публичные сценарии ───────────────────────────────────── */
function askPin(kind) {
  return new Promise((resolve) => {
    pending = { resolve, value: null };
    buffer = '';
    mode = kind;
    showLock();
    if (kind === 'set') setHint(t('pin.setTitle'), t('pin.setSub'), false);
    else setHint(t('pin.enterCurrent'), '', false);
    paintDots();
  });
}

export async function enablePin() {
  if (hasPin()) return true;
  const ok = await askPin('set');
  if (ok) toast(t('pin.saved'), { type: 'success' });
  return !!ok;
}

export async function disablePin() {
  if (!hasPin()) return true;
  const ok = await askPin('verify');
  if (ok) {
    clearPin();
    toast(t('pin.off'), { type: 'success' });
  }
  return !!ok;
}

export async function changePin() {
  if (!hasPin()) return enablePin();
  const ok = await askPin('verify');
  if (!ok) return false;
  const changed = await askPin('set');
  if (changed) toast(t('pin.saved'), { type: 'success' });
  return !!changed;
}

/* Вызывается после входа/восстановления сессии */
export function armPin() {
  if (armed || !hasPin() || !S.me) return;
  armed = true;
  lockNow();
}

export function resetPin() {
  clearPin();
  hideLock();
}

export function initPin() {
  if (bound) return;
  bound = true;

  const root = els().root;
  if (!root) return;

  const pad = $('#pinPad');
  pad?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pin]');
    if (b) press(b.dataset.pin);
  });

  $('#pinForgot')?.addEventListener('click', async () => {
    const ok = await confirmAction({
      title: t('pin.forgot'),
      text: t('pin.forgotText'),
      ok: t('pin.reset'),
      danger: true,
      iconName: 'lock',
    });
    if (!ok) return;
    resetPin();
    location.reload();
  });

  $('#pinCancel')?.addEventListener('click', cancelAsk);

  /* автоблокировка после сворачивания вкладки */
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now();
      return;
    }
    if (!hasPin() || !S.me) return;
    if (hiddenAt && Date.now() - hiddenAt > AUTO_LOCK_MS) {
      armed = false;
      armPin();
    }
    hiddenAt = 0;
  });

  paintDots();
}
