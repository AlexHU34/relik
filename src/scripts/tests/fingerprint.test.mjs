/* Тесты отпечатков безопасности: канонизация P-256, порядок участников,
   формат отображения. Регресс здесь = ложное «ключ не изменился». */
import test from 'node:test';
import assert from 'node:assert/strict';
import { installShim, makeP256Jwk } from './_shim.mjs';

installShim();
const {
  rawPublicKeyBytes, formatFingerprint, normalizeFingerprint,
  fingerprintsEqual, fingerprintForPair, shortFingerprint,
} = await import('../../js/crypto/fingerprint.js');

test('сырые байты ключа — ровно x||y (64 байта)', async () => {
  const jwk = await makeP256Jwk();
  const raw = rawPublicKeyBytes(jwk);
  assert.equal(raw.length, 64);
  const jwkStr = JSON.stringify(jwk);
  assert.equal(rawPublicKeyBytes(jwkStr).length, 64, 'строковый JWK принимается так же');
});

test('чужая кривая и мусор отвергаются', async () => {
  assert.throws(() => rawPublicKeyBytes({ kty: 'EC', crv: 'P-384', x: 'a', y: 'b' }));
  assert.throws(() => rawPublicKeyBytes(null));
  assert.throws(() => rawPublicKeyBytes('{oops'));
});

test('формат отображения: 8 групп по 4 hex', () => {
  const hex = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
  const out = formatFingerprint(hex);
  assert.equal(out.split('-').length, 8);
  assert.ok(out.split('-').every((g) => g.length === 4));
  assert.equal(out.replace(/-/g, '').length, 32);
});

test('нормализация терпит пробелы, дефисы и регистр', () => {
  const a = normalizeFingerprint('ab cd-ef 01');
  const b = normalizeFingerprint('ABCDEF01');
  assert.equal(a, b);
  assert.equal(fingerprintsEqual('ab cd-ef 01', 'abcdef01'), true);
  assert.equal(fingerprintsEqual('', ''), false);
});

test('отпечаток пары не зависит от порядка аргументов', async () => {
  const ka = await makeP256Jwk();
  const kb = await makeP256Jwk();
  const first = await fingerprintForPair('user-a', ka, 'user-b', kb);
  const second = await fingerprintForPair('user-b', kb, 'user-a', ka);
  assert.equal(first.fullHex, second.fullHex);
  assert.equal(first.display, second.display);
});

test('разные ключи дают разные отпечатки', async () => {
  const ka = await makeP256Jwk();
  const kb = await makeP256Jwk();
  const a = await fingerprintForPair('user-a', ka, 'user-b', kb);
  const b = await fingerprintForPair('user-a', ka, 'user-b', ka);
  assert.notEqual(a.fullHex, b.fullHex);
});

test('отпечаток пары требует двух разных пользователей', async () => {
  const ka = await makeP256Jwk();
  await assert.rejects(() => fingerprintForPair('same', ka, 'same', ka));
  await assert.rejects(() => fingerprintForPair('', ka, 'b', ka));
});

test('стабильность: одинаковый вход — одинаковый отпечаток', async () => {
  const ka = await makeP256Jwk();
  const kb = await makeP256Jwk();
  const a = await fingerprintForPair('u1', ka, 'u2', kb);
  const b = await fingerprintForPair('u1', ka, 'u2', kb);
  assert.equal(a.fullHex, b.fullHex);
  assert.equal(shortFingerprint(a.fullHex), a.display);
});
