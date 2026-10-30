/* Relik — демо-данные: участники, чаты, сообщения (засеиваются в IndexedDB) */
import { idb } from '../db/idb.js';

const M = 60e3, H = 36e5, D = 864e5;
const now = () => Date.now();

export const ME = { id: 'u_me', name: 'Вы', hue: 0, mail: 'you@relik.app' };

export const USERS = [
  { id: 'u_alina',  name: 'Алина',  hue: 1, seen: 'online'  },
  { id: 'u_max',    name: 'Максим', hue: 2, seen: 'offline' },
  { id: 'u_sonya',  name: 'Софья',  hue: 3, seen: 'recent'  },
  { id: 'u_kirill', name: 'Кирилл', hue: 4, seen: 'online'  },
  { id: 'u_nikita', name: 'Никита', hue: 0, seen: 'offline' },
  { id: 'u_masha',  name: 'Маша',   hue: 2, seen: 'online'  },
];

/* Демо-«фото»: генерируем градиент-арт прямо в браузере */
export function makeDemoPhoto(i = 0) {
  const w = 640, h = 420;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  const palettes = [
    ['#0e1420', '#4e7fff', '#9f5cf6'],
    ['#101014', '#8a5cf6', '#f96a6a'],
    ['#0b1226', '#3ecf8e', '#4e7fff'],
    ['#1a1a2e', '#f093fb', '#f5576c'],
  ];
  const p = palettes[i % palettes.length];
  const grd = g.createLinearGradient(0, 0, w, h);
  grd.addColorStop(0, p[0]);
  grd.addColorStop(.55, p[1]);
  grd.addColorStop(1, p[2]);
  g.fillStyle = grd;
  g.fillRect(0, 0, w, h);
  for (let k = 0; k < 120; k++) {
    g.fillStyle = `rgba(255,255,255,${Math.random() * .05})`;
    g.beginPath();
    g.arc(Math.random() * w, Math.random() * h, Math.random() * 44 + 8, 0, 7);
    g.fill();
  }
  return c.toDataURL('image/jpeg', .82);
}

/* Стабильные «волны» для голосового */
const bars = (n = 26, seed = 1) =>
  Array.from({ length: n }, (_, i) => {
    const v = .28 + .62 * Math.abs(Math.sin(i * seed + 1.2) * Math.sin(i * .61 + seed));
    return Math.max(.18, Math.min(1, v));
  });

/* Сообщение, которое «прилетает» через несколько секунд после входа — демо живого чата */
export function demoMessage() {
  return {
    id: 'm_demo_' + Date.now().toString(36),
    chatId: 'c_alina',
    sender: 'u_alina',
    ts: Date.now(),
    type: 'text',
    text: 'Кстати, наведи на любое сообщение: реакции, ответы, редактирование 😉',
    reactions: [],
    status: 'read',
  };
}

