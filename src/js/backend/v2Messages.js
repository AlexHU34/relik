/* Relik — отправка и приём личных сообщений по протоколу v2.
   Включается только при CRYPTO_V2.enabled = true. Если что-то не готово
   (нет SQL, bundle, prekey), вызывающий код откатывается на v1. */

import { idb } from '../db/idb.js';
import { S } from '../ui/state.js';
import { CRYPTO_V2 } from '../config.js';
import { ensureDeviceV2, loadDeviceBundles, takeOneTimePrekey, localDevice } from './devices.js';
import {
  buildAAD,
  x3dhInitiate,
  x3dhRespond,
  ratchetInitInitiator,
  ratchetInitResponder,
  ratchetEncrypt,
  ratchetDecrypt,
  exportRatchet,
  importRatchet,
  importEcdhPrivate,
  importEcdhPublic,
} from '../crypto/v2/protocol.js';
import { packEnvelope, pickBox } from '../crypto/v2/envelope.js';

const sessions = new Map(); // `${chatId}:${remoteDevice}` -> { state, remoteDevice }
const sessionId = (chatId, deviceId) => `ratchet:${chatId}:${deviceId}`;

export function isV2Row(row) {
  return !!(row && (Number(row.crypto_version) === 2 || row.envelope?.v === 2));
}

async function loadSession(chatId, remoteDevice) {
  const key = `${chatId}:${remoteDevice}`;
  if (sessions.has(key)) return sessions.get(key);
  const rec = await idb.get('settings', sessionId(chatId, remoteDevice));
  if (!rec?.value) return null;
  try {
    const state = await importRatchet(rec.value);
    const session = { state, remoteDevice };
    sessions.set(key, session);
    return session;
  } catch (e) {
    return null;
  }
}

async function saveSession(chatId, remoteDevice, state) {
  const key = `${chatId}:${remoteDevice}`;
  sessions.set(key, { state, remoteDevice });
  try {
    await idb.put('settings', {
      key: sessionId(chatId, remoteDevice),
      value: await exportRatchet(state),
    });
  } catch (e) { /* кэш в памяти останется */ }
}

function aadFor({ chatId, senderId, senderDevice, recipientDevice, messageId, ts }) {
  return buildAAD({
    conversation_id: chatId,
    sender_id: senderId,
    sender_device_id: senderDevice,
    recipient_device_id: recipientDevice,
    message_id: messageId,
    ts: String(ts),
  });
}

/* Вернуть null, если v2 недоступен — вызывающий отправит v1. */
export async function encryptV2Dm({ chatId, peerUserId, senderId, text, messageId, ts }) {
  if (!CRYPTO_V2.enabled || !S.me?.id || !peerUserId) return null;
  const local = await ensureDeviceV2();
  if (!local) return null;

  /* Fan-out: одно сообщение шифруем для КАЖДОГО устройства получателя
     и для своих остальных устройств. Иначе на втором устройстве
     сообщение выглядит как «недоступное». */
  const [peerBundles, ownBundles] = await Promise.all([
    loadDeviceBundles(peerUserId).catch(() => []),
    loadDeviceBundles(S.me.id).catch(() => []),
  ]);
  const targets = [...peerBundles, ...ownBundles].filter(
    (b) => b?.deviceId && b.deviceId !== local.deviceId && b.signedPrekey,
  );
  if (!targets.length) return null;

  const tsValue = Number(ts) || Date.now();
  const boxes = {};
  for (const target of targets) {
    const box = await sealForDevice({
      chatId, local, target, senderId: senderId || S.me.id, text, messageId, tsValue,
    }).catch((err) => {
      console.warn('v2 seal failed for device:', err?.message || err);
      return null;
    });
    if (box) boxes[target.deviceId] = box;
  }

  const envelope = packEnvelope({ fromDevice: local.deviceId, ts: tsValue, boxes });
  if (!envelope) return null;

  return {
    cryptoVersion: 2,
    senderDevice: local.deviceId,
    envelope,
    ciphertext: 'v2',
    iv: '',
  };
}

