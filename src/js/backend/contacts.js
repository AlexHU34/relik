/* Relik — контакты и заявки в контакты.
   Реальный режим: таблица contact_requests + RPC из supabase/contacts.sql.
   Демо/офлайн: те же данные в IndexedDB (settings → contacts). */

import { sb } from './supabaseClient.js';
import { SUPABASE } from '../config.js';
import { idb, newId } from '../db/idb.js';
import { S } from '../ui/state.js';

const real = () => !!(SUPABASE.url && SUPABASE.anonKey);
const LOCAL_KEY = 'contacts';

/* ── локальное (демо) хранилище ── */
async function localRead() {
  const rec = await idb.get('settings', LOCAL_KEY);
  return Array.isArray(rec?.value) ? rec.value : [];
}
async function localWrite(list) {
  await idb.put('settings', { key: LOCAL_KEY, value: list });
  return list;
}

/* ── нормализация строк из базы ── */
function norm(r) {
  return {
    id: r.id,
    from: r.from_user,
    to: r.to_user,
    status: r.status,
    ts: r.created_at ? new Date(r.created_at).getTime() : Date.now(),
  };
}

/* ── есть ли миграция supabase/contacts.sql ── */
let readyCache = null;
export async function contactsReady() {
  if (!real()) return true;
  if (readyCache !== null) return readyCache;
  try {
    const { error } = await sb.from('contact_requests').select('id').limit(1);
    readyCache = !error || !/42P01|does not exist|schema cache|relation/i.test(error.message || '');
  } catch (err) {
    readyCache = false;
  }
  return readyCache;
}

/* ── все заявки текущего пользователя ── */
export async function listRequests() {
  const me = S.me?.id;
  if (!me) return { incoming: [], outgoing: [], contacts: [] };

  if (!real()) {
    const all = await localRead();
    return split(all, me);
  }

  const { data, error } = await sb
    .from('contact_requests')
    .select('id, from_user, to_user, status, created_at')
    .or(`from_user.eq.${me},to_user.eq.${me}`)
    .order('created_at', { ascending: false })
    .limit(200);

  if (error) throw error;
  return split((data || []).map(norm), me);
}

function split(rows, me) {
  const incoming = rows.filter((r) => r.to === me && r.status === 'pending');
  const outgoing = rows.filter((r) => r.from === me && r.status === 'pending');
  /* контакт = принятая заявка; собеседник — противоположная сторона */
  const contacts = rows
    .filter((r) => r.status === 'accepted')
    .map((r) => ({ reqId: r.id, userId: r.from === me ? r.to : r.from, ts: r.ts }));
  const seen = new Set();
  const uniqContacts = contacts.filter((c) => {
    if (seen.has(c.userId)) return false;
    seen.add(c.userId);
    return true;
  });
  return { incoming, outgoing, contacts: uniqContacts, all: rows };
}

/* ── отправить заявку. Возвращает 'pending' | 'accepted' ── */
export async function sendRequest(userId) {
  const me = S.me?.id;
  if (!me) throw new Error('not authenticated');
  if (!userId || userId === me) throw new Error('invalid target');

  if (!real()) {
    const all = await localRead();
    /* встречная заявка — сразу принимаем */
    const rev = all.find((r) => r.from === userId && r.to === me && r.status === 'pending');
    if (rev) {
      rev.status = 'accepted';
      await localWrite(all);
      return 'accepted';
    }
    if (all.some((r) => r.status === 'accepted' && ((r.from === me && r.to === userId) || (r.from === userId && r.to === me)))) {
      return 'accepted';
    }
    const mine = all.find((r) => r.from === me && r.to === userId);
    if (mine) {
      mine.status = 'pending';
      mine.ts = Date.now();
    } else {
      all.push({ id: newId(), from: me, to: userId, status: 'pending', ts: Date.now() });
    }
    await localWrite(all);
    return 'pending';
  }

  const { data, error } = await sb.rpc('send_contact_request', { target_user: userId });
  if (error) throw error;
  return typeof data === 'string' ? data : 'pending';
}

/* ── принять/отклонить входящую заявку ── */
export async function respondRequest(reqId, accept) {
  if (!real()) {
    const all = await localRead();
    const row = all.find((r) => r.id === reqId);
    if (row) row.status = accept ? 'accepted' : 'declined';
    await localWrite(all);
    return;
  }
  const { error } = await sb.rpc('respond_contact_request', { req_id: reqId, accept: !!accept });
  if (error) throw error;
}

/* ── отменить свою исходящую заявку ── */
export async function cancelRequest(reqId) {
  if (!real()) {
    const all = await localRead();
    await localWrite(all.filter((r) => r.id !== reqId));
    return;
  }
  const { error } = await sb.rpc('cancel_contact_request', { req_id: reqId });
  if (error) throw error;
}

/* ── убрать из контактов ── */
export async function removeContact(userId) {
  const me = S.me?.id;
  if (!me || !userId) return;
  if (!real()) {
    const all = await localRead();
    await localWrite(all.filter((r) => !((r.from === me && r.to === userId) || (r.from === userId && r.to === me))));
    return;
  }
  const { error } = await sb.rpc('remove_contact', { other_user: userId });
  if (error) throw error;
}

/* ── демо: одна входящая заявка, чтобы механизм был виден ── */
export async function seedDemoRequests(demoUsers) {
  if (real() || !S.me) return;
  const all = await localRead();
  if (all.length) return;
  const u = (demoUsers || []).find((x) => x.id && x.id !== S.me.id && !x.id.startsWith('u_me'));
  if (!u) return;
  await localWrite([{ id: newId(), from: u.id, to: S.me.id, status: 'pending', ts: Date.now() }]);
}

/* ── realtime: новая/изменённая заявка для меня ── */
export function subscribeRequests(onChange) {
  if (!real() || !sb || !S.me?.id) return { unsubscribe: () => {} };
  const me = S.me.id;
  const channel = sb
    .channel(`contact-req:${me}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'contact_requests', filter: `to_user=eq.${me}` },
      (payload) => onChange?.(payload),
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'contact_requests', filter: `from_user=eq.${me}` },
      (payload) => onChange?.(payload),
    )
    .subscribe();
  return { unsubscribe: () => { sb.removeChannel(channel); } };
}
