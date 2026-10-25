# Relik — проект протокола v2 (X3DH + Double Ratchet)

Статус: **ядро реализовано, в отправку не включено**. SQL: `supabase/crypto_v2.sql`. Флаг: `CRYPTO_V2.enabled` в `js/config.js`.

## 1. Зачем

Текущий v1 (см. `CRYPTO.md`) даёт E2E-содержимое, но имеет известные ограничения:

- нет Perfect Forward Secrecy и пост-компромиссной безопасности;
- один долговременный ECDH-ключ на аккаунт, а не на устройство;
- нет AAD/подписи отправителя, нет защиты от replay/reorder;
- нет верифицируемых prekeys;
- групповой ключ общий на версию, без sender keys.

## 2. Целевая модель

- **Одно устройство = одна identity-пара.** Мультидевайс не делит приватный ключ.
- **Асимметрия:** ECDH P-256 для DH, ECDSA P-256 для подписи prekeys (поддержка WebCrypto шире, чем X25519/Ed25519; при отказе от Safari можно перейти на X25519).
- **X3DH:** identity key, signed prekey, one-time prekey → общий секрет.
- **Double Ratchet:** root key + chain keys, DH-ratchet, skipped message keys.
- **AAD:** версия, `conversation_id`, `sender_id`, `sender_device_id`, `message_id`, `created_at`/`ts`, `key_version`.
- **Safety numbers:** fingerprint всех устройств пары, QR, алерт смены.
- **Группы:** Sender Keys, раздача pairwise, ротация при изменении состава.

## 3. Серверные таблицы (черновик)

```sql
create table public.device_keys (
  user_id uuid references public.profiles(id) on delete cascade,
  device_id uuid not null,
  identity_key text not null,          -- ECDH public
  identity_sig_key text not null,      -- ECDSA public
  signed_prekey text not null,
  signed_prekey_sig text not null,
  signed_prekey_id int not null,
  created_at timestamptz default now(),
  primary key (user_id, device_id)
);

create table public.one_time_prekeys (
  user_id uuid references public.profiles(id) on delete cascade,
  device_id uuid not null,
  prekey_id int not null,
  public_key text not null,
  used boolean not null default false,
  primary key (user_id, device_id, prekey_id)
);

-- messages: добавить
alter table public.messages add column if not exists crypto_version int not null default 1;
alter table public.messages add column if not exists sender_device uuid;
alter table public.messages add column if not exists envelope jsonb;
```

RLS: свои device_keys/prekeys читает любой авторизованный (публичные), писать — только владелец; one-time prekey помечается использованным атомарно через RPC.

## 4. Конверт v2

```json
{
  "v": 2,
  "from": "<user>",
  "fromDevice": "<uuid>",
  "toDevice": "<uuid|null>",
  "ephemeral": "<base64>",
  "prekeyId": 123,
  "otpId": 456,
  "n": 0,
  "pn": 0,
  "iv": "<base64>",
  "ct": "<base64>"
}
```

AAD собирается канонически (length-prefixed) и проверяется при расшифровке. Неверный AAD → отказ.

## 5. Ratchet

- Инициализация из X3DH.
- При каждом ответе — новый DH-ratchet.
- Пропущенные ключи хранятся ограниченно (например, 1000) и удаляются после использования.
- Запрет повторного использования message key (replay).
- Лимит прыжка вперёд, чтобы не зациклиться на огромном `n`.

## 6. Группы

- Каждый участник генерирует Sender Key (chain key) и рассылает pairwise каждому устройству.
- Сообщение группы подписывается ключом отправителя; получатель проверяет подпись.
- Ротация при добавлении/удалении/выходе.
- Старые сообщения остаются читаемыми у тех, у кого есть старая цепочка.

## 7. Мультидевайс и миграция

1. Добавить `crypto_version` и новые таблицы, не включая v2 по умолчанию.
2. Клиент публикует device_keys/prekeys при входе.
3. Чат остаётся на v1, пока все устройства не умеют v2.
4. При готовности — новый чат/сообщение v2. Старые читаются v1-веткой.
5. Бэкфилл не перешифровывает историю: старые сообщения остаются v1 навсегда.
6. Откат: флаг `CRYPTO_V2=off` возвращает v1-отправку, v2-сообщения показываются как недоступные.

Это требует отдельной SQL-миграции и проверки на двух аккаунтах/устройствах. Без этого релиз v2 в прод недопустим.

## 8. Тесты

- X3DH: известные векторы, подмена signed prekey, отсутствие one-time prekey.
- Ratchet: порядок, пропуски, повтор, слишком большой пропуск.
- AAD: подмена conversation_id/sender_id/ts → ошибка.
- Мультидевайс: каждое устройство расшифровывает своё.
- Группы: добавление/удаление, старая/новая цепочка.
- Миграция: v1+v2 в одном чате, старая история, откат.

## 9. Что не решает v2

- метаданные (кто, когда, размер) на сервере;
- компрометацию устройства с разблокированным приложением;
- подменённый веб-клиент;
- скриншоты;
- необходимость независимого аудита.

## 10. Порядок работ

1. ~~Дизайн-ревью и тест-векторы~~ — ядро и тесты готовы (`js/crypto/v2/protocol.js`, 24 selftest).
2. ~~SQL-миграция + RLS + RPC для one-time prekeys~~ — `supabase/crypto_v2.sql`.
3. ~~Модуль X3DH + ratchet + тесты без UI~~ — готово.
4. Мультидевайс-регистрация и публикация prekeys — `js/backend/devices.js` готов, включается флагом.
5. Двухрежимная отправка/чтение v1+v2 — **следующий этап, не включено**.
6. UI safety numbers на все устройства.
7. Групповые sender keys.
8. Аудит и только потом включение по умолчанию.

Пока этот документ не реализован полностью, действует `CRYPTO.md` и протокол v1.
