/* Relik — отложенные сообщения на сервере.
   Сообщение шифруется на устройстве сразу при планировании,
   на сервер уходит только шифротекст + время. pg_cron переносит
   его в messages и ставит push в очередь, даже если приложение
   закрыто у отправителя. */

import { sb } from './supabaseClient.js';
import { SUPABASE } from '../config.js';
import { idb } from '../db/idb.js';
import { buildMessageRow } from './messages.js';

export function scheduledSupported() {
  return !!(SUPABASE.url && SUPABASE.anonKey && sb);
}

/* Зашифровать и запланировать на сервере. Возвращает id сообщения. */
export async function scheduleOnServer(item) {
  if (!scheduledSupported()) throw new Error('no_backend');
  const { row } = await buildMessageRow({
    chatId: item.chatId,
    text: item.text,
    replyToId: item.replyId || null,
    chatKind: item.chatKind || 'dm',
    theirPublicKeyJwk: item.publicKey || null,
    messageId: item.id,
    peerUserId: item.peerUserId || null,
  });

  const { error } = await sb.from('scheduled_messages').insert({
    id: row.id,
    chat_id: item.chatId,
    sender_id: row.sender_id,
    due_at: new Date(item.dueAt).toISOString(),
    payload: {
      id: row.id,
      ciphertext: row.ciphertext,
      iv: row.iv,
      reply_to: row.reply_to || null,
    },
  });

  if (error) {
    const msg = String(error.message || '');
    if (/relation|does not exist|schema cache/i.test(msg)) throw new Error('need_sql');
    throw error;
  }
  return row.id;
}

export async function cancelOnServer(id) {
  if (!scheduledSupported()) return;
  await sb.from('scheduled_messages').delete().eq('id', id);
}

export async function sendNowOnServer(id) {
  if (!scheduledSupported()) return;
  await sb.from('scheduled_messages')
    .update({ due_at: new Date().toISOString() })
    .eq('id', id);
  await sb.rpc('relik_flush_scheduled');
}

/* id, которые ещё ждут отправки на сервере */
export async function pendingOnServer() {
  if (!scheduledSupported()) return null;
  const { data, error } = await sb
    .from('scheduled_messages')
    .select('id')
    .is('delivered_at', null);
  if (error) return null;
  return (data || []).map((r) => r.id);
}

/* Убрать локальные записи, которые сервер уже отправил.
   Без сети ничего не трогаем. */
export async function reconcileLocal() {
  const ids = await pendingOnServer().catch(() => null);
  if (!ids) return 0;
  const alive = new Set(ids);
  let removed = 0;
  try {
    const all = await idb.getAll('settings');
    for (const rec of all) {
      if (!String(rec.key || '').startsWith('sched:')) continue;
      if (!rec.value?.server) continue;
      if (alive.has(rec.value.id)) continue;
      await idb.del('settings', rec.key);
      removed += 1;
    }
  } catch (e) { /* ignore */ }
  return removed;
}
