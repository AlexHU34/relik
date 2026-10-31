/* Relik — медиа в композере: сжатие, превью, шифрование и отправка.
   Чат-экран передаёт deliverMessage через bindMediaHooks (без циклического импорта). */
import { S, chatById } from '../state.js';
import { idb, newId } from '../../db/idb.js';
import { t } from '../../i18n/i18n.js';
import { SUPABASE } from '../../config.js';
import { toast } from '../toast.js';
import { sendMessage, encodeMedia } from '../../backend/messages.js';
import { uploadEncryptedBlob, dataUrlToBlob, rememberMediaPreview, readFileAsDataURL } from '../../backend/storage.js';
import { refreshMessageStatus } from '../chat/receipts.js';
import { playSent } from '../sounds.js';
import { friendlySendError } from './retry.js';

let hooks = { deliverMessage: async () => {}, clearReplyEdit: () => {} };
export function bindMediaHooks(next = {}) { hooks = { ...hooks, ...next }; }

export const blobToDataUrl = (blob) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(r.result);
  r.onerror = rej;
  r.readAsDataURL(blob);
});

const MAX_MEDIA_CHARS = 900000;
export const MAX_VOICE_CHARS = 4000000;
const MAX_FILE_BYTES = 60 * 1024 * 1024;
const MAX_VIDEO_BYTES = 80 * 1024 * 1024;
export const MAX_CIRCLE_MS = 60000;

function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = src;
  });
}

/* Миниатюра для мгновенного превью, пока полный файл летит из Storage */
async function imageThumbFromDataUrl(dataUrl, max = 96) {
  try {
    const img = await loadImage(dataUrl);
    const w = img.width || img.naturalWidth || 1;
    const h = img.height || img.naturalHeight || 1;
    const scale = Math.min(1, max / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const g = canvas.getContext('2d');
    g.fillStyle = '#0b0e14';
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.62);
  } catch (e) {
    return '';
  }
}

async function videoThumbFromBlob(blob, max = 160) {
  const url = URL.createObjectURL(blob);
  return await new Promise((resolve) => {
    const v = document.createElement('video');
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      try { v.removeAttribute('src'); v.load(); } catch (e) { /* ignore */ }
      URL.revokeObjectURL(url);
      resolve(val || '');
    };
    const timer = setTimeout(() => finish(''), 5000);
    v.muted = true;
    v.playsInline = true;
    v.preload = 'metadata';
    v.onloadedmetadata = () => {
      try { v.currentTime = Math.min(0.25, (v.duration || 1) / 2); } catch (e) { finish(''); }
    };
    v.onseeked = () => {
      try {
        const w = v.videoWidth || 1;
        const h = v.videoHeight || 1;
        const scale = Math.min(1, max / Math.max(w, h));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(w * scale));
        canvas.height = Math.max(1, Math.round(h * scale));
        canvas.getContext('2d').drawImage(v, 0, 0, canvas.width, canvas.height);
        clearTimeout(timer);
        finish(canvas.toDataURL('image/jpeg', 0.65));
      } catch (e) {
        clearTimeout(timer);
        finish('');
      }
    };
    v.onerror = () => { clearTimeout(timer); finish(''); };
    v.src = url;
  });
}

async function compressToDataUrl(file) {
  const url = URL.createObjectURL(file);
  let source = null;
  try {
    if (typeof createImageBitmap === 'function') {
      try {
        source = await createImageBitmap(file, { imageOrientation: 'from-image' });
      } catch (e) { /* браузер не умеет — ниже обычный Image */ }
    }
    if (!source) source = await loadImage(url);

    const w = source.width || source.naturalWidth || 1;
    const h = source.height || source.naturalHeight || 1;
    const keepAlpha = /^image\/(png|webp|gif)$/i.test(String(file.type));
    const bgColor = getComputedStyle(document.body).backgroundColor || '#0b0e14';

    /* PNG/WebP с прозрачностью сначала пробуем сохранить как есть,
       и только если не влезает — уменьшаем и уходим в JPEG */
    const variants = keepAlpha
      ? [
        [1400, 0.92, 'image/png'], [1100, 0.9, 'image/png'],
        [900, 0.88, 'image/png'], [720, 0.85, 'image/png'],
        [1400, 0.82, 'image/jpeg'], [1100, 0.76, 'image/jpeg'],
        [900, 0.7, 'image/jpeg'], [720, 0.64, 'image/jpeg'],
      ]
      : [
        [1400, 0.82, 'image/jpeg'], [1100, 0.76, 'image/jpeg'],
        [900, 0.7, 'image/jpeg'], [720, 0.64, 'image/jpeg'],
      ];

    for (const [max, quality, mime] of variants) {
      const scale = Math.min(1, max / Math.max(w, h));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(w * scale));
      canvas.height = Math.max(1, Math.round(h * scale));
      const g = canvas.getContext('2d');
      if (mime === 'image/jpeg') {
        g.fillStyle = bgColor;
        g.fillRect(0, 0, canvas.width, canvas.height);
      }
      g.drawImage(source, 0, 0, canvas.width, canvas.height);
      const src = canvas.toDataURL(mime, quality);
      if (src.length <= MAX_MEDIA_CHARS) return src;
    }
    return null;
  } finally {
    try { source?.close?.(); } catch (e) { /* ignore */ }
    URL.revokeObjectURL(url);
  }
}

