/* Relik — сигналинг звонков через Supabase Realtime Broadcast
   Каждый пользователь слушает канал user:<свой id>, звонящий шлёт в user:<id собеседника>. */

import { sb } from './supabaseClient.js';

let inChannel = null;
const outChannels = new Map();

export function initCallSignaling(me, onEvent) {
  if (!sb || !me?.id) return;
  stopCallSignaling();
  inChannel = sb.channel(`user:${me.id}`, { config: { broadcast: { self: false } } });
  inChannel.on('broadcast', { event: 'call' }, (payload) => {
    if (payload?.payload) onEvent(payload.payload);
  });
  inChannel.subscribe((status) => {
    if (status === 'SUBSCRIBED') console.log('Call signaling ready');
  });
}

export function stopCallSignaling() {
  if (!sb) return;
  if (inChannel) { sb.removeChannel(inChannel); inChannel = null; }
  for (const ch of outChannels.values()) sb.removeChannel(ch);
  outChannels.clear();
}

function ensureOut(userId) {
  if (outChannels.has(userId)) return Promise.resolve(outChannels.get(userId));
  return new Promise((resolve) => {
    const ch = sb.channel(`user:${userId}`);
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      outChannels.set(userId, ch);
      resolve(ch);
    };
    ch.subscribe((status) => { if (status === 'SUBSCRIBED') done(); });
    setTimeout(done, 2500);
  });
}

export async function sendCallSignal(userId, payload) {
  if (!sb || !userId) return;
  const ch = await ensureOut(userId);
  try {
    await ch.send({ type: 'broadcast', event: 'call', payload });
  } catch (err) {
    console.warn('Call signal failed:', err);
  }
}
