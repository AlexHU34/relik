/* Общий шим для тестов: модули Relik рассчитаны на браузер, но большая
   часть логики чистая. Здесь добавляем только то, что трогается при импорте. */
export function installShim() {
  if (typeof globalThis.localStorage === 'undefined') {
    const store = new Map();
    globalThis.localStorage = {
      getItem: (k) => (store.has(String(k)) ? store.get(String(k)) : null),
      setItem: (k, v) => store.set(String(k), String(v)),
      removeItem: (k) => store.delete(String(k)),
      clear: () => store.clear(),
      key: (i) => [...store.keys()][i] ?? null,
      get length() { return store.size; },
    };
  }
  return globalThis;
}

export function makeP256Jwk() {
  return crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
    .then((pair) => crypto.subtle.exportKey('jwk', pair.publicKey));
}
