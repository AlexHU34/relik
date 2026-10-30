/* Relik — хранение ключей: парольный бэкап, резервная копия фразой, файл.
   На сервере лежит только шифротекст; приватный ключ в открытом виде
   никогда не покидает устройство. */

import { sb } from './supabaseClient.js';
import { SUPABASE } from '../config.js';
import { S } from '../ui/state.js';
import { idb } from '../db/idb.js';
import * as backup from '../crypto/backup.js';

export function isRealBackend() {
  return !!(SUPABASE.url && SUPABASE.anonKey && sb);
}

async function currentUser() {
  try {
    const { data } = await sb.auth.getUser();
    return data?.user || null;
  } catch (e) {
    return null;
  }
}

/* Приватный ключ с этого устройства (JWK-объект) */
export async function getLocalPrivateKeyJwk() {
  let raw = S.me?.privateKey || null;
  if (!raw) {
    const rec = await idb.get('settings', 'keyPair');
    raw = rec?.value?.privateKey || null;
  }
  if (!raw) return null;
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) {
    return null;
  }
}

/* Сохранить ключ локально (IndexedDB settings.keyPair) */
export async function savePrivateKey(privateKeyJwk) {
  const value = typeof privateKeyJwk === 'string' ? privateKeyJwk : JSON.stringify(privateKeyJwk);
  const publicKey = S.me?.publicKey || (await idb.get('settings', 'keyPair'))?.value?.publicKey || null;
  await idb.put('settings', { key: 'keyPair', value: { publicKey, privateKey: value } });
  if (S.me) S.me.privateKey = value;
  return value;
}

/* Перешифровать парольный бэкап новым паролем */
export async function savePasswordBackup(privateKeyJwk, password) {
  if (!password) throw new Error('no_password');
  const enc = await backup.encryptPrivateKeyWithPassword(privateKeyJwk, password);
  if (!isRealBackend()) {
    await idb.put('settings', { key: 'keyBackupLocal', value: enc });
    return enc;
  }
  const user = await currentUser();
  if (!user) throw new Error('no_user');
  const { error } = await sb.from('profiles').update({ key_backup: JSON.stringify(enc) }).eq('id', user.id);
  if (error) throw error;
  return enc;
}

/* Резервная копия, зашифрованная фразой */
export async function getRecoveryBlob() {
  if (isRealBackend()) {
    const user = await currentUser();
    if (!user) return null;
    const { data, error } = await sb
      .from('profiles')
      .select('key_recovery')
      .eq('id', user.id)
      .maybeSingle();
    if (error) return null;
    return data?.key_recovery || null;
  }
  const rec = await idb.get('settings', 'keyRecovery');
  return rec?.value || null;
}

export async function saveRecoveryBlob(blob) {
  if (isRealBackend()) {
    const user = await currentUser();
    if (!user) throw new Error('no_user');
    const { error } = await sb.from('profiles').update({ key_recovery: blob }).eq('id', user.id);
    if (error) {
      const msg = String(error.message || '');
      if (/column|key_recovery|schema cache/i.test(msg)) throw new Error('need_sql');
      throw error;
    }
    return blob;
  }
  await idb.put('settings', { key: 'keyRecovery', value: blob });
  return blob;
}

export async function hasRecovery() {
  return !!(await getRecoveryBlob());
}
