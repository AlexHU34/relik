/* Relik — «код безопасности» для проверки ключей собеседника.
   Это не часть шифрования сообщений, а способ сверить публичные ключи
   по другому каналу и заметить подмену (MitM).

   Канонизация:
   - публичный ключ P-256 → сырые 64 байта x||y (без JSON/JWK-обёртки);
   - два участника сортируются по user id;
   - каждый id и ключ кодируются с длиной (length-prefixed), чтобы
     нельзя было подобрать разные пары с одинаковой склейкой;
   - SHA-256 от domain-separated префикса.

   Результат одинаков у обоих участников. Для показа берутся первые
   128 бит (8 групп по 4 hex-символа), полный хеш доступен для QR. */

const DOMAIN = new TextEncoder().encode('relik-safety-v1');
const VERSION = 1;

function toJwk(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch (e) { return null; }
  }
  return value;
}

function b64urlToBytes(value) {
  const src = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  if (!src) return new Uint8Array(0);
  const padded = src + '='.repeat((4 - (src.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concatBytes(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function lengthPrefixed(bytes) {
  const head = new Uint8Array(4);
  new DataView(head.buffer).setUint32(0, bytes.length, false);
  return concatBytes([head, bytes]);
}

function bytesToHex(bytes) {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/* Публичный ключ в каноническом виде: 32 байта x + 32 байта y */
export function rawPublicKeyBytes(value) {
  const jwk = toJwk(value);
  if (!jwk || typeof jwk !== 'object') throw new Error('Invalid public key');
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256') throw new Error('Unsupported public key curve');
  const x = b64urlToBytes(jwk.x);
  const y = b64urlToBytes(jwk.y);
  if (x.length !== 32 || y.length !== 32) throw new Error('Invalid P-256 public key length');
  return concatBytes([x, y]);
}

export function formatFingerprint(hex, groupSize = 4, groups = 8) {
  let clean = String(hex || '').toUpperCase().replace(/[^0-9A-F]/g, '');
  if (!clean) return '';
  const size = Math.max(1, Number(groupSize) || 4);
  const count = Math.max(1, Number(groups) || 8);
  clean = clean.slice(0, size * count);
  const chunks = [];
  for (let i = 0; i < clean.length; i += size) chunks.push(clean.slice(i, i + size));
  return chunks.join('-');
}

export function normalizeFingerprint(value) {
  return String(value || '').toUpperCase().replace(/[^0-9A-F]/g, '');
}

export function fingerprintsEqual(a, b) {
  const x = normalizeFingerprint(a);
  const y = normalizeFingerprint(b);
  return !!x && x === y;
}

/* Пара участников → одинаковый код у обоих.
   myId/theirId — UUID (или другой стабильный id), ключи — JWK или JSON-строка JWK. */
export async function fingerprintForPair(idA, keyA, idB, keyB) {
  const a = { id: String(idA || '').trim(), raw: rawPublicKeyBytes(keyA) };
  const b = { id: String(idB || '').trim(), raw: rawPublicKeyBytes(keyB) };
  if (!a.id || !b.id) throw new Error('Both user ids are required');
  if (a.id === b.id) throw new Error('Fingerprint requires two different users');

  /* Сортировка по id, а не по ключу: обе стороны получают один порядок. */
  const [first, second] = a.id < b.id ? [a, b] : [b, a];
  const payload = concatBytes([
    DOMAIN,
    new Uint8Array([VERSION]),
    lengthPrefixed(new TextEncoder().encode(first.id)),
    lengthPrefixed(first.raw),
    lengthPrefixed(new TextEncoder().encode(second.id)),
    lengthPrefixed(second.raw),
  ]);

  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', payload));
  const fullHex = bytesToHex(digest);
  return {
    version: VERSION,
    fullHex,
    display: formatFingerprint(fullHex),
    bytes: digest,
  };
}

/* Короткая форма для сравнения вручную (128 бит). */
export function shortFingerprint(value) {
  return formatFingerprint(normalizeFingerprint(value), 4, 8);
}
