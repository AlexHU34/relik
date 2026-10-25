/* Relik — E2E-ключи групповых чатов
   Каждый участник получает свою копию ключа группы, зашифрованную
   на его ECDH-ключе. Сервер видит только шифротекст ключа.
   Версии ключей нужны для ротации при удалении участника. */

import { sb } from './supabaseClient.js';
import { SUPABASE } from '../config.js';
import { idb } from '../db/idb.js';
import { S } from '../ui/state.js';
import {
  getKeyPair,
  getTheirPublicKey,
  generateGroupKey,
  encryptGroupKeyForUser,
  decryptGroupKey,
  encryptForGroup,
  decryptFromGroup,
} from '../crypto/encryption.js';

let tableState = null;               // null — не проверяли, true/false — есть ли group_keys
const cache = new Map();             // chatId -> [{ v, key }]
const loading = new Map();           // chatId -> Promise
const refreshedAt = new Map();       // chatId -> ms
const retryRefreshAt = new Map();    // chatId -> ms (защита от шквала запросов)

const cacheId = (chatId) => 'gkeys:' + chatId;

function isMissingTable(err) {
  const msg = String(err?.message || '');
  return err?.code === '42P01' || err?.code === '42703'
    || /could not find the table|does not exist|schema cache/i.test(msg);
}

export async function hasGroupKeysTable() {
  if (tableState !== null) return tableState;
  if (!sb || !SUPABASE.url || !SUPABASE.anonKey) { tableState = false; return false; }
  const { error } = await sb.from('group_keys').select('conversation_id').limit(1);
  if (!error) { tableState = true; return true; }
  if (isMissingTable(error)) { tableState = false; return false; }
  /* сетевую ошибку не запоминаем — попробуем позже */
  return false;
}

const exportJwk = (key) => crypto.subtle.exportKey('jwk', key);
const importJwk = (jwk) => crypto.subtle.importKey(
  'jwk', jwk, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'],
);

async function readCache(chatId) {
  if (cache.has(chatId)) return cache.get(chatId);
  try {
    const rec = await idb.get('settings', cacheId(chatId));
    const keys = Array.isArray(rec?.value) ? rec.value : [];
    const out = [];
    for (const item of keys) {
      try {
        out.push({ v: Number(item.v) || 1, key: await importJwk(item.jwk) });
      } catch (e) { /* повреждённая запись — пропускаем */ }
    }
    out.sort((a, b) => b.v - a.v);
    cache.set(chatId, out);
    return out;
  } catch (e) {
    cache.set(chatId, []);
    return [];
  }
}

async function writeCache(chatId, keys) {
  const sorted = [...keys].sort((a, b) => b.v - a.v);
  cache.set(chatId, sorted);
  try {
    const value = [];
    for (const item of sorted) {
      value.push({ v: item.v, jwk: await exportJwk(item.key) });
    }
    await idb.put('settings', { key: cacheId(chatId), value });
  } catch (e) { /* не критично: ключи придут с сервера */ }
}

function addToCache(chatId, key, version) {
  const list = cache.get(chatId) || [];
  const next = list.filter((x) => x.v !== version).concat([{ v: version, key }]);
  writeCache(chatId, next);
  refreshedAt.set(chatId, Date.now());
  return next;
}

