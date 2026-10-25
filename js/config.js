/* Relik — конфигурация приложения */

export const APP = {
  name: 'Relik',
  version: '1.3.1',
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

/* Phase 4/5: создайте бесплатный проект на https://supabase.com
   и вставьте сюда Project URL + anon public key.
   До этого приложение работает в демо-режиме (IndexedDB). */
export const SUPABASE = forcedDemo ? { url: '', anonKey: '' } : REAL_SUPABASE;

/* Быстрые реакции на сообщение */
export const EMOJI_QUICK = ['👍', '❤️', '🔥', '😂', '😮', '😢'];

/* Полная палитра в пикере эмодзи */
export const EMOJI_PALETTE = [
  '😀','😅','😂','😍','🤩','😎','🥳','😉',
  '😴','🤔','🙄','😭','😡','🤯','🤝','👍',
  '👎','🙏','👀','🔥','💜','✨','🎉','🚀',
  '💯','☕','🍕','🎮','🌙','💡','📎','🔒',
];