export async function seedIfEmpty() {
  const chats = await idb.getAll('chats');
  if (chats.length) return;

  const t0 = now();

  const chatsData = [
    {
      id: 'c_alina', kind: 'dm', userId: 'u_alina', members: ['u_alina'],
      unread: 2, last: { ts: t0 - 3 * M, from: 'u_alina', type: 'text', text: 'Кстати, ты не забыл про демо?' },
    },
    {
      id: 'c_team', kind: 'group', title: 'Команда Relik', hue: 5, members: ['u_alina', 'u_max', 'u_kirill'],
      unread: 0, last: { ts: t0 - 20 * H, from: 'u_alina', type: 'text', text: 'Релиз на горизонте 🚀' },
    },
    {
      id: 'c_max', kind: 'dm', userId: 'u_max', members: ['u_max'],
      unread: 1, last: { ts: t0 - 45 * M, from: 'u_max', type: 'text', text: 'Ты тут?' },
    },
    {
      id: 'c_sonya', kind: 'dm', userId: 'u_sonya', members: ['u_sonya'],
      unread: 0, last: { ts: t0 - 2 * D, from: 'u_sonya', type: 'text', text: 'Привет! Как дела?' },
    },
  ];

  const msgs = [
    /* --- Алина: история с медиа и фразами --- */
    { id: 'm1', chatId: 'c_alina', sender: 'u_alina', ts: t0 - 40 * M, type: 'text', text: 'Привет! Посмотри, что получалось у художника по Relik', reactions: [], status: 'read' },
    { id: 'm2', chatId: 'c_alina', sender: 'u_me', ts: t0 - 38 * M, type: 'text', text: 'Сетка сразу читается, и цвета логотипа легли идеально 🔥', reactions: [], status: 'read' },
    { id: 'm3', chatId: 'c_alina', sender: 'u_alina', ts: t0 - 37 * M, type: 'image', text: 'Держи свежий вариант', reactions: [{ e: '❤️', by: ['u_me'] }], status: 'read', file: { name: 'relik-обои.png', src: makeDemoPhoto(0) } },
    { id: 'm4', chatId: 'c_alina', sender: 'u_me', ts: t0 - 35 * M, type: 'text', text: 'Красота! Особенно градиент', reactions: [], status: 'read', replyTo: { id: 'm3', name: 'Алина', snippet: '📷 Фото' } },
    { id: 'm5', chatId: 'c_alina', sender: 'u_alina', ts: t0 - 30 * M, type: 'text', text: 'Кирилл тоже в восторге 😄', reactions: [{ e: '😂', by: ['u_me', 'u_kirill'] }], status: 'read' },
    { id: 'm6', chatId: 'c_alina', sender: 'u_alina', ts: t0 - 4 * M, type: 'text', text: 'Скинь потом иконку в PNG — поставлю в презу', reactions: [], status: 'read' },
    { id: 'm7', chatId: 'c_alina', sender: 'u_alina', ts: t0 - 3 * M, type: 'text', text: 'Кстати, ты не забыл про демо?', reactions: [], status: 'read' },

    /* --- Группа «Команда Relik» --- */
    { id: 'g1', chatId: 'c_team', sender: 'u_kirill', ts: t0 - 26 * H, type: 'text', text: 'Все вошли в новый чат 👌', reactions: [], status: 'read' },
    { id: 'g2', chatId: 'c_team', sender: 'u_max', ts: t0 - 21 * H, type: 'voice', reactions: [{ e: '❤️', by: ['u_me'] }], status: 'read', voice: { dur: 12, bars: bars(26, 2) } },
    { id: 'g3', chatId: 'c_team', sender: 'u_me', ts: t0 - 20.9 * H, type: 'text', text: 'Голосовые тоже работают!', reactions: [], status: 'read', replyTo: { id: 'g2', name: 'Максим', snippet: '🎙 Голосовое · 0:12' } },
    { id: 'g4', chatId: 'c_team', sender: 'u_alina', ts: t0 - 20 * H, type: 'text', text: 'Релиз на горизонте 🚀', reactions: [{ e: '🔥', by: ['u_max', 'u_kirill'] }, { e: '🚀', by: ['u_me'] }], status: 'read' },

    /* --- Максим: файл --- */
    { id: 'x1', chatId: 'c_max', sender: 'u_me', ts: t0 - 2 * D - 10 * M, type: 'text', text: 'Скинь, пожалуйста, тот файл по брендингу', reactions: [], status: 'read' },
    { id: 'x2', chatId: 'c_max', sender: 'u_max', ts: t0 - 2 * D, type: 'file', text: '', reactions: [], status: 'read', file: { name: 'Relik-брендинг.pdf', size: 2.4e6 }, meta: { caption: 'Вот, держи' } },
    { id: 'x3', chatId: 'c_max', sender: 'u_me', ts: t0 - 2 * D + 5 * M, type: 'text', text: 'Спасибо!', reactions: [], status: 'read' },
    { id: 'x4', chatId: 'c_max', sender: 'u_max', ts: t0 - 45 * M, type: 'text', text: 'Ты тут?', reactions: [], status: 'read' },

    /* --- Софья: просто привет --- */
    { id: 's1', chatId: 'c_sonya', sender: 'u_sonya', ts: t0 - 2 * D, type: 'text', text: 'Привет! Как дела?', reactions: [], status: 'read' },
    { id: 's2', chatId: 'c_sonya', sender: 'u_me', ts: t0 - 2 * D + 5 * M, type: 'text', text: 'Всё 잘, спасибо! А у тебя?', reactions: [], status: 'read' },
    { id: 's3', chatId: 'c_sonya', sender: 'u_sonya', ts: t0 - 2 * D + 10 * M, type: 'text', text: 'Тоже норм, работаю над дизайном Relik', reactions: [{ e: '👍', by: ['u_me'] }], status: 'read' },
  ];

  await Promise.all([
    idb.bulkPut('chats', chatsData),
    idb.bulkPut('messages', msgs),
  ]);
}
