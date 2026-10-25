/* Relik — протокол v2: X3DH + Double Ratchet (P-256)
   Статус: ядро. В сообщения пока не включено по умолчанию.
   Не заменяет CRYPTO.md: v1 остаётся рабочим протоколом. */

const enc = new TextEncoder();
const ZERO_SALT = new Uint8Array(32);

/* ── байты / base64url ───────────────────────────────────── */
export function utf8(value) {
  return enc.encode(String(value ?? ''));
}

export function concatBytes(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

export function toB64u(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64u(value) {
  const src = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = src + '='.repeat((4 - (src.length % 4)) % 4);
  const bin = atob(pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

function lenPrefixed(bytes) {
  const head = new Uint8Array(4);
  new DataView(head.buffer).setUint32(0, bytes.length, false);
  return concatBytes([head, bytes]);
}

function toJwk(value) {
  if (!value) return null;
  if (typeof value === 'string') { try { return JSON.parse(value); } catch (e) { return null; } }
  return value;
}

export function publicRaw(value) {
  const jwk = toJwk(value);
  if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256') throw new Error('Invalid P-256 key');
  const x = fromB64u(jwk.x);
  const y = fromB64u(jwk.y);
  if (x.length !== 32 || y.length !== 32) throw new Error('Invalid P-256 point');
  return concatBytes([x, y]);
}

/* ── примитивы ───────────────────────────────────────────── */
export async function hkdf(secret, salt = ZERO_SALT, info = '', length = 32) {
  const material = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: typeof info === 'string' ? utf8(info) : info },
    material,
    length * 8,
  );
  return new Uint8Array(bits);
}

async function hmac(keyBytes, data) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
}

export async function aesEncrypt(keyBytes, plaintext, aad) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt']);
  const iv = randomBytes(12);
  const data = typeof plaintext === 'string' ? utf8(plaintext) : plaintext;
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad || new Uint8Array(0) }, key, data);
  return { iv: toB64u(iv), ct: toB64u(new Uint8Array(ct)) };
}

export async function aesDecrypt(keyBytes, ivB64, ctB64, aad) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt']);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64u(ivB64), additionalData: aad || new Uint8Array(0) },
    key,
    fromB64u(ctB64),
  );
  return new Uint8Array(plain);
}

export async function generateEcdh() {
  return await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
}

export async function generateEcdsa() {
  return await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
}

export async function exportPublic(pair) {
  return await crypto.subtle.exportKey('jwk', pair.publicKey);
}

export async function exportPrivate(pair) {
  return await crypto.subtle.exportKey('jwk', pair.privateKey);
}

export async function importEcdhPublic(jwk) {
  return await crypto.subtle.importKey('jwk', toJwk(jwk), { name: 'ECDH', namedCurve: 'P-256' }, true, []);
}

export async function importEcdhPrivate(jwk) {
  return await crypto.subtle.importKey('jwk', toJwk(jwk), { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
}

export async function importEcdsaPublic(jwk) {
  return await crypto.subtle.importKey('jwk', toJwk(jwk), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
}

export async function importEcdsaPrivate(jwk) {
  return await crypto.subtle.importKey('jwk', toJwk(jwk), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
}

export async function ecdh(priv, pub) {
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: pub }, priv, 256));
}

export async function sign(priv, data) {
  return new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, priv, data));
}

export async function verify(pub, signature, data) {
  return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, signature, data);
}

/* ── AAD ─────────────────────────────────────────────────── */
export function buildAAD(fields) {
  const parts = [utf8('relik-aad-v2')];
  for (const key of Object.keys(fields || {}).sort()) {
    parts.push(lenPrefixed(utf8(key)), lenPrefixed(utf8(fields[key])));
  }
  return concatBytes(parts);
}

/* ── X3DH ────────────────────────────────────────────────── */
const SPK_DOMAIN = utf8('relik-spk-v2');
const X3DH_INFO = 'relik-x3dh-v2';

export async function generateDeviceBundle({ prekeys = 20 } = {}) {
  const identity = await generateEcdh();
  const identitySign = await generateEcdsa();
  const spk = await generateEcdh();
  const spkPub = await exportPublic(spk);
  const spkId = (Date.now() % 2147483647);
  const spkSig = await sign(identitySign.privateKey, concatBytes([SPK_DOMAIN, publicRaw(spkPub)]));

  const oneTime = [];
  const oneTimePrivate = [];
  for (let i = 0; i < prekeys; i++) {
    const pair = await generateEcdh();
    const pub = await exportPublic(pair);
    const id = ((Date.now() + i) % 2147483647);
    oneTime.push({ id, key: pub });
    oneTimePrivate.push({ id, key: await exportPrivate(pair) });
  }

  return {
    publicBundle: {
      identityKey: await exportPublic(identity),
      identitySignKey: await exportPublic(identitySign),
      signedPrekeyId: spkId,
      signedPrekey: spkPub,
      signedPrekeySig: toB64u(spkSig),
      oneTimePrekeys: oneTime,
    },
    privateBundle: {
      identityPrivate: await exportPrivate(identity),
      identitySignPrivate: await exportPrivate(identitySign),
      signedPrekeyId: spkId,
      signedPrekeyPrivate: await exportPrivate(spk),
      oneTimePrekeys: oneTimePrivate,
    },
  };
}

