/* Relik — конфигурация приложения */

export const APP = {
  name: 'Relik',
  version: '1.1.7',
  phase: 'Production Ready — E2E Encrypted Messenger',
};

/* Phase 4/5: создайте бесплатный проект на https://supabase.com
   и вставьте сюда Project URL + anon public key.
   До этого приложение работает в демо-режиме (IndexedDB). */
export const SUPABASE = {
  url: 'https://sumaysqzahgesifdevxu.supabase.co',
  anonKey: 'sb_publishable_YotDOWeDBvBEzQTFiSJWlg_ljGjpm2Q',
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
