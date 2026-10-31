/* Relik — выбор нескольких сообщений: копировать, переслать, удалить.
   Экран чата передаёт свои DOM-функции через bindSelectHooks. */
import { S, chatById } from '../state.js';
import { $, snippet } from '../utils.js';
import { t } from '../../i18n/i18n.js';
import { toast } from '../toast.js';
import { idb } from '../../db/idb.js';
import { confirmAction } from '../dialog.js';
import { clearTtlTimer } from './ttl.js';
import { openForwardMany } from './forward.js';

let selectMode = false;
const selectedMsgs = new Set();

export function isSelectMode() { return selectMode; }
export function selectedIds() { return selectedMsgs; }

let hooks = {
  getEls: () => ({}),
  byId: () => null,
  escapeId: (id) => String(id),
  closeTools: () => {},
  closeReact: () => {},
  renderMessages: () => {},
  renderSidebar: () => {},
  renderPin: () => {},
};
export function bindSelectHooks(next = {}) { hooks = { ...hooks, ...next }; }

/* ── выбор нескольких сообщений ────────────────────────────── */
export function syncSelectBar() {
  const bar = $('#selectBar');
  if (!bar) return;
  bar.hidden = !selectMode;
  if (!selectMode) return;
  const n = selectedMsgs.size;
  const count = $('#selCount');
  if (count) count.textContent = n ? t('select.count').replace('{n}', String(n)) : t('select.hint');
  ['selForward', 'selCopy', 'selDelete'].forEach((id) => {
    const b = $('#' + id);
    if (b) b.disabled = n === 0;
  });
}

export function startSelect(m) {
  selectMode = true;
  selectedMsgs.clear();
  if (m?.id) selectedMsgs.add(m.id);
  hooks.closeTools();
  hooks.closeReact();
  const holder = hooks.getEls().msgs;
  holder?.classList.add('selecting');
  holder?.querySelectorAll('.msg[data-mid]').forEach((el) => {
    el.classList.add('selectable');
    el.classList.toggle('selected', selectedMsgs.has(el.dataset.mid));
  });
  syncSelectBar();
}

export function exitSelect() {
  selectMode = false;
  selectedMsgs.clear();
  const holder = hooks.getEls().msgs;
  holder?.classList.remove('selecting');
  holder?.querySelectorAll('.msg[data-mid]').forEach((el) => el.classList.remove('selectable', 'selected'));
  syncSelectBar();
}

export function toggleSelect(id) {
  if (!hooks.byId(id)) return;
  if (selectedMsgs.has(id)) selectedMsgs.delete(id);
  else selectedMsgs.add(id);
  const el = hooks.getEls().msgs?.querySelector(`.msg[data-mid="${hooks.escapeId(id)}"]`);
  el?.classList.toggle('selected', selectedMsgs.has(id));
  syncSelectBar();
}

export function selectedList() {
  return [...selectedMsgs].map((id) => hooks.byId(id)).filter(Boolean);
}

export async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* fallback */ }
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch (e) {
    return false;
  }
}

export async function copySelected() {
  const text = selectedList()
    .map((m) => m.text || snippet(m))
    .filter(Boolean)
    .join('\n\n');
  if (!text) { toast(t('select.nothing')); return; }
  if (await copyText(text)) {
    toast(t('select.copied'), { type: 'success' });
    exitSelect();
  } else {
    toast(t('toast.error'), { type: 'error' });
  }
}

export async function deleteSelected() {
  const list = selectedList();
  if (!list.length) return;
  let ok = false;
  try {
    ok = await confirmAction({
      title: t('select.deleteTitle'),
      text: t('select.deleteText'),
      ok: t('select.deleteOk'),
      danger: true,
    });
  } catch (e) { /* ignore */ }
  if (!ok) return;

  const ids = new Set(list.map((m) => m.id));
  for (const m of list) {
    clearTtlTimer(m.id);
    m.hidden = true;
    m.localDeleted = true;
  }
  await idb.bulkPut('messages', list).catch(() => {});
  const chat = chatById(S.active);
  if (chat) {
    if (chat.pin && ids.has(chat.pin.id)) {
      delete chat.pin;
      idb.del('settings', 'pin:' + chat.id).catch(() => {});
    }
    const last = (S.messages[S.active] || []).filter((x) => !x.hidden).pop();
    chat.last = last ? { ts: last.ts, from: last.sender, type: last.type, text: last.text || '' } : null;
    await idb.put('chats', chat).catch(() => {});
  }
  exitSelect();
  hooks.renderMessages();
  hooks.renderSidebar();
  hooks.renderPin();
  toast(t('select.deleted').replace('{n}', String(list.length)), { type: 'success' });
}

export function forwardSelected() {
  const list = selectedList();
  if (!list.length) return;
  exitSelect();
  openForwardMany(list);
}