/* Загружаем все версии ключа, доступные этому пользователю */
export async function loadGroupKeys(chatId, { refresh = false } = {}) {
  if (!chatId) return [];
  const cached = await readCache(chatId);
  if (loading.has(chatId)) return loading.get(chatId);
  if (cached.length && !refresh && Date.now() - (refreshedAt.get(chatId) || 0) < 60000) return cached;

  const task = (async () => {
    if (!(await hasGroupKeysTable()) || !S.me?.id) return cached;

    const { data, error } = await sb
      .from('group_keys')
      .select('conversation_id, user_id, sender_id, iv, ciphertext, key_version')
      .eq('conversation_id', chatId)
      .eq('user_id', S.me.id)
      .order('key_version', { ascending: false });

    if (error) {
      if (!isMissingTable(error)) console.warn('Group keys load:', error.message);
      return cached;
    }
    if (!data?.length) return cached;

    const keyPair = await getKeyPair();
    if (!keyPair) return cached;

    const senderIds = [...new Set(data.map((r) => r.sender_id).filter(Boolean))];
    const pub = new Map();
    if (senderIds.length) {
      const { data: profiles } = await sb
        .from('profiles')
        .select('id, public_key')
        .in('id', senderIds);
      for (const p of profiles || []) pub.set(p.id, p.public_key);
    }

    const merged = new Map(cached.map((x) => [x.v, x.key]));
    for (const row of data) {
      if (merged.has(row.key_version)) continue;
      try {
        const senderJwk = row.sender_id === S.me.id ? null : pub.get(row.sender_id);
        if (row.sender_id !== S.me.id && !senderJwk) continue;
        const senderKey = senderJwk ? await getTheirPublicKey(senderJwk) : keyPair.publicKey;
        const key = await decryptGroupKey(
          { iv: row.iv, ciphertext: row.ciphertext },
          keyPair.privateKey,
          senderKey,
        );
        merged.set(row.key_version, key);
      } catch (err) {
        console.warn('Group key decrypt failed:', err?.message || err);
      }
    }

    const result = [...merged.entries()]
      .map(([v, key]) => ({ v, key }))
      .sort((a, b) => b.v - a.v);
    if (result.length) await writeCache(chatId, result);
    refreshedAt.set(chatId, Date.now());
    return result;
  })();

  loading.set(chatId, task);
  try {
    return await task;
  } finally {
    if (loading.get(chatId) === task) loading.delete(chatId);
  }
}

export async function getLatestGroupKey(chatId, refresh = false) {
  const keys = await loadGroupKeys(chatId, { refresh });
  return keys[0] || null;
}

/* ── Раздача ключа ─────────────────────────────────────────── */

async function memberIdsOf(chatId) {
  if (sb && SUPABASE.url && SUPABASE.anonKey) {
    try {
      const { data, error } = await sb
        .from('conversation_members')
        .select('user_id')
        .eq('conversation_id', chatId);
      if (!error && data?.length) return data.map((r) => r.user_id).filter(Boolean);
    } catch (e) { /* офлайн — берём из кэша чата */ }
  }
  const fromChat = S.chats?.find((c) => c.id === chatId);
  return [...new Set([S.me?.id, ...(fromChat?.members || [])].filter(Boolean))];
}

async function memberPublicKeys(ids) {
  const map = new Map();
  if (!ids.length) return map;
  const { data, error } = await sb
    .from('profiles')
    .select('id, public_key')
    .in('id', ids);
  if (error) throw error;
  for (const p of data || []) if (p.public_key) map.set(p.id, p.public_key);
  return map;
}

async function distributeKey(chatId, key, version, userIds) {
  const keyPair = await getKeyPair();
  if (!keyPair || !S.me?.id) throw new Error('No key pair');
  const ids = [...new Set(userIds)].filter(Boolean);
  const pubs = await memberPublicKeys(ids.filter((id) => id !== S.me.id));

  const rows = [];
  for (const uid of ids) {
    try {
      const theirKey = uid === S.me.id
        ? keyPair.publicKey
        : (pubs.has(uid) ? await getTheirPublicKey(pubs.get(uid)) : null);
      if (!theirKey) continue;
      const wrapped = await encryptGroupKeyForUser(key, keyPair.privateKey, theirKey);
      rows.push({
        conversation_id: chatId,
        user_id: uid,
        sender_id: S.me.id,
        iv: wrapped.iv,
        ciphertext: wrapped.ciphertext,
        key_version: version,
      });
    } catch (err) {
      console.warn('Group key wrap failed for', uid, err?.message || err);
    }
  }
  if (!rows.length) throw new Error('Group key distribution failed');

  const { error } = await sb
    .from('group_keys')
    .upsert(rows, { onConflict: 'conversation_id,user_id,key_version', ignoreDuplicates: true });
  if (error && !isMissingTable(error)) throw error;

  addToCache(chatId, key, version);
  return rows.length;
}

