/* Relik — ECDH: вывод общего секрета из двух публичных ключей
   HKDF: деривация ключей AES из секрета */

import * as keygen from './keygen.js';

/* ── Вывод общего секрета ECDH ── */
export async function deriveSharedSecret(privateKey, publicKey) {
  const bits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: publicKey },
    privateKey,
    256
  );
  return new Uint8Array(bits);
}

/* ── HKDF: деривация ключей из секрета (RFC 5869) ── */
export async function hkdf(secret, salt, info, length = 32) {
  const enc = new TextEncoder();

  // Import secret key
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    secret,
    'HKDF',
    false,
    ['deriveBits']
  );

  // Derive bits
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: salt,
      info: info,
    },
    keyMaterial,
    length * 8
  );

  return new Uint8Array(bits);
}

/* ── Вывод ключа шифрования для чата (из двух публичных ключей) ── */
export async function deriveChatKey(myPrivateKey, theirPublicKey) {
  const sharedSecret = await deriveSharedSecret(myPrivateKey, theirPublicKey);
  const salt = new Uint8Array(16); // фиксированная соль для простоты (v1)
  const info = new TextEncoder().encode('relik-chat-key');
  const keyBytes = await hkdf(sharedSecret, salt, info, 32);

  return await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
}

/* ── Шифрование сообщения AES-GCM ── */
export async function encryptMessage(key, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const data = enc.encode(plaintext);

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    data
  );

  return {
    iv: keygen.toBase64(iv),
    ciphertext: keygen.toBase64(new Uint8Array(ciphertext)),
  };
}

/* ── Дешифрование сообщения AES-GCM ── */
export async function decryptMessage(key, ivBase64, ciphertextBase64) {
  const iv = keygen.fromBase64(ivBase64);
  const ciphertext = keygen.fromBase64(ciphertextBase64);

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext
  );

  const dec = new TextDecoder();
  return dec.decode(decrypted);
}