/* Зашифровать текст для одного устройства: сессия Double Ratchet,
   при первом сообщении — X3DH-заголовок. */
async function sealForDevice({ chatId, local, target, senderId, text, messageId, tsValue }) {
  let session = await loadSession(chatId, target.deviceId);
  let first = null;

  if (!session) {
    const otp = await takeOneTimePrekey(target.userId, target.deviceId).catch(() => null);
    const bundle = otp
      ? { ...target, oneTimePrekeys: [otp] }
      : { ...target, oneTimePrekeys: [] };
    const init = await x3dhInitiate(local.privateBundle.identityPrivate, bundle);
    const state = await ratchetInitInitiator(init.sk, target.signedPrekey);
    session = { state, remoteDevice: target.deviceId };
    first = {
      ik: local.publicBundle.identityKey,
      ek: init.ephemeral,
      spkId: target.signedPrekeyId,
      opkId: init.opkId,
    };
  }

  const aad = aadFor({
    chatId, senderId,
    senderDevice: local.deviceId, recipientDevice: target.deviceId,
    messageId, ts: tsValue,
  });
  const box = await ratchetEncrypt(session.state, text, aad);
  await saveSession(chatId, target.deviceId, session.state);

  return {
    header: box.header,
    iv: box.iv,
    ct: box.ct,
    ...(first ? { x3dh: first } : {}),
  };
}

/* Расшифровать строку сообщения v2. null — это не v2.
   { failed: true } — v2, но ключей/сессии нет. */
export async function decryptV2Row(row) {
  if (!isV2Row(row)) return null;
  const env = row.envelope;
  const local = await localDevice();
  if (!local?.privateBundle) return { failed: true };
  const box = pickBox(env, local.deviceId);
  if (!box) return { failed: true };

  const chatId = row.conversation_id;
  const senderId = row.sender_id;
  const remoteDevice = env.fromDevice;
  if (!chatId || !senderId || !remoteDevice) return { failed: true };

  try {
    let session = await loadSession(chatId, remoteDevice);

    if (box.x3dh) {
      const x = box.x3dh;
      if (Number(x.spkId) !== Number(local.publicBundle.signedPrekeyId)) {
        throw new Error('Signed prekey mismatch');
      }
      const spkPriv = await importEcdhPrivate(local.privateBundle.signedPrekeyPrivate);
      const spkPub = await importEcdhPublic(local.publicBundle.signedPrekey);
      const sk = await x3dhRespond({
        identityPrivateJwk: local.privateBundle.identityPrivate,
        signedPrekeyPrivateJwk: local.privateBundle.signedPrekeyPrivate,
        oneTimePrekeys: local.privateBundle.oneTimePrekeys || [],
        initiatorIdentityJwk: x.ik,
        initiatorEphemeralJwk: x.ek,
        opkId: x.opkId ?? null,
      });
      const state = await ratchetInitResponder(sk, { publicKey: spkPub, privateKey: spkPriv });
      session = { state, remoteDevice };
    }

    if (!session) return { failed: true };

    const aad = aadFor({
      chatId,
      senderId,
      senderDevice: remoteDevice,
      recipientDevice: local.deviceId,
      messageId: row.id,
      ts: env.ts,
    });
    const plain = await ratchetDecrypt(session.state, box.header, box.iv, box.ct, aad);
    await saveSession(chatId, remoteDevice, session.state);
    return { text: new TextDecoder().decode(plain) };
  } catch (err) {
    console.warn('v2 decrypt failed:', err?.message || err);
    return { failed: true };
  }
}

/* Удалить ratchet-сессии при выходе/очистке. */
export async function clearV2Sessions() {
  sessions.clear();
  try {
    const all = await idb.getAll('settings');
    for (const rec of all) {
      if (String(rec.key).startsWith('ratchet:')) await idb.del('settings', rec.key);
    }
  } catch (e) { /* ignore */ }
}