async function nextVersion(chatId) {
  const cached = await readCache(chatId);
  let max = cached.reduce((m, x) => Math.max(m, x.v || 0), 0);
  if (await hasGroupKeysTable() && S.me?.id) {
    const { data } = await sb
      .from('group_keys')
      .select('key_version')
      .eq('conversation_id', chatId)
      .eq('user_id', S.me.id)
      .order('key_version', { ascending: false })
      .limit(1);
    if (data?.[0]) max = Math.max(max, Number(data[0].key_version) || 0);
  }
  return max + 1;
}

/* Создать новый ключ группы и раздать всем участникам */
export async function createGroupKey(chatId, userIds = null) {
  if (!(await hasGroupKeysTable())) return null;
  const ids = userIds || await memberIdsOf(chatId);
  if (!ids.length) return null;

  const version = await nextVersion(chatId);
  const key = await generateGroupKey();
  try {
    await distributeKey(chatId, key, version, ids);
    return key;
  } catch (err) {
    console.warn('Create group key:', err?.message || err);
    return null;
  }
}

/* Гарантировать ключ: для старых групп создаём его при первом сообщении */
export async function ensureGroupKey(chatId) {
  const latest = await getLatestGroupKey(chatId);
  if (latest) return latest.key;
  if (!(await hasGroupKeysTable())) return null;
  return await createGroupKey(chatId);
}

/* Довыдать текущий ключ конкретному участнику (например, после добавления) */
export async function shareGroupKey(chatId, userId) {
  const latest = await getLatestGroupKey(chatId);
  if (!latest) return null;
  try {
    await distributeKey(chatId, latest.key, latest.v, [userId]);
    return latest.key;
  } catch (err) {
    console.warn('Share group key:', err?.message || err);
    return null;
  }
}

/* Ротация: новый ключ знают только оставшиеся участники */
export async function rotateGroupKey(chatId, userIds = null) {
  if (!(await hasGroupKeysTable())) return null;
  const ids = userIds || await memberIdsOf(chatId);
  if (!ids.length) return null;
  const version = await nextVersion(chatId);
  const key = await generateGroupKey();
  try {
    await distributeKey(chatId, key, version, ids);
    return key;
  } catch (err) {
    console.warn('Rotate group key:', err?.message || err);
    return null;
  }
}

/* ── Шифрование / дешифрование сообщения группы ───────────── */
export async function encryptGroupText(chatId, text) {
  const latest = await getLatestGroupKey(chatId, true);
  const key = latest?.key || await createGroupKey(chatId);
  if (!key) return null;
  return await encryptForGroup(text, key);
}

export async function decryptGroupText(chatId, iv, ciphertext) {
  if (!chatId || !iv || !ciphertext) return null;
  let keys = await loadGroupKeys(chatId);
  for (const item of keys) {
    try {
      return await decryptFromGroup(iv, ciphertext, item.key);
    } catch (e) { /* другая версия ключа — пробуем следующую */ }
  }
  /* Возможно, ключ ротировали на другом устройстве — обновляем список */
  if (keys.length && Date.now() - (retryRefreshAt.get(chatId) || 0) > 10000) {
    retryRefreshAt.set(chatId, Date.now());
    keys = await loadGroupKeys(chatId, { refresh: true });
    for (const item of keys) {
      try {
        const text = await decryptFromGroup(iv, ciphertext, item.key);
        retryRefreshAt.delete(chatId);
        return text;
      } catch (e) { /* всё ещё не тот ключ */ }
    }
  }
  return null;
}

/* Сбросить кэш (после выхода из аккаунта/очистки) */
export async function clearGroupKeyCache(chatId = null) {
  if (chatId) {
    cache.delete(chatId);
    await idb.del('settings', cacheId(chatId));
    return;
  }
  const ids = [...cache.keys()];
  cache.clear();
  for (const id of ids) await idb.del('settings', cacheId(id));
}
