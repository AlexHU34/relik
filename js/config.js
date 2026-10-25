/* Relik — конфигурация приложения */

export const APP = {
  name: 'Relik',
  version: '1.6.0',
  phase: 'E2E Encrypted Messenger',
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
  urls: [],              // например ['turn:turn.example.com:3478']
  username: '',
  credential: '',
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
