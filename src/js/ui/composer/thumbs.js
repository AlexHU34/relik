/* Relik — превью и миниатюры для медиа в композере.
   Вынесено из media.js: там лимит строк, а работа с canvas/видео — отдельная тема. */

export const blobToDataUrl = (blob) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(r.result);
  r.onerror = rej;
  r.readAsDataURL(blob);
});

export function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = src;
  });
}

/* Миниатюра для мгновенного превью, пока полный файл летит из Storage */
export async function imageThumbFromDataUrl(dataUrl, max = 96) {
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

export async function videoThumbFromBlob(blob, max = 160) {
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
