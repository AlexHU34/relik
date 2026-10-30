/* Relik — восстановление ключа кодовой фразой (12 слов, BIP-39) и файлом.
   Приватный ключ шифруется фразой: PBKDF2-SHA256(310k) + AES-GCM.
   Фраза и ключ никогда не уходят на сервер — только шифротекст. */

import { BIP39_EN } from '../vendor/bip39-wordlist.js';

const DOMAIN = 'relik-recovery-v1';
const ITER = 310000;
const BLOB_VERSION = 1;

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64(bytes) {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

function unb64(str) {
  return Uint8Array.from(atob(String(str || '')), (c) => c.charCodeAt(0));
}

/* ── Фраза ───────────────────────────────────────────────── */

export function normalizeMnemonic(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}

export function isMnemonicValid(text) {
  const words = normalizeMnemonic(text).split(' ').filter(Boolean);
  if (words.length !== 12) return false;
  return words.every((w) => BIP39_EN.includes(w));
}

/* Полная проверка: 12 слов + контрольная сумма BIP-39 */
export async function verifyMnemonic(text) {
  if (!isMnemonicValid(text)) return false;
  const words = normalizeMnemonic(text).split(' ');
  const idx = words.map((w) => BIP39_EN.indexOf(w));
  const bits = [];
  for (const i of idx) for (let b = 10; b >= 0; b -= 1) bits.push((i >> b) & 1);
  const entropy = new Uint8Array(16);
  for (let i = 0; i < 128; i += 1) entropy[i >> 3] |= bits[i] << (7 - (i % 8));
  const back = await entropyToMnemonic(entropy);
  return back === words.join(' ');
}

/* Возвращает массив слов, если фраза валидна, иначе null */
export function mnemonicWords(text) {
  const norm = normalizeMnemonic(text);
  return isMnemonicValid(norm) ? norm.split(' ') : null;
}

async function entropyToMnemonic(entropy) {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', entropy));
  const bits = [];
  for (const byte of entropy) for (let b = 7; b >= 0; b -= 1) bits.push((byte >> b) & 1);
  for (let b = 7; b >= 4; b -= 1) bits.push((hash[0] >> b) & 1);
  const words = [];
  for (let i = 0; i < bits.length; i += 11) {
    let idx = 0;
    for (let j = 0; j < 11; j += 1) idx = (idx << 1) | bits[i + j];
    words.push(BIP39_EN[idx]);
  }
  return words.join(' ');
}

/* Новый набор из 12 слов (128 бит энтропии + контрольная сумма) */
export async function newMnemonic() {
  const entropy = crypto.getRandomValues(new Uint8Array(16));
  return entropyToMnemonic(entropy);
}

/* ── Шифрование ключа фразой ─────────────────────────────── */

async function deriveWrapKey(mnemonic) {
  const base = await crypto.subtle.importKey(
    'raw', enc.encode(normalizeMnemonic(mnemonic)), 'PBKDF2', false, ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode(DOMAIN), iterations: ITER, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptPrivateKeyWithMnemonic(privateKeyJwk, mnemonic) {
  if (!(await verifyMnemonic(mnemonic))) throw new Error('bad_mnemonic');
  const key = await deriveWrapKey(mnemonic);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    enc.encode(JSON.stringify(privateKeyJwk)),
  );
  return {
    v: BLOB_VERSION,
    kdf: 'pbkdf2-sha256',
    iter: ITER,
    iv: b64(iv),
    ciphertext: b64(new Uint8Array(ct)),
    createdAt: new Date().toISOString(),
  };
}

export async function decryptPrivateKeyWithMnemonic(blob, mnemonic) {
  if (!blob || !blob.ciphertext) throw new Error('no_recovery');
  if (!(await verifyMnemonic(mnemonic))) throw new Error('bad_mnemonic');
  const key = await deriveWrapKey(mnemonic);
  let plain;
  try {
    plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(blob.iv) },
      key,
      unb64(blob.ciphertext),
    );
  } catch (e) {
    /* неверная фраза либо повреждённый бэкап */
    throw new Error('wrong_phrase');
  }
  return JSON.parse(dec.decode(plain));
}

/* ── Файл ключа ──────────────────────────────────────────── */

export function buildKeyFile({ me, privateKeyJwk, recovery }) {
  return {
    app: 'relik',
    format: 'relik-key',
    version: 1,
    exportedAt: new Date().toISOString(),
    user: {
      id: me?.id || null,
      username: me?.username || null,
      name: me?.name || null,
      mail: me?.mail || null,
    },
    publicKey: me?.publicKey || null,
    privateKey: privateKeyJwk,
    recovery: recovery || null,
    note: 'Этот файл даёт доступ к переписке. Храните его как пароль от банка.',
  };
}

export function parseKeyFile(text) {
  let data = null;
  try { data = JSON.parse(String(text || '')); } catch (e) { throw new Error('bad_file'); }
  if (!data || data.format !== 'relik-key' || !data.privateKey) throw new Error('bad_file');
  const jwk = data.privateKey;
  if (!jwk || jwk.kty !== 'EC' || !jwk.d) throw new Error('bad_file');
  return {
    user: data.user || {},
    publicKey: data.publicKey || null,
    privateKeyJwk: jwk,
    recovery: data.recovery || null,
  };
}

export function fileNameFor(me) {
  const who = String(me?.username || me?.id || 'relik').replace(/[^a-z0-9_.-]/gi, '').slice(0, 32) || 'relik';
  return `relik-key-${who}.json`;
}

export function downloadText(filename, text, type = 'application/json') {
  try {
    const blob = new Blob([text], { type: `${type};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return true;
  } catch (e) {
    return false;
  }
}

/* Для тестов/самопроверки */
export async function _entropyToMnemonic(bytes) {
  return entropyToMnemonic(bytes);
}
