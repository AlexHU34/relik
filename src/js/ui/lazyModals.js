/* Relik — ленивая загрузка модальных окон (modals.js + settings/contacts/group).
   Настройки, новый чат, люди и заявки нужны не всем и не сразу: экран входа
   обходится без них. Обёртки ниже грузят чанк по первому обращению, поэтому
   app-чанк легче на ~60 КБ исходника (настройки + контакты + группы).

   Правила:
   - initModals() вызывается ровно один раз, перед первым открытием окна;
   - повторный клик во время загрузки игнорируется (окно откроет первый);
   - наведение/фокус на кнопки-триггеры заранее тянет чанк (как палитра). */
import { S } from './state.js';
import { $ } from './utils.js';

let chunk = null;
let booted = false;
let loading = false;

function modalsReady() {
  if (!chunk) {
    chunk = import('./modals.js');
    /* ошибка сети: следующий клик попробует снова */
    chunk.catch(() => { chunk = null; });
  }
  return chunk;
}

async function bootModals() {
  const m = await modalsReady();
  if (!booted) {
    booted = true;
    try { m.initModals(); } catch (e) { console.error('initModals error:', e); }
  }
  return m;
}

/* Одна загрузка на все окна: второй клик ждёт тот же промис. */
async function withModals(fn) {
  if (loading) return undefined;
  loading = true;
  try {
    const m = await bootModals();
    return await fn(m);
  } catch (e) {
    console.error('modals load error:', e);
    return undefined;
  } finally {
    loading = false;
  }
}

export function openSettings() {
  return withModals((m) => m.openSettings());
}

export function openNewChat() {
  return withModals((m) => m.openNewChat());
}

export function openPeople() {
  return withModals((m) => m.openPeople());
}

export function openRequests() {
  return withModals((m) => m.openRequests());
}

export function openGroupCreator() {
  return withModals((m) => m.openGroupCreator());
}

export function openGroupManager(chatId) {
  return withModals((m) => m.openGroupManager(chatId));
}

export function openGlobalSearch(initial = '') {
  return withModals((m) => m.openGlobalSearch(initial));
}

/* Клик по контакту в окне «новый чат» — окно уже открыто, значит чанк есть. */
export function contactClicked(e) {
  return withModals((m) => m.contactClicked(e));
}

/* Заранее тянем чанк по наведению/фокусу на кнопки, которые его откроют. */
const TRIGGERS = '#settingsBtn,#meChip,#newChatBtn,#peopleBtn,#requestsBtn,#emptyNewChat,#emptySettings';

export function wireModalsPrefetch() {
  const wake = () => { modalsReady().catch(() => {}); };
  document.addEventListener('pointerover', (e) => {
    if (e.target instanceof Element && e.target.closest(TRIGGERS)) wake();
  }, { passive: true });
  document.addEventListener('focusin', (e) => {
    if (e.target instanceof Element && e.target.closest(TRIGGERS)) wake();
  });

  /* Ctrl/Cmd+Shift+F — сквозной поиск. Пока modals.js не загружен, его
     обработчика нет, поэтому лёгкий дубль живёт здесь и замолкает после boot. */
  document.addEventListener('keydown', (e) => {
    if (booted) return;
    if (!(e.ctrlKey || e.metaKey) || !e.shiftKey) return;
    if (!(e.code === 'KeyF' || String(e.key).toLowerCase() === 'f') || !S.me) return;
    if ($('#paletteOv') && !$('#paletteOv').hidden) return;
    e.preventDefault();
    openGlobalSearch($('#searchInput')?.value || '');
  }, true);

  /* «Поиск по переписке» из панели чата */
  document.addEventListener('click', (e) => {
    if (booted) return;
    if (!(e.target instanceof Element) || !e.target.closest('[data-search-messages]')) return;
    e.preventDefault();
    openGlobalSearch($('#searchInput')?.value || '');
  });
}