/* Собираем wire-формат: либо inline data URL, либо путь в Storage + ключ.
   Ключ файла едет внутри зашифрованного сообщения. */
function mediaWire(payload) {
  const base = {
    kind: payload.kind,
    name: payload.name,
    size: payload.size,
    mime: payload.mime || '',
  };
  if (payload.path) {
    base.path = payload.path;
    base.k = payload.k;
    base.iv = payload.iv;
    if (payload.thumb) base.thumb = payload.thumb;
  } else if (payload.src) {
    base.src = payload.src;
  }
  if (payload.voice) base.voice = { ...payload.voice };
  if (Array.isArray(payload.items)) {
    base.items = payload.items.map((it) => ({
      name: it.name || 'photo.jpg',
      size: it.size || 0,
      mime: it.mime || '',
      ...(it.path ? { path: it.path, k: it.k, iv: it.iv, ...(it.thumb ? { thumb: it.thumb } : {}) } : { src: it.src }),
    }));
  }
  return encodeMedia(base);
}

function mediaMessage(payload, replyBox) {
  const src = payload.previewSrc || payload.src || '';
  const msg = {
    id: newId(), chatId: S.active, sender: 'u_me', ts: Date.now(),
    type: payload.kind,
    file: {
      name: payload.name || 'file',
      size: payload.size || 0,
      mime: payload.mime || '',
      src,
      ...(payload.thumb ? { thumb: payload.thumb } : {}),
    },
    text: '', reactions: [],
    wire: mediaWire(payload),
    status: SUPABASE.url && SUPABASE.anonKey ? 'sending' : 'sent',
    ...(replyBox ? { replyTo: replyBox } : {}),
  };

  if (payload.path) {
    msg.media = {
      path: payload.path, k: payload.k, iv: payload.iv,
      mime: payload.mime || '', name: payload.name || 'file', size: payload.size || 0,
    };
    rememberMediaPreview(payload.path, src);
  }
  if (payload.kind === 'voice') {
    msg.voice = { ...(payload.voice || {}), src: payload.voice?.src || src };
  }
  if (payload.kind === 'album') {
    msg.album = (payload.items || []).map((it) => {
      const itemSrc = it.previewSrc || it.src || '';
      if (it.path) rememberMediaPreview(it.path, itemSrc);
      return {
        name: it.name || 'photo.jpg',
        size: it.size || 0,
        mime: it.mime || '',
        src: itemSrc,
        ...(it.thumb ? { thumb: it.thumb } : {}),
        ...(it.path ? { path: it.path, k: it.k, iv: it.iv } : {}),
      };
    });
  }
  return msg;
}

export async function sendMediaPayload(payload, chatId = S.active) {
  const chat = chatById(chatId);
  if (!chat) return null;

  const replyId = S.reply?.id || null;
  const replyBox = S.reply ? { ...S.reply } : null;
  const msg = mediaMessage(payload, replyBox);
  msg.chatId = chat.id;

  hooks.clearReplyEdit();
  await hooks.deliverMessage(chat.id, msg);
  playSent();

  if (!(SUPABASE.url && SUPABASE.anonKey)) return msg;

  try {
    await sendMessage(chat.id, msg.wire, replyId, chat.kind, chat.publicKey, msg.id, chat.userId || null);
    msg.status = 'sent';
    await idb.put('messages', msg);
    refreshMessageStatus(msg);
  } catch (err) {
    console.error('Media send error:', err);
    msg.status = 'error';
    await idb.put('messages', msg);
    refreshMessageStatus(msg);
    toast(friendlySendError(err) || t('media.error'), { type: 'error' });
  }
  return msg;
}

/* Inline data URL → Storage; если Storage недоступен — оставляем data URL */
export async function payloadFromDataUrl(chatId, dataUrl, meta = {}) {
  const blob = dataUrlToBlob(dataUrl);
  const name = meta.name || 'file';
  const mime = meta.mime || blob.type || 'application/octet-stream';
  const up = await uploadEncryptedBlob(chatId, blob, { name, size: blob.size, mime });
  if (up) {
    const thumb = meta.kind === 'image' ? await imageThumbFromDataUrl(dataUrl) : '';
    return { ...meta, ...up, name, mime, size: blob.size, thumb, previewSrc: URL.createObjectURL(blob) };
  }
  const limit = meta.kind === 'voice' ? MAX_VOICE_CHARS : MAX_MEDIA_CHARS;
  if (dataUrl.length > limit) return null;
  return { ...meta, name, mime, size: blob.size, src: dataUrl };
}

