/* Relik — полноэкранный просмотр медиа (лайтбокс).
   Вынесено из modals.js: свои данные и только один импорт ($). */
import { $ } from '../utils.js';

/* ── ЛАЙТБОКС ── */
let lightboxSrc = '';
let lightboxName = 'relik-image.jpg';
let lightboxGallery = [];
let lightboxIndex = 0;

function showLightboxItem() {
  const item = lightboxGallery[lightboxIndex];
  if (!item) return;
  lightboxSrc = item.src;
  lightboxName = item.name || 'relik-image.jpg';
  $('#lbImg').src = lightboxSrc;
  $('#lbImg').alt = lightboxName;
  const many = lightboxGallery.length > 1;
  const prev = $('#lbPrev');
  const next = $('#lbNext');
  const count = $('#lbCount');
  if (prev) prev.hidden = !many;
  if (next) next.hidden = !many;
  if (count) {
    count.hidden = !many;
    count.textContent = many ? `${lightboxIndex + 1} / ${lightboxGallery.length}` : '';
  }
}

export function openLightbox(src, name, gallery = null) {
  const items = (Array.isArray(gallery) ? gallery : [])
    .filter((it) => it?.src)
    .map((it) => ({ src: it.src, name: it.name || 'relik-image.jpg' }));
  lightboxGallery = items.length ? items : [{ src: String(src || ''), name: name ? String(name) : 'relik-image.jpg' }];
  const wanted = String(src || '');
  const idx = lightboxGallery.findIndex((it) => it.src === wanted);
  lightboxIndex = idx >= 0 ? idx : 0;
  showLightboxItem();
  $('#lightbox').hidden = false;
}

export function stepLightbox(dir) {
  if (lightboxGallery.length < 2) return;
  lightboxIndex = (lightboxIndex + dir + lightboxGallery.length) % lightboxGallery.length;
  showLightboxItem();
}

export function closeLightbox() {
  $('#lightbox').hidden = true;
  $('#lbImg').src = '';
  lightboxSrc = '';
  lightboxGallery = [];
  lightboxIndex = 0;
}
export function downloadLightbox() {
  if (!lightboxSrc) return;
  const a = document.createElement('a');
  a.href = lightboxSrc;
  a.download = lightboxName || 'relik-image.jpg';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
