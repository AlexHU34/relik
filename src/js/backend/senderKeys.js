/* Relik — групповые sender keys: раздача цепочек и шифрование сообщений группы.
   Включается только при CRYPTO_V2.groupsEnabled = true и наличии таблицы
   group_sender_keys (supabase/group_sender_keys.sql). Без таблицы или без
   раздачи вызывающий честно откатывается на прежний групповой ключ.

   Почему так: общий AES-ключ на группу (groupKeys.js) знают все участники,
   и ушедший из группы продолжает читать, пока ключ не сменили. Sender keys
   дают каждому отправителю свою цепочку: ключ группы никому не выдаётся,
   а чужая цепочка расшифровывается только тем устройством, которому её лично
   зашифровали парным ratchet-сеансом. Ротация = новая цепочка у всех. */

import { sb } from './supabaseClient.js';
import { CRYPTO_V2 } from '../config.js';
import { idb } from '../db/idb.js';
import { S, chatById } from '../ui/state.js';
import { localDevice, loadDeviceBundles } from './devices.js';
import { newChain, chainEncrypt, chainDecrypt, groupAad } from '../crypto/v2/senderKey.js';
import { sealForDevice, openBox } from './v2Messages.js';

/* Сколько устройств получают цепочку за одну рассылку: группа из 5 человек
   с двумя устройствами — это 10 «коробок», дальше рост не нужен. */
const DIST_LIMIT = 40;

const ownKey = (chatId) => `gsk:${chatId}`;
const peerKey = (chatId, chainId, device) => `gskp:${chatId}:${chainId}:${device}`;

export function groupsEnabled() {
  return Boolean(CRYPTO_V2?.groupsEnabled && sb);
}

export function isV3Row(row) {
  return Boolean(row && (Number(row.crypto_version) === 3 || Number(row.envelope?.v) === 3));
}

async function loadOwn(chatId) {
  const rec = await idb.get('settings', ownKey(chatId));
  return rec?.value || null;
}

async function saveOwn(chatId, value) {
  await idb.put('settings', { key: ownKey(chatId), value });
}

async function savePeer(chatId, chainId, device, value) {
  await idb.put('settings', { key: peerKey(chatId, chainId, device), value });
}

async function loadPeer(chatId, chainId, device) {
  const rec = await idb.get('settings', peerKey(chatId, chainId, device));
  return rec?.value || null;
}

/* Раздать свою цепочку всем устройствам участников (и своим другим тоже,
   иначе на втором устройстве группа будет «недоступной»). */
async function distribute(chatId, own) {
  const chat = chatById(chatId);
  const local = await localDevice();
  if (!chat || !local || !S.me?.id) return 0;

  const userIds = [...new Set([...(chat.members || []), S.me.id].filter(Boolean))];
  const targets = [];
  for (const uid of userIds) {
    const list = await loadDeviceBundles(uid).catch(() => []);
    for (const b of list) {
      if (b?.deviceId && b.deviceId !== local.deviceId && b.signedPrekey) targets.push(b);
    }
    if (targets.length >= DIST_LIMIT) break;
  }

  const ts = Date.now();
  const payload = JSON.stringify({
    type: 'gsk',
    version: 1,
    chatId,
    chainId: own.chainId,
    chain: own.chain,
    iteration: own.iteration || 0,
  });

  let sent = 0;
  for (const target of targets.slice(0, DIST_LIMIT)) {
    /* messageId уникален на цепочку+устройство: AAD не даст переиграть коробку */
    const messageId = `gsk:${own.chainId}:${target.deviceId}`;
    const box = await sealForDevice({
      chatId, local, target, senderId: S.me.id, text: payload, messageId, tsValue: ts,
    }).catch(() => null);
    if (!box) continue;
    const { error } = await sb.from('group_sender_keys').upsert({
      conversation_id: chatId,
      sender_id: S.me.id,
      sender_device: local.deviceId,
      recipient_device: target.deviceId,
      chain_id: own.chainId,
      /* ts нужен получателю: он входит в AAD коробки */
      box: { ...box, ts },
    }, { onConflict: 'conversation_id,sender_id,sender_device,recipient_device' });
    if (!error) sent += 1;
  }
  return sent;
}

/* Зашифровать сообщение группы своей цепочкой.
   null — v2 для групп недоступен, вызывающий шифрует прежним способом. */
