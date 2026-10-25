/* Relik — центральное состояние приложения */

export const S = {
  me: null,          // текущий пользователь {id,name,hue,mail}
  users: [],         // контакты
  chats: [],         // все чаты
  messages: {},      // chatId -> [msg] (загружается при открытии)
  active: null,      // id активного чата
  reply: null,       // {id, name, snippet}
  editing: null,     // id сообщения в режиме изменения
  reactOpen: null,   // id сообщения с открытой панелью реакций
  filter: '',        // поиск по чатам
  folder: 'all',     // all | dm | group | work | archive
  typingChat: null,  // chatId, где показать «печатает…»
  typingUser: null,  // кто именно печатает (для групп)
  demoShown: false,  // тост про демо-медиа показывали
  unreadFrom: {},    // chatId -> ts последнего прочтения (для разделителя)
  renderLimit: {},   // chatId -> сколько сообщений показывать
  reqIn: [],         // входящие заявки в контакты [{id, from, to, status, ts}]
  reqOut: [],        // исходящие заявки
  contacts: [],      // принятые контакты [{userId, reqId}]
};

export const bus = new EventTarget();

export function emit(type, detail) {
  bus.dispatchEvent(new CustomEvent(type, { detail }));
}

export function user(id) {
  if (id === 'u_me') return S.me;
  return S.users.find((u) => u.id === id) || { id, name: '…', hue: 0, seen: 'offline' };
}

export function chatById(id) {
  return S.chats.find((c) => c.id === id);
}

export function chatTitle(chat) {
  if (!chat) return '';
  if (chat.kind === 'group') return chat.title || '';
  const u = S.users.find((x) => x.id === chat.userId);
  return u?.name || chat.title || '…';
}