async function verifyBundle(bundle) {
  if (!bundle?.identitySignKey || !bundle?.signedPrekey || !bundle?.signedPrekeySig) {
    throw new Error('Incomplete device bundle');
  }
  const signPub = await importEcdsaPublic(bundle.identitySignKey);
  const ok = await verify(signPub, fromB64u(bundle.signedPrekeySig), concatBytes([SPK_DOMAIN, publicRaw(bundle.signedPrekey)]));
  if (!ok) throw new Error('Invalid signed prekey signature');
}

export async function x3dhInitiate(identityPrivateJwk, bundle, opkId = null) {
  await verifyBundle(bundle);
  const identityPriv = await importEcdhPrivate(identityPrivateJwk);
  const theirIdentity = await importEcdhPublic(bundle.identityKey);
  const theirSpk = await importEcdhPublic(bundle.signedPrekey);
  const ephemeral = await generateEcdh();
  const ephemeralPub = await exportPublic(ephemeral);

  const otp = opkId
    ? (bundle.oneTimePrekeys || []).find((x) => Number(x.id) === Number(opkId))
    : (bundle.oneTimePrekeys || [])[0];
  const theirOtp = otp ? await importEcdhPublic(otp.key) : null;

  const parts = [
    await ecdh(identityPriv, theirSpk),
    await ecdh(ephemeral.privateKey, theirIdentity),
    await ecdh(ephemeral.privateKey, theirSpk),
  ];
  if (theirOtp) parts.push(await ecdh(ephemeral.privateKey, theirOtp));

  const sk = await hkdf(concatBytes(parts), ZERO_SALT, X3DH_INFO, 32);
  return {
    sk,
    ephemeral: ephemeralPub,
    identity: bundle.identityKey,
    spkId: bundle.signedPrekeyId,
    opkId: otp?.id ?? null,
    ad: concatBytes([publicRaw(await exportPublic(ephemeral)), publicRaw(bundle.identityKey)]),
  };
}

export async function x3dhRespond({
  identityPrivateJwk,
  signedPrekeyPrivateJwk,
  oneTimePrekeys = [],
  initiatorIdentityJwk,
  initiatorEphemeralJwk,
  opkId = null,
}) {
  const identityPriv = await importEcdhPrivate(identityPrivateJwk);
  const spkPriv = await importEcdhPrivate(signedPrekeyPrivateJwk);
  const theirIdentity = await importEcdhPublic(initiatorIdentityJwk);
  const theirEphemeral = await importEcdhPublic(initiatorEphemeralJwk);
  const otp = opkId ? oneTimePrekeys.find((x) => Number(x.id) === Number(opkId)) : null;
  const otpPriv = otp ? await importEcdhPrivate(otp.key) : null;

  const parts = [
    await ecdh(spkPriv, theirIdentity),
    await ecdh(identityPriv, theirEphemeral),
    await ecdh(spkPriv, theirEphemeral),
  ];
  if (otpPriv) parts.push(await ecdh(otpPriv, theirEphemeral));

  const sk = await hkdf(concatBytes(parts), ZERO_SALT, X3DH_INFO, 32);
  return {
    sk,
    ad: concatBytes([publicRaw(initiatorEphemeralJwk), publicRaw(initiatorIdentityJwk)]),
  };
}

/* ── Double Ratchet ──────────────────────────────────────── */
const ROOT_INFO = 'relik-dr-root-v2';
const CHAIN_MK = utf8('relik-mk-v2');
const CHAIN_CK = utf8('relik-ck-v2');
const MAX_SKIP = 1000;

async function kdfRoot(root, dh) {
  const out = await hkdf(dh, root, ROOT_INFO, 64);
  return { root: out.slice(0, 32), chain: out.slice(32, 64) };
}

async function kdfChain(chain) {
  return {
    messageKey: await hmac(chain, CHAIN_MK),
    nextChain: await hmac(chain, CHAIN_CK),
  };
}

function headerAAD(header) {
  return buildAAD({
    dh: header.dh || '',
    n: header.n,
    pn: header.pn,
    v: 2,
  });
}

function addSkipped(state, dh, n, mk) {
  state.skipped.push({ dh, n, mk: toB64u(mk) });
  while (state.skipped.length > MAX_SKIP) state.skipped.shift();
}

async function skipRecv(state, until) {
  if (!state.recvChain) return;
  while (state.recvCount < until) {
    const { messageKey, nextChain } = await kdfChain(state.recvChain);
    addSkipped(state, state.remoteDHRaw || '', state.recvCount, messageKey);
    state.recvChain = nextChain;
    state.recvCount++;
  }
}

async function takeSkipped(state, dh, n) {
  const idx = state.skipped.findIndex((x) => x.dh === dh && Number(x.n) === Number(n));
  if (idx < 0) return null;
  const [item] = state.skipped.splice(idx, 1);
  return fromB64u(item.mk);
}

