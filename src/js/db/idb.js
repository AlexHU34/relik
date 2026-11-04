/* Relik — тонкая обёртка над IndexedDB с запасным хранилищем в памяти.
   В приватном режиме / встроенном браузере мессенджера IndexedDB может быть
   недоступен или падать — тогда работаем на памяти, чтобы приложение
   открывалось, а не показывало пустой экран. */

const DB_NAME = /(?:^|[?&])demo=1(?:&|$)/.test(typeof location !== 'undefined' ? location.search : '')
  ? 'relik-db-demo'
  : 'relik-db';
const VERSION = 2;
let dbp = null;
let broken = false;

/* ── запасное хранилище (живёт до перезагрузки страницы) ── */
const mem = new Map();
const memStore = (st) => {
  if (!mem.has(st)) mem.set(st, new Map());
  return mem.get(st);
};
const memKey = (st, val) => (st === 'settings' ? val.key : val.id);
const memPut = (st, val) => {
  const k = memKey(st, val);
  memStore(st).set(k, val);
  return k;
};

function open() {
  if (broken) return Promise.reject(new Error('IndexedDB is not available'));
  if (dbp) return dbp;
  if (typeof indexedDB === 'undefined' || !indexedDB) {
    broken = true;
    return Promise.reject(new Error('IndexedDB is not available'));
  }

  dbp = new Promise((res, rej) => {
    let r;
    try {
      r = indexedDB.open(DB_NAME, VERSION);
    } catch (err) {
      broken = true;
      rej(err);
      return;
    }
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('chats')) {
        db.createObjectStore('chats', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('messages')) {
        const s = db.createObjectStore('messages', { keyPath: 'id' });
        s.createIndex('byChat', 'chatId');
        s.createIndex('byChatTs', ['chatId', 'ts']);
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('media')) {
        db.createObjectStore('media', { keyPath: 'path' });
      }
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => {
      broken = true;
      rej(r.error || new Error('IndexedDB open error'));
    };
    /* блокировка другим табом — не повод падать */
    r.onblocked = () => {};
  });

  /* чтобы не было «unhandled rejection» до первого await */
  dbp.catch(() => {});
  return dbp;
}

const pr = (req) => new Promise((res, rej) => {
  req.onsuccess = () => res(req.result);
  req.onerror = () => rej(req.error);
});

/* Любая ошибка IndexedDB переводит приложение на запасное хранилище */
async function run(fn, fallback) {
  if (broken) return fallback();
  try {
    return await fn();
  } catch (err) {
    broken = true;
    dbp = null;
    console.warn('IndexedDB fallback:', err && err.message ? err.message : err);
    return fallback();
  }
}

export const idb = {
  getAll: (st) => run(
    async () => pr((await open()).transaction(st).objectStore(st).getAll()),
    () => [...memStore(st).values()],
  ),
  get: (st, key) => run(
    async () => pr((await open()).transaction(st).objectStore(st).get(key)),
    () => memStore(st).get(key),
  ),
  put: (st, val) => run(
    async () => pr((await open()).transaction(st, 'readwrite').objectStore(st).put(val)),
    () => memPut(st, val),
  ),
  del: (st, key) => run(
    async () => pr((await open()).transaction(st, 'readwrite').objectStore(st).delete(key)),
    () => { memStore(st).delete(key); },
  ),
  clear: (st) => run(
    async () => pr((await open()).transaction(st, 'readwrite').objectStore(st).clear()),
    () => { memStore(st).clear(); },
  ),
  bulkPut: (st, arr) => run(
    async () => {
      const db = await open();
      return new Promise((res, rej) => {
        const tx = db.transaction(st, 'readwrite');
        const store = tx.objectStore(st);
        for (const v of arr) store.put(v);
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      });
    },
    () => { for (const v of arr) memPut(st, v); },
  ),
  /* Все сообщения чата, отсортированные по времени */
  messagesOf: (chatId) => run(
    async () => {
      const db = await open();
      const arr = await pr(db.transaction('messages').objectStore('messages').index('byChat').getAll(chatId));
      return arr.sort((a, b) => a.ts - b.ts);
    },
    () => [...memStore('messages').values()]
      .filter((m) => m.chatId === chatId)
      .sort((a, b) => a.ts - b.ts),
  ),
  /* Последние `limit` сообщений чата: открытие чата читает окно, а не всю
     историю. `more = true` — в базе есть ещё более старые записи. */
  messagesTail: (chatId, limit = 300) => run(
    async () => {
      const db = await open();
      const idx = db.transaction('messages').objectStore('messages').index('byChatTs');
      const n = Math.max(1, Number(limit) || 300);
      const out = [];
      await new Promise((res, rej) => {
        const range = IDBKeyRange.bound([chatId, -Infinity], [chatId, Infinity]);
        const req = idx.openCursor(range, 'prev');
        req.onsuccess = () => {
          const cur = req.result;
          if (!cur || out.length > n) return res();
          out.push(cur.value);
          cur.continue();
        };
        req.onerror = () => rej(req.error);
      });
      const more = out.length > n;
      return { messages: (more ? out.slice(0, n) : out).reverse(), more };
    },
    () => {
      const arr = [...memStore('messages').values()]
        .filter((m) => m.chatId === chatId)
        .sort((a, b) => a.ts - b.ts);
      const more = arr.length > limit;
      return { messages: more ? arr.slice(-limit) : arr, more };
    },
  ),
  /* Страница истории строго старше beforeTs — для «показать раньше». */
  messagesBefore: (chatId, beforeTs, limit = 120) => run(
    async () => {
      const db = await open();
      const idx = db.transaction('messages').objectStore('messages').index('byChatTs');
      const n = Math.max(1, Number(limit) || 120);
      const out = [];
      await new Promise((res, rej) => {
        const range = IDBKeyRange.bound([chatId, -Infinity], [chatId, Number(beforeTs) || 0], false, true);
        const req = idx.openCursor(range, 'prev');
        req.onsuccess = () => {
          const cur = req.result;
          if (!cur || out.length > n) return res();
          out.push(cur.value);
          cur.continue();
        };
        req.onerror = () => rej(req.error);
      });
      const more = out.length > n;
      return { messages: (more ? out.slice(0, n) : out).reverse(), more };
    },
    () => {
      const arr = [...memStore('messages').values()]
        .filter((m) => m.chatId === chatId)
        .sort((a, b) => a.ts - b.ts);
      const older = arr.filter((m) => (Number(m.ts) || 0) < (Number(beforeTs) || 0));
      const more = older.length > limit;
      return { messages: more ? older.slice(-limit) : older, more };
    },
  ),
  /* Удалить все сообщения одного чата одним проходом по индексу */
  delMessagesOf: (chatId) => run(
    async () => {
      if (!chatId) return;
      const db = await open();
      await new Promise((res, rej) => {
        const tx = db.transaction('messages', 'readwrite');
        const store = tx.objectStore('messages');
        const req = store.index('byChat').openKeyCursor(IDBKeyRange.only(chatId));
        req.onsuccess = () => {
          const cur = req.result;
          if (!cur) return;
          store.delete(cur.primaryKey);
          cur.continue();
        };
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      });
    },
    () => {
      for (const [k, v] of memStore('messages')) {
        if (v.chatId === chatId) memStore('messages').delete(k);
      }
    },
  ),
};

export const newId = () => (crypto.randomUUID ? crypto.randomUUID() : 'id_' + Math.random().toString(36).slice(2) + Date.now().toString(36));
