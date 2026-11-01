/* Relik — онбординг первого запуска: три экрана, показывается один раз.
   Без внешних зависимостей и без правок index.html: DOM строится здесь,
   стили — css/components/modals.css (классы .ob-*). */

import { icon } from './icons.js';
import { t } from '../i18n/i18n.js';
import { toast } from './toast.js';

const FLAG = 'relik.onboarded.v1';
const PIN_FLAG = 'relik.pin.v1';

const STEPS = [
  { ic: 'spark', title: 'ob.step1Title', text: 'ob.step1Text' },
  { ic: 'shield', title: 'ob.step2Title', text: 'ob.step2Text' },
  { ic: 'users', title: 'ob.step3Title', text: 'ob.step3Text' },
];

let built = null;
let step = 0;

function inviteLink() {
  try {
    return `${location.origin}${location.pathname.replace(/index\.html$/, '')}`;
  } catch (e) {
    return 'https://relik.best/';
  }
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

function build() {
  if (built) return built;

  const ov = el('div', 'ob-ov');
  ov.id = 'obOv';
  ov.hidden = true;
  ov.setAttribute('role', 'dialog');
  ov.setAttribute('aria-modal', 'true');
  ov.setAttribute('aria-labelledby', 'obTitle');

  const card = el('div', 'ob-card');
  const art = el('div', 'ob-art');
  const title = el('h2', '', '');
  title.id = 'obTitle';
  const text = el('p', 'ob-text', '');
  const dots = el('div', 'ob-dots');
  for (let i = 0; i < STEPS.length; i += 1) dots.appendChild(el('i'));

  const actions = el('div', 'ob-actions');
  const copy = el('button', 'ob-copy');
  copy.type = 'button';
  copy.addEventListener('click', async () => {
    const link = inviteLink();
    try {
      await navigator.clipboard.writeText(link);
      toast(t('chat.inviteCopied'), { type: 'success' });
    } catch (e) {
      toast(link, { duration: 0 });
    }
  });
  const next = el('button', 'btn btn-primary ob-next');
  next.type = 'button';
  next.id = 'obNext';
  const skip = el('button', 'ob-skip');
  skip.type = 'button';
  skip.id = 'obSkip';
  skip.textContent = t('ob.skip');
  actions.append(copy, next, skip);

  card.append(art, title, text, dots, actions);
  ov.appendChild(card);
  document.body.appendChild(ov);

  next.addEventListener('click', () => {
    if (step >= STEPS.length - 1) { finish(); return; }
    step += 1;
    paint();
  });
  skip.addEventListener('click', finish);
  ov.addEventListener('click', (e) => {
    if (e.target === ov) finish();
  });
  ov.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); finish(); return; }
    if (e.key !== 'Tab') return;
    /* Ловушка фокуса: в оверлее всего две-три кнопки. */
    const focusable = [copy, next, skip].filter((b) => !b.hidden);
    if (!focusable.length) return;
    const i = focusable.indexOf(document.activeElement);
    const dir = e.shiftKey ? -1 : 1;
    const to = focusable[(i + dir + focusable.length) % focusable.length];
    e.preventDefault();
    to.focus();
  });

  built = { ov, art, title, text, dots, copy, next, skip };
  return built;
}

function paint() {
  if (!built) return;
  const s = STEPS[step];
  built.art.innerHTML = icon(s.ic, 26);
  built.title.textContent = t(s.title);
  built.text.textContent = t(s.text);
  built.dots.querySelectorAll('i').forEach((d, i) => {
    d.classList.toggle('on', i === step);
  });
  const last = step === STEPS.length - 1;
  built.next.textContent = t(last ? 'ob.done' : 'ob.next');
  built.copy.hidden = !last;
  built.copy.textContent = t('ob.copy');
}

function finish() {
  try { localStorage.setItem(FLAG, '1'); } catch (e) { /* приватный режим */ }
  if (built) built.ov.hidden = true;
}

/** Показать онбординг принудительно (например, из настроек в будущем). */
export function openOnboarding() {
  built = build();
  step = 0;
  paint();
  built.ov.hidden = false;
  setTimeout(() => { try { built.next.focus(); } catch (e) { /* ignore */ } }, 60);
  return true;
}

/** Показать один раз на первом запуске. Возвращает true, если показали. */
export function maybeShowOnboarding() {
  try {
    if (localStorage.getItem(FLAG)) return false;
    /* С PIN-кодом сначала разблокировка — иначе модалка перекроет замок. */
    if (localStorage.getItem(PIN_FLAG)) return false;
  } catch (e) { /* приватный режим: покажем, ничего не сломается */ }
  return openOnboarding();
}

/* Для тестов и e2e: сбросить отметку «уже видел». */
export function resetOnboarding() {
  try { localStorage.removeItem(FLAG); } catch (e) { /* ignore */ }
}