export async function encryptGroupSenderKey({ chatId, text, messageId }) {
  if (!groupsEnabled() || !S.me?.id) return null;
  const local = await localDevice();
  if (!local) return null;

  let own = await loadOwn(chatId);
  if (!own?.chain) {
    own = { ...newChain(), distributed: false };
    await saveOwn(chatId, own);
  }

  if (!own.distributed) {
    const sent = await distribute(chatId, own).catch(() => 0);
    /* без раздачи сообщение прочитает только автор — это хуже, чем v1 */
    if (!sent) return null;
    own = { ...own, distributed: true };
    await saveOwn(chatId, own);
  }

  const aad = groupAad({
    chatId, senderId: S.me.id, senderDevice: local.deviceId, messageId,
  });
  const { header, iv, ct, state } = await chainEncrypt(own, text, aad);
  await saveOwn(chatId, state);

  return {
    cryptoVersion: 3,
    senderDevice: local.deviceId,
    envelope: {
      v: 3,
      fromDevice: local.deviceId,
      chainId: header.chainId,
      n: header.n,
      iv,
      ct,
    },
    ciphertext: 'v3',
    iv: '',
  };
}

/* Своё сообщение: расшифровывать нечего, текст есть в локальном кэше. */
export function ownV3Row(row) {
  return Boolean(row && isV3Row(row) && row.sender_id === S.me?.id);
}

/* Расшифровать сообщение группы, отправленное другим устройством. */
export async function decryptGroupSenderKey(row) {
  const env = row?.envelope;
  if (!isV3Row(row) || !env) return { failed: true };
  const local = await localDevice();
  if (!local) return { failed: true };
  if (env.fromDevice === local.deviceId) return { failed: true };

  const chainId = String(env.chainId || '');
  if (!chainId) return { failed: true };

  let state = await loadPeer(row.conversation_id, chainId, env.fromDevice);
  if (!state) {
    state = await fetchPeerChain(row, chainId, local.deviceId);
    if (!state) return { failed: true };
  }

  const aad = groupAad({
    chatId: row.conversation_id,
    senderId: row.sender_id,
    senderDevice: env.fromDevice,
    messageId: row.id,
  });

  try {
    const { plaintext, state: next } = await chainDecrypt(
      state,
      { chainId, n: env.n },
      env.iv,
      env.ct,
      aad,
    );
    await savePeer(row.conversation_id, chainId, env.fromDevice, next);
    return { text: new TextDecoder().decode(plaintext) };
  } catch (err) {
    console.warn('group sender key decrypt failed:', err?.message || err);
    return { failed: true };
  }
}

/* Достаём свою «коробку» из таблицы и открываем её парным ratchet-сеансом. */
async function fetchPeerChain(row, chainId, myDevice) {
  const { data, error } = await sb
    .from('group_sender_keys')
    .select('box, chain_id')
    .eq('conversation_id', row.conversation_id)
    .eq('sender_id', row.sender_id)
    .eq('sender_device', row.envelope.fromDevice)
    .eq('recipient_device', myDevice)
    .maybeSingle();

  if (error) {
    if (!/does not exist|schema cache/i.test(error.message || '')) {
      console.warn('group_sender_keys read:', error.message);
    }
    return null;
  }
  if (!data?.box) return null;

  const box = data.box;
  const opened = await openBox({
    chatId: row.conversation_id,
    senderId: row.sender_id,
    remoteDevice: row.envelope.fromDevice,
    messageId: `gsk:${chainId}:${myDevice}`,
    ts: box.ts,
    box,
  }).catch(() => null);
  if (!opened?.text) return null;

  let payload;
  try { payload = JSON.parse(opened.text); } catch (e) { return null; }
  if (payload?.type !== 'gsk' || !payload.chain || payload.chainId !== chainId) return null;

  const state = {
    version: 1,
    chainId: payload.chainId,
    chain: payload.chain,
    iteration: Number(payload.iteration) || 0,
    skipped: {},
  };
  await savePeer(row.conversation_id, chainId, row.envelope.fromDevice, state);
  return state;
}

/* Ротация: состав группы изменился — старая цепочка больше не годится.
   Чистим свою цепочку и кэш чужих, старые коробки удаляем. */
export async function resetSenderKeys(chatId = null) {
  try {
    const all = await idb.getAll('settings');
    for (const rec of all) {
      const key = String(rec.key || '');
      const mine = key.startsWith('gsk:') && (!chatId || key === `gsk:${chatId}`);
      const peer = key.startsWith('gskp:') && (!chatId || key.startsWith(`gskp:${chatId}:`));
      if (mine || peer) await idb.del('settings', key);
    }
  } catch (e) { /* кэш не критичен */ }

  if (!sb || !S.me?.id) return;
  const query = sb.from('group_sender_keys').delete().eq('sender_id', S.me.id);
  const { error } = chatId ? await query.eq('conversation_id', chatId) : await query;
  if (error && !/does not exist|schema cache/i.test(error.message || '')) {
    console.warn('group_sender_keys reset:', error.message);
  }
}
