/* Тесты протокола v2: X3DH + Double Ratchet + AES-GCM с AAD.
   Повторяют путь приложения (js/backend/v2Messages.js):
   инициатор шифрует, ответчик расшифровывает, AAD привязан к чату/отправителю,
   порядок сообщений устойчив, состояние переживает перезагрузку.

   Контракт X3DH: x3dhInitiate всегда выбирает одноразовый prekey (первый или
   указанный), а ответчик обязан передать ТОТ ЖЕ opkId и приватный список —
   иначе общий секрет не сойдётся. Это зафиксировано отдельным тестом. */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  generateDeviceBundle, x3dhInitiate, x3dhRespond,
  ratchetInitInitiator, ratchetInitResponder,
  ratchetEncrypt, ratchetDecrypt, buildAAD, exportRatchet, importRatchet,
  generateEcdh, exportPublic, exportPrivate, ecdh,
  aesEncrypt, aesDecrypt, toB64u, fromB64u, utf8,
  importEcdhPrivate, importEcdhPublic,
} from '../../js/crypto/v2/protocol.js';

const txt = (bytes) => new TextDecoder().decode(bytes);
const AAD = (chatId, from, to, id) => buildAAD({ chatId, from, to, messageId: id, ts: 1 });

/* Полная сессия: бандл Bob, рукопожатие Alice, состояния ratchet с обеих сторон. */
async function session({ prekeys = 2 } = {}) {
  const bob = await generateDeviceBundle({ prekeys });
  const aliceId = await generateEcdh();
  const aliceIdentity = await exportPrivate(aliceId);

  const init = await x3dhInitiate(aliceIdentity, bob.publicBundle, null);
  const resp = await x3dhRespond({
    identityPrivateJwk: bob.privateBundle.identityPrivate,
    signedPrekeyPrivateJwk: bob.privateBundle.signedPrekeyPrivate,
    oneTimePrekeys: bob.privateBundle.oneTimePrekeys,
    initiatorIdentityJwk: await exportPublic(aliceId),
    initiatorEphemeralJwk: init.ephemeral,
    opkId: init.opkId,
  });

  const aliceState = await ratchetInitInitiator(init.sk, bob.publicBundle.signedPrekey);
  const spkPriv = await importEcdhPrivate(bob.privateBundle.signedPrekeyPrivate);
  const spkPub = await importEcdhPublic(bob.publicBundle.signedPrekey);
  const bobState = await ratchetInitResponder(resp.sk, { publicKey: spkPub, privateKey: spkPriv });

  return { bob, aliceId, init, resp, aliceState, bobState };
}

test('бандл устройства полный и годный для X3DH', async () => {
  const { publicBundle } = await generateDeviceBundle({ prekeys: 2 });
  for (const k of ['identityKey', 'identitySignKey', 'signedPrekey', 'signedPrekeySig']) {
    assert.ok(publicBundle[k], 'нет ' + k);
  }
  assert.equal(publicBundle.oneTimePrekeys.length, 2);
});

test('X3DH: общий секрет совпадает, если ответчик знает opkId', async () => {
  const { init, resp } = await session();
  assert.ok(init.opkId, 'инициатор должен выбрать одноразовый prekey');
  assert.equal(toB64u(init.sk), toB64u(resp.sk));
  assert.equal(toB64u(init.ad), toB64u(resp.ad));
});

test('X3DH: без opkId секрет НЕ совпадает (контракт нельзя нарушать)', async () => {
  const bob = await generateDeviceBundle({ prekeys: 2 });
  const aliceId = await generateEcdh();
  const init = await x3dhInitiate(await exportPrivate(aliceId), bob.publicBundle, null);
  const resp = await x3dhRespond({
    identityPrivateJwk: bob.privateBundle.identityPrivate,
    signedPrekeyPrivateJwk: bob.privateBundle.signedPrekeyPrivate,
    initiatorIdentityJwk: await exportPublic(aliceId),
    initiatorEphemeralJwk: init.ephemeral,
    opkId: null,
  });
  assert.notEqual(toB64u(init.sk), toB64u(resp.sk));
});

test('X3DH отвергает подделанную подпись SPK', async () => {
  const bob = await generateDeviceBundle({ prekeys: 1 });
  const aliceId = await generateEcdh();
  const alicePriv = await exportPrivate(aliceId);
  const broken = { ...bob.publicBundle, signedPrekeySig: 'AAAA' };
  await assert.rejects(() => x3dhInitiate(alicePriv, broken, null));
});