export async function payloadFromBlob(chatId, blob, meta = {}) {
  const name = meta.name || 'file';
  const mime = blob.type || meta.mime || 'application/octet-stream';
  const up = await uploadEncryptedBlob(chatId, blob, { name, size: blob.size, mime });
  const previewSrc = URL.createObjectURL(blob);
  if (up) {
    const thumb = (meta.kind === 'video' || meta.kind === 'videoNote')
      ? await videoThumbFromBlob(blob)
      : '';
    return { ...meta, ...up, name, mime, size: blob.size, thumb, previewSrc };
  }
  if (blob.size <= MAX_MEDIA_CHARS * 0.72) {
    const src = await blobToDataUrl(blob);
    if (src.length <= MAX_MEDIA_CHARS) {
      try { URL.revokeObjectURL(previewSrc); } catch (e) { /* ignore */ }
      return { ...meta, name, mime, size: blob.size, src };
    }
  }
  try { URL.revokeObjectURL(previewSrc); } catch (e) { /* ignore */ }
  return null;
}

/* Индикатор для больших файлов: без него непонятно, почему ничего не происходит */
export async function withUploadNotice(size, fn) {
  let note = null;
  if (Number(size) > 2 * 1024 * 1024) {
    note = toast(t('media.uploading'), { duration: 0 });
  }
  try {
    return await fn();
  } finally {
    try { note?.close(); } catch (e) { /* ignore */ }
  }
}

/* Отправка выбранного/вставленного/перетащенного файла */
export async function handlePickedFile(file, chatId = S.active) {
  if (!file || !chatById(chatId)) return;
  try {
    const kind = String(file.type || '');

    if (kind.startsWith('image/')) {
      const src = await compressToDataUrl(file);
      if (!src) { toast(t('media.tooBig'), { type: 'error' }); return; }
      const payload = await payloadFromDataUrl(chatId, src, {
        kind: 'image', name: file.name || 'photo.jpg',
        mime: dataUrlToBlob(src).type || 'image/jpeg',
      });
      if (!payload) { toast(t('media.tooBig'), { type: 'error' }); return; }
      await sendMediaPayload(payload, chatId);
      return;
    }

    if (kind.startsWith('video/')) {
      if (file.size > MAX_VIDEO_BYTES) { toast(t('media.tooBig'), { type: 'error' }); return; }
      const payload = await withUploadNotice(file.size, () => payloadFromBlob(chatId, file, {
        kind: 'video', name: file.name || 'video.mp4', mime: kind,
      }));
      if (!payload) { toast(t('media.storageNeeded'), { type: 'error' }); return; }
      await sendMediaPayload(payload, chatId);
      return;
    }

    if (file.size > MAX_FILE_BYTES) { toast(t('media.tooBig'), { type: 'error' }); return; }
    let payload = await withUploadNotice(file.size, () => payloadFromBlob(chatId, file, {
      kind: 'file', name: file.name || 'file', mime: kind,
    }));
    if (!payload && file.size <= MAX_MEDIA_CHARS * 0.72) {
      const src = await readFileAsDataURL(file);
      if (src.length <= MAX_MEDIA_CHARS) {
        payload = { kind: 'file', name: file.name || 'file', size: file.size, mime: kind, src };
      }
    }
    if (!payload) { toast(t('media.storageNeeded'), { type: 'error' }); return; }
    await sendMediaPayload(payload, chatId);
  } catch (err) {
    console.error('File error:', err);
    toast(t('media.error'), { type: 'error' });
  }
}

/* Несколько фото одним сообщением-альбомом */
export async function sendAlbum(files, chatId = S.active) {
  if (!chatById(chatId) || !files?.length) return;
  const list = [...files].slice(0, 10);
  const total = list.reduce((n, f) => n + (f.size || 0), 0);
  const items = await withUploadNotice(total > 3 * 1024 * 1024 ? total : 0, async () => {
    const out = [];
    for (const file of list) {
      if (!String(file.type || '').startsWith('image/')) continue;
      try {
        const src = await compressToDataUrl(file);
        if (!src) continue;
        const item = await payloadFromDataUrl(chatId, src, {
          kind: 'image',
          name: file.name || 'photo.jpg',
          mime: dataUrlToBlob(src).type || 'image/jpeg',
        });
        if (item) out.push(item);
      } catch (err) {
        console.warn('Album item error:', err);
      }
    }
    return out;
  });
  if (!items.length) { toast(t('media.tooBig'), { type: 'error' }); return; }
  const size = items.reduce((sum, it) => sum + (it.size || 0), 0);
  await sendMediaPayload({ kind: 'album', name: 'album', size, items }, chatId);
}

export function pickAndSend(kind) {
  const chatId = S.active;
  if (!chatById(chatId)) return;
  const input = document.createElement('input');
  input.type = 'file';
  if (kind === 'image' || kind === 'album') input.accept = 'image/*';
  if (kind === 'video') input.accept = 'video/*';
  if (kind === 'album') input.multiple = true;
  input.onchange = (e) => {
    const files = [...(e.target.files || [])];
    e.target.value = '';
    if (!files.length) return;
    if (kind === 'album') sendAlbum(files, chatId);
    else handlePickedFile(files[0], chatId);
  };
  input.click();
}

/* Оставлены для совместимости (могут вызываться из других модулей) */
export function sendImage() { pickAndSend('image'); }
export function sendFile() { pickAndSend('file'); }
export function sendVideo() { pickAndSend('video'); }
