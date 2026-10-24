/* Relik — Supabase Storage для шифрованных файлов (Фаза 7)
   Загрузка, скачивание, шифрование/дешифрование файлов */

import { sb } from './supabaseClient.js';
import { SUPABASE } from '../config.js';
import { generateGroupKey, encryptBytes, decryptBytes } from '../crypto/encryption.js';
import { toBase64, fromBase64 } from '../crypto/keygen.js';

const BUCKET_NAME = 'files';

/* ── Инициализация bucket (выполняется один раз в Supabase) ── */
export async function ensureBucket() {
  if (!sb) return;

  // Проверяем существование bucket
  const { data: buckets } = await sb.storage.listBuckets();
  const exists = buckets?.find((b) => b.name === BUCKET_NAME);

  if (!exists) {
    // Создаём bucket (требуется admin rights, делается вручную в Supabase)
    console.warn(`Bucket "${BUCKET_NAME}" не найден. Создайте его в Supabase Storage.`);
  }
}

/* ── Загрузка файла ── */
export async function uploadFile(chatId, file, encryptionKey = null) {
  if (!sb) throw new Error('No Supabase client');

  let fileBytes;
  let fileMetadata = { name: file.name, size: file.size, type: file.type };

  // Читаем файл
  fileBytes = await file.arrayBuffer();

  // Шифруем если есть ключ
  if (encryptionKey && SUPABASE.url && SUPABASE.anonKey) {
    const encrypted = await encryptBytes(new Uint8Array(fileBytes), encryptionKey);
    fileBytes = fromBase64(encrypted.ciphertext);
    fileMetadata.encrypted = true;
    fileMetadata.iv = encrypted.iv;
  }

  // Формируем путь: files/{chatId}/{timestamp}_{name}
  const timestamp = Date.now();
  const sanitizedName = file.name.replace(/[^a-zA-Z0-9.-]/g, '_');
  const path = `${chatId}/${timestamp}_${sanitizedName}`;

  // Загружаем в Storage
  const { data, error } = await sb.storage
    .from(BUCKET_NAME)
    .upload(path, fileBytes, {
      contentType: file.type,
      upsert: false,
    });

  if (error) throw error;

  return {
    path: data.path,
    metadata: fileMetadata,
    url: `${SUPABASE.url}/storage/v1/object/public/${BUCKET_NAME}/${data.path}`,
  };
}

/* ── Скачивание файла ── */
export async function downloadFile(path, encryptionKey = null) {
  if (!sb) throw new Error('No Supabase client');

  // Скачиваем из Storage
  const { data, error } = await sb.storage
    .from(BUCKET_NAME)
    .download(path);

  if (error) throw error;

  let fileBytes = await data.arrayBuffer();

  // Дешифруем если есть ключ
  if (encryptionKey && SUPABASE.url && SUPABASE.anonKey) {
    // Нужно получить IV из метаданных (хранится в сообщении)
    throw new Error('IV должен передаваться отдельно');
  }

  return new Uint8Array(fileBytes);
}

/* ── Скачивание с дешифрованием ── */
export async function downloadAndDecryptFile(path, iv, encryptionKey) {
  if (!sb) throw new Error('No Supabase client');

  const { data, error } = await sb.storage
    .from(BUCKET_NAME)
    .download(path);

  if (error) throw error;

  const encryptedBytes = new Uint8Array(await data.arrayBuffer());
  const decryptedBytes = await decryptBytes(iv, toBase64(encryptedBytes), encryptionKey);

  return decryptedBytes;
}

/* ── Удаление файла ── */
export async function deleteFile(path) {
  if (!sb) throw new Error('No Supabase client');

  const { error } = await sb.storage
    .from(BUCKET_NAME)
    .remove([path]);

  if (error) throw error;
}

/* ── Получение публичного URL ── */
export function getPublicUrl(path) {
  if (!SUPABASE.url) return null;
  return `${SUPABASE.url}/storage/v1/object/public/${BUCKET_NAME}/${path}`;
}

/* ── Генерация ключа для файла ── */
export async function generateFileKey() {
  return await generateGroupKey(); // используем тот же метод
}

/* ── Чтение файла как DataURL (для превью) ── */
export async function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/* ── Чтение файла как ArrayBuffer ── */
export async function readFileAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

/* ── Создание blob из дешифрованных байтов ── */
export function bytesToBlob(bytes, mimeType) {
  return new Blob([bytes], { type: mimeType });
}

/* ── Скачивание blob как файл ── */
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
