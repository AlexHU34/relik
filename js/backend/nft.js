/* Relik — коллекционные предметы за Relics (офчейн, без блокчейна).
   Все проверки (тираж, баланс, владение, кулдаун) — в RPC Postgres. */
import { sb } from './supabaseClient.js';
import { SUPABASE } from '../config.js';
import { S } from '../ui/state.js';

const real = () => !!(SUPABASE.url && SUPABASE.anonKey && sb && S.me?.id);

export async function listDrops() {
  if (!real()) return [];
  const [dropsRes, itemsRes] = await Promise.all([
    sb.from('nft_drops').select('id, slug, name, art, rarity, total, price, active, season, ends_at').eq('active', true).order('price'),
    sb.from('nft_items').select('drop_id'),
  ]);
  if (dropsRes.error) return [];
  const counts = {};
  for (const row of itemsRes.data || []) {
    counts[row.drop_id] = (counts[row.drop_id] || 0) + 1;
  }
  return (dropsRes.data || []).map((d) => ({
    ...d,
    minted: counts[d.id] || 0,
    left: Math.max(0, d.total - (counts[d.id] || 0)),
  }));
}

export async function myItems() {
  if (!real()) return [];
  const { data, error } = await sb
    .from('nft_items')
    .select('id, drop_id, serial, owner_id, minted_at, nft_drops(name, art, rarity, price, slug)')
    .eq('owner_id', S.me.id)
    .order('minted_at', { ascending: false })
    .limit(200);
  if (error) return [];
  return (data || []).map((it) => ({
    id: it.id,
    serial: it.serial,
    mintedAt: it.minted_at,
    drop: it.nft_drops || {},
  }));
}

export async function buyItem(dropId) {
  if (!real()) throw new Error('no_backend');
  const { data, error } = await sb.rpc('nft_buy', { p_drop: dropId });
  if (error) {
    const msg = String(error.message || '');
    if (/not_enough_relics/i.test(msg)) throw new Error('not_enough_relics');
    if (/sold_out/i.test(msg)) throw new Error('sold_out');
    if (/drop_inactive/i.test(msg)) throw new Error('drop_inactive');
    throw error;
  }
  const item = Array.isArray(data) ? data[0] : data;
  try {
    const w = await sb.from('wallets').select('balance').eq('user_id', S.me.id).maybeSingle();
    if (w?.data) S.relics = Number(w.data.balance);
  } catch (e) { /* ignore */ }
  return item;
}

export async function transferItem(itemId, toUserId) {
  if (!real()) throw new Error('no_backend');
  const { data, error } = await sb.rpc('nft_transfer', { p_item: itemId, p_to: toUserId });
  if (error) {
    const msg = String(error.message || '');
    if (/cooldown/i.test(msg)) throw new Error('cooldown');
    if (/not_owner/i.test(msg)) throw new Error('not_owner');
    if (/self_transfer/i.test(msg)) throw new Error('self_transfer');
    throw error;
  }
  return Array.isArray(data) ? data[0] : data;
}

export async function setShowcase(itemId, slot) {
  if (!real()) return;
  const { error } = await sb.rpc('nft_showcase_set', { p_item: itemId, p_slot: slot });
  if (error) throw error;
}

export async function showcaseOf(userId) {
  if (!real() || !userId) return [];
  const { data, error } = await sb
    .from('nft_showcase')
    .select('slot, item_id, nft_items(serial, nft_drops(name, art, rarity))')
    .eq('owner_id', userId)
    .order('slot');
  if (error) return [];
  return data || [];
}

export async function shareItem(itemId, chatId) {
  if (!real()) return null;
  const { data, error } = await sb.rpc('nft_share', { p_item: itemId, p_chat: chatId });
  if (error) throw error;
  return Array.isArray(data) ? data[0] : data;
}

export async function sharesForChat(chatId) {
  if (!real() || !chatId) return [];
  const { data, error } = await sb
    .from('nft_shares')
    .select('id, chat_id, item_id, from_user, created_at, nft_items(serial, nft_drops(name, art, rarity))')
    .eq('chat_id', chatId)
    .order('created_at', { ascending: true })
    .limit(50);
  if (error) return [];
  return data || [];
}

export function subscribeShares(chatId, onShare) {
  if (!real() || !chatId) return { unsubscribe: () => {} };
  const ch = sb
    .channel(`nft-shares:${chatId}`)
    .on('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'nft_shares', filter: `chat_id=eq.${chatId}`,
    }, (payload) => onShare?.(payload.new))
    .subscribe();
  return { unsubscribe: () => { sb.removeChannel(ch); } };
}
export async function itemDetail(itemId) {
  if (!real() || !itemId) return null;
  const { data, error } = await sb
    .from('nft_items')
    .select('id, drop_id, serial, owner_id, minted_at, nft_drops(name, art, rarity, price, slug, season)')
    .eq('id', itemId)
    .maybeSingle();
  if (error || !data) return null;

  const { data: history } = await sb
    .from('nft_transfers')
    .select('id, from_user, to_user, price, kind, created_at')
    .eq('item_id', itemId)
    .order('created_at', { ascending: true })
    .limit(50);

  return {
    id: data.id,
    serial: data.serial,
    ownerId: data.owner_id,
    mintedAt: data.minted_at,
    drop: data.nft_drops || {},
    history: history || [],
  };
}