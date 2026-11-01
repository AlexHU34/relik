/* Relik — какие устройства получают конверт crypto v2.
   Чистые функции без сети и WebCrypto: политика должна быть покрыта тестами.

   Зачем: конверт адресуется каждому устройству (fan-out), иначе на втором
   телефоне сообщение выглядит как «недоступное». Но список устройств растёт:
   переустановки, сбросы, чужие браузеры. Фан-аут на «призраков» — это лишние
   ECDH на каждое сообщение и мёртвый вес в конверте. Поэтому:

   - устройство без активности дольше maxAgeDays считается брошенным;
   - в конверте не больше limit устройств (самые свежие), иначе одно сообщение
     раздувается на десятки коробок, а мобильный канал этого не любит. */

export const DEVICE_MAX_AGE_DAYS = 45;
export const DEVICE_FANOUT_LIMIT = 8;

const DAY_MS = 24 * 60 * 60 * 1000;

/* devices: [{ deviceId, updatedAt? }] */
export function pickActiveDevices(devices, {
  now = Date.now(),
  maxAgeDays = DEVICE_MAX_AGE_DAYS,
  limit = DEVICE_FANOUT_LIMIT,
} = {}) {
  const cutoff = now - Math.max(1, maxAgeDays) * DAY_MS;
  const alive = (devices || []).filter((d) => {
    if (!d || !d.deviceId) return false;
    const seen = Number(d.updatedAt || 0);
    /* без метки времени — старые строки: считаем живыми, иначе потеряем письма */
    return !seen || seen >= cutoff;
  });
  alive.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  const cap = Math.max(1, limit);
  return alive.slice(0, cap);
}

/* Пора ли продлить метку активности своего устройства (раз в сутки). */
export function needsTouch(publishedAt, now = Date.now()) {
  const at = Number(publishedAt || 0);
  if (!at) return true;
  return now - at > DAY_MS;
}
