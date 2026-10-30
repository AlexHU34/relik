/* Relik — управление группами и ключами (Фаза 8)
   Создание групп, ключ группы каждому участнику, добавление/удаление */

import { sb } from './supabaseClient.js';
import { getKeyPair, getTheirPublicKey, decryptGroupKey, encryptForGroup, decryptFromGroup } from '../crypto/encryption.js';
import { createGroupKey, rotateGroupKey } from './groupKeys.js';

/* ── Создание группы ── */
export async function createGroup(title, memberIds) {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) throw new Error('Not authenticated');

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
  /* Ключ группы: каждому участнику — своя зашифрованная копия.
     Если миграции group_keys ещё нет, группа продолжит работать
     в прежнем режиме (без E2E), ничего не ломается. */
  const allMembers = [...new Set([user.id, ...memberIds])];
  const groupKey = await createGroupKey(convId, allMembers);

  return {
    id: convId,
    title,
    kind: 'group',
    members: allMembers,
    groupKey,
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

  /* Новому участнику нужен актуальный ключ. Ротация не даёт ему
     прочитать старые сообщения, но новые он расшифрует. */
  await rotateGroupKey(chatId);

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

  /* Ротация: удалённый участник больше не получит новые сообщения */
  await rotateGroupKey(chatId);

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

  /* Сначала ротация без себя: остальные получат новый ключ,
     а у нас останется только старый. */
  const { data: members } = await sb
    .from('conversation_members')
    .select('user_id')
    .eq('conversation_id', chatId);
  const remaining = (members || [])
    .map((m) => m.user_id)
    .filter((id) => id !== user.id);
  if (remaining.length) await rotateGroupKey(chatId, remaining);

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
