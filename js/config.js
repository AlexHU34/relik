/* Relik — конфигурация приложения */

export const APP = {
  name: 'Relik',
  version: '1.25.1',
  phase: 'Приватный мессенджер',
};

const REAL_SUPABASE = {
  url: 'https://sumaysqzahgesifdevxu.supabase.co',
  anonKey: 'sb_publishable_YotDOWeDBvBEzQTFiSJWlg_ljGjpm2Q',
};

/* ?demo=1 — принудительный демо-режим без аккаунта (удобно для показа
   приложения и для проверки UI без сети). Режим живёт только в URL. */
let forcedDemo = false;
try {
  const q = new URLSearchParams(location.search);
  forcedDemo = q.get('demo') === '1';
} catch (e) { /* location может быть недоступен */ }

/* Supabase: вставьте Project URL + anon public key.
   Без ключей приложение работает в демо-режиме (IndexedDB). */
export const SUPABASE = forcedDemo ? { url: '', anonKey: '' } : REAL_SUPABASE;

/* TURN для звонков. STUN работает не за всеми NAT; для надёжности
   укажите свой TURN (coturn и т.п.). Пустые значения = только STUN. */
export const RELAY = {
  /* TURN на нашем VPS: turn:62.113.99.46:3478 (coturn, supabase/scripts/vps.sh).
     UDP — основной путь, TCP — запасной для сетей, где UDP режут. */
  urls: [
    'turn:62.113.99.46:3478?transport=udp',
    'turn:62.113.99.46:3478?transport=tcp',
  ],
  /* Свой STUN на том же сервере: не зависим от Google/Twilio, которые
     в РФ могут быть недоступны. */
  stunUrls: [
    'stun:62.113.99.46:3478',
  ],
  /* Статические креды удалены: TURN выдаёт короткоживущие через RPC turn_creds()
     (supabase/turn.sql + coturn use-auth-secret). Без username/credential
     js/backend/turn.js работает в режиме STUN, пока RPC не ответил. */
};

/* Web Push. publicKey — VAPID (публичная часть). Рассылку делает сервис на VPS:
   он опрашивает push_queue, входящий HTTPS не нужен. */
export const PUSH = {
  publicKey: 'BAucjRGMVNU1VBbKEdrqYdC5ABadajTP8bmZLq0IDrhAMx4J3XlBNCXz-dekTKlpqQ3QTafDZbn4-Cr5tyX6JvY',
  endpoint: '',
};

/* Протокол v2 (X3DH + Double Ratchet).
   enabled = false: приложение работает по v1, новые таблицы не нужны.
   После выполнения supabase/crypto_v2.sql и проверки на двух устройствах
   можно включить true — новые личные сообщения пойдут по v2. */
export const CRYPTO_V2 = {
  enabled: false,
  prekeys: 20,
};

/* Быстрые реакции на сообщение */
export const EMOJI_QUICK = ['👍', '❤️', '🔥', '😂', '😮', '😢'];

/* Полная палитра в пикере эмодзи */
export const EMOJI_PALETTE = [
  '😀','😅','😂','😍','🤩','😎','🥳','😉',
  '😴','🤔','🙄','😭','😡','🤯','🤝','👍',
  '👎','🙏','👀','🔥','💜','✨','🎉','🚀',
  '💯','☕','🍕','🎮','🌙','💡','📎','🔒',
];
