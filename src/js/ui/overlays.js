/* Relik — инфраструктура оверлеев: закрытие, ловушка фокуса, Esc, лайтбокс.
   Живёт отдельно от modals.js, потому что эти обработчики нужны с первого
   экрана (окна открывают chatView/composer), а сами модалки грузятся лениво. */
import { $ } from './utils.js';
import { icon } from './icons.js';
import { t } from '../i18n/i18n.js';
import { closeOv } from './modals/shared.js';
import { stepLightbox, closeLightbox, downloadLightbox } from './modals/lightbox.js';

/* Окна, которые навигация/Esc не закрывают: пригласительный код, палитра
   команд (свой Esc) и «кружок» видеосообщения во время звонка. */
const KEEP_OPEN = new Set(['verifyOv', 'paletteOv', 'circleOv']);

/* Закрыть все «мимолётные» окна: Esc и любая навигация по хешу. */
export function closeTransientOverlays() {
  document.querySelectorAll('.overlay').forEach((ov) => {
    if (!ov.hidden && !KEEP_OPEN.has(ov.id)) closeOv(ov);
  });
}

export function initOverlays() {
  /* статичные иконки закрытия */
  document.querySelectorAll('.m-head [data-close]').forEach((b) => { b.innerHTML = icon('x', 18); });
  if ($('#lbX')) $('#lbX').innerHTML = icon('x', 20);
  if ($('#lbDl')) {
    $('#lbDl').innerHTML = icon('dl', 20);
    $('#lbDl').title = t('media.download');
    $('#lbDl').setAttribute('aria-label', t('media.download'));
  }
  if ($('#ncGroupIc')) $('#ncGroupIc').innerHTML = icon('users', 18);
  if ($('#ncPeopleIc')) $('#ncPeopleIc').innerHTML = icon('search', 18);

  /* закрытие по крестику и клику по фону любого оверлея */
  document.querySelectorAll('.overlay').forEach((ov) => {
    ov.addEventListener('click', (e) => { if (e.target === ov) closeOv(ov); });
    ov.querySelectorAll('[data-close]').forEach((btn) => {
      btn.addEventListener('click', () => closeOv(ov));
    });
  });

  /* ── доступность: Tab не выходит из открытого окна ── */
  const dialogRoots = [...document.querySelectorAll('.overlay, .lightbox')];
  const trapStack = [];
  const focusables = (root) => [...root.querySelectorAll(
    'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'
  )].filter((el) => !el.hidden && el.getClientRects().length > 0);
  const topTrap = () => trapStack[trapStack.length - 1] || null;

  const pushTrap = (root) => {
    if (trapStack.some((tr) => tr.root === root)) return;
    const prev = document.activeElement;
    trapStack.push({ root, prev });
    const list = focusables(root);
    const first = root.querySelector('[autofocus]') || list[0] || root;
    if (first === root && !root.hasAttribute('tabindex')) root.setAttribute('tabindex', '-1');
    try { first.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  };

  const popTrap = (root) => {
    const i = trapStack.findIndex((tr) => tr.root === root);
    if (i < 0) return;
    const [tr] = trapStack.splice(i, 1);
    const top = topTrap();
    const list = top ? focusables(top.root) : [];
    const target = top ? (list[0] || top.root) : tr.prev;
    if (target && target.isConnected && !root.contains(target)) {
      try { target.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    }
  };

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const top = topTrap();
    if (!top) return;
    const list = focusables(top.root);
    if (!list.length) { e.preventDefault(); return; }
    const first = list[0];
    const last = list[list.length - 1];
    const active = document.activeElement;
    if (!top.root.contains(active)) { e.preventDefault(); first.focus(); return; }
    if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  }, true);

  const trapObserver = new MutationObserver((muts) => {
    for (const m of muts) {
      const root = m.target;
      if (!(root instanceof Element) || !root.matches('.overlay, .lightbox')) continue;
      if (!root.hidden) pushTrap(root);
      else popTrap(root);
    }
  });
  dialogRoots.forEach((root) => {
    trapObserver.observe(root, { attributes: true, attributeFilter: ['hidden'] });
    if (!root.hidden) pushTrap(root);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if ($('#lightbox') && !$('#lightbox').hidden) closeLightbox();
    else closeTransientOverlays();
  });
  document.addEventListener('keydown', (e) => {
    if (!$('#lightbox') || $('#lightbox').hidden) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); stepLightbox(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); stepLightbox(1); }
  });
  $('#lbPrev')?.addEventListener('click', () => stepLightbox(-1));
  $('#lbNext')?.addEventListener('click', () => stepLightbox(1));
  $('#lbX')?.addEventListener('click', closeLightbox);
  $('#lbDl')?.addEventListener('click', downloadLightbox);
}