export async function ratchetInitInitiator(sk, theirSignedPrekeyJwk) {
  const root = await hkdf(sk, ZERO_SALT, ROOT_INFO, 32);
  const self = await generateEcdh();
  const theirSpk = await importEcdhPublic(theirSignedPrekeyJwk);
  const dh = await ecdh(self.privateKey, theirSpk);
  const { root: newRoot, chain } = await kdfRoot(root, dh);
  return {
    rootKey: newRoot,
    self,
    remoteDHRaw: toB64u(publicRaw(theirSignedPrekeyJwk)),
    sendChain: chain,
    recvChain: null,
    sendCount: 0,
    recvCount: 0,
    prevSendCount: 0,
    skipped: [],
  };
}

export async function ratchetInitResponder(sk, signedPrekeyPair) {
  return {
    rootKey: await hkdf(sk, ZERO_SALT, ROOT_INFO, 32),
    self: signedPrekeyPair,
    remoteDHRaw: null,
    sendChain: null,
    recvChain: null,
    sendCount: 0,
    recvCount: 0,
    prevSendCount: 0,
    skipped: [],
  };
}

export async function ratchetEncrypt(state, plaintext, aad) {
  if (!state.sendChain) throw new Error('Send chain is not initialized');
  const { messageKey, nextChain } = await kdfChain(state.sendChain);
  const header = {
    dh: toB64u(publicRaw(await exportPublic(state.self))),
    n: state.sendCount,
    pn: state.prevSendCount,
  };
  state.sendChain = nextChain;
  state.sendCount++;
  const fullAAD = concatBytes([aad || new Uint8Array(0), headerAAD(header)]);
  const box = await aesEncrypt(messageKey, plaintext, fullAAD);
  return { header, iv: box.iv, ct: box.ct };
}

export async function ratchetDecrypt(state, header, iv, ct, aad) {
  if (!header || !header.dh) throw new Error('Missing ratchet header');
  const dh = String(header.dh);

  if (dh !== state.remoteDHRaw) {
    if (state.recvChain) await skipRecv(state, Number(header.pn) || 0);
    const raw = fromB64u(dh);
    if (raw.length !== 64) throw new Error('Invalid ratchet key');
    const remoteKey = await importEcdhPublic({
      kty: 'EC', crv: 'P-256',
      x: toB64u(raw.slice(0, 32)),
      y: toB64u(raw.slice(32, 64)),
    });
    const step = await ecdh(state.self.privateKey, remoteKey);
    const { root, chain } = await kdfRoot(state.rootKey, step);
    state.rootKey = root;
    state.recvChain = chain;
    state.recvCount = 0;
    state.remoteDHRaw = dh;

    /* Rotate our sending ratchet after receiving a new DH key */
    const fresh = await generateEcdh();
    const step2 = await ecdh(fresh.privateKey, remoteKey);
    const { root: root2, chain: sendChain } = await kdfRoot(state.rootKey, step2);
    state.rootKey = root2;
    state.sendChain = sendChain;
    state.prevSendCount = state.sendCount;
    state.sendCount = 0;
    state.self = fresh;
  }

  let mk = await takeSkipped(state, dh, Number(header.n));
  if (!mk) {
    if (!state.recvChain) throw new Error('Receive chain is not initialized');
    if (Number(header.n) < state.recvCount) throw new Error('Old message key is gone');
    await skipRecv(state, Number(header.n));
    const { messageKey, nextChain } = await kdfChain(state.recvChain);
    mk = messageKey;
    state.recvChain = nextChain;
    state.recvCount = Number(header.n) + 1;
  }

  const fullAAD = concatBytes([aad || new Uint8Array(0), headerAAD(header)]);
  return await aesDecrypt(mk, iv, ct, fullAAD);
}

/* ── сериализация состояния ─────────────────────────────── */
export async function exportRatchet(state) {
  return {
    rootKey: toB64u(state.rootKey),
    selfPub: await exportPublic(state.self),
    selfPriv: await exportPrivate(state.self),
    remoteDHRaw: state.remoteDHRaw || '',
    sendChain: state.sendChain ? toB64u(state.sendChain) : null,
    recvChain: state.recvChain ? toB64u(state.recvChain) : null,
    sendCount: state.sendCount,
    recvCount: state.recvCount,
    prevSendCount: state.prevSendCount,
    skipped: state.skipped,
  };
}

export async function importRatchet(data) {
  return {
    rootKey: fromB64u(data.rootKey),
    self: {
      publicKey: await importEcdhPublic(data.selfPub),
      privateKey: await importEcdhPrivate(data.selfPriv),
    },
    remoteDHRaw: data.remoteDHRaw || null,
    sendChain: data.sendChain ? fromB64u(data.sendChain) : null,
    recvChain: data.recvChain ? fromB64u(data.recvChain) : null,
    sendCount: Number(data.sendCount) || 0,
    recvCount: Number(data.recvCount) || 0,
    prevSendCount: Number(data.prevSendCount) || 0,
    skipped: Array.isArray(data.skipped) ? data.skipped : [],
  };
}
