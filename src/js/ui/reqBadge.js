/* Relik — заявки в контакты: состояние, счётчик на конверте, realtime.
   Вынесено из modals/contacts.js: это нужно с первого экрана (бейдж и опрос
   раз в 30 с), а сами модалки грузятся лениво. Перерисовку открытых окон
   подписчики регистрируют сами через onRequestsChanged(). */
import { S } from './state.js';
import { $ } from './utils.js';
import { t } from '../i18n/i18n.js';
import { SUPABASE } from '../config.js';
import { toast } from './toast.js';
import {
  listRequests, subscribeRequests, seedDemoRequests,
} from '../backend/contacts.js';

/* обновить заявки и счётчик на конверте */
export async function refreshRequests() {
  if (!S.me) return { incoming: [], outgoing: [], contacts: [] };
  let data = { incoming: [], outgoing: [], contacts: [] };
  try {
    /* в демо-режиме один раз показываем входящую заявку, чтобы был виден механизм */
    if (!(SUPABASE.url && SUPABASE.anonKey)) await seedDemoRequests(S.users);
    data = await listRequests();
  } catch (err) {
    console.error('Contact requests error:', err);
  }
  S.reqIn = data.incoming || [];
  S.reqOut = data.outgoing || [];
  S.contacts = data.contacts || [];
  updateReqBadge();
  return data;
}

export function updateReqBadge() {
  const badge = $('#reqBadge');
  if (!badge) return;
  const n = S.reqIn.length;
  badge.textContent = n > 99 ? '99+' : String(n);
  badge.hidden = n === 0;
  const btn = $('#requestsBtn');
  if (btn) btn.classList.toggle('has-requests', n > 0);
}

/* Подписчики на «заявки изменились» (окна людей/заявок, если они уже открыты). */
const changedListeners = new Set();
export function onRequestsChanged(fn) {
  changedListeners.add(fn);
  return () => changedListeners.delete(fn);
}

/* realtime: пришла заявка — показать сразу */
let reqSub = null;
export function startContactRealtime() {
  if (reqSub) return;
  reqSub = subscribeRequests(async (payload) => {
    await refreshRequests();
    if (payload?.eventType === 'INSERT' && $('#reqOv').hidden) {
      toast(t('req.toastNew'));
    }
    for (const fn of changedListeners) {
      try { fn(); } catch (e) { /* ignore */ }
    }
  });
}
