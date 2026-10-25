/* Relik — блокировка пользователей.
   Отдельная таблица blocks (supabase/v2_features.sql). */
import { sb } from './supabaseClient.js';
import { SUPABASE } from '../config.js';
import { S } from '../ui/state.js';

const real = () => !!(SUPABASE.url && SUPABASE.anonKey);

export function isBlocked(uid) {
  if (!uid) return false;
  return (S.blocked || []).includes(uid);
}

export function blockedMe(uid) {
  if (!uid) return false;
  return (S.blockedBy || []).includes(uid);
}

export function hideUser(uid) {
  return isBlocked(uid) || blockedMe(uid);
}

export async function loadBlocks() {
  if (!real() || !S.me?.id) {
    S.blocked = [];
    S.blockedBy = [];
    return;
  }
  try {
    const { data, error } = await sb.from('blocks').select('owner_id, blocked_id');
    if (error) throw error;
    const rows = data || [];
    S.blocked = rows.filter((r) => r.owner_id === S.me.id).map((r) => r.blocked_id);
    S.blockedBy = rows.filter((r) => r.blocked_id === S.me.id).map((r) => r.owner_id);
  } catch (err) {
    /* таблицы нет — работаем без блокировок */
    S.blocked = S.blocked || [];
    S.blockedBy = S.blockedBy || [];
  }
}

export async function blockUser(uid) {
  if (!real() || !uid || !S.me) return;
  const { error } = await sb.from('blocks').insert({ owner_id: S.me.id, blocked_id: uid });
  if (error) throw error;
  S.blocked = [...new Set([...(S.blocked || []), uid])];
}

export async function unblockUser(uid) {
  if (!real() || !uid || !S.me) return;
  const { error } = await sb.from('blocks').delete().eq('owner_id', S.me.id).eq('blocked_id', uid);
  if (error) throw error;
  S.blocked = (S.blocked || []).filter((id) => id !== uid);
}
