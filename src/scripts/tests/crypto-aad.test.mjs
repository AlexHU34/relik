/* Крипто: привязка шифртекста (AAD) и параметры бэкапа ключа. */
import test from 'node:test';
import assert from 'node:assert/strict';

import { installShim } from './_shim.mjs';

installShim();

const ecdh = await import('../../js/crypto/ecdh.js');
const backup = await import('../../js/crypto/backup.js');
const keygen = await import('../../js/crypto/keygen.js');

async function pair() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  return { pub: kp.publicKey, priv: kp.privateKey };
}

const AAD = 'relik-v1|c1|u1|m1';

test('AAD: своё сообщение расшифровывается', async () => {
  const a = await pair();
  const b = await pair();
  const key = await ecdh.deriveChatKey(a.priv, b.pub);
  const box = await ecdh.encryptMessage(key, 'привет', AAD);
  assert.equal(await ecdh.decryptMessage(key, box.iv, box.ciphertext, AAD), 'привет');
});

test('AAD: перестановка в другой чат ломает расшифровку', async () => {
  const a = await pair();
  const b = await pair();
  const key = await ecdh.deriveChatKey(a.priv, b.pub);
  const box = await ecdh.encryptMessage(key, 'секрет', AAD);
  await assert.rejects(
    () => ecdh.decryptMessage(key, box.iv, box.ciphertext, 'relik-v1|c2|u1|m1'),
    'чужой чат не должен расшифровываться',
  );
});

test('AAD: подмена отправителя или id ломает расшифровку', async () => {
  const a = await pair();
  const b = await pair();
  const key = await ecdh.deriveChatKey(a.priv, b.pub);
  const box = await ecdh.encryptMessage(key, 'секрет', AAD);
  await assert.rejects(() => ecdh.decryptMessage(key, box.iv, box.ciphertext, 'relik-v1|c1|u2|m1'));
  await assert.rejects(() => ecdh.decryptMessage(key, box.iv, box.ciphertext, 'relik-v1|c1|u1|m2'));
});

test('AAD: сообщение без AAD не читается как защищённое (обратная совместимость — отдельным вызовом)', async () => {
  const a = await pair();
  const b = await pair();
  const key = await ecdh.deriveChatKey(a.priv, b.pub);
  const legacy = await ecdh.encryptMessage(key, 'старое');
  assert.equal(await ecdh.decryptMessage(key, legacy.iv, legacy.ciphertext), 'старое');
  await assert.rejects(() => ecdh.decryptMessage(key, legacy.iv, legacy.ciphertext, AAD));
});

test('бэкап: новые записи помечены 600 000 итераций и читаются', async () => {
  const jwk = { kty: 'EC', crv: 'P-256', d: 'x', x: 'y', y: 'z' };
  const rec = await backup.encryptPrivateKeyWithPassword(jwk, 'пароль-123');
  assert.equal(rec.iter, 600000);
  assert.deepEqual(await backup.decryptPrivateKeyWithPassword(rec, 'пароль-123'), jwk);
  assert.equal(await backup.verifyPassword(rec, 'неверный'), false);
});

test('бэкап: старые записи с 100 000 итераций всё ещё открываются', async () => {
  const jwk = { kty: 'EC', crv: 'P-256', d: 'a', x: 'b', y: 'c' };
  const salt = keygen.generateSalt();
  const key = await keygen.deriveKeyFromPassword('старый-пароль', salt, 100000);
  const enc = await keygen.encryptAES(key, JSON.stringify(jwk));
  const legacy = {
    salt: keygen.toBase64(salt),
    iv: keygen.toBase64(new Uint8Array(enc.iv)),
    ciphertext: keygen.toBase64(new Uint8Array(enc.ciphertext)),
    /* iter отсутствует — как в бэкапах до 1.44 */
  };
  assert.deepEqual(await backup.decryptPrivateKeyWithPassword(legacy, 'старый-пароль'), jwk);
});
