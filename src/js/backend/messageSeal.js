/* Relik — выбор шифрования для одного сообщения (v1 / v2 DM / v3 группа).
   Вынесено из messages.js: там жёсткий лимит строк, а решение «чем шифруем»
   это отдельная тема и единственное место, где сходятся три версии.

   Порядок: v2 для личных (если включён), v3 для групп (если включён и есть
   раздача sender keys), иначе — прежний путь (ECDH для личек, общий ключ
   группы, либо открытый текст без ключей). */

import { SUPABASE, CRYPTO_V2 } from '../config.js';
import { getKeyPair, getTheirPublicKey, encryptForChat } from '../crypto/encryption.js';
import { encryptGroupText } from './groupKeys.js';
import { encryptV2Dm } from './v2Messages.js';
import { encryptGroupSenderKey } from './senderKeys.js';

/* AAD: привязка шифртекста к чату, отправителю и id сообщения.
   Сервер с доступом к базе не сможет переставить или подменить шифртекст,
   не сломав расшифровку. Формат обязан совпадать на отправке и приёме. */
export function aadForMessage(m) {
  if (!m || !m.id || !m.conversation_id || !m.sender_id) return null;
  return `relik-v1|${m.conversation_id}|${m.sender_id}|${m.id}`;
}

/* Зашифровать текст сообщения. Возвращает { ciphertext, iv, v2, v3 }. */
export async function sealMessageText({
  chatId, text, chatKind, theirPublicKeyJwk, messageId, senderId, peerUserId, ts,
}) {
  let ciphertext = '';
  let iv = '';
  let v2 = null;
  let v3 = null;

  const real = Boolean(SUPABASE.url && SUPABASE.anonKey);
  if (!real) return { ciphertext: text, iv: '', v2, v3 };

  if (chatKind === 'dm' && CRYPTO_V2.enabled && peerUserId) {
    try {
      v2 = await encryptV2Dm({ chatId, peerUserId, senderId, text, messageId, ts });
    } catch (err) {
      console.warn('v2 encrypt failed, fallback to v1:', err?.message || err);
      v2 = null;
    }
  }

  /* Группа: сначала sender keys (crypto_version = 3), при любой проблеме —
     прежний общий ключ группы. Флаг выключен по умолчанию. */
  if (!v2 && chatKind === 'group' && CRYPTO_V2.groupsEnabled) {
    try {
      v3 = await encryptGroupSenderKey({ chatId, text, messageId });
    } catch (err) {
      console.warn('group sender key failed, fallback:', err?.message || err);
      v3 = null;
    }
  }
  if (v3) return { ciphertext: v3.ciphertext, iv: v3.iv, v2: null, v3 };

  if (v2) return { ciphertext: v2.ciphertext, iv: v2.iv, v2, v3: null };

  const aad = aadForMessage({ id: messageId, conversation_id: chatId, sender_id: senderId });
  if (chatKind === 'dm' && theirPublicKeyJwk) {
    const keyPair = await getKeyPair();
    if (!keyPair) throw new Error('No key pair found');
    const theirPubKey = await getTheirPublicKey(theirPublicKeyJwk);
    const encrypted = await encryptForChat(text, keyPair.privateKey, theirPubKey, aad);
    ciphertext = encrypted.ciphertext;
    iv = encrypted.iv;
  } else if (chatKind === 'group') {
    const encrypted = await encryptGroupText(chatId, text, aad);
    if (encrypted) {
      ciphertext = encrypted.ciphertext;
      iv = encrypted.iv;
    } else {
      ciphertext = text;
      iv = '';
    }
  } else {
    ciphertext = text;
    iv = '';
  }

  return { ciphertext, iv, v2: null, v3: null };
}
