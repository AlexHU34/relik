/* Relik — Supabase Auth + профили
   Регистрация с подтверждением по коду из письма, вход, ключи E2E */

import { sb } from './supabaseClient.js';
import { idb } from '../db/idb.js';
import * as keygen from '../crypto/keygen.js';
import * as backup from '../crypto/backup.js';
import { hasAvatarColumn, hasUsernameColumn, hasRoleColumn } from './chats.js';

/* Приватный ключ может прийти и объектом (после расшифровки бэкапа), и строкой.
   В IndexedDB всегда кладём строку — так его читают все версии приложения. */
function jwkToString(v) {
  if (!v) return null;
  return typeof v === 'string' ? v : JSON.stringify(v);
}

function avatarOf(profile, user) {
  return profile?.avatar || user?.user_metadata?.avatar || null;
}

/* Юзернейм: латиница, цифры и _, 3–32 символа, начинается с буквы */
const USERNAME_RE = /^[A-Za-z][A-Za-z0-9_]{2,31}$/;

export function normalizeUsername(v) {
  return String(v || '').trim().replace(/^@+/, '');
}

export function isValidUsername(v) {
  return USERNAME_RE.test(v);
}

export async function isUsernameTaken(username, myId) {
  /* _ и % в LIKE — служебные, экранируем */
  const pattern = String(username).replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
  const { data, error } = await sb
    .from('profiles')
    .select('id')
    .ilike('username', pattern)
    .neq('id', myId)
    .limit(1);
  if (error) throw error;
  return Array.isArray(data) && data.length > 0;
}

export { hasUsernameColumn, hasRoleColumn };

/* Пароль нужен один раз — чтобы зашифровать резервную копию ключа.
   Держим только в памяти/на время вкладки и очищаем сразу после создания профиля. */
function pendingName(email) {
  return sessionStorage.getItem('relik.pendingName') || email.split('@')[0];
}

/* ── Регистрация: шаг 1 — создать пользователя в Auth ── */
export async function signUp(email, password) {
  sessionStorage.setItem('relik.pendingPass', password);
  const { data, error } = await sb.auth.signUp({ email, password });
  if (error) throw error;

  // Если подтверждение email включено — сессии ещё нет, нужен код
  if (!data.session) return { pending: true, email };

  return await finalizeProfile(data.user, email, pendingName(email), password);
}

/* ── Регистрация: шаг 2 — проверить код из письма ── */
export async function verifySignupCode(email, token, password) {
  const { data, error } = await sb.auth.verifyOtp({ email, token, type: 'signup' });
  if (error) throw error;

  const pass = password || sessionStorage.getItem('relik.pendingPass') || '';
  if (!pass) throw new Error('Перезапустите регистрацию: пароль не найден');

  return await finalizeProfile(data.user, email, pendingName(email), pass);
}

/* ── Создание E2E-ключей и профиля после успешной аутентификации ── */
async function finalizeProfile(user, email, name, password) {
  const keyPair = await keygen.generateKeyPair();
  const publicKeyJwk = await keygen.exportPublicKey(keyPair);
  const privateKeyJwk = await keygen.exportPrivateKey(keyPair);
  const encryptedBackup = await backup.encryptPrivateKeyWithPassword(
    JSON.parse(privateKeyJwk),
    password
  );

  const row = {
    id: user.id,
    display_name: name,
    avatar_hue: Math.floor(Math.random() * 360),
    public_key: publicKeyJwk,
    key_backup: JSON.stringify(encryptedBackup),
  };

  const { error: profileError } = await sb.from('profiles').insert(row);
  if (profileError) {
    // 23505 — профиль уже есть (повторная попытка): обновляем ключи
    if (profileError.code === '23505') {
      const { error: updErr } = await sb.from('profiles').update({
        display_name: name,
        public_key: publicKeyJwk,
        key_backup: JSON.stringify(encryptedBackup),
      }).eq('id', user.id);
      if (updErr) throw updErr;
    } else {
      throw profileError;
    }
  }

  const me = {
    id: user.id,
    name,
    mail: email,
    username: null,
    role: 'user',
    publicKey: publicKeyJwk,
    privateKey: privateKeyJwk,
  };

  await idb.put('settings', { key: 'me', value: me });
  await idb.put('settings', { key: 'keyPair', value: { publicKey: publicKeyJwk, privateKey: privateKeyJwk } });

  sessionStorage.removeItem('relik.pendingPass');
  sessionStorage.removeItem('relik.pendingName');

  return me;
}

