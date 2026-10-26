# Relik mail service

Отправляет **только auth-письма** Supabase: подтверждение регистрации,
сброс пароля, magic link, смену почты, reauthentication и уведомления
безопасности. Новостей и рекламы здесь нет.

Домен не нужен. Два варианта транспорта:

| Транспорт | Бесплатно | Плюсы | Минусы |
|---|---|---|---|
| **Yandex SMTP** (`MAIL_PROVIDER=smtp`) | ~500 получателей/сутки | DMARC/SPF проходят, отправитель `@yandex.ru`, лучшая доставка в RU | нужен пароль приложения; лимит на ящик |
| **Brevo API** (`MAIL_PROVIDER=brevo`) | 300 писем/сутки | не нужен app password, удобная статистика | From `@yandex.ru` не выровнен по DMARC; может попадать в «Промо» |

Для аудитории в РФ по умолчанию выбран **Yandex SMTP**. Если Яндекс блокирует
автоматическую отправку или нужна статистика — переключитесь на Brevo.

```
Supabase Auth ──POST──► Caddy (HTTPS) ──► 127.0.0.1:8100
                                           │
                                           ├─ проверка Standard Webhooks
                                           ├─ rate limit / idempotency
                                           └─ Yandex SMTP / Brevo API ──► почта
```

## 1. Яндекс SMTP (рекомендуется без домена)

1. Создайте бесплатный ящик, например `relik.support@yandex.ru`.
2. Включите двухфакторную защиту.
3. Яндекс ID → **Безопасность → Пароли приложений** → создайте пароль
   для «Почты» (не основной пароль).
4. В настройках Почты включите **«Почтовые программы»** (IMAP/SMTP).
5. Проверьте на VPS:

```bash
openssl s_client -connect smtp.yandex.ru:465 -crlf -quiet
# должно быть 220 smtp.yandex.ru ...
```

В env:

```ini
MAIL_PROVIDER=smtp
SMTP_HOST=smtp.yandex.ru
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=relik.support@yandex.ru
SMTP_PASS=<пароль приложения>
MAIL_FROM="Relik <relik.support@yandex.ru>"
MAIL_REPLY_TO=relik.support@yandex.ru
```

> `MAIL_FROM` и `SMTP_USER` должны совпадать, иначе Яндекс отклонит письмо.

### Вариант Brevo

1. <https://www.brevo.com/> → бесплатный аккаунт (300/сутки, без карты).
2. **Senders** → добавьте и подтвердите `relik.support@yandex.ru`.
3. **SMTP & API → API Keys → v3** → ключ `xkeysib-...`.
4. В env:

```ini
MAIL_PROVIDER=brevo
BREVO_API_KEY=xkeysib-...
MAIL_FROM="Relik <relik.support@yandex.ru>"
MAIL_REPLY_TO=relik.support@yandex.ru
```

## 2. Установка на VPS

Нужны Ubuntu/Debian, Node.js 18+ и npm (для `nodemailer`).

```bash
cd scripts/mail-service
sudo bash install.sh
```

Скрипт:

- скопирует сервис в `/opt/relik-mail`;
- выполнит `npm install` (нужен только для SMTP);
- создаст `/etc/relik-mail.env` (chmod 600);
- поставит systemd-юнит `relik-mail`;
- запустит на `127.0.0.1:8100`;
- откроет 80/443 в ufw (если ufw есть).

Секрет хука **не** генерируется скриптом: его создаст Supabase (шаг 4).
Заполните `/etc/relik-mail.env` и перезапустите:

```bash
systemctl restart relik-mail
curl -s http://127.0.0.1:8100/healthz
# {"ok":true,"ready":true,"provider":"smtp",...}
```

Если `ready:false` — не хватает SMTP/Brevo, отправителя или секрета.
`journalctl -u relik-mail -n 50 --no-pager` покажет причину.

## 3. HTTPS без домена (Caddy + nip.io)

Supabase требует HTTPS. `nip.io` — бесплатный DNS: `mail.203.0.113.10.nip.io`
указывает на `203.0.113.10`.

Установите Caddy и добавьте сайт:

```caddyfile
mail.203.0.113.10.nip.io {
    encode zstd gzip
    reverse_proxy 127.0.0.1:8100
    header {
        Strict-Transport-Security "max-age=31536000"
        X-Content-Type-Options "nosniff"
        -Server
    }
}
```

```bash
systemctl reload caddy
curl https://mail.203.0.113.10.nip.io/healthz
```

Если Caddy уже занят другим сервисом, добавьте отдельный блок
`mail.<IP>.nip.io` — он не конфликтует.

> Откройте 80/443 не только в `ufw`, но и в firewall/security group
> облачного провайдера (Oracle, Selectel, Hetzner и т.п.).

Альтернатива без покупки домена — бесплатный `relik.duckdns.org`
(DuckDNS). Он стабильнее nip.io, но требует регистрации и обновления IP.

## 4. Supabase Send Email Hook

1. Supabase Dashboard → **Authentication → Hooks**.
2. **Send Email** → **HTTP**.
3. URL: `https://mail.<IP>.nip.io/hooks/send-email`.
4. **Generate secret** → скопируйте `v1,whsec_...` в
   `/etc/relik-mail.env` → `SEND_EMAIL_HOOK_SECRET`.
5. Включите **Email provider** (Authentication → Providers → Email).
6. Включите **Confirm email** — иначе Supabase не будет отправлять код при
   регистрации.
7. Включите хук и перезапустите сервис:

```bash
systemctl restart relik-mail
```

После этого Supabase не использует свой SMTP — все письма идут через
этот сервис.

