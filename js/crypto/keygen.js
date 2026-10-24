/* Relik — генерация криптографических ключей (WebCrypto)
   ECDH P-256 для обмена ключами, PBKDF2 для деривации из пароля */

/* ── ECDH P-256: генерация пары ключей ── */
export async function generateKeyPair() {
  return await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveKey', 'deriveBits']
  );
}

/* ── Экспорт публичного ключа в JWK (для хранения в Supabase) ── */
export async function exportPublicKey(keyPair) {
  const jwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  return JSON.stringify(jwk);
}

/* ── Импорт публичного ключа из JWK ── */
export async function importPublicKey(jwkStr) {
  const jwk = JSON.parse(jwkStr);
  return await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    []
  );
}

/* ── Экспорт приватного ключа в JWK (для локального хранения) ── */
export async function exportPrivateKey(keyPair) {
  const jwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);
  return JSON.stringify(jwk);
}

/* ── Импорт приватного ключа из JWK ── */
export async function importPrivateKey(jwkStr) {
  const jwk = JSON.parse(jwkStr);
  return await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveKey', 'deriveBits']
  );
}

/* ── PBKDF2: деривация ключа из пароля (для шифрования бэкапа приватного ключа) ── */
export async function deriveKeyFromPassword(password, salt) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt,
      iterations: 100000,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
}

/* ── Генерация случайной соли ── */
export function generateSalt() {
  return crypto.getRandomValues(new Uint8Array(16));
}

/* ── AES-GCM: шифрование данных ── */
export async function encryptAES(key, data) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const plaintext = typeof data === 'string' ? enc.encode(data) : data;

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    plaintext
  );

  return {
    iv: Array.from(iv),
    ciphertext: Array.from(new Uint8Array(ciphertext)),
  };
}

/* ── AES-GCM: дешифрование данных ── */
export async function decryptAES(key, iv, ciphertext) {
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(iv) },
    key,
    new Uint8Array(ciphertext)
  );

  return new Uint8Array(decrypted);
}

/* ── Конвертация Uint8Array в base64 ── */
export function toBase64(arr) {
  return btoa(String.fromCharCode(...arr));
}

/* ── Конвертация base64 в Uint8Array ── */
export function fromBase64(str) {
  return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
}
