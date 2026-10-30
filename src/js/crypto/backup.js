/* Relik — резервное копирование приватного ключа по паролю
   PBKDF2 + AES-GCM: шифрование приватного ключа паролем пользователя */

import * as keygen from './keygen.js';

/* ── Шифрование приватного ключа паролем ── */
export async function encryptPrivateKeyWithPassword(privateKeyJwk, password) {
  const salt = keygen.generateSalt();
  const key = await keygen.deriveKeyFromPassword(password, salt);

  const encrypted = await keygen.encryptAES(key, JSON.stringify(privateKeyJwk));

  return {
    salt: keygen.toBase64(salt),
    iv: keygen.toBase64(new Uint8Array(encrypted.iv)),
    ciphertext: keygen.toBase64(new Uint8Array(encrypted.ciphertext)),
  };
}

/* ── Дешифрование приватного ключа паролем ── */
export async function decryptPrivateKeyWithPassword(encryptedBackup, password) {
  const salt = keygen.fromBase64(encryptedBackup.salt);
  const iv = keygen.fromBase64(encryptedBackup.iv);
  const ciphertext = keygen.fromBase64(encryptedBackup.ciphertext);

  const key = await keygen.deriveKeyFromPassword(password, salt);
  const decrypted = await keygen.decryptAES(key, iv, ciphertext);

  const dec = new TextDecoder();
  return JSON.parse(dec.decode(decrypted));
}

/* ── Проверка пароля (попытка дешифровать) ── */
export async function verifyPassword(encryptedBackup, password) {
  try {
    await decryptPrivateKeyWithPassword(encryptedBackup, password);
    return true;
  } catch (e) {
    return false;
  }
}
