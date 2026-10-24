/* Relik — высокоуровневое шифрование для сообщений
   Объединяет ECDH, AES-GCM и управление ключами */

import * as keygen from './keygen.js';
import * as ecdh from './ecdh.js';
import * as backup from './backup.js';
import { idb } from '../db/idb.js';

/* ── Получение ключевой пары пользователя ── */
export async function getKeyPair() {
  const rec = await idb.get('settings', 'keyPair');
  if (!rec?.value) return null;

  const { publicKey, privateKey } = rec.value;
  const pubKey = await keygen.importPublicKey(publicKey);
  const privKey = await keygen.importPrivateKey(privateKey);

  return { publicKey: pubKey, privateKey: privKey };
}

/* ── Получение публичного ключа собеседника ── */
export async function getTheirPublicKey(theirPublicKeyJwk) {
  return await keygen.importPublicKey(theirPublicKeyJwk);
}

/* ── Шифрование сообщения для личного чата ── */
export async function encryptForChat(text, myPrivateKey, theirPublicKey) {
  const chatKey = await ecdh.deriveChatKey(myPrivateKey, theirPublicKey);
  return await ecdh.encryptMessage(chatKey, text);
}

/* ── Дешифрование сообщения из личного чата ── */
export async function decryptFromChat(iv, ciphertext, myPrivateKey, theirPublicKey) {
  const chatKey = await ecdh.deriveChatKey(myPrivateKey, theirPublicKey);
  return await ecdh.decryptMessage(chatKey, iv, ciphertext);
}

/* ── Шифрование для группы (v1: общий ключ группы) ── */
export async function encryptForGroup(text, groupKey) {
  return await ecdh.encryptMessage(groupKey, text);
}

/* ── Дешифрование для группы ── */
export async function decryptFromGroup(iv, ciphertext, groupKey) {
  return await ecdh.decryptMessage(groupKey, iv, ciphertext);
}

/* ── Генерация ключа группы ── */
export async function generateGroupKey() {
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  return await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
}

/* ── Шифрование ключа группы для участника ── */
export async function encryptGroupKeyForUser(groupKey, myPrivateKey, theirPublicKey) {
  const sharedSecret = await ecdh.deriveSharedSecret(myPrivateKey, theirPublicKey);
  const salt = new Uint8Array(16);
  const info = new TextEncoder().encode('relik-group-key');
  const keyBytes = await ecdh.hkdf(sharedSecret, salt, info, 32);

  const wrappingKey = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );

  const exportedKey = await crypto.subtle.exportKey('raw', groupKey);
  const encrypted = await keygen.encryptAES(wrappingKey, exportedKey);

  return {
    iv: keygen.toBase64(new Uint8Array(encrypted.iv)),
    ciphertext: keygen.toBase64(new Uint8Array(encrypted.ciphertext)),
  };
}

/* ── Дешифрование ключа группы ── */
export async function decryptGroupKey(encryptedKey, myPrivateKey, theirPublicKey) {
  const sharedSecret = await ecdh.deriveSharedSecret(myPrivateKey, theirPublicKey);
  const salt = new Uint8Array(16);
  const info = new TextEncoder().encode('relik-group-key');
  const keyBytes = await ecdh.hkdf(sharedSecret, salt, info, 32);

  const wrappingKey = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );

  const iv = keygen.fromBase64(encryptedKey.iv);
  const ciphertext = keygen.fromBase64(encryptedKey.ciphertext);
  const decrypted = await keygen.decryptAES(wrappingKey, iv, ciphertext);

  return await crypto.subtle.importKey(
    'raw',
    decrypted,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
}

/* ── Шифрование байтов (для файлов) ── */
export async function encryptBytes(data, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    data
  );

  return {
    iv: keygen.toBase64(iv),
    ciphertext: keygen.toBase64(new Uint8Array(encrypted)),
  };
}

/* ── Дешифрование байтов ── */
export async function decryptBytes(iv, ciphertext, key) {
  const ivArr = keygen.fromBase64(iv);
  const cipherArr = keygen.fromBase64(ciphertext);

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ivArr },
    key,
    cipherArr
  );

  return new Uint8Array(decrypted);
}