test('сообщение v2 доходит и текст совпадает', async () => {
  const { aliceState, bobState } = await session();
  const aad = AAD('chat-1', 'alice', 'bob', 'm1');
  const enc = await ratchetEncrypt(aliceState, 'привет, это v2', aad);
  assert.equal(txt(await ratchetDecrypt(bobState, enc.header, enc.iv, enc.ct, aad)), 'привет, это v2');
});

test('несколько сообщений в обе стороны (DH-ratchet крутится)', async () => {
  const { aliceState, bobState } = await session();
  for (let i = 0; i < 4; i += 1) {
    const aad = AAD('c', 'alice', 'bob', 'a' + i);
    const enc = await ratchetEncrypt(aliceState, 'A' + i, aad);
    assert.equal(txt(await ratchetDecrypt(bobState, enc.header, enc.iv, enc.ct, aad)), 'A' + i);
  }
  for (let i = 0; i < 4; i += 1) {
    const aad = AAD('c', 'bob', 'alice', 'b' + i);
    const enc = await ratchetEncrypt(bobState, 'B' + i, aad);
    assert.equal(txt(await ratchetDecrypt(aliceState, enc.header, enc.iv, enc.ct, aad)), 'B' + i);
  }
});

test('чужой AAD не расшифровывается (привязка к чату)', async () => {
  const { aliceState, bobState } = await session();
  const enc = await ratchetEncrypt(aliceState, 'секрет', AAD('chat-1', 'alice', 'bob', 'm1'));
  await assert.rejects(() => ratchetDecrypt(bobState, enc.header, enc.iv, enc.ct, AAD('chat-2', 'alice', 'bob', 'm1')));
});

test('опоздавшее сообщение достаётся через skipped-keys', async () => {
  const { aliceState, bobState } = await session();
  const m0 = await ratchetEncrypt(aliceState, 'нулевое', AAD('c', 'a', 'b', '0'));
  const m1 = await ratchetEncrypt(aliceState, 'первое', AAD('c', 'a', 'b', '1'));
  assert.equal(txt(await ratchetDecrypt(bobState, m1.header, m1.iv, m1.ct, AAD('c', 'a', 'b', '1'))), 'первое');
  assert.equal(txt(await ratchetDecrypt(bobState, m0.header, m0.iv, m0.ct, AAD('c', 'a', 'b', '0'))), 'нулевое');
});

test('состояние ratchet переживает сериализацию', async () => {
  const { aliceState, bobState } = await session();
  const aad = AAD('c', 'a', 'b', '1');
  const enc = await ratchetEncrypt(aliceState, 'до перезагрузки', aad);

  const saved = JSON.parse(JSON.stringify(await exportRatchet(aliceState)));
  const restored = await importRatchet(saved);
  const next = await ratchetEncrypt(restored, 'после перезагрузки', AAD('c', 'a', 'b', '2'));
  assert.equal(enc.header.n, 0);
  assert.equal(next.header.n, 1);
  assert.equal(txt(await ratchetDecrypt(bobState, next.header, next.iv, next.ct, AAD('c', 'a', 'b', '2'))), 'после перезагрузки');
});

test('AES-GCM: без ключа и с чужим AAD не расшифровывается', async () => {
  const key = new Uint8Array(32).fill(7);
  const aad = utf8('aad');
  const enc = await aesEncrypt(key, 'текст', aad);
  assert.equal(txt(await aesDecrypt(key, enc.iv, enc.ct, aad)), 'текст');
  await assert.rejects(() => aesDecrypt(key, enc.iv, enc.ct, utf8('другой')));
  await assert.rejects(() => aesDecrypt(new Uint8Array(32).fill(8), enc.iv, enc.ct, aad));
});

test('ECDH симметричен', async () => {
  const a = await generateEcdh();
  const b = await generateEcdh();
  const ab = await ecdh(await importEcdhPrivate(await exportPrivate(a)), await importEcdhPublic(await exportPublic(b)));
  const ba = await ecdh(await importEcdhPrivate(await exportPrivate(b)), await importEcdhPublic(await exportPublic(a)));
  assert.equal(toB64u(ab), toB64u(ba));
});

test('base64url — обратимое кодирование', () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
  assert.deepEqual(Array.from(fromB64u(toB64u(bytes))), Array.from(bytes));
});
