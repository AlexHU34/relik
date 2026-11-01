/* Relik — групповые sender keys (crypto v2, шаг 7).
   Чистые функции без сети и DOM: их проверяет scripts/tests/v2-sender-key.test.mjs.

   Идея (как в Signal): у каждого участника своя цепочка ключей на группу.
   - chain — 32 случайных байта, из него детерминированно выводятся ключи
     сообщений: mk = HKDF(ck, 'mk'), ck' = HKDF(ck, 'ck').
   - отправка шифрует AES-GCM ключом mk и увеличивает iteration;
   - приём идёт по своим iteration, а «пропущенные» ключи складываются в
     skipped, чтобы сообщения могли приходить не по порядку (сеть, ретраи);
   - chainId меняется при ротации (изменился состав группы), и старые
     сообщения остаются читаемыми своим старым chain.

   Чего здесь нет (и это осознанно):
   - подписи каждого сообщения (аутентичность даёт парный ratchet, которым
     цепочка доставлена каждому устройству);
   - пост-компрометационной безопасности: утёкший chain читает всю группу
     до ротации — поэтому ротация обязательна при изменении состава. */

import { hkdf, aesEncrypt, aesDecrypt, randomBytes, toB64u, fromB64u, utf8 } from './protocol.js';

export const SENDER_KEY_VERSION = 1;
/* Сколько «пропущенных» ключей держим: сеть может переставить сообщения,
   но бесконечная память тут не нужна. */
export const MAX_SKIP = 200;

const CHAIN_MK = 'relik-sk-mk-v1';
const CHAIN_CK = 'relik-sk-ck-v1';

/* Новая цепочка: то, что отправитель создаёт и раздаёт группе. */
export function newChain() {
  return {
    version: SENDER_KEY_VERSION,
    chainId: toB64u(randomBytes(12)),
    chain: toB64u(randomBytes(32)),
    iteration: 0,
    skipped: {},
  };
}

async function kdf(chainB64) {
  const chain = fromB64u(chainB64);
  const mk = await hkdf(chain, undefined, CHAIN_MK, 32);
  const next = toB64u(await hkdf(chain, undefined, CHAIN_CK, 32));
  return { mk, next };
}

/* AAD привязывает сообщение к чату, отправителю и его устройству:
   переставить ciphertext в другое сообщение или чат нельзя. */
export function groupAad({ chatId, senderId, senderDevice, messageId }) {
  return `relik-gsk-v1|${chatId}|${senderId}|${senderDevice}|${messageId}`;
}

/* Зашифровать одно сообщение. Возвращает заголовок (chainId + номер) и новое
   состояние цепочки — вызывающий обязан сохранить его (IndexedDB). */
export async function chainEncrypt(state, plaintext, aad) {
  if (!state?.chain || !state.chainId) throw new Error('sender key: нет цепочки');
  const { mk, next } = await kdf(state.chain);
  const { iv, ct } = await aesEncrypt(mk, plaintext, utf8(aad));
  return {
    header: { chainId: state.chainId, n: Number(state.iteration) || 0 },
    iv,
    ct,
    state: {
      ...state,
      chain: next,
      iteration: (Number(state.iteration) || 0) + 1,
    },
  };
}

/* Расшифровать сообщение. Бросает, если цепочка не та, сообщение уже было
   использовано или пропуск больше MAX_SKIP. */
export async function chainDecrypt(state, header, iv, ct, aad) {
  if (!state?.chain || !state.chainId) throw new Error('sender key: нет цепочки');
  if (!header || header.chainId !== state.chainId) throw new Error('sender key: другая цепочка');

  const n = Number(header.n);
  if (!Number.isFinite(n) || n < 0) throw new Error('sender key: плохой номер сообщения');

  const skipped = { ...(state.skipped || {}) };

  /* сообщение пришло раньше предыдущего — берём сохранённый ключ */
  if (skipped[n]) {
    const mk = fromB64u(skipped[n]);
    delete skipped[n];
    const plain = await aesDecrypt(mk, iv, ct, utf8(aad));
    return { plaintext: plain, state: { ...state, skipped } };
  }
  if (n < (Number(state.iteration) || 0)) throw new Error('sender key: ключ уже использован');

  const gap = n - (Number(state.iteration) || 0);
  if (gap > MAX_SKIP) throw new Error('sender key: слишком большой пропуск');

  let chain = state.chain;
  let i = Number(state.iteration) || 0;
  const fresh = {};
  while (i < n) {
    const { mk, next } = await kdf(chain);
    fresh[i] = toB64u(mk);
    chain = next;
    i += 1;
  }

  const { mk, next } = await kdf(chain);
  const plain = await aesDecrypt(mk, iv, ct, utf8(aad));

  /* держим только последние MAX_SKIP пропущенных ключей */
  const merged = { ...skipped, ...fresh };
  const keys = Object.keys(merged).map(Number).sort((a, b) => a - b);
  while (keys.length > MAX_SKIP) delete merged[keys.shift()];

  return {
    plaintext: plain,
    state: { ...state, chain: next, iteration: i + 1, skipped: merged },
  };
}

/* Размер состояния в «ключах» — для метрик/отладки, без содержимого. */
export function skippedCount(state) {
  return Object.keys(state?.skipped || {}).length;
}