Проверка: зарегистрируйте тестовый аккаунт. Должно прийти письмо с кодом
`123-456`; введите его в окне подтверждения Relik.

## 5. Тест без Supabase

`DRY_RUN=1` — сервис ничего не отправляет, только пишет в лог.

```bash
# в /etc/relik-mail.env: DRY_RUN=1
systemctl restart relik-mail

SEND_EMAIL_HOOK_SECRET='v1,whsec_...' \
TO_EMAIL='you@yandex.ru' \
node /opt/relik-mail/test-hook.mjs
```

Юнит-тесты сервиса (без сети и без писем):

```bash
cd /opt/relik-mail
npm test
# 7 tests: формат кода, подпись, email_change, шаблон
```

Реальная отправка:

```bash
SEND_EMAIL_HOOK_SECRET='v1,whsec_...' \
TO_EMAIL='you@yandex.ru' \
MAIL_SERVICE_URL='https://mail.<IP>.nip.io/hooks/send-email' \
node /opt/relik-mail/test-hook.mjs
```

Скрипт подписывает payload тем же секретом и вызывает endpoint. Можно
проверить `signup`, `recovery`, `magiclink`, `email_change`,
`reauthentication` и уведомления.

## 6. Переменные

| Переменная | Обязательно | По умолчанию | Смысл |
|---|---|---|---|
| `MAIL_PROVIDER` | нет | `smtp` | `smtp` или `brevo` |
| `SMTP_HOST` | для smtp | `smtp.yandex.ru` | SMTP-сервер |
| `SMTP_PORT` | для smtp | `465` | 465 (SSL) или 587 (STARTTLS) |
| `SMTP_SECURE` | для smtp | `true` | SSL |
| `SMTP_USER` | для smtp | — | полный адрес ящика |
| `SMTP_PASS` | для smtp | — | пароль приложения |
| `BREVO_API_KEY` | для brevo | — | ключ Brevo v3 |
| `MAIL_FROM` | да | `Relik <relik.support@yandex.ru>` | отправитель |
| `MAIL_REPLY_TO` | нет | — | Reply-To |
| `SUPABASE_URL` | для ссылок | — | проект Supabase |
| `SEND_EMAIL_HOOK_SECRET` | да | — | секрет Standard Webhooks |
| `CODE_TTL_MINUTES` | нет | `60` | срок кода в тексте |
| `RATE_PER_EMAIL` | нет | `5` | писем на email за окно |
| `RATE_WINDOW_MS` | нет | `900000` | окно лимита (15 мин) |
| `RATE_GLOBAL_PER_MIN` | нет | `30` | общий лимит в минуту |
| `BREVO_TIMEOUT_MS` | нет | `4000` | таймаут провайдера |
| `DRY_RUN` | нет | `0` | 1 — не отправлять |
| `LOG_LEVEL` | нет | `info` | `debug/info/warn/error` |

## 7. Если что-то не работает

| Симптом | Что проверить |
|---|---|
| `401 invalid signature` | секрет в Supabase и env не совпадает; скопирован целиком |
| `ready:false` | SMTP_USER/SMTP_PASS или BREVO_API_KEY; MAIL_FROM; секрет |
| `EAUTH` / `535` | пароль приложения Яндекса, а не основной; включены «Почтовые программы» |
| `EENVELOPE` / `sender` | `MAIL_FROM` не совпадает с `SMTP_USER` |
| `brevo 401` | неверный API-ключ |
| `brevo 400 sender` | отправитель не подтверждён в Brevo |
| `429 rate limited` | лимит сервиса; подождите или поднимите `RATE_PER_EMAIL` |
| `503` | SMTP/Brevo недоступен или таймаут; Supabase повторит 3 раза |
| `https://mail...` не открывается | DNS nip.io, 80/443, Caddy, ufw |
| письмо в спаме | прогрейте ящик, проверьте SPF/DKIM; с доменом будет лучше |

Логи:

```bash
journalctl -u relik-mail -f
```

## 8. Безопасность

- `SMTP_PASS`, `BREVO_API_KEY`, `SEND_EMAIL_HOOK_SECRET` — только в
  `/etc/relik-mail.env`, `chmod 600`.
- Сервис слушает `127.0.0.1`; наружу — только Caddy.
- Подпись Standard Webhooks обязательна; без неё — 401.
- Коды и токены **не логируются**, email маскируется.
- Тело запроса ≤ 20 КБ (лимит Supabase).
- Повторный `webhook-id` не создаёт дубль.
- Rate limit защищает квоту провайдера.
- Секрет можно ротировать: два значения через `|`, затем убрать старое.
- Никаких новостей/рекламы через этот сервис.

## 9. Ограничения

- **Нет домена** → отправитель `@yandex.ru`; для RU это нормально, для
  западных ящиков иногда «Промо».
- Яндекс: ~500 получателей/сутки; Brevo Free: 300 писем/сутки.
- Rate-limit/idempotency в памяти: после рестарта счётчики сбрасываются,
  редкий ретрай Supabase может дать дубль.
- Письма на русском. Для EN можно добавить `user.user_metadata.i18n`.
- Вход по паролю остаётся основным. Сервис уже умеет `magiclink`, но
  **passwordless-вход в клиенте** требует отдельного решения: сейчас
  приватный ключ E2E шифруется паролем, и без пароля его нечем
  расшифровать. Это следующий этап, а не часть рассылки.

## 10. Подпись вручную

Секрет: `v1,whsec_<base64>`. Подписывается:

```
<webhook-id>.<webhook-timestamp>.<raw-body>
```

HMAC-SHA256, ключ — base64-секрет. Заголовок:

```
webhook-signature: v1,<base64-hmac>
```

Допуск по времени — 5 минут.
