/* Relik — подписка на все новые сообщения (Realtime).
   Вынесено из backend/messages.js, чтобы модуль сообщений не разрастался,
   и чтобы статус канала (SUBSCRIBED / CHANNEL_ERROR / CLOSED) было видно
   вызывающему: по нему boot/realtime.js переподключается и догоняет
   пропущенное после обрыва сети. */

import { sb } from './supabaseClient.js';

export function subscribeAllMessages(onInsert, onStatus) {
  if (!sb) {
    try { onStatus?.('NO_CLIENT'); } catch (e) { /* ignore */ }
    return { unsubscribe: () => {} };
  }

  const channel = sb
    .channel('all-messages')
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'messages' },
      (payload) => { onInsert?.(payload.new); }
    )
    .subscribe((status, err) => {
      try { onStatus?.(status, err); } catch (e) { /* ignore */ }
    });

  return {
    unsubscribe: () => {
      try { sb.removeChannel(channel); } catch (e) { /* уже удалён */ }
    },
  };
}
