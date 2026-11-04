/* Relik — легаси-квитки прочтения (таблица read_receipts).
   Настоящие галочки давно едут скрытыми сообщениями (`sendReadUpto`), а эта
   запись нужна только старым клиентам. Раньше она делала `sb.auth.getUser()`
   плюс upsert на КАЖДОЕ открытие чата — два лишних round-trip на пустом месте.
   Теперь: без getUser (берём S.me), не чаще раза в минуту на чат, не ждём и
   полностью замолкаем, если таблицы в проекте нет. */
import { sb } from './supabaseClient.js';
import { S } from '../ui/state.js';

const sentAt = new Map();
let tableMissing = false;

export async function updateReadReceipt(chatId) {
  if (tableMissing || !sb || !chatId) return;
  const userId = S.me?.id;
  if (!userId) return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;

  const now = Date.now();
  if (now - (sentAt.get(chatId) || 0) < 60000) return;
  sentAt.set(chatId, now);

  const { error } = await sb.from('read_receipts').upsert({
    conversation_id: chatId,
    user_id: userId,
    last_read_at: new Date().toISOString(),
  });

  if (!error) return;
  if (/does not exist|schema cache|relation/i.test(error.message || '')) {
    tableMissing = true;
    return;
  }
  console.warn('Read receipt error:', error.message || error);
}
