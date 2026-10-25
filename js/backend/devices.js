/* Relik — устройства и prekeys для протокола v2 (X3DH).
   Пока используется только при CRYPTO_V2.enabled = true. */

import { sb } from './supabaseClient.js';
import { SUPABASE, CRYPTO_V2 } from '../config.js';
import { idb } from '../db/idb.js';
import { S } from '../ui/state.js';
import { generateDeviceBundle } from '../crypto/v2/protocol.js';

const LOCAL_KEY = 'deviceV2';

function newDeviceId() {
  return crypto.randomUUID ? crypto.randomUUID() : 'd_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export async function localDevice() {
  const rec = await idb.get('settings', LOCAL_KEY);
  return rec?.value || null;
}

async function saveLocal(value) {
  await idb.put('settings', { key: LOCAL_KEY, value });
}

/* Зарегистрировать устройство и опубликовать bundle.
   Идемпотентно: повторный вызов обновляет ключи только если их нет. */
export async function ensureDeviceV2() {
  if (!CRYPTO_V2?.enabled || !sb || !SUPABASE.url || !S.me?.id) return null;

  let local = await localDevice();
  if (!local?.deviceId) {
    const deviceId = newDeviceId();
    const bundle = await generateDeviceBundle({ prekeys: Number(CRYPTO_V2.prekeys) || 20 });
    local = { deviceId, ...bundle, createdAt: Date.now() };
    await saveLocal(local);
  }

  const { data: existing, error } = await sb
    .from('device_keys')
    .select('device_id')
    .eq('user_id', S.me.id)
    .eq('device_id', local.deviceId)
    .maybeSingle();

  if (error && !/does not exist|schema cache/i.test(error.message || '')) {
    console.warn('device_keys check:', error.message);
  }

  if (!existing) {
    const pub = local.publicBundle;
    const { error: insErr } = await sb.from('device_keys').upsert({
      user_id: S.me.id,
      device_id: local.deviceId,
      identity_key: pub.identityKey,
      identity_sign_key: pub.identitySignKey,
      signed_prekey_id: pub.signedPrekeyId,
      signed_prekey: pub.signedPrekey,
      signed_prekey_sig: pub.signedPrekeySig,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,device_id' });
    if (insErr) console.warn('device_keys publish:', insErr.message);

    if (pub.oneTimePrekeys?.length) {
      const rows = pub.oneTimePrekeys.map((k) => ({
        user_id: S.me.id,
        device_id: local.deviceId,
        prekey_id: k.id,
        public_key: k.key,
      }));
      const { error: otpErr } = await sb.from('one_time_prekeys').upsert(rows, {
        onConflict: 'user_id,device_id,prekey_id',
        ignoreDuplicates: true,
      });
      if (otpErr) console.warn('prekeys publish:', otpErr.message);
    }
  }

  return local;
}

/* Публичные bundle всех устройств пользователя */
export async function loadDeviceBundles(userId) {
  if (!sb || !userId) return [];
  const { data, error } = await sb
    .from('device_keys')
    .select('user_id, device_id, identity_key, identity_sign_key, signed_prekey_id, signed_prekey, signed_prekey_sig')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })
    .limit(10);
  if (error) throw error;
  return (data || []).map((row) => ({
    userId: row.user_id,
    deviceId: row.device_id,
    identityKey: row.identity_key,
    identitySignKey: row.identity_sign_key,
    signedPrekeyId: row.signed_prekey_id,
    signedPrekey: row.signed_prekey,
    signedPrekeySig: row.signed_prekey_sig,
  }));
}

/* Атомарно забрать одноразовый prekey получателя (RPC из crypto_v2.sql) */
export async function takeOneTimePrekey(userId, deviceId) {
  if (!sb) return null;
  const { data, error } = await sb.rpc('take_one_time_prekey', {
    p_user: userId,
    p_device: deviceId,
  });
  if (error) {
    if (!/does not exist|schema cache/i.test(error.message || '')) console.warn('take prekey:', error.message);
    return null;
  }
  const row = Array.isArray(data) ? data[0] : data;
  return row ? { id: row.prekey_id, key: row.public_key } : null;
}

/* Удалить приватные v2-ключи при выходе. */
export async function clearDeviceV2() {
  await idb.del('settings', LOCAL_KEY);
}
