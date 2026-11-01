/* Групповые sender keys: цепочка на отправителя, порядок и пропуски.
   Проверяем свойства, без которых группу включать нельзя: каждое сообщение
   читается только своим ключом, опоздавшие не теряются, повтор и подмена
   AAD/цепочки отвергаются. */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  newChain, chainEncrypt, chainDecrypt, groupAad, skippedCount, MAX_SKIP,
} from '../../js/crypto/v2/senderKey.js';

const AAD = groupAad({
  chatId: 'chat-1', senderId: 'user-a', senderDevice: 'dev-a1', messageId: 'm-1',
});

const enc = (state, text, aad = AAD) => chainEncrypt(state, text, aad);
const dec = (state, parts, aad = AAD) => chainDecrypt(state, parts.header, parts.iv, parts.ct, aad);
const textOf = (r) => new TextDecoder().decode(r.plaintext);

test('sender key: цепочка создаётся случайной и с версией', () => {
  const a = newChain();
  const b = newChain();
  assert.equal(a.version, 1);
  assert.ok(a.chainId && a.chainId !== b.chainId, 'chainId должен быть уникальным');
  assert.ok(a.chain !== b.chain, 'цепочки не должны совпадать');
  assert.equal(a.iteration, 0);
  assert.equal(skippedCount(a), 0);
});

test('sender key: сообщение шифруется и читается, счётчик растёт', async () => {
  let send = newChain();
  let recv = { ...newChain(), chainId: send.chainId, chain: send.chain };

  const r1 = await enc(send, 'привет');
  send = r1.state;
  assert.equal(r1.header.n, 0);
  assert.equal(send.iteration, 1);
  assert.notEqual(new TextDecoder().decode(new TextEncoder().encode('')), r1.ct, 'ciphertext не пустой');

  const d1 = await dec(recv, r1);
  recv = d1.state;
  assert.equal(textOf(d1), 'привет');
  assert.equal(recv.iteration, 1);
});

test('sender key: три сообщения по порядку', async () => {
  let send = newChain();
  let recv = { ...newChain(), chainId: send.chainId, chain: send.chain };

  for (const text of ['один', 'два', 'три']) {
    const r = await enc(send, text);
    send = r.state;
    const d = await dec(recv, r);
    recv = d.state;
    assert.equal(textOf(d), text);
  }
  assert.equal(send.iteration, 3);
  assert.equal(recv.iteration, 3);
});

test('sender key: сообщения не по порядку — пропуски сохраняются и потом читаются', async () => {
  let send = newChain();
  let recv = { ...newChain(), chainId: send.chainId, chain: send.chain };

  const parts = [];
  for (const text of ['первое', 'второе', 'третье']) {
    const r = await enc(send, text);
    send = r.state;
    parts.push(r);
  }

  /* третье пришло первым: два ключа уходят в skipped */
  const d3 = await dec(recv, parts[2]);
  recv = d3.state;
  assert.equal(textOf(d3), 'третье');
  assert.equal(skippedCount(recv), 2);

  const d1 = await dec(recv, parts[0]);
  recv = d1.state;
  const d2 = await dec(recv, parts[1]);
  recv = d2.state;
  assert.equal(textOf(d1), 'первое');
  assert.equal(textOf(d2), 'второе');
  assert.equal(skippedCount(recv), 0, 'использованные ключи не копятся');
});

test('sender key: повторное сообщение отвергается (ключ уже израсходован)', async () => {
  let send = newChain();
  let recv = { ...newChain(), chainId: send.chainId, chain: send.chain };

  const r1 = await enc(send, 'один');
  send = r1.state;
  const d1 = await dec(recv, r1);
  recv = d1.state;

  await assert.rejects(() => dec(recv, r1), /уже использован/);
});

test('sender key: чужой AAD не расшифровывается', async () => {
  let send = newChain();
  const recv = { ...newChain(), chainId: send.chainId, chain: send.chain };
  const r1 = await enc(send, 'секрет');
  const wrong = groupAad({ chatId: 'chat-2', senderId: 'user-a', senderDevice: 'dev-a1', messageId: 'm-1' });
  await assert.rejects(() => dec(recv, r1, wrong));
});

test('sender key: другая цепочка (ротация) отвергается', async () => {
  const send = newChain();
  const other = newChain();
  const recv = { ...newChain(), chainId: other.chainId, chain: other.chain };
  const r1 = await enc(send, 'старая цепочка');
  await assert.rejects(() => dec(recv, r1), /другая цепочка/);
});

test('sender key: слишком большой пропуск не принимаем', async () => {
  const send = newChain();
  const recv = { ...newChain(), chainId: send.chainId, chain: send.chain };
  const r = await enc(send, 'далеко');
  const jumped = { ...r, header: { ...r.header, n: MAX_SKIP + 5 } };
  await assert.rejects(() => dec(recv, jumped), /слишком большой пропуск/);
});

test('sender key: после ротации старые сообщения читаются старым chain', async () => {
  const send1 = newChain();
  const start1 = { chainId: send1.chainId, chain: send1.chain };
  const r1 = await enc(send1, 'до ротации');

  const send2 = newChain();
  const start2 = { chainId: send2.chainId, chain: send2.chain };
  const r2 = await enc(send2, 'после ротации');

  const recv1 = { ...newChain(), ...start1 };
  const recv2 = { ...newChain(), ...start2 };

  assert.equal(textOf(await dec(recv1, r1)), 'до ротации');
  assert.equal(textOf(await dec(recv2, r2)), 'после ротации');
  assert.notEqual(r1.header.chainId, r2.header.chainId);
});

test('sender key: состояние переживает сериализацию в IndexedDB', async () => {
  let send = newChain();
  let recv = { ...newChain(), chainId: send.chainId, chain: send.chain };
  const r1 = await enc(send, 'один');
  send = r1.state;
  const d1 = await dec(recv, r1);
  recv = d1.state;

  const restored = JSON.parse(JSON.stringify({ send, recv }));
  const r2 = await enc(restored.send, 'два');
  const d2 = await dec(restored.recv, r2);
  assert.equal(textOf(d2), 'два');
});

test('sender key: пустое состояние не роняет, а честно отказывает', async () => {
  await assert.rejects(() => chainEncrypt(null, 'x', AAD), /нет цепочки/);
  await assert.rejects(() => chainDecrypt({}, null, 'iv', 'ct', AAD), /нет цепочки/);
});
