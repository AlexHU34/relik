/* Relik — Supabase Storage для E2E-шифрованных медиа
   Файл шифруется случайным AES-GCM-ключом на устройстве,
   в Storage уходит только шифротекст. Ключ едет внутри
   зашифрованного сообщения, поэтому сервер его не видит. */

import { sb } from './supabaseClient.js';
import { SUPABASE } from '../config.js';
import { idb } from '../db/idb.js';
import { generateGroupKey, encryptBytes, decryptBytes } from '../crypto/encryption.js';
import { toBase64, fromBase64 } from '../crypto/keygen.js';

const BUCKET_NAME = 'files';
const MAX_CACHE_ITEMS = 120;

let bucketState = null;                  // null | true | false
const urlCache = new Map();              // path -> object URL
const urlOrder = [];

const randomId = () => (crypto.randomUUID
  ? crypto.randomUUID()
  : 'f_' + Math.random().toString(36).slice(2) + Date.now().toString(36));

const isMissingBucket = (err) => /bucket not found|not found|does not exist/i.test(String(err?.message || err));

/* ── Есть ли bucket и можно ли в него писать ──────────────── */
export async function storageAvailable() {
  if (!sb || !SUPABASE.url || !SUPABASE.anonKey) return false;
  if (bucketState !== null) return bucketState;
  try {
    const { error } = await sb.storage.from(BUCKET_NAME).list('', { limit: 1 });
    if (!error) bucketState = true;
    else if (isMissingBucket(error)) bucketState = false;
    /* прочие ошибки (сеть/RLS) не кэшируем — попробуем в следующий раз */
  } catch (err) {
    /* офлайн — не запоминаем */
  }
  return bucketState === true;
}

export function resetStorageState() {
  bucketState = null;
}

/* Отозвать все objectURL при выходе из аккаунта */
export function clearMediaObjectUrls() {
  for (const url of urlCache.values()) {
    try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ }
  }
  urlCache.clear();
  urlOrder.length = 0;
}

/* ── Загрузка: blob → шифротекст в Storage ────────────────── */
export async function uploadEncryptedBlob(chatId, blob, meta = {}) {
  if (!blob) return null;
  if (!(await storageAvailable())) return null;

  try {
    const key = await generateGroupKey();
    const rawKey = await crypto.subtle.exportKey('raw', key);
    const encrypted = await encryptBytes(new Uint8Array(await blob.arrayBuffer()), key);
    const path = `${chatId}/${randomId()}.bin`;

    const { error } = await sb.storage
      .from(BUCKET_NAME)
      .upload(path, fromBase64(encrypted.ciphertext), {
        contentType: 'application/octet-stream',
        upsert: false,
      });

    if (error) {
      if (isMissingBucket(error)) bucketState = false;
      console.warn('Storage upload failed:', error.message || error);
      return null;
    }

    return {
      path,
      k: toBase64(rawKey),
      iv: encrypted.iv,
      size: blob.size || meta.size || 0,
      mime: blob.type || meta.mime || 'application/octet-stream',
      name: meta.name || 'file',
    };
  } catch (err) {
    console.warn('Storage upload error:', err?.message || err);
    return null;
  }
}

/* ── Кэш расшифрованных файлов ────────────────────────────── */
async function cachedBlob(path) {
  try {
    const rec = await idb.get('media', path);
    return rec?.blob || null;
  } catch (e) {
    return null;
  }
}

async function saveCachedBlob(path, blob) {
  try {
    await idb.put('media', { path, blob, at: Date.now() });
    const all = await idb.getAll('media');
    if (all.length > MAX_CACHE_ITEMS) {
      all.sort((a, b) => (a.at || 0) - (b.at || 0));
      for (const rec of all.slice(0, all.length - MAX_CACHE_ITEMS)) {
        await idb.del('media', rec.path);
      }
    }
  } catch (e) { /* приватный режим — просто не кэшируем */ }
}

/* ── Скачивание + расшифровка ─────────────────────────────── */
export async function downloadEncryptedBlob(item) {
  if (!sb || !item?.path || !item?.k) return null;

  const cached = await cachedBlob(item.path);
  if (cached) return cached;

  const { data, error } = await sb.storage.from(BUCKET_NAME).download(item.path);
  if (error) {
    if (isMissingBucket(error)) bucketState = false;
    throw error;
  }

  const bytes = new Uint8Array(await data.arrayBuffer());
  const key = await crypto.subtle.importKey(
    'raw', fromBase64(item.k), { name: 'AES-GCM', length: 256 }, false, ['decrypt'],
  );
  const decrypted = await decryptBytes(item.iv, toBase64(bytes), key);
  const blob = new Blob([decrypted], { type: item.mime || 'application/octet-stream' });
  await saveCachedBlob(item.path, blob);
  return blob;
}

