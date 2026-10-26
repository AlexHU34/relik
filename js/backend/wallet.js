/* Relik — внутренняя валюта «Relics».
   Все операции начисления/списания выполняются RPC в Postgres:
   клиент не может накрутить баланс. */
import { sb } from './supabaseClient.js';
import { SUPABASE } from '../config.js';
import { S } from '../ui/state.js';

const real = () => !!(SUPABASE.url && SUPABASE.anonKey && sb && S.me?.id);

function normalize(row) {
  if (!row) return null;
  return { balance: Number(row.balance) || 0, updatedAt: row.updated_at || null };
}

export async function ensureWallet() {
  if (!real()) return null;
  try {
    const { data, error } = await sb.rpc('relik_wallet_init');
    if (error) throw error;
    const w = Array.isArray(data) ? data[0] : data;
    const wl = normalize(w);
    if (wl) S.relics = wl.balance;
    return wl;
  } catch (err) {
    return null;
  }
}

export async function claimDailyBonus() {
  if (!real()) throw new Error('no_backend');
  const { data, error } = await sb.rpc('relik_daily_bonus');
  if (error) {
    if (/bonus_too_early/i.test(error.message || '')) throw new Error('bonus_too_early');
    throw error;
  }
  const w = Array.isArray(data) ? data[0] : data;
  const wl = normalize(w);
  if (wl) S.relics = wl.balance;
  return wl;
}

export async function sendGift(chatId, messageId, toUserId, amount) {
  if (!real()) throw new Error('no_backend');
  const amt = Number(amount);
  if (!Number.isInteger(amt) || amt < 1 || amt > 1000) throw new Error('invalid_amount');
  const { data, error } = await sb.rpc('relik_send_gift', {
    p_chat: chatId,
    p_message: messageId,
    p_to: toUserId,
    p_amount: amt,
  });
  if (error) {
    const msg = String(error.message || '');
    if (/not_enough_relics/i.test(msg)) throw new Error('not_enough_relics');
    if (/self_gift/i.test(msg)) throw new Error('self_gift');
    throw error;
  }
  if (S.relics != null) S.relics = Math.max(0, S.relics - amt);
  const g = Array.isArray(data) ? data[0] : data;
  return g;
}

export async function giftsForChat(chatId) {
  if (!real() || !chatId) return [];
  const { data, error } = await sb
    .from('gifts')
    .select('id, chat_id, message_id, from_user, to_user, amount, created_at')
    .eq('chat_id', chatId)
    .order('created_at', { ascending: true })
    .limit(500);
  if (error) return [];
  return data || [];
}

export function subscribeGifts(chatId, onGift) {
  if (!real() || !chatId) return { unsubscribe: () => {} };
  const ch = sb
    .channel(`gifts:${chatId}`)
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'gifts',
      filter: `chat_id=eq.${chatId}`,
    }, (payload) => onGift?.(payload.new))
    .subscribe();
  return { unsubscribe: () => { sb.removeChannel(ch); } };
}