/* ── Вход ── */
export async function signIn(email, password) {
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw error;

  const { data: profile, error: profileError } = await sb
    .from('profiles')
    .select('*')
    .eq('id', data.user.id)
    .single();

  if (profileError) throw profileError;

  // Дешифрование приватного ключа из бэкапа
  let privateKeyJwk = null;
  try {
    const keyBackup = typeof profile.key_backup === 'string'
      ? JSON.parse(profile.key_backup)
      : profile.key_backup;
    privateKeyJwk = await backup.decryptPrivateKeyWithPassword(keyBackup, password);
  } catch (err) {
    console.error('Key backup decrypt error:', err);
  }

  const privateKeyStr = jwkToString(privateKeyJwk);

  const me = {
    id: profile.id,
    name: profile.display_name,
    mail: email,
    hue: profile.avatar_hue,
    avatar: avatarOf(profile, data.user),
    username: profile.username || null,
    role: profile.role || 'user',
    publicKey: profile.public_key,
    privateKey: privateKeyStr,
  };

  await idb.put('settings', { key: 'me', value: me });
  if (privateKeyStr) {
    await idb.put('settings', {
      key: 'keyPair',
      value: { publicKey: profile.public_key, privateKey: privateKeyStr },
    });
  }

  return me;
}

/* ── Выход ── */
async function clearLocalData() {
  /* не оставляем расшифрованную переписку и черновики на устройстве */
  try {
    await idb.clear('messages');
    await idb.clear('chats');
    await idb.clear('media');
    const settings = await idb.getAll('settings');
    for (const rec of settings) {
      if (rec.key === 'me' || rec.key === 'keyPair' ||
          String(rec.key).startsWith('draft:') || String(rec.key).startsWith('pin:') ||
          String(rec.key).startsWith('gkeys:')) {
        await idb.del('settings', rec.key);
      }
    }
  } catch (e) {
    await idb.del('settings', 'me');
    await idb.del('settings', 'keyPair');
  }
}

export async function signOut() {
  try {
    await sb.auth.signOut();
  } catch (e) {
    console.warn('Sign out request failed:', e && e.message ? e.message : e);
  }
  await clearLocalData();
}

/* Выход со всех устройств: завершаем все сессии аккаунта */
export async function signOutAll() {
  try {
    await sb.auth.signOut({ scope: 'global' });
  } catch (e) {
    console.warn('Global sign out failed:', e && e.message ? e.message : e);
  }
  await clearLocalData();
}

/* ── Получение текущего пользователя ── */
export async function getCurrentUser() {
  const { data: { user }, error } = await sb.auth.getUser();
  if (error) throw error;
  return user;
}

/* ── Обновление профиля ── */
export async function updateProfile(updates) {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const { error } = await sb.from('profiles').update(updates).eq('id', user.id);
  if (error) throw error;

  const meRec = await idb.get('settings', 'me');
  if (meRec) {
    meRec.value = { ...meRec.value, ...updates };
    await idb.put('settings', meRec);
  }

  return updates;
}

/* ── Аватар: сохраняем на бэкенде (profiles.avatar + метаданные Auth) ── */
export async function saveAvatar(dataUrl) {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  let storedInProfile = false;
  if (await hasAvatarColumn()) {
    const { error } = await sb.from('profiles').update({ avatar: dataUrl }).eq('id', user.id);
    if (error) throw error;
    storedInProfile = true;
  }

  /* Дублируем в метаданные пользователя: так аватар переживает перезагрузку
     и доступен на любом устройстве даже до миграции profiles.avatar. */
  const { error: metaError } = await sb.auth.updateUser({ data: { avatar: dataUrl } });
  if (metaError && !storedInProfile) throw metaError;

  const meRec = await idb.get('settings', 'me');
  if (meRec) {
    meRec.value = { ...meRec.value, avatar: dataUrl };
    await idb.put('settings', meRec);
  }

  return dataUrl;
}

/* ── Восстановление сессии при загрузке ── */
export async function restoreSession() {
  const { data: { session }, error } = await sb.auth.getSession();
  if (error || !session) return null;

  const { data: profile, error: profileError } = await sb
    .from('profiles')
    .select('*')
    .eq('id', session.user.id)
    .single();
  if (profileError) return null;

  const keyPairRec = await idb.get('settings', 'keyPair');
  const privateKey = jwkToString(keyPairRec?.value?.privateKey);

  /* старые записи могли хранить JWK объектом — нормализуем в строку */
  if (keyPairRec?.value && privateKey !== keyPairRec.value.privateKey) {
    await idb.put('settings', {
      key: 'keyPair',
      value: { publicKey: profile.public_key, privateKey },
    });
  }

  return {
    id: profile.id,
    name: profile.display_name,
    mail: session.user.email,
    hue: profile.avatar_hue,
    avatar: avatarOf(profile, session.user),
    username: profile.username || null,
    role: profile.role || 'user',
    publicKey: profile.public_key,
    privateKey: privateKey || null,
  };
}

/* ── last_seen (presence) ── */
export async function updateLastSeen() {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return;

  await sb.from('profiles').update({ last_seen: new Date().toISOString() }).eq('id', user.id);
}