/* ── objectURL для показа в ленте ─────────────────────────── */
export async function mediaObjectUrl(item) {
  if (!item?.path) return null;
  if (urlCache.has(item.path)) return urlCache.get(item.path);
  if (item.src && /^(data:|https?:)/i.test(item.src)) return item.src;

  const blob = await downloadEncryptedBlob(item);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  urlCache.set(item.path, url);
  urlOrder.push(item.path);
  while (urlOrder.length > MAX_CACHE_ITEMS) {
    const old = urlOrder.shift();
    const oldUrl = urlCache.get(old);
    if (oldUrl) { try { URL.revokeObjectURL(oldUrl); } catch (e) { /* ignore */ } }
    urlCache.delete(old);
  }
  return url;
}

/* ── Подтягиваем медиа в сообщение (src → objectURL) ──────── */
export async function hydrateMessageMedia(m) {
  if (!m) return false;
  let changed = false;

  if (m.type === 'album' && Array.isArray(m.album)) {
    for (const item of m.album) {
      if (!item?.path) continue;
      if (item.src && (!/^blob:/i.test(item.src) || urlCache.get(item.path) === item.src)) continue;
      try {
        const url = await mediaObjectUrl(item);
        if (url) { item.src = url; changed = true; }
      } catch (e) { /* битый файл — покажем заглушку */ }
    }
    return changed;
  }

  if (!m.media?.path) return false;
  const current = m.type === 'voice' ? m.voice?.src : m.file?.src;
  if (current) {
    const fresh = urlCache.get(m.media.path);
    if (!/^blob:/i.test(current) || fresh === current) return false;
  }

  try {
    const url = await mediaObjectUrl(m.media);
    if (!url) return false;
    if (m.type === 'voice') m.voice = { ...(m.voice || {}), src: url };
    else m.file = { ...(m.file || {}), src: url };
    return true;
  } catch (e) {
    return false;
  }
}

/* Ограниченная параллельность: не заваливаем сеть сотней файлов */
export async function hydrateMessagesMedia(list = []) {
  const pending = list.filter((m) => (m.media?.path || (m.type === 'album' && m.album?.some((i) => i?.path))));
  if (!pending.length) return false;

  let changed = false;
  let i = 0;
  const workers = Array.from({ length: Math.min(4, pending.length) }, async () => {
    while (i < pending.length) {
      const m = pending[i++];
      if (await hydrateMessageMedia(m)) {
        changed = true;
        try { await idb.put('messages', m); } catch (e) { /* ignore */ }
      }
    }
  });
  await Promise.all(workers);
  return changed;
}

/* ── Совместимость со старыми вызовами ───────────────────── */
export async function ensureBucket() {
  return await storageAvailable();
}

export async function uploadFile(chatId, file, encryptionKey = null) {
  if (!sb) throw new Error('No Supabase client');
  if (encryptionKey) {
    const encrypted = await encryptBytes(new Uint8Array(await file.arrayBuffer()), encryptionKey);
    const path = `${chatId}/${Date.now()}_${randomId()}.bin`;
    const { data, error } = await sb.storage
      .from(BUCKET_NAME)
      .upload(path, fromBase64(encrypted.ciphertext), { contentType: 'application/octet-stream', upsert: false });
    if (error) throw error;
    return { path: data.path, metadata: { name: file.name, size: file.size, type: file.type, iv: encrypted.iv } };
  }
  const result = await uploadEncryptedBlob(chatId, file, { name: file.name, size: file.size, mime: file.type });
  if (!result) throw new Error('Storage is not available');
  return { path: result.path, metadata: result, url: getPublicUrl(result.path) };
}

export async function downloadFile(path) {
  return await downloadEncryptedBlob({ path });
}

export async function downloadAndDecryptFile(path, iv, encryptionKey) {
  if (!sb) throw new Error('No Supabase client');
  const { data, error } = await sb.storage.from(BUCKET_NAME).download(path);
  if (error) throw error;
  const bytes = new Uint8Array(await data.arrayBuffer());
  return await decryptBytes(iv, toBase64(bytes), encryptionKey);
}

export async function deleteFile(path) {
  if (!sb) throw new Error('No Supabase client');
  const { error } = await sb.storage.from(BUCKET_NAME).remove([path]);
  if (error) throw error;
}

export function getPublicUrl(path) {
  if (!SUPABASE.url) return null;
  return `${SUPABASE.url}/storage/v1/object/public/${BUCKET_NAME}/${path}`;
}

export async function generateFileKey() {
  return await generateGroupKey();
}

export async function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export async function readFileAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

export function bytesToBlob(bytes, mimeType) {
  return new Blob([bytes], { type: mimeType });
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function dataUrlToBlob(dataUrl) {
  const [head, body] = String(dataUrl).split(',');
  const mime = /data:([^;]+)/.exec(head)?.[1] || 'application/octet-stream';
  const bytes = head.includes(';base64') ? fromBase64(body) : new TextEncoder().encode(decodeURIComponent(body));
  return new Blob([bytes], { type: mime });
}
