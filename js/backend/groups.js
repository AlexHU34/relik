/* Relik — управление группами и ключами (Фаза 8)
   Создание групп, ключ группы каждому участнику, добавление/удаление */

import { sb } from './supabaseClient.js';
import { getKeyPair, getTheirPublicKey, generateGroupKey, encryptGroupKeyForUser, decryptGroupKey, encryptForGroup, decryptFromGroup } from '../crypto/encryption.js';

/* ── Создание группы ── */
export async function createGroup(title, memberIds) {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  // Генерируем ключ группы
  const groupKey = await generateGroupKey();

  // Создаём conversation (id на клиенте — без RETURNING)
  const convId = (crypto.randomUUID ? crypto.randomUUID() : 'g_' + Date.now().toString(36));
  const { error: convError } = await sb
    .from('conversations')
    .insert({
      id: convId,
      kind: 'group',
      title,
      created_by: user.id,
    });

  if (convError) throw convError;

  // Добавляем создателя
  const { error: memberError } = await sb
    .from('conversation_members')
    .insert({
      conversation_id: convId,
      user_id: user.id,
    });

  if (memberError) throw memberError;

  // Добавляем участников
  for (const memberId of memberIds) {
    const { error } = await sb
      .from('conversation_members')
      .insert({
        conversation_id: convId,
        user_id: memberId,
      });

    if (error) throw error;
  }

  // Получаем публичные ключи всех участников
  const { data: profiles } = await sb
    .from('profiles')
    .select('id, public_key')
    .in('id', [user.id, ...memberIds]);

  if (!profiles) throw new Error('Failed to load profiles');

  // Шифруем ключ группы для каждого участника
  const myKeyPair = await getKeyPair();
  if (!myKeyPair) throw new Error('No key pair');

  const keyMessages = [];

  for (const profile of profiles) {
    if (profile.id === user.id) {
      // Для себя сохраняем ключ в IndexedDB
      const exportedKey = await crypto.subtle.exportKey('jwk', groupKey);
      // TODO: сохранить в indexedDB
    } else {
      // Для других шифруем и отправляем как сообщение
      const theirPubKey = await getTheirPublicKey(profile.public_key);
      const encryptedKey = await encryptGroupKeyForUser(groupKey, myKeyPair.privateKey, theirPubKey);

      // Отправляем как системное сообщение
      // TODO: добавить тип сообщения 'group_key'
    }
  }

  return {
    id: convId,
    title,
    kind: 'group',
    members: [user.id, ...memberIds],
    groupKey, // временно возвращаем для UI
  };
}

/* ── Добавление участника в группу ── */
export async function addMemberToGroup(chatId, userId) {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  // Добавляем в conversation_members
  const { error } = await sb
    .from('conversation_members')
    .insert({
      conversation_id: chatId,
      user_id: userId,
    });

  if (error) throw error;

  // Получаем публичный ключ нового участника
  const { data: profile } = await sb
    .from('profiles')
    .select('public_key')
    .eq('id', userId)
    .single();

  if (!profile) throw new Error('Profile not found');

  // TODO: получить ключ группы из хранилища
  // TODO: зашифровать ключ группы для нового участника
  // TODO: отправить как сообщение типа 'group_key'

  return true;
}

/* ── Удаление участника из группы ── */
export async function removeMemberFromGroup(chatId, userId) {
  const { error } = await sb
    .from('conversation_members')
    .delete()
    .match({
      conversation_id: chatId,
      user_id: userId,
    });

  if (error) throw error;

  // TODO: ротация ключа группы (v2)
  // TODO: перераздача ключа всем оставшимся участникам

  return true;
}

/* ── Получение ключа группы из сообщения ── */
export async function extractGroupKeyFromMessage(encryptedKeyMessage, senderPublicKeyJwk) {
  const myKeyPair = await getKeyPair();
  if (!myKeyPair) throw new Error('No key pair');

  const theirPubKey = await getTheirPublicKey(senderPublicKeyJwk);
  return await decryptGroupKey(encryptedKeyMessage, myKeyPair.privateKey, theirPubKey);
}

/* ── Шифрование сообщения для группы ── */
export async function encryptGroupMessage(text, groupKey) {
  return await encryptForGroup(text, groupKey);
}

/* ── Дешифрование сообщения группы ── */
export async function decryptGroupMessage(iv, ciphertext, groupKey) {
  return await decryptFromGroup(iv, ciphertext, groupKey);
}

/* ── Получение участников группы ── */
export async function getGroupMembers(chatId) {
  const { data, error } = await sb
    .from('conversation_members')
    .select('user_id, profiles(*)')
    .eq('conversation_id', chatId);

  if (error) throw error;

  return data;
}

/* ── Обновление названия группы ── */
export async function updateGroupTitle(chatId, title) {
  const { error } = await sb
    .from('conversations')
    .update({ title })
    .eq('id', chatId);

  if (error) throw error;

  return title;
}

/* ── Покинуть группу ── */
export async function leaveGroup(chatId) {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const { error } = await sb
    .from('conversation_members')
    .delete()
    .match({
      conversation_id: chatId,
      user_id: user.id,
    });

  if (error) throw error;

  return true;
}
