/* Relik — упаковка конвертов crypto v2 для нескольких устройств.
   Чистые функции: без сети и без WebCrypto, чтобы их можно было покрыть тестами.

   Одно сообщение адресуется всем активным устройствам получателя и своим
   собственным (кроме отправителя) — иначе на втором устройстве оно выглядит
   как «недоступное». */

export const ENVELOPE_VERSION = 2;

/* boxes: { [deviceId]: { header, iv, ct, x3dh? } } */
export function packEnvelope({ fromDevice, ts, boxes }) {
  const devices = Object.keys(boxes || {});
  if (!devices.length) return null;
  return {
    v: ENVELOPE_VERSION,
    fromDevice,
    ts,
    toDevice: null, /* адресат не один — смотри envelopes */
    envelopes: { ...boxes },
  };
}

/* Достаём «свою» коробку. Поддерживаем старый одиночный формат,
   чтобы сообщения, отправленные до обновления, всё ещё читались. */
export function pickBox(envelope, deviceId) {
  if (!envelope || Number(envelope.v) !== ENVELOPE_VERSION || !deviceId) return null;
  if (envelope.envelopes && typeof envelope.envelopes === 'object') {
    return envelope.envelopes[deviceId] || null;
  }
  if (envelope.toDevice && envelope.toDevice !== deviceId) return null;
  if (!envelope.header || !envelope.iv || !envelope.ct) return null;
  return { header: envelope.header, iv: envelope.iv, ct: envelope.ct, x3dh: envelope.x3dh };
}

export function envelopeDevices(envelope) {
  if (!envelope) return [];
  if (envelope.envelopes) return Object.keys(envelope.envelopes);
  return envelope.toDevice ? [envelope.toDevice] : [];
}

/* Кому адресовано сообщение (для отладки и метрик, без содержимого). */
export function isAddressedTo(envelope, deviceId) {
  return !!pickBox(envelope, deviceId);
}
