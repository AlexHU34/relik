/* Relik — серверный срок жизни сообщений.
   Клиент знает, когда сообщение должно исчезнуть (после прочтения),
   и сообщает серверу только id + время. pg_cron раз в минуту
   стирает шифротекст просроченных сообщений, даже если приложение
   закрыто у всех участников. */

import { sb } from './supabaseClient.js';
import { SUPABASE } from '../config.js';

const real = () => !!(SUPABASE.url && SUPABASE.anonKey && sb);

const queue = new Map(); // messageId -> { chat_id, expires_at }
let timer = null;
let lastSweep = 0;
let busy = false;

function schedule() {
  if (timer) return;
  timer = setTimeout(flush, 1500);
}

async function flush() {
  timer = null;
  if (!real() || !queue.size || busy) return;
  busy = true;
  const rows = [...queue.entries()].map(([message_id, v]) => ({
    message_id,
    chat_id: v.chat_id,
    expires_at: v.expires_at,
  }));
  queue.clear();
  try {
    const { error } = await sb.from('message_expiry').upsert(rows, { onConflict: 'message_id' });
    if (error) {
      /* без миграции ttl_server.sql фича просто не работает — не шумим */
      if (!/relation|does not exist|schema cache|permission/i.test(error.message || '')) {
        console.warn('TTL sync error:', error.message);
      }
    }
  } catch (e) { /* игнорируем: TTL остаётся локальным */ }
  finally {
    busy = false;
    if (queue.size) schedule();
  }
}

/* Поставить/обновить срок исчезновения сообщения */
export function registerExpiry(messageId, chatId, expiresAt) {
  if (!real() || !messageId || !chatId || !expiresAt) return;
  const iso = new Date(expiresAt).toISOString();
  const prev = queue.get(messageId);
  if (prev && prev.expires_at === iso) return;
  queue.set(messageId, { chat_id: chatId, expires_at: iso });
  schedule();
}

/* Снять срок (TTL выключили) */
export async function clearExpiry(chatId) {
  if (!real() || !chatId) return;
  try { await sb.from('message_expiry').delete().eq('chat_id', chatId); } catch (e) { /* ignore */ }
}

/* Досрочно прогнать уборку (на случай, если cron отключён) */
export async function sweepExpired(force = false) {
  if (!real()) return 0;
  if (!force && Date.now() - lastSweep < 5 * 60 * 1000) return 0;
  lastSweep = Date.now();
  try {
    const { data, error } = await sb.rpc('relik_expire_messages');
    if (error) return 0;
    return Number(data) || 0;
  } catch (e) {
    return 0;
  }
}
